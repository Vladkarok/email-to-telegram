/**
 * Telegram update handling across start and shutdown, against a fake Bot API:
 * the update gates createBot installs, the polling controller and the
 * shutdown sequence wired the way src/index.ts wires them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { Bot, Context } from "grammy";
import { FakeBotApi, FAKE_BOT_INFO } from "../../helpers/fakeBotApi.js";

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../../../src/utils/logger.js", () => ({ getLogger: () => logger }));
vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../../src/telegram/middleware/auth.js", () => ({
  authMiddleware: async (_ctx: unknown, next: () => Promise<void>) => next(),
}));

const handlers = vi.hoisted(() => ({
  listemail: vi.fn<(ctx: Context) => Promise<void>>(),
  chatMember: vi.fn<(ctx: Context) => Promise<void>>(),
  migrateTo: vi.fn<(ctx: Context) => Promise<void>>(),
  deleteMeConfirm: vi.fn<(ctx: Context) => Promise<void>>(),
}));
vi.mock("../../../src/telegram/commands/listemail.js", () => ({
  listemailHandler: (ctx: Context) => handlers.listemail(ctx),
}));
vi.mock("../../../src/telegram/handlers/chatMember.js", () => ({
  chatMemberHandler: (ctx: Context) => handlers.chatMember(ctx),
}));
vi.mock("../../../src/telegram/chatMigration.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  migrateToChatIdHandler: (ctx: Context) => handlers.migrateTo(ctx),
}));
vi.mock("../../../src/telegram/commands/deleteme.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deleteMeConfirmCallback: (ctx: Context) => handlers.deleteMeConfirm(ctx),
}));

const { createBot, syncBotCommands } = await import("../../../src/telegram/bot.js");
const { createPollingController } = await import("../../../src/telegram/polling.js");
const { createShutdown } = await import("../../../src/startup/shutdown.js");
const { createRetryRunner } = await import("../../../src/email/retry.js");
const { InFlightTracker } = await import("../../../src/utils/inFlight.js");
const { isBotHealthy, markBotUnhealthy } = await import("../../../src/telegram/health.js");
const { healthzRoute } = await import("../../../src/http/routes/healthz.js");
const { metricsRegistry, resetMetricsForTests } =
  await import("../../../src/observability/metrics.js");

const bots: Bot[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** One app process: the bot, polling and the shutdown, wired as src/index.ts does. */
function startProcess(
  api: FakeBotApi,
  options: { closeHttp?: () => Promise<void>; deadlineMs?: number } = {},
) {
  let shuttingDown = false;
  const isShuttingDown = () => shuttingDown;
  const bot = createBot("123:test", { isShuttingDown, client: api.client });
  bots.push(bot);
  const startSpy = vi.spyOn(bot, "start");
  const polling = createPollingController({
    bot,
    logger,
    isShuttingDown,
    syncCommands: syncBotCommands,
    restartDelayMs: 50,
  });
  const retryRunner = createRetryRunner(() => Promise.resolve());
  const events: string[] = [];
  const exited = deferred<number>();
  const shutdown = createShutdown(
    {
      begin: () => {
        shuttingDown = true;
        markBotUnhealthy();
        polling.cancelRestart();
        retryRunner.stop();
      },
      stopNotices: () => Promise.resolve(),
      closeHttp: options.closeHttp ?? (() => Promise.resolve()),
      stopBot: () => bot.stop(),
      pollingRun: () => polling.currentRun(),
      retryRun: () => retryRunner.activeRun(),
      pipelines: new InFlightTracker(),
      destroySessionStore: () => {},
      closeDb: () => {
        events.push("db_closed");
        return Promise.resolve();
      },
    },
    {
      logger,
      exit: (code) => {
        events.push(`exit:${code}`);
        exited.resolve(code);
      },
      deadlineMs: options.deadlineMs,
    },
  );
  return { bot, polling, shutdown, events, exited, startSpy };
}

async function healthzStatus(): Promise<number> {
  const app = Fastify();
  healthzRoute(app);
  const res = await app.inject({ method: "GET", url: "/healthz" });
  await app.close();
  return res.statusCode;
}

function handledUpdateIds(): number[] {
  return handlers.listemail.mock.calls.map(([ctx]) => ctx.update.update_id);
}

beforeEach(() => {
  vi.clearAllMocks();
  markBotUnhealthy();
  resetMetricsForTests();
  handlers.listemail.mockImplementation(async (ctx) => {
    await ctx.reply("aliases");
  });
  for (const handler of [handlers.chatMember, handlers.migrateTo, handlers.deleteMeConfirm]) {
    handler.mockResolvedValue(undefined);
  }
});

afterEach(async () => {
  for (const bot of bots.splice(0)) {
    if (bot.isRunning()) await bot.stop().catch(() => {});
  }
});

