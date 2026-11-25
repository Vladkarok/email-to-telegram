/**
 * One delivery attempt (src/email/deliveryAttempt.ts) against a real Postgres
 * (TEST_DATABASE_URL, see tests/helpers/pgTestDb.ts). Telegram is faked at the
 * sender, the one external dependency; the attempt row, log status, refund,
 * chat-migration repair, first-delivered marker and fallback links are real
 * rows.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GrammyError, type Api } from "grammy";
import type { Logger } from "pino";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../../src/db/schema.js";
import { createPgTestDatabase, hasTestDatabase, type PgTestDatabase } from "../helpers/pgTestDb.js";
import {
  readDeliveryLog,
  seedDeliveryLog,
  seedOwnerAndAlias,
} from "../helpers/deliveryFixtures.js";
import { setLogger } from "../../src/utils/logger.js";
import { metricsRegistry, resetMetricsForTests } from "../../src/observability/metrics.js";
import type { PhotoItem, SendResult, SendPhotosResult } from "../../src/telegram/sender.js";
import { describeSendError, type TelegramSendFailure } from "../../src/telegram/errorClassifier.js";

const mockSendTelegramMessage = vi.fn<(...args: unknown[]) => Promise<SendResult>>();
const mockSendTelegramPhotos = vi.fn<(...args: unknown[]) => Promise<SendPhotosResult>>();
vi.mock("../../src/telegram/sender.js", () => ({
  sendTelegramMessage: (...args: unknown[]) => mockSendTelegramMessage(...args),
  sendTelegramPhotos: (...args: unknown[]) => mockSendTelegramPhotos(...args),
}));

const { runDeliveryAttempt, renderAttemptMessage, ATTEMPT_EVENTS } =
  await import("../../src/email/deliveryAttempt.js");
type AttemptInput = Parameters<typeof runDeliveryAttempt>[2];

const OWNER = 7201n;
const OLD_CHAT = -7201n;
const NEW_CHAT = -1007201n;
const BASE_URL = "https://mail.example.com";
// Accepted in October, failing in November: a refund must hit October.
const RECEIVED_AT = new Date("2026-10-31T23:50:00.000Z");
const ACCEPTED_MONTH = "2026-10";
const CURRENT_MONTH = "2026-11";

function failure(code: number, description: string, migrateToChatId: bigint | null = null) {
  const f: TelegramSendFailure = { code, description, transient: false, migrateToChatId };
  return { ok: false, error: description, failure: f } satisfies SendResult;
}
const RETRYABLE = failure(400, "Bad Request: message is too long");
const BLOCKED = failure(403, "Forbidden: bot was blocked by the user");
// Built from the error grammY actually throws, so the sender -> classifier ->
// repair chain sees the real shape rather than a convenient stand-in.
const MIGRATED_FAILURE = describeSendError(
  new GrammyError(
    "Call to 'sendMessage' failed! (400: Bad Request: group chat was upgraded to a supergroup chat)",
    {
      ok: false,
      error_code: 400,
      description: "Bad Request: group chat was upgraded to a supergroup chat",
      parameters: { migrate_to_chat_id: Number(NEW_CHAT) },
    },
    "sendMessage",
    {},
  ),
);
const MIGRATED = {
  ok: false,
  error: MIGRATED_FAILURE.description,
  failure: MIGRATED_FAILURE,
} satisfies SendResult;

const getChat = vi.fn(() =>
  Promise.resolve({ id: Number(NEW_CHAT), type: "supergroup", title: "Upgraded" }),
);
const fakeApi = { getChat } as unknown as Api;

// Events the modules log through the global logger (refund, repair), in order
// with the hooks' own entries.
const timeline: string[] = [];
const recordEvent = (_fields: unknown, event?: string): void => {
  if (typeof event === "string") timeline.push(event);
};
const globalLogger = {
  info: recordEvent,
  warn: recordEvent,
  error: recordEvent,
  debug: recordEvent,
  child: () => globalLogger,
};
setLogger(globalLogger as unknown as Logger);

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Sum of the series of `name` whose labels include `labels`. */
async function metricValue(name: string, labels: Record<string, string> = {}): Promise<number> {
  const metric = await metricsRegistry.getSingleMetric(name)?.get();
  return (metric?.values ?? [])
    .filter((v) => Object.entries(labels).every(([k, value]) => v.labels[k] === value))
    .reduce((sum, v) => sum + v.value, 0);
}

