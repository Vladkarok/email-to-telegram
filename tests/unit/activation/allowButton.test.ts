import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallbackQueryContext, Context } from "grammy";
import { createMockCtx } from "../../helpers/mockContext.js";

vi.mock("../../../src/utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const calls: string[] = [];
const tx = {
  execute: vi.fn(() => {
    calls.push("owner-lock");
    return Promise.resolve(undefined);
  }),
  select: vi.fn(() => ({
    from: () => ({
      where: () => ({
        for: (mode: string) => {
          calls.push(`alias-${mode}`);
          return Promise.resolve(lockedAlias ? [lockedAlias] : []);
        },
      }),
    }),
  })),
  transaction: vi.fn(async (fn: (sp: unknown) => Promise<unknown>) => {
    calls.push("savepoint");
    return fn(tx);
  }),
};
const db = { tx };
vi.mock("../../../src/db/client.js", () => ({ getDb: () => db }));

const mockWithBoundedTransaction = vi.fn(
  (_db: unknown, _bounds: unknown, work: (t: unknown) => Promise<unknown>) => work(tx),
);
vi.mock("../../../src/activation/transaction.js", () => ({
  withBoundedTransaction: (...args: [unknown, unknown, (t: unknown) => Promise<unknown>]) =>
    mockWithBoundedTransaction(...args),
}));

const mockFindAliasById = vi.fn();
vi.mock("../../../src/db/repos/aliases.js", () => ({
  findAliasById: (...args: unknown[]): unknown => {
    calls.push("owner-lookup");
    return mockFindAliasById(...args);
  },
}));
const mockConsume = vi.fn();
vi.mock("../../../src/db/repos/aliasActivation.js", () => ({
  consumeActivationToken: (...args: unknown[]): unknown => {
    calls.push("consume");
    return mockConsume(...args);
  },
}));
const mockInsertAllowRule = vi.fn();
vi.mock("../../../src/telegram/commands/allow.js", () => ({
  insertAllowRule: (...args: unknown[]): unknown => {
    calls.push("insert");
    return mockInsertAllowRule(...args);
  },
}));
const mockAssertAliasAccess = vi.fn();
vi.mock("../../../src/telegram/middleware/authorization.js", () => ({
  assertAliasAccess: (...args: unknown[]): unknown => mockAssertAliasAccess(...args),
}));
const mockSendAllowRulesMenu = vi.fn();
vi.mock("../../../src/telegram/menu/allowRulesMenu.js", () => ({
  sendAllowRulesMenu: (...args: unknown[]): unknown => mockSendAllowRulesMenu(...args),
}));
vi.mock("../../../src/db/repos/users.js", () => ({
  findUserById: vi.fn().mockResolvedValue({ locale: "en" }),
}));

const { activationAllowCallback, activationRulesCallback } =
  await import("../../../src/activation/allowButton.js");
const { CB_ACTIVATION_RULES } = await import("../../../src/telegram/callbacks.js");
const { NOTICE_BOUNDS } = await import("../../../src/activation/bounds.js");
const { metricsRegistry, resetMetricsForTests } =
  await import("../../../src/observability/metrics.js");

const ALIAS_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "AbCdEfGhIjKlMnOpQrSt_-";
const OWNER = 123456789n;

let lockedAlias: Record<string, unknown> | null;

function alias(overrides: Record<string, unknown> = {}) {
  return {
    id: ALIAS_ID,
    localPart: "inbox",
    fullAddress: "inbox@mail.example.com",
    createdBy: OWNER,
    chatId: OWNER,
    routingVersion: 2,
    status: "active",
    ...overrides,
  };
}

function ctx() {
  const c = createMockCtx({ chatType: "private" }) as ReturnType<typeof createMockCtx> & {
    editMessageReplyMarkup: ReturnType<typeof vi.fn>;
  };
  (c as unknown as { match: string[] }).match = [`rn:${ALIAS_ID}:${TOKEN}`, ALIAS_ID, TOKEN];
  c.editMessageReplyMarkup = vi.fn().mockResolvedValue(true);
  return c;
}

async function tap(c = ctx(), bounds = NOTICE_BOUNDS) {
  await activationAllowCallback(c as unknown as CallbackQueryContext<Context>, bounds);
  return c;
}

async function allowCount(result: string): Promise<number> {
  const text = await metricsRegistry.getSingleMetricAsString(
    "email_to_telegram_activation_allows_total",
  );
  const line = text.split("\n").find((l) => l.includes(`result="${result}"`));
  return Number(line?.split(" ").pop() ?? NaN);
}

describe("one-tap allow button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    resetMetricsForTests();
    lockedAlias = alias();
    mockFindAliasById.mockResolvedValue(alias());
    mockAssertAliasAccess.mockResolvedValue(true);
    mockConsume.mockResolvedValue({ domain: "github.com", chatId: OWNER, routingVersion: 2 });
    mockInsertAllowRule.mockResolvedValue({ kind: "added" });
    mockSendAllowRulesMenu.mockResolvedValue(undefined);
  });

  it("checks fresh access first, then in one bounded transaction reads the owner, locks owner and alias, spends the token, inserts in a savepoint", async () => {
    const c = await tap();

    expect(mockAssertAliasAccess).toHaveBeenCalledWith(c, ALIAS_ID, { fresh: true });
    expect(mockAssertAliasAccess.mock.invocationCallOrder[0]).toBeLessThan(
      mockWithBoundedTransaction.mock.invocationCallOrder[0],
    );
    expect(mockWithBoundedTransaction).toHaveBeenCalledTimes(1);
    expect(mockWithBoundedTransaction).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ statementTimeout: "5s", lockTimeout: "2s" }),
      expect.any(Function),
    );
    expect(calls).toEqual([
      "owner-lookup",
      "owner-lock",
      "alias-update",
      "consume",
      "savepoint",
      "insert",
    ]);
    // The owner lookup runs on the transaction, not the pool.
    expect(mockFindAliasById).toHaveBeenCalledWith(tx, ALIAS_ID);
    expect(mockConsume).toHaveBeenCalledWith(tx, { aliasId: ALIAS_ID, token: TOKEN });
    expect(mockInsertAllowRule).toHaveBeenCalledWith(tx, {
      aliasId: ALIAS_ID,
      ownerId: OWNER,
      rule: { matchType: "domain", normalized: "github.com" },
      expected: { chatId: OWNER, routingVersion: 2 },
    });
    expect(c.reply).toHaveBeenCalledWith(
      "Added an allow rule for <code>inbox@mail.example.com</code>: <code>github.com</code>. It allows every address at <code>github.com</code>.",
      { parse_mode: "HTML" },
    );
    // The spent one-tap button leaves the notice; "Allow rules" stays, and
    // still opens the menu as a new message.
    const markup = c.editMessageReplyMarkup.mock.calls[0][0] as {
      reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    };
    expect(markup.reply_markup.inline_keyboard.flat()).toEqual([
      { text: "📋 Allow Rules", callback_data: CB_ACTIVATION_RULES.build(ALIAS_ID) },
    ]);
    expect(mockSendAllowRulesMenu).not.toHaveBeenCalled();
    expect(await allowCount("added")).toBe(1);
  });

  it("a de-admined user cannot use the button: nothing is read or spent", async () => {
    mockAssertAliasAccess.mockResolvedValue(false);
    const c = await tap();
    expect(mockFindAliasById).not.toHaveBeenCalled();
    expect(mockWithBoundedTransaction).not.toHaveBeenCalled();
    expect(c.reply).not.toHaveBeenCalled();
  });

  it("an access check that does not answer in time denies", async () => {
    mockAssertAliasAccess.mockReturnValue(new Promise(() => {}));
    const c = await tap(ctx(), { ...NOTICE_BOUNDS, buttonAccessCheckTimeoutMs: 10 });
    expect(c.answerCallbackQuery).toHaveBeenCalledWith("⛔ Access denied.");
    expect(mockWithBoundedTransaction).not.toHaveBeenCalled();
  });

  it("an access check that throws denies", async () => {
    mockAssertAliasAccess.mockRejectedValue(new Error("telegram down"));
    await tap();
    expect(mockWithBoundedTransaction).not.toHaveBeenCalled();
  });

  it("expired (spent, replaced or timed-out token): says so and opens the allow rules", async () => {
    mockConsume.mockResolvedValue(null);
    const c = await tap();
    expect(mockInsertAllowRule).not.toHaveBeenCalled();
    expect(c.reply).toHaveBeenCalledWith("This button has expired.");
    expect(mockSendAllowRulesMenu).toHaveBeenCalledWith(c, db, ALIAS_ID);
    expect(await allowCount("expired")).toBe(1);
  });

  it.each([
    ["moved to another routing version", { routingVersion: 3 }],
    ["moved to another chat", { chatId: -100n }],
    ["paused", { status: "paused" }],
    ["owned by someone else now", { createdBy: 1n }],
  ])("expired when the alias was %s after the claim; the token stays spent", async (_l, change) => {
    lockedAlias = alias(change);
    const c = await tap();
    expect(mockConsume).toHaveBeenCalled();
    expect(mockInsertAllowRule).not.toHaveBeenCalled();
    expect(c.reply).toHaveBeenCalledWith("This button has expired.");
  });

  it("expired when the alias row is gone: no lock taken, nothing spent", async () => {
    mockFindAliasById.mockResolvedValue(null);
    const c = await tap();
    expect(calls).toEqual(["owner-lookup"]);
    expect(c.reply).toHaveBeenCalledWith("This button has expired.");
  });

  it("expired when the claim stored no usable domain", async () => {
    mockConsume.mockResolvedValue({ domain: null, chatId: OWNER, routingVersion: 2 });
    await tap();
    expect(mockInsertAllowRule).not.toHaveBeenCalled();
  });

  it("a failed insert spends the button, says so and opens the allow rules", async () => {
    mockInsertAllowRule.mockRejectedValue(new Error("db error"));
    const c = await tap();
    expect(c.reply).toHaveBeenCalledWith(
      "Could not allow <code>github.com</code> for <code>inbox@mail.example.com</code>.",
      { parse_mode: "HTML" },
    );
    expect(mockSendAllowRulesMenu).toHaveBeenCalled();
    expect(c.editMessageReplyMarkup).toHaveBeenCalled();
    expect(await allowCount("failed")).toBe(1);
  });

  it("the rule limit spends the button too", async () => {
    mockInsertAllowRule.mockResolvedValue({
      kind: "limit",
      limit: { ok: false, code: "allow_rule_limit", limit: 10, used: 10 },
    });
    const c = await tap();
    expect(c.reply).toHaveBeenCalledWith(
      "Could not allow <code>github.com</code> for <code>inbox@mail.example.com</code>: the limit of 10 allow rules is reached.",
      { parse_mode: "HTML" },
    );
    expect(mockSendAllowRulesMenu).toHaveBeenCalled();
    expect(await allowCount("failed")).toBe(1);
  });

  it("an inactive hosted account is a plain failure", async () => {
    mockInsertAllowRule.mockResolvedValue({
      kind: "limit",
      limit: { ok: false, code: "subscription_inactive" },
    });
    const c = await tap();
    expect(c.reply).toHaveBeenCalledWith(
      "Could not allow <code>github.com</code> for <code>inbox@mail.example.com</code>.",
      { parse_mode: "HTML" },
    );
  });

  it("an existing rule counts as added", async () => {
    mockInsertAllowRule.mockResolvedValue({ kind: "duplicate" });
    const c = await tap();
    expect(c.reply).toHaveBeenCalledWith(
      "<code>inbox@mail.example.com</code> already has an allow rule for <code>github.com</code>. It allows every address at <code>github.com</code>.",
      { parse_mode: "HTML" },
    );
    expect(await allowCount("added")).toBe(1);
  });

  it("a failed transaction (or commit) keeps the button: a toast, no replies, button untouched", async () => {
    mockWithBoundedTransaction.mockRejectedValueOnce(new Error("commit failed"));
    const c = await tap();
    expect(c.answerCallbackQuery).toHaveBeenCalledWith("Could not add the rule. Try again.");
    expect(c.reply).not.toHaveBeenCalled();
    expect(c.editMessageReplyMarkup).not.toHaveBeenCalled();
    expect(await allowCount("failed")).toBe(1);
  });
});