describe("update gates", () => {
  function initializedBot(api: FakeBotApi, isShuttingDown = () => false) {
    const bot = createBot("123:test", { isShuttingDown, client: api.client });
    bot.botInfo = FAKE_BOT_INFO;
    return bot;
  }
  const minutesAgo = (minutes: number) => Math.floor(Date.now() / 1000) - minutes * 60;

  it("skips, logs and counts a text message older than the threshold", async () => {
    const api = new FakeBotApi();
    const bot = initializedBot(api);
    api.enqueueText("/listemail", 11 * 60);
    const [update] = api.queuedUpdates();

    await bot.handleUpdate(update);

    expect(handlers.listemail).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      { updateId: update.update_id, updateType: "message", ageS: expect.any(Number) as number },
      "telegram.update.stale_skipped",
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("/listemail");
    const metric = await metricsRegistry.getSingleMetricAsString(
      "email_to_telegram_bot_updates_skipped_total",
    );
    expect(metric).toMatch(/\{reason="stale"[^}]*\} 1$/m);
  });

  it("handles a text message inside the threshold", async () => {
    const api = new FakeBotApi();
    const bot = initializedBot(api);
    api.enqueueText("/listemail", 9 * 60);

    await bot.handleUpdate(api.queuedUpdates()[0]);

    expect(handlers.listemail).toHaveBeenCalledOnce();
  });

  it("handles old membership changes, migration service messages and callback queries", async () => {
    const api = new FakeBotApi();
    const bot = initializedBot(api);
    const user = { id: 123, is_bot: false, first_name: "Test" };
    const group = { id: -100, type: "group" as const, title: "Group" };

    await bot.handleUpdate({
      update_id: 1,
      my_chat_member: {
        chat: group,
        from: user,
        date: minutesAgo(120),
        old_chat_member: { status: "left", user: FAKE_BOT_INFO },
        new_chat_member: { status: "member", user: FAKE_BOT_INFO },
      },
    });
    await bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 5,
        date: minutesAgo(120),
        chat: group,
        from: user,
        migrate_to_chat_id: -1001,
      },
    });
    await bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "cb-1",
        from: user,
        chat_instance: "ci",
        data: "delme:c",
        message: { message_id: 6, date: minutesAgo(120), chat: { id: 123, type: "private" } },
      },
    } as never);

    expect(handlers.chatMember).toHaveBeenCalledOnce();
    expect(handlers.migrateTo).toHaveBeenCalledOnce();
    expect(handlers.deleteMeConfirm).toHaveBeenCalledOnce();
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      "telegram.update.stale_skipped",
    );
  });

  it("starts no handler once shutdown has begun", async () => {
    const api = new FakeBotApi();
    const bot = initializedBot(api, () => true);
    api.enqueueText("/listemail");

    await bot.handleUpdate(api.queuedUpdates()[0]);
    await bot.handleUpdate({
      update_id: 99,
      my_chat_member: {
        chat: { id: -100, type: "group", title: "Group" },
        from: { id: 123, is_bot: false, first_name: "Test" },
        date: minutesAgo(0),
        old_chat_member: { status: "left", user: FAKE_BOT_INFO },
        new_chat_member: { status: "member", user: FAKE_BOT_INFO },
      },
    });

    expect(handlers.listemail).not.toHaveBeenCalled();
    expect(handlers.chatMember).not.toHaveBeenCalled();
  });

  it('lets a handler go on when Telegram refuses a late callback answer as "query is too old"', async () => {
    const api = new FakeBotApi();
    const bot = initializedBot(api);
    api.respond("answerCallbackQuery", () => ({
      ok: false,
      error_code: 400,
      description:
        "Bad Request: query is too old and response timeout expired or query ID is invalid",
    }));
    const actions: string[] = [];
    handlers.deleteMeConfirm.mockImplementation(async (ctx) => {
      await ctx.answerCallbackQuery();
      actions.push("ran");
    });

    await bot.handleUpdate({
      update_id: 1,
      callback_query: {
        id: "cb-1",
        from: { id: 123, is_bot: false, first_name: "Test" },
        chat_instance: "ci",
        data: "delme:c",
      },
    });

    expect(actions).toEqual(["ran"]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("still fails other errors of answerCallbackQuery", async () => {
    const api = new FakeBotApi();
    const bot = initializedBot(api);
    api.respond("answerCallbackQuery", () => ({
      ok: false,
      error_code: 400,
      description: "Bad Request: something else",
    }));
    handlers.deleteMeConfirm.mockImplementation(async (ctx) => {
      await ctx.answerCallbackQuery();
    });

    await expect(
      bot.handleUpdate({
        update_id: 1,
        callback_query: {
          id: "cb-1",
          from: { id: 123, is_bot: false, first_name: "Test" },
          chat_instance: "ci",
          data: "delme:c",
        },
      }),
    ).rejects.toThrow(/something else/);
  });
});

describe("polling", () => {
  it("handles updates queued before start, without dropping pending updates", async () => {
    const api = new FakeBotApi();
    const updateId = api.enqueueText("/listemail");
    const { polling } = startProcess(api);

    void polling.start();
    await vi.waitFor(() => expect(api.callsTo("sendMessage")).toHaveLength(1));

    expect(handledUpdateIds()).toEqual([updateId]);
    const deleteWebhook = api.callsTo("deleteWebhook");
    expect(deleteWebhook).toHaveLength(1);
    expect(deleteWebhook[0].payload["drop_pending_updates"]).not.toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      { pending_update_count: 1 },
      "telegram.polling.started",
    );
  });

  it("keeps /healthz at 503 while deleteWebhook stalls, and 200 once polling is set up", async () => {
    const api = new FakeBotApi();
    const release = api.hold("deleteWebhook");
    const { polling } = startProcess(api);

    void polling.start();
    await api.waitForCall("deleteWebhook");
    await sleep(20);
    expect(await healthzStatus()).toBe(503);

    release();
    await api.waitForCall("getUpdates");
    expect(await healthzStatus()).toBe(200);
  });

  it("leaves /healthz at 503 when shutdown begins while deleteWebhook stalls", async () => {
    const api = new FakeBotApi();
    // The stalled call succeeds even after grammY aborts it, so onStart runs.
    const release = api.hold("deleteWebhook", { ignoreAbort: true });
    const { polling, shutdown, exited } = startProcess(api);

    void polling.start();
    await api.waitForCall("deleteWebhook");
    const shutdownDone = shutdown("SIGTERM");
    release();
    await shutdownDone;

    expect(await exited.promise).toBe(0);
    expect(isBotHealthy()).toBe(false);
    expect(await healthzStatus()).toBe(503);
  });

  for (const method of ["getMe", "setMyCommands", "getWebhookInfo"]) {
    it(`starts no poller when shutdown begins during ${method}`, async () => {
      const api = new FakeBotApi();
      const queued = [api.enqueueText("/listemail"), api.enqueueText("/listemail")];
      const releaseMethod = api.hold(method);
      const httpClosed = deferred();
      const first = startProcess(api, { closeHttp: () => httpClosed.promise });

      void first.polling.start();
      await api.waitForCall(method);
      const shutdownDone = first.shutdown("SIGTERM");
      releaseMethod();
      await sleep(50);

      // app.close() is still open: the process is shutting down, not gone.
      expect(first.events).toEqual([]);
      expect(first.startSpy).not.toHaveBeenCalled();
      expect(api.callsTo("getUpdates")).toEqual([]);
      expect(await healthzStatus()).toBe(503);

      httpClosed.resolve();
      await shutdownDone;
      expect(first.events).toEqual(["db_closed", "exit:0"]);
      expect(api.callsTo("getUpdates")).toEqual([]);

      const next = startProcess(api);
      void next.polling.start();
      await vi.waitFor(() => expect(handledUpdateIds()).toEqual(queued));
    });
  }
});

