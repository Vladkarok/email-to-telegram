import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";
import type { SenderAuthResult } from "../../../src/email/authenticateSender.js";
import type {
  ActivationGateRow,
  ActivationRevalidationRow,
} from "../../../src/db/repos/aliasActivation.js";

vi.mock("../../../src/utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../../src/telegram/api.js", () => ({ getApi: vi.fn(() => null) }));

const mockReadGate = vi.fn();
const mockClaim = vi.fn();
const mockSetDomain = vi.fn();
const mockRevalidate = vi.fn();
const mockAck = vi.fn();
vi.mock("../../../src/db/repos/aliasActivation.js", () => ({
  readActivationGate: (...args: unknown[]): unknown => mockReadGate(...args),
  claimActivationNotice: (...args: unknown[]): unknown => mockClaim(...args),
  setActivationDomain: (...args: unknown[]): unknown => mockSetDomain(...args),
  readActivationRevalidation: (...args: unknown[]): unknown => mockRevalidate(...args),
  recordActivationNoticeSent: (...args: unknown[]): unknown => mockAck(...args),
}));
const mockTransactionBounds = vi.fn();
vi.mock("../../../src/activation/transaction.js", () => ({
  withBoundedTransaction: (db: unknown, bounds: unknown, work: (tx: unknown) => unknown) => {
    mockTransactionBounds(bounds);
    return work(db);
  },
}));

const {
  buildActivationNotice,
  createNoticeRunner,
  generateActivationToken,
  isStillEligible,
  oneTapDomainFor,
  passesActivationGate,
  usableFromDomain,
  admitPreflightNoRules,
  admitRawSenderRejection,
  setActivationNoticeQueue,
  getActivationNoticeQueue,
  shutdownActivationNotices,
} = await import("../../../src/activation/notice.js");
const { ActivationNoticeQueue } = await import("../../../src/activation/noticeQueue.js");
const { NOTICE_BOUNDS } = await import("../../../src/activation/bounds.js");
const { CB_ACTIVATION_ALLOW, CB_ALLOW_RULES } = await import("../../../src/telegram/callbacks.js");
const { getMessages } = await import("../../../src/i18n/index.js");
const { metricsRegistry, resetMetricsForTests } =
  await import("../../../src/observability/metrics.js");

const ALIAS_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "AbCdEfGhIjKlMnOpQrSt_-";
const OWNER = 42n;

function gateRow(overrides: Partial<ActivationGateRow> = {}): ActivationGateRow {
  return {
    aliasId: ALIAS_ID,
    status: "active",
    ownerId: OWNER,
    chatId: OWNER,
    routingVersion: 3,
    recentlyCreated: true,
    working: false,
    ownerNeverAccepted: false,
    ...overrides,
  };
}

function revalidation(
  overrides: Partial<ActivationRevalidationRow> = {},
): ActivationRevalidationRow {
  return {
    status: "active",
    ownerId: OWNER,
    chatId: OWNER,
    routingVersion: 3,
    fullAddress: "inbox@mail.example.com",
    ownerLocale: "en",
    token: TOKEN,
    domain: null,
    working: false,
    ...overrides,
  };
}

function pass(domain = "github.com"): SenderAuthResult {
  return {
    headerFromEmail: `noreply@${domain}`,
    headerFromDomain: domain,
    dkimPassDomains: [domain],
    dmarcPass: true,
    authenticatedDomains: [domain],
    status: "pass",
    reason: "authenticated",
  };
}

interface Sent {
  chatId: string;
  text: string;
  buttons: Array<{ text: string; callback_data: string }>;
  options: Record<string, unknown>;
  signal: unknown;
}

function makeApi(impl?: () => Promise<unknown>) {
  const sent: Sent[] = [];
  const sendMessage = vi.fn(
    async (chatId: string, text: string, options: Record<string, unknown>, signal: unknown) => {
      if (impl) await impl();
      const markup = options["reply_markup"] as {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
      };
      sent.push({ chatId, text, buttons: markup.inline_keyboard.flat(), options, signal });
      return { message_id: 1 };
    },
  );
  return { api: { sendMessage } as unknown as Api, sendMessage, sent };
}