describe("the notice's allow-rules button", () => {
  function rulesCtx() {
    const c = ctx();
    (c as unknown as { match: string[] }).match = [CB_ACTIVATION_RULES.build(ALIAS_ID), ALIAS_ID];
    return c;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAliasAccess.mockResolvedValue(true);
    mockSendAllowRulesMenu.mockResolvedValue(undefined);
  });

  it("opens the menu as a new message and leaves the notice and its one-tap alone", async () => {
    const c = rulesCtx();
    await activationRulesCallback(c as unknown as CallbackQueryContext<Context>);
    expect(mockAssertAliasAccess).toHaveBeenCalledWith(c, ALIAS_ID);
    expect(c.answerCallbackQuery).toHaveBeenCalled();
    expect(mockSendAllowRulesMenu).toHaveBeenCalledWith(c, db, ALIAS_ID);
    expect(c.editMessageText).not.toHaveBeenCalled();
    expect(c.editMessageReplyMarkup).not.toHaveBeenCalled();
    expect(mockWithBoundedTransaction).not.toHaveBeenCalled();
  });

  it("opens nothing for someone who cannot manage the alias", async () => {
    mockAssertAliasAccess.mockResolvedValue(false);
    const c = rulesCtx();
    await activationRulesCallback(c as unknown as CallbackQueryContext<Context>);
    expect(mockSendAllowRulesMenu).not.toHaveBeenCalled();
  });

  it("has callback data distinct from the alias menu's own button", () => {
    expect(CB_ACTIVATION_RULES.build(ALIAS_ID)).toBe(`rl:${ALIAS_ID}`);
    expect(CB_ACTIVATION_RULES.pattern.test(`al:${ALIAS_ID}`)).toBe(false);
  });
});