async function latency(path: string): Promise<{ count: number; sum: number }> {
  const metric = await metricsRegistry
    .getSingleMetric("email_to_telegram_delivery_latency_seconds")
    ?.get();
  const series = (suffix: string): number =>
    metric?.values.find(
      (v) =>
        v.labels["path"] === path && (v as { metricName?: string }).metricName?.endsWith(suffix),
    )?.value ?? 0;
  return { count: series("_count"), sum: series("_sum") };
}

async function latencyCount(path: string): Promise<number> {
  return (await latency(path)).count;
}

describe.skipIf(!hasTestDatabase)("delivery attempt on real Postgres", () => {
  let t: PgTestDatabase;
  let alias: schema.EmailAddress;
  let log: schema.DeliveryLog;
  let logger: ReturnType<typeof fakeLogger>;

  beforeAll(async () => {
    process.env["HMAC_SECRET"] = "hmac-secret-test-32chars-abcdef";
    t = await createPgTestDatabase();
    await t.migrate();
  });

  afterAll(async () => {
    await t?.drop();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSendTelegramMessage.mockReset();
    mockSendTelegramPhotos.mockReset();
    resetMetricsForTests();
    timeline.length = 0;
    mockSendTelegramMessage.mockResolvedValue({ ok: true, telegramMessageId: 42 });
    mockSendTelegramPhotos.mockResolvedValue({ ok: true, failedPhotos: [] });
    alias = await seedOwnerAndAlias(t.db, { owner: OWNER, chatId: OLD_CHAT });
    await t.db.insert(schema.chats).values({ id: OLD_CHAT, title: "Group", type: "group" });
    log = await seedDeliveryLog(t.db, alias, { receivedAt: RECEIVED_AT });
    await t.db.insert(schema.userUsageMonths).values([
      { userId: OWNER, month: ACCEPTED_MONTH, deliveredCount: 1 },
      { userId: OWNER, month: CURRENT_MONTH, deliveredCount: 5 },
    ]);
    logger = fakeLogger();
  });

  async function seedPhoto(name: string): Promise<schema.Attachment> {
    const [row] = await t.db
      .insert(schema.attachments)
      .values({
        deliveryLogId: log.id,
        originalFilename: name,
        contentType: "image/png",
        sizeBytes: 10,
        storagePath: `/data/att/${name}.bin`,
      })
      .returning();
    return row;
  }

  function attempt(overrides: Partial<AttemptInput> = {}): ReturnType<typeof runDeliveryAttempt> {
    return runDeliveryAttempt(t.db, fakeApi, {
      path: "initial",
      log: logger as unknown as Logger,
      deliveryLog: log,
      aliasId: alias.id,
      route: { chatId: OLD_CHAT, threadId: null },
      attemptNo: 1,
      message: { text: "hello", parseMode: undefined, richMessagesEnabled: true },
      privacyMode: false,
      photos: [],
      fallbackAttachments: [],
      publicBaseUrl: BASE_URL,
      attachmentTtlHours: 24,
      failedStatus: (disposition) =>
        disposition === "fail_permanently" ? "permanently_failed" : "failed",
      ...overrides,
    });
  }

  function photoItem(row: schema.Attachment): PhotoItem {
    return {
      id: row.id,
      storagePath: row.storagePath,
      filename: row.originalFilename ?? "attachment",
      encryptionMode: row.encryptionMode,
      wrappedDek: row.wrappedDek,
      kekKeyId: row.kekKeyId,
    };
  }

  function photoInputs(rows: schema.Attachment[]): Partial<AttemptInput> {
    return {
      photos: rows.map(photoItem),
      fallbackAttachments: rows.map((row) => ({
        attachmentId: row.id,
        storagePath: row.storagePath,
        filename: row.originalFilename ?? "attachment",
        sizeBytes: row.sizeBytes ?? 0,
      })),
    };
  }

  async function attemptRows(): Promise<schema.DeliveryAttempt[]> {
    return t.db
      .select()
      .from(schema.deliveryAttempts)
      .where(eq(schema.deliveryAttempts.deliveryLogId, log.id));
  }

  async function usage(month: string): Promise<number> {
    const [row] = await t.db
      .select()
      .from(schema.userUsageMonths)
      .where(
        and(eq(schema.userUsageMonths.userId, OWNER), eq(schema.userUsageMonths.month, month)),
      );
    return row?.deliveredCount ?? 0;
  }

  async function aliasChat(): Promise<bigint> {
    const [row] = await t.db
      .select()
      .from(schema.emailAddresses)
      .where(eq(schema.emailAddresses.id, alias.id));
    return row.chatId;
  }

  async function firstDeliveredAt(): Promise<Date | null> {
    const [row] = await t.db
      .select()
      .from(schema.aliasActivation)
      .where(eq(schema.aliasActivation.aliasId, alias.id));
    return row?.firstDeliveredAt ?? null;
  }

  async function linksFor(attachmentId: string): Promise<number> {
    const rows = await t.db
      .select()
      .from(schema.attachmentLinks)
      .where(eq(schema.attachmentLinks.attachmentId, attachmentId));
    return rows.length;
  }

  it("delivers: one succeeded attempt row, log delivered, marker set, photos reply on the route", async () => {
    const photo = await seedPhoto("cat");
    const afterCommit = vi.fn();

    const result = await attempt({
      ...photoInputs([photo]),
      route: { chatId: OLD_CHAT, threadId: 9n },
      attemptNo: 2,
      afterCommit,
    });

    expect(result).toBe("delivered");
    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(fakeApi, {
      chatId: OLD_CHAT,
      threadId: 9n,
      text: "hello",
      parseMode: undefined,
      richMessagesEnabled: true,
    });
    const [row] = await attemptRows();
    expect(row).toMatchObject({
      attemptNo: 2,
      status: "succeeded",
      targetChatId: OLD_CHAT,
      targetThreadId: 9n,
      telegramMessageId: 42n,
      errorText: null,
      errorClass: null,
    });
    expect((await readDeliveryLog(t.db, log.id)).finalStatus).toBe("delivered");
    expect(await firstDeliveredAt()).toBeInstanceOf(Date);
    expect(mockSendTelegramPhotos).toHaveBeenCalledWith(fakeApi, {
      chatId: OLD_CHAT,
      threadId: 9n,
      replyToMessageId: 42,
      photos: [expect.objectContaining({ id: photo.id, storagePath: photo.storagePath })],
    });
    expect(afterCommit).toHaveBeenCalledWith(
      expect.objectContaining({ attemptNo: 2, status: "delivered", errorClass: null }),
    );
    expect(await latencyCount("initial")).toBe(1);
    expect(await usage(ACCEPTED_MONTH)).toBe(1);
  });

  it("observes latency on the caller's path, from receivedAt to the text's acceptance", async () => {
    const recent = await seedDeliveryLog(t.db, alias, {
      receivedAt: new Date(Date.now() - 5 * 60 * 1000),
    });
    await attempt({ path: "retry", deliveryLog: recent });

    const observed = await latency("retry");
    expect(observed.count).toBe(1);
    expect(observed.sum).toBeGreaterThanOrEqual(300);
    expect(observed.sum).toBeLessThan(330);
    expect(await latencyCount("initial")).toBe(0);
  });

  it("sends no photos in privacy mode", async () => {
    const photo = await seedPhoto("cat");
    expect(await attempt({ ...photoInputs([photo]), privacyMode: true })).toBe("delivered");
    expect(mockSendTelegramPhotos).not.toHaveBeenCalled();
  });

  it("leaves a retryable failure failed, with no loss, refund, marker or photos", async () => {
    mockSendTelegramMessage.mockResolvedValue(RETRYABLE);
    const photo = await seedPhoto("cat");
    const afterFailure = vi.fn();

    const result = await attempt({ ...photoInputs([photo]), afterFailure });

    expect(result).toBe("send_failed");
    const [row] = await attemptRows();
    expect(row).toMatchObject({
      status: "failed",
      errorText: RETRYABLE.error,
      errorClass: "bad_request",
      telegramMessageId: null,
    });
    expect((await readDeliveryLog(t.db, log.id)).finalStatus).toBe("failed");
    expect(afterFailure).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    expect(await metricValue("email_to_telegram_deliveries_lost_total")).toBe(0);
    expect(await usage(ACCEPTED_MONTH)).toBe(1);
    expect(await firstDeliveredAt()).toBeNull();
    expect(mockSendTelegramPhotos).not.toHaveBeenCalled();
    expect(await latencyCount("initial")).toBe(0);
  });

  it("closes a permanent failure, counts it lost and refunds the acceptance month", async () => {
    mockSendTelegramMessage.mockResolvedValue(BLOCKED);

    expect(await attempt()).toBe("send_failed");

    expect((await attemptRows())[0]).toMatchObject({ status: "failed", errorClass: "forbidden" });
    expect((await readDeliveryLog(t.db, log.id)).finalStatus).toBe("permanently_failed");
    expect(await metricValue("email_to_telegram_deliveries_lost_total", { stage: "initial" })).toBe(
      1,
    );
    expect(await usage(ACCEPTED_MONTH)).toBe(0);
    expect(await usage(CURRENT_MONTH)).toBe(5);
  });

  it("lets the caller close a counted failure permanently, under its own loss stage", async () => {
    mockSendTelegramMessage.mockResolvedValue(RETRYABLE);
    const dispositions: string[] = [];

    await attempt({
      path: "retry",
      failedStatus: (disposition) => {
        dispositions.push(disposition);
        return "permanently_failed";
      },
    });

    expect(dispositions).toEqual(["retry_counted"]);
    expect((await readDeliveryLog(t.db, log.id)).finalStatus).toBe("permanently_failed");
    expect(await metricValue("email_to_telegram_deliveries_lost_total", { stage: "retry" })).toBe(
      1,
    );
    expect(await usage(ACCEPTED_MONTH)).toBe(0);
  });

  it("runs afterCommit before the refund and afterFailure after it", async () => {
    mockSendTelegramMessage.mockResolvedValue(BLOCKED);

    await attempt({
      afterCommit: () => timeline.push("afterCommit"),
      afterFailure: () => timeline.push("afterFailure"),
    });

    expect(timeline).toEqual(["afterCommit", "usage.refund.permanent_failure", "afterFailure"]);
  });

  it("repairs a text-phase migration and stays retryable, with no refund", async () => {
    mockSendTelegramMessage.mockResolvedValue(MIGRATED);

    const result = await attempt({
      afterCommit: () => timeline.push("afterCommit"),
      afterFailure: () => timeline.push("afterFailure"),
    });

    expect(result).toBe("send_failed");
    expect((await attemptRows())[0]).toMatchObject({ status: "failed", errorClass: "migrated" });
    expect((await readDeliveryLog(t.db, log.id)).finalStatus).toBe("failed");
    expect(await aliasChat()).toBe(NEW_CHAT);
    expect(timeline).toEqual(["afterCommit", "chat.migrated", "afterFailure"]);
    expect(await usage(ACCEPTED_MONTH)).toBe(1);
  });

  it("logs a failed migration repair and keeps the failure retryable", async () => {
    mockSendTelegramMessage.mockResolvedValue(MIGRATED);
    // The new chat row cannot be written: the title overflows its column.
    getChat.mockResolvedValueOnce({
      id: Number(NEW_CHAT),
      type: "supergroup",
      title: "x".repeat(300),
    });

    expect(await attempt()).toBe("send_failed");

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryLogId: log.id }),
      ATTEMPT_EVENTS.initial.repairFailed,
    );
    expect((await readDeliveryLog(t.db, log.id)).finalStatus).toBe("failed");
    expect(await aliasChat()).toBe(OLD_CHAT);
  });

  it("hands a photo-phase migration back: attempt succeeded, log reopened, repaired, no refund or latency", async () => {
    const photo = await seedPhoto("cat");
    mockSendTelegramPhotos.mockResolvedValue({
      ok: false,
      failedPhotos: [],
      failure: MIGRATED.failure,
    });

    const result = await attempt(photoInputs([photo]));

    expect(result).toBe("chat_migrated");
    expect((await attemptRows())[0]?.status).toBe("succeeded");
    expect((await readDeliveryLog(t.db, log.id)).finalStatus).toBe("failed");
    // The text landed, so the alias is marked working before the attachments.
    expect(await firstDeliveredAt()).toBeInstanceOf(Date);
    expect(await aliasChat()).toBe(NEW_CHAT);
    expect(await usage(ACCEPTED_MONTH)).toBe(1);
    expect(await latencyCount("initial")).toBe(0);
    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { deliveryLogId: log.id, oldChatId: OLD_CHAT.toString() },
      ATTEMPT_EVENTS.initial.abortedForMigration,
    );
  });

  it("hands a fallback-phase migration back the same way", async () => {
    const photo = await seedPhoto("cat");
    mockSendTelegramPhotos.mockResolvedValue({
      ok: false,
      failedPhotos: [photoItem(photo)],
      failure: RETRYABLE.failure,
    });
    mockSendTelegramMessage
      .mockResolvedValueOnce({ ok: true, telegramMessageId: 42 })
      .mockResolvedValueOnce(MIGRATED);

    const result = await attempt({ ...photoInputs([photo]), path: "retry" });

    expect(result).toBe("chat_migrated");
    expect((await attemptRows())[0]?.status).toBe("succeeded");
    expect((await readDeliveryLog(t.db, log.id)).finalStatus).toBe("failed");
    // The text landed, so the alias is marked working before the attachments.
    expect(await firstDeliveredAt()).toBeInstanceOf(Date);
    expect(await aliasChat()).toBe(NEW_CHAT);
    expect(await usage(ACCEPTED_MONTH)).toBe(1);
    expect(await latencyCount("retry")).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      { deliveryLogId: log.id, error: MIGRATED.error },
      ATTEMPT_EVENTS.retry.fallbackFailed,
    );
    expect(
      await metricValue("email_to_telegram_telegram_send_failures_total", {
        error_class: "migrated",
      }),
    ).toBe(1);
  });

  it("sends download links for the photos that failed, and stays delivered", async () => {
    const sent = await seedPhoto("sent");
    const failed = await seedPhoto("failed");
    const inputs = photoInputs([sent, failed]);
    mockSendTelegramPhotos.mockResolvedValue({
      ok: false,
      failedPhotos: [photoItem(failed)],
      failure: RETRYABLE.failure,
    });

    expect(await attempt(inputs)).toBe("delivered");

    expect(await linksFor(failed.id)).toBe(1);
    expect(await linksFor(sent.id)).toBe(0);
    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(2);
    const fallback = mockSendTelegramMessage.mock.calls[1]?.[1] as { text: string; chatId: bigint };
    expect(fallback.chatId).toBe(OLD_CHAT);
    expect(fallback.text).toContain(`failed: ${BASE_URL}/dl/`);
    expect(fallback.text).not.toContain("sent:");
    expect((await readDeliveryLog(t.db, log.id)).finalStatus).toBe("delivered");
    expect(await latencyCount("initial")).toBe(1);
  });

  it("keeps the text delivered when the attachment phase throws", async () => {
    const photo = await seedPhoto("cat");
    mockSendTelegramPhotos.mockRejectedValue(new Error("disk gone"));

    expect(await attempt(photoInputs([photo]))).toBe("delivered");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryLogId: log.id }),
      ATTEMPT_EVENTS.initial.secondaryFailed,
    );
    expect((await readDeliveryLog(t.db, log.id)).finalStatus).toBe("delivered");
  });

  it("swallows a first-delivered marker failure and still sends the photos", async () => {
    const photo = await seedPhoto("cat");
    const missingAlias = "00000000-0000-0000-0000-000000000000";

    expect(await attempt({ ...photoInputs([photo]), aliasId: missingAlias })).toBe("delivered");

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryLogId: log.id, aliasId: missingAlias }),
      ATTEMPT_EVENTS.initial.markerFailed,
    );
    expect(mockSendTelegramPhotos).toHaveBeenCalledTimes(1);
    expect((await readDeliveryLog(t.db, log.id)).finalStatus).toBe("delivered");
  });

  describe("persistence", () => {
    it("retries the attempt-row write without sending again", async () => {
      const spy = vi
        .spyOn(t.db, "transaction")
        .mockRejectedValueOnce(new Error("connection reset"));

      expect(await attempt()).toBe("delivered");

      // Two persistence tries, then the first-delivered marker's own transaction.
      expect(spy).toHaveBeenCalledTimes(3);
      expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
      expect(await attemptRows()).toHaveLength(1);
      expect((await readDeliveryLog(t.db, log.id)).finalStatus).toBe("delivered");
    });

    it("keeps one row per (log, attempt) when a committed write is retried", async () => {
      const original = t.db.transaction.bind(t.db);
      const spy = vi.spyOn(t.db, "transaction").mockImplementationOnce(async (fn) => {
        await original(fn);
        throw new Error("commit acknowledgement lost");
      });

      expect(await attempt()).toBe("delivered");

      expect(spy).toHaveBeenCalledTimes(3);
      expect(await attemptRows()).toHaveLength(1);
    });

    it("writes the attempt row and the status in one transaction", async () => {
      // A deferred trigger fails every commit that inserted an attempt row, so
      // the status write survives only if it ran outside that transaction.
      await t.db.execute(sql`
        create function fail_attempt_commit() returns trigger language plpgsql as $$
        begin raise exception 'commit refused'; end $$`);
      await t.db.execute(sql`
        create constraint trigger fail_attempt_commit after insert on delivery_attempts
        deferrable initially deferred for each row execute function fail_attempt_commit()`);
      try {
        mockSendTelegramMessage.mockResolvedValue(BLOCKED);

        await expect(attempt()).rejects.toThrow("Failed query: commit");

        expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
        expect(await attemptRows()).toHaveLength(0);
        expect((await readDeliveryLog(t.db, log.id)).finalStatus).toBe("processing");
      } finally {
        await t.db.execute(sql`drop trigger fail_attempt_commit on delivery_attempts`);
        await t.db.execute(sql`drop function fail_attempt_commit()`);
      }

      // The other direction: a refused status write takes the attempt row
      // with it, which it cannot if it runs after the row's transaction.
      await t.db.execute(sql`
        create function fail_status_write() returns trigger language plpgsql as $$
        begin raise exception 'status write refused'; end $$`);
      await t.db.execute(sql`
        create trigger fail_status_write before update on delivery_logs
        for each row execute function fail_status_write()`);
      try {
        await expect(attempt()).rejects.toThrow("Failed query: update");

        expect(await attemptRows()).toHaveLength(0);
      } finally {
        await t.db.execute(sql`drop trigger fail_status_write on delivery_logs`);
        await t.db.execute(sql`drop function fail_status_write()`);
      }
      expect((await readDeliveryLog(t.db, log.id)).finalStatus).toBe("processing");
    });

    it.each([
      ["initial", 1],
      ["retry", 0],
    ] as const)(
      "throws on the %s path once every write fails, logging it %i times, after one send",
      async (path, logged) => {
        mockSendTelegramMessage.mockResolvedValue(BLOCKED);
        const spy = vi.spyOn(t.db, "transaction").mockRejectedValue(new Error("db down"));
        const afterCommit = vi.fn();

        await expect(attempt({ path, afterCommit })).rejects.toThrow("db down");

        expect(spy).toHaveBeenCalledTimes(3);
        spy.mockRestore();
        expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
        expect(afterCommit).not.toHaveBeenCalled();
        expect(await firstDeliveredAt()).toBeNull();
        const persistLogs = logger.error.mock.calls.filter(
          ([, event]) => event === "delivery.attempt_log_persist_failed",
        );
        expect(persistLogs).toHaveLength(logged);
        expect((await readDeliveryLog(t.db, log.id)).finalStatus).toBe("processing");
        // A loss is counted, and refunded, only once its status is written.
        expect(await metricValue("email_to_telegram_deliveries_lost_total")).toBe(0);
        expect(await usage(ACCEPTED_MONTH)).toBe(1);
      },
    );
  });

  describe("renderAttemptMessage", () => {
    const parsed = {
      headerFrom: "sender@example.com",
      headerFromDisplay: "sender@example.com",
      subject: "Hi",
      textBody: "Body",
      htmlBody: null,
      attachments: [],
    } as unknown as Parameters<typeof renderAttemptMessage>[1]["parsed"];

    function render(privacyMode: boolean, deliveryLog = log) {
      return renderAttemptMessage(t.db, {
        privacyMode,
        renderMode: "plaintext",
        aliasFullAddress: alias.fullAddress,
        parsed,
        attachmentLinks: [],
        deliveryLog,
        publicBaseUrl: BASE_URL,
        rawEmailTtlHours: 24,
      });
    }

    it("renders the email itself outside privacy mode", async () => {
      const rendered = await render(false);
      expect(rendered.text).toContain("Body");
    });

    it("sends a privacy alert with a view link that expires with the raw email", async () => {
      const rendered = await render(true);
      expect(rendered).toMatchObject({ parseMode: "HTML", richHtml: undefined });
      expect(rendered.text).toContain(`${BASE_URL}/view/`);
      expect(rendered.text).not.toContain("Body");
      const [link] = await t.db
        .select()
        .from(schema.deliveryViewLinks)
        .where(eq(schema.deliveryViewLinks.deliveryLogId, log.id));
      expect(link?.expiresAt.getTime()).toBe(RECEIVED_AT.getTime() + 24 * 60 * 60 * 1000);
    });

    it("refuses privacy mode without a durable raw email", async () => {
      await expect(render(true, { ...log, rawEmailPath: null })).rejects.toThrow(
        "privacy mode requires a durable raw email path",
      );
    });
  });
});