async function run(
  request: Parameters<InstanceType<typeof ActivationNoticeQueue>["admit"]>[0],
  opts: {
    api?: Api | null;
    authenticate?: (raw: Buffer, envelopeFrom: string | null) => Promise<SenderAuthResult>;
    bounds?: Partial<typeof NOTICE_BOUNDS>;
  } = {},
) {
  const bounds = { ...NOTICE_BOUNDS, ...opts.bounds };
  const runner = createNoticeRunner({
    getDb: () => ({}) as never,
    getApi: () => (opts.api === undefined ? null : opts.api),
    authenticate: opts.authenticate ?? (() => Promise.resolve(pass())),
    generateToken: () => TOKEN,
    bounds,
  });
  const queue = new ActivationNoticeQueue(runner, bounds);
  queue.admit(request);
  await queue.whenIdle();
}

function rawRequest(overrides: Record<string, unknown> = {}) {
  return {
    stage: "raw" as const,
    aliasId: ALIAS_ID,
    headerFromDomain: "github.com",
    envelopeFrom: "bounce@github.com",
    rawMime: Buffer.from("From: noreply@github.com\r\n\r\nbody"),
    ...overrides,
  };
}

async function noticeCount(stage: string, result: string): Promise<number> {
  const text = await metricsRegistry.getSingleMetricAsString(
    "email_to_telegram_activation_notices_total",
  );
  const line = text
    .split("\n")
    .find((l) => l.includes(`stage="${stage}"`) && l.includes(`result="${result}"`));
  return Number(line?.split(" ").pop() ?? NaN);
}

describe("policy", () => {
  it("gate: active, not working, and new or owned by someone who never had mail accepted", () => {
    expect(passesActivationGate(gateRow())).toBe(true);
    expect(
      passesActivationGate(gateRow({ recentlyCreated: false, ownerNeverAccepted: true })),
    ).toBe(true);
    expect(passesActivationGate(gateRow({ recentlyCreated: false }))).toBe(false);
    expect(passesActivationGate(gateRow({ working: true }))).toBe(false);
    expect(passesActivationGate(gateRow({ status: "paused" }))).toBe(false);
    expect(passesActivationGate(gateRow({ status: "deleted", ownerNeverAccepted: true }))).toBe(
      false,
    );
  });

  it("usable From domain: a valid ASCII domain, lowercased", () => {
    expect(usableFromDomain("GitHub.COM")).toBe("github.com");
    expect(usableFromDomain("mail.github.com")).toBe("mail.github.com");
    expect(usableFromDomain("localhost")).toBeNull();
    expect(usableFromDomain("bücher.de")).toBeNull();
    expect(usableFromDomain("a@b.com")).toBeNull();
    expect(usableFromDomain("")).toBeNull();
    expect(usableFromDomain(null)).toBeNull();
    expect(usableFromDomain(`${"a".repeat(250)}.com`)).toBeNull();
  });

  it("one-tap only on an authenticated pass of exactly the header From domain", () => {
    expect(oneTapDomainFor(pass(), "github.com")).toBe("github.com");
    expect(oneTapDomainFor(pass(), "GitHub.com")).toBe("github.com");
    expect(oneTapDomainFor({ ...pass(), status: "fail" }, "github.com")).toBeNull();
    expect(oneTapDomainFor({ ...pass(), status: "temperror" }, "github.com")).toBeNull();
    expect(oneTapDomainFor({ ...pass(), authenticatedDomains: [] }, "github.com")).toBeNull();
    expect(
      oneTapDomainFor({ ...pass(), authenticatedDomains: ["example.org"] }, "github.com"),
    ).toBeNull();
    expect(oneTapDomainFor(pass("example.org"), "github.com")).toBeNull();
  });

  it("revalidation: same alias state, same token, still not working", () => {
    const claim = { token: TOKEN, gate: gateRow() };
    expect(isStillEligible(revalidation(), claim)).toBe(true);
    expect(isStillEligible(null, claim)).toBe(false);
    expect(isStillEligible(revalidation({ status: "paused" }), claim)).toBe(false);
    expect(isStillEligible(revalidation({ ownerId: 43n }), claim)).toBe(false);
    expect(isStillEligible(revalidation({ chatId: -100n }), claim)).toBe(false);
    expect(isStillEligible(revalidation({ routingVersion: 4 }), claim)).toBe(false);
    expect(isStillEligible(revalidation({ token: null }), claim)).toBe(false);
    expect(isStillEligible(revalidation({ token: "other" }), claim)).toBe(false);
    expect(isStillEligible(revalidation({ working: true }), claim)).toBe(false);
  });

  it("tokens are 22 base64url characters and the button data fits 64 bytes", () => {
    const token = generateActivationToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const data = CB_ACTIVATION_ALLOW.build(ALIAS_ID, token);
    expect(Buffer.byteLength(data)).toBe(62);
    expect(CB_ACTIVATION_ALLOW.pattern.exec(data)?.slice(1)).toEqual([ALIAS_ID, token]);
    expect(CB_ACTIVATION_ALLOW.pattern.test(`rn:${ALIAS_ID}:${token}:x`)).toBe(false);
  });
});