describe("shutdown with a Telegram update in progress", () => {
  it("finishes the update in progress, skips the rest of the batch and leaves it queued", async () => {
    const api = new FakeBotApi();
    const [first, second, third] = [
      api.enqueueText("/listemail"),
      api.enqueueText("/listemail"),
      api.enqueueText("/listemail"),
    ];
    const proc = startProcess(api);
    const started = deferred();
    handlers.listemail.mockImplementationOnce(async () => {
      started.resolve();
      await sleep(2_000);
      proc.events.push("handler_done");
    });

    void proc.polling.start();
    await started.promise;
    await proc.shutdown("SIGTERM");

    expect(await proc.exited.promise).toBe(0);
    expect(proc.events).toEqual(["handler_done", "db_closed", "exit:0"]);
    expect(handledUpdateIds()).toEqual([first]);
    const confirm = api.callsTo("getUpdates").at(-1)!;
    expect(confirm.payload).toMatchObject({ offset: first + 1, limit: 1 });
    expect(api.pendingUpdateIds()).toEqual([second, third]);

    const next = startProcess(api);
    void next.polling.start();
    await vi.waitFor(() => expect(handledUpdateIds()).toEqual([first, second, third]));
  }, 10_000);

  it("exits at the deadline when the handler outlives it, and the update is not handled again", async () => {
    const api = new FakeBotApi();
    const updateId = api.enqueueText("/listemail");
    const proc = startProcess(api, { deadlineMs: 300 });
    const started = deferred();
    const handlerDone = deferred();
    handlers.listemail.mockImplementationOnce(async () => {
      started.resolve();
      await sleep(1_000);
      handlerDone.resolve();
    });

    void proc.polling.start();
    await started.promise;
    const startedAt = Date.now();
    void proc.shutdown("SIGTERM");

    expect(await proc.exited.promise).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(900);
    expect(proc.events).toEqual(["exit:1"]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ pending: expect.arrayContaining(["polling_run"]) as string[] }),
      "shutdown.deadline_exceeded",
    );
    await handlerDone.promise;

    const later = api.enqueueText("/listemail");
    const next = startProcess(api);
    void next.polling.start();
    await vi.waitFor(() => expect(handledUpdateIds()).toEqual([updateId, later]));
  }, 10_000);
});