describe("copy", () => {
  const en = getMessages("en");

  it("scenario 1: domain, From-line hint, one-tap and allow-rules buttons", () => {
    const notice = buildActivationNotice(en, {
      stage: "raw",
      aliasId: ALIAS_ID,
      address: "inbox@mail.example.com",
      fromDomain: "github.com",
      oneTap: { domain: "github.com", token: TOKEN },
    });
    expect(notice.text).toBe(
      "Mail to <code>inbox@mail.example.com</code> from github.com bounced: no allow rule matches it. A rule matches the address in the email's From line.",
    );
    expect(notice.keyboard.inline_keyboard).toEqual([
      [{ text: "Allow github.com", callback_data: CB_ACTIVATION_ALLOW.build(ALIAS_ID, TOKEN) }],
      [{ text: "📋 Allow Rules", callback_data: CB_ALLOW_RULES.build(ALIAS_ID) }],
    ]);
  });

  it("scenario 2: same text without the one-tap", () => {
    const notice = buildActivationNotice(en, {
      stage: "raw",
      aliasId: ALIAS_ID,
      address: "inbox@mail.example.com",
      fromDomain: "github.com",
      oneTap: null,
    });
    expect(notice.text).toContain("from github.com bounced");
    expect(notice.keyboard.inline_keyboard).toEqual([
      [{ text: "📋 Allow Rules", callback_data: CB_ALLOW_RULES.build(ALIAS_ID) }],
    ]);
  });

  it("scenario 3: no usable From", () => {
    const notice = buildActivationNotice(en, {
      stage: "raw",
      aliasId: ALIAS_ID,
      address: "inbox@mail.example.com",
      fromDomain: null,
      oneTap: null,
    });
    expect(notice.text).toBe(
      "Mail to <code>inbox@mail.example.com</code> bounced: no allow rule matches its sender.",
    );
  });

  it("scenario 4: preflight, no rules", () => {
    const notice = buildActivationNotice(en, {
      stage: "preflight",
      aliasId: ALIAS_ID,
      address: "inbox@mail.example.com",
      fromDomain: "ignored.example",
      oneTap: null,
    });
    expect(notice.text).toBe(
      "Mail to <code>inbox@mail.example.com</code> bounced: this alias has no allow rules yet.",
    );
  });

  it("escapes the address and the domain", () => {
    const notice = buildActivationNotice(en, {
      stage: "raw",
      aliasId: ALIAS_ID,
      address: "a<b>@x",
      fromDomain: "x<y>",
      oneTap: null,
    });
    expect(notice.text).toContain("<code>a&lt;b&gt;@x</code>");
    expect(notice.text).toContain("from x&lt;y&gt; bounced");
  });

  it("has every string in all four locales, without decorative emoji", () => {
    for (const locale of ["en", "uk", "fr", "it"] as const) {
      const m = getMessages(locale).activationNotice;
      const strings = [
        m.bouncedFromDomain("a@b.c", "d.e"),
        m.bouncedNoSender("a@b.c"),
        m.bouncedNoRules("a@b.c"),
        m.allowDomainButton("d.e"),
        m.added("a@b.c", "d.e"),
        m.alreadyAllowed("a@b.c", "d.e"),
        m.expired,
        m.ruleLimit("a@b.c", "d.e", 10),
        m.addFailed("a@b.c", "d.e"),
        m.tryAgainToast,
      ];
      for (const text of strings) {
        expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      }
      expect(m.bouncedFromDomain("a@b.c", "d.e")).toContain("d.e");
      expect(m.added("a@b.c", "d.e")).toContain("d.e");
    }
  });
});

describe("runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMetricsForTests();
    mockReadGate.mockResolvedValue(gateRow());
    mockClaim.mockResolvedValue(true);
    mockSetDomain.mockResolvedValue(true);
    mockRevalidate.mockResolvedValue(revalidation({ domain: "github.com" }));
    mockAck.mockResolvedValue(undefined);
  });

  it("claims with the gate's routing snapshot, then sends with the one-tap on a pass", async () => {
    const { api, sent } = makeApi();
    const authenticate = vi.fn(() => Promise.resolve(pass()));
    await run(rawRequest(), { api, authenticate });

    expect(mockClaim).toHaveBeenCalledWith(expect.anything(), {
      aliasId: ALIAS_ID,
      token: TOKEN,
      chatId: OWNER,
      routingVersion: 3,
    });
    expect(authenticate).toHaveBeenCalledWith(expect.any(Buffer), "bounce@github.com");
    expect(mockSetDomain).toHaveBeenCalledWith(expect.anything(), {
      aliasId: ALIAS_ID,
      token: TOKEN,
      domain: "github.com",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe("42");
    expect(sent[0].options).toMatchObject({
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    expect(sent[0].signal).toBeInstanceOf(AbortSignal);
    expect(sent[0].buttons.map((b) => b.text)).toEqual(["Allow github.com", "📋 Allow Rules"]);
    expect(mockAck).toHaveBeenCalledWith(expect.anything(), ALIAS_ID);
    expect(mockTransactionBounds).toHaveBeenCalledWith(
      expect.objectContaining({ statementTimeout: "5s", lockTimeout: "2s" }),
    );
    expect(await noticeCount("raw", "sent")).toBe(1);
  });

  it("authentication failure: text names the domain, no one-tap, nothing stored", async () => {
    const { api, sent } = makeApi();
    mockRevalidate.mockResolvedValue(revalidation());
    await run(rawRequest(), {
      api,
      authenticate: () => Promise.resolve({ ...pass(), status: "fail", authenticatedDomains: [] }),
    });
    expect(mockSetDomain).not.toHaveBeenCalled();
    expect(sent[0].text).toContain("from github.com bounced");
    expect(sent[0].buttons.map((b) => b.text)).toEqual(["📋 Allow Rules"]);
  });

  it("authentication that cannot run in time: notice without one-tap", async () => {
    const { api, sent } = makeApi();
    mockRevalidate.mockResolvedValue(revalidation());
    await run(rawRequest(), {
      api,
      bounds: { authenticationBudgetMs: 10 },
      authenticate: () => new Promise((resolve) => setTimeout(() => resolve(pass()), 60)),
    });
    expect(mockSetDomain).not.toHaveBeenCalled();
    expect(sent[0].text).toContain("from github.com bounced");
    expect(sent[0].buttons).toHaveLength(1);
  });

  it("MIME too large to hold: no authentication, notice without one-tap", async () => {
    const { api, sent } = makeApi();
    mockRevalidate.mockResolvedValue(revalidation());
    const authenticate = vi.fn(() => Promise.resolve(pass()));
    await run(rawRequest({ rawMime: Buffer.alloc(16) }), {
      api,
      authenticate,
      bounds: { maxHeldMimeBytes: 8 },
    });
    expect(authenticate).not.toHaveBeenCalled();
    expect(sent[0].text).toContain("from github.com bounced");
    expect(sent[0].buttons).toHaveLength(1);
  });

  it("no usable From: domainless notice, no authentication", async () => {
    const { api, sent } = makeApi();
    mockRevalidate.mockResolvedValue(revalidation());
    const authenticate = vi.fn(() => Promise.resolve(pass()));
    await run(rawRequest({ headerFromDomain: null }), { api, authenticate });
    expect(authenticate).not.toHaveBeenCalled();
    expect(sent[0].text).toContain("no allow rule matches its sender");
  });

  it("preflight: no-rules notice", async () => {
    const { api, sent } = makeApi();
    mockRevalidate.mockResolvedValue(revalidation());
    await run(
      {
        stage: "preflight",
        aliasId: ALIAS_ID,
        headerFromDomain: null,
        envelopeFrom: null,
        rawMime: null,
      },
      { api },
    );
    expect(sent[0].text).toContain("this alias has no allow rules yet");
    expect(await noticeCount("preflight", "sent")).toBe(1);
  });

  it("uses the owner's language", async () => {
    const { api, sent } = makeApi();
    mockRevalidate.mockResolvedValue(revalidation({ ownerLocale: "uk", domain: "github.com" }));
    await run(rawRequest(), { api });
    expect(sent[0].text).toBe(
      getMessages("uk").activationNotice.bouncedFromDomain("inbox@mail.example.com", "github.com"),
    );
    expect(sent[0].buttons[0].text).toBe("Дозволити github.com");
  });

  it("gated: no claim, no send", async () => {
    const { api, sendMessage } = makeApi();
    mockReadGate.mockResolvedValue(gateRow({ working: true }));
    await run(rawRequest(), { api });
    expect(mockClaim).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await noticeCount("raw", "gated")).toBe(1);
  });

  it("a missing alias is gated too", async () => {
    mockReadGate.mockResolvedValue(null);
    await run(rawRequest(), { api: makeApi().api });
    expect(mockClaim).not.toHaveBeenCalled();
    expect(await noticeCount("raw", "gated")).toBe(1);
  });

  it("a gate error means no notice", async () => {
    const { api, sendMessage } = makeApi();
    mockReadGate.mockRejectedValue(new Error("statement timeout"));
    await run(rawRequest(), { api });
    expect(mockClaim).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await noticeCount("raw", "failed")).toBe(1);
  });

  it("not claimed: no authentication, no send", async () => {
    const { api, sendMessage } = makeApi();
    const authenticate = vi.fn(() => Promise.resolve(pass()));
    mockClaim.mockResolvedValue(false);
    await run(rawRequest(), { api, authenticate });
    expect(authenticate).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await noticeCount("raw", "not_claimed")).toBe(1);
  });

  it.each([
    ["the alias was paused", { status: "paused" }],
    ["the alias moved", { routingVersion: 4 }],
    ["the owner changed", { ownerId: 99n }],
    ["a newer claim replaced the token", { token: "ZZZZZZZZZZZZZZZZZZZZZZ" }],
    ["the token was spent", { token: null }],
    ["the alias delivered meanwhile", { working: true }],
  ])("stale when %s: no send", async (_label, change) => {
    const { api, sendMessage } = makeApi();
    mockRevalidate.mockResolvedValue(revalidation(change as Partial<ActivationRevalidationRow>));
    await run(rawRequest(), { api });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await noticeCount("raw", "stale")).toBe(1);
  });

  it("a failed domain write still sends, without the one-tap", async () => {
    const { api, sent } = makeApi();
    mockSetDomain.mockRejectedValue(new Error("lock timeout"));
    mockRevalidate.mockResolvedValue(revalidation());
    await run(rawRequest(), { api });
    expect(sent).toHaveLength(1);
    expect(sent[0].buttons).toHaveLength(1);
  });

  it("a send failure is failed and records no acknowledgement", async () => {
    const { api } = makeApi(() => Promise.reject(new Error("Forbidden")));
    await run(rawRequest(), { api });
    expect(mockAck).not.toHaveBeenCalled();
    expect(await noticeCount("raw", "failed")).toBe(1);
  });

  it("a failed acknowledgement does not turn a sent notice into a failure", async () => {
    const { api, sent } = makeApi();
    mockAck.mockRejectedValue(new Error("db down"));
    await run(rawRequest(), { api });
    expect(sent).toHaveLength(1);
    expect(await noticeCount("raw", "sent")).toBe(1);
  });

  it("without a Telegram API there is nothing to send", async () => {
    await run(rawRequest(), { api: null });
    expect(await noticeCount("raw", "failed")).toBe(1);
  });
});

describe("process-wide admission", () => {
  beforeEach(() => {
    resetMetricsForTests();
  });

  it("routes raw and preflight bounces to the queue with only what the job needs", () => {
    const admit = vi.fn(() => true);
    setActivationNoticeQueue({ admit } as unknown as InstanceType<typeof ActivationNoticeQueue>);
    const raw = Buffer.from("x");
    admitRawSenderRejection({
      aliasId: ALIAS_ID,
      headerFromDomain: "GitHub.com",
      envelopeFrom: "b@github.com",
      rawMime: raw,
    });
    admitRawSenderRejection({
      aliasId: ALIAS_ID,
      headerFromDomain: "not a domain",
      envelopeFrom: null,
      rawMime: raw,
    });
    admitPreflightNoRules(ALIAS_ID);
    expect(admit.mock.calls).toEqual([
      [
        {
          stage: "raw",
          aliasId: ALIAS_ID,
          headerFromDomain: "github.com",
          envelopeFrom: "b@github.com",
          rawMime: raw,
        },
      ],
      [
        {
          stage: "raw",
          aliasId: ALIAS_ID,
          headerFromDomain: null,
          envelopeFrom: null,
          rawMime: raw,
        },
      ],
      [
        {
          stage: "preflight",
          aliasId: ALIAS_ID,
          headerFromDomain: null,
          envelopeFrom: null,
          rawMime: null,
        },
      ],
    ]);
    setActivationNoticeQueue(null);
  });

  it("never throws, even when the queue does", () => {
    setActivationNoticeQueue({
      admit: () => {
        throw new Error("boom");
      },
    } as unknown as InstanceType<typeof ActivationNoticeQueue>);
    expect(() => admitPreflightNoRules(ALIAS_ID)).not.toThrow();
    expect(() =>
      admitRawSenderRejection({
        aliasId: ALIAS_ID,
        headerFromDomain: null,
        envelopeFrom: null,
        rawMime: Buffer.alloc(0),
      }),
    ).not.toThrow();
    setActivationNoticeQueue(null);
  });

  it("creates one queue lazily and shuts it down", async () => {
    setActivationNoticeQueue(null);
    const queue = getActivationNoticeQueue();
    expect(getActivationNoticeQueue()).toBe(queue);
    await shutdownActivationNotices();
    expect(queue.isClosed).toBe(true);
    admitPreflightNoRules(ALIAS_ID);
    expect(await noticeCount("preflight", "dropped")).toBe(1);
    setActivationNoticeQueue(null);
  });
});
