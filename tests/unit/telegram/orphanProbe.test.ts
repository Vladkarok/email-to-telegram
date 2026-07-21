import { describe, it, expect, vi, beforeEach } from "vitest";
import { GrammyError } from "grammy";
import {
  probeChatReachability,
  invalidateReachabilityCache,
  clearReachabilityCache,
} from "../../../src/telegram/orphanProbe.js";

const BOT_ID = 555;
const CHAT_ID = -100999n;

function apiError(code: number, description: string): GrammyError {
  return new GrammyError(
    `Call to 'getChatMember' failed! (${code}: ${description})`,
    { ok: false, error_code: code, description, parameters: {} },
    "getChatMember",
    {},
  );
}

function makeApi(getChatMember: () => Promise<unknown>) {
  return {
    getMe: vi.fn().mockResolvedValue({ id: BOT_ID }),
    getChatMember: vi.fn(getChatMember),
  } as never;
}

describe("probeChatReachability", () => {
  beforeEach(() => {
    clearReachabilityCache();
    vi.clearAllMocks();
  });

  it.each(["left", "kicked"] as const)(
    "reports dead when the bot's own membership is %s",
    async (status) => {
      const api = makeApi(() => Promise.resolve({ status }));
      await expect(probeChatReachability(api, CHAT_ID)).resolves.toBe("dead");
    },
  );

  it.each(["member", "administrator", "creator", "restricted"] as const)(
    "reports reachable when the bot is still %s",
    async (status) => {
      const api = makeApi(() => Promise.resolve({ status }));
      await expect(probeChatReachability(api, CHAT_ID)).resolves.toBe("reachable");
    },
  );

  it.each([
    ["chat not found", 400],
    ["Forbidden: bot was kicked from the supergroup chat", 403],
    ["Forbidden: the group chat was deactivated", 403],
  ])("reports dead for the definitive error %j", async (description, code) => {
    const api = makeApi(() => Promise.reject(apiError(code, description)));
    await expect(probeChatReachability(api, CHAT_ID)).resolves.toBe("dead");
  });

  it.each([
    ["timeout", new Error("getChatMember timed out")],
    ["network", new Error("fetch failed")],
    ["flood wait", apiError(429, "Too Many Requests: retry after 30")],
    ["server error", apiError(500, "Internal Server Error")],
    ["bad gateway", apiError(502, "Bad Gateway")],
    ["unrecognized", new Error("something inexplicable")],
    // A transport error is not a Bot API verdict, however its message reads.
    [
      "wrapped transport error quoting a definitive phrase",
      new Error("fetch failed: chat not found"),
    ],
    ["transformer error quoting a kick", new Error("proxy error: bot was kicked")],
  ])("reports unknown for the transient failure %s — never dead", async (_name, err) => {
    const api = makeApi(() => Promise.reject(err));
    await expect(probeChatReachability(api, CHAT_ID)).resolves.toBe("unknown");
  });

  it("triggers migration repair rather than declaring a migrated chat dead", async () => {
    const migrate = new GrammyError(
      "Call to 'getChatMember' failed! (400: Bad Request: group chat was upgraded to a supergroup chat)",
      {
        ok: false,
        error_code: 400,
        description: "Bad Request: group chat was upgraded to a supergroup chat",
        parameters: { migrate_to_chat_id: -1002222333444 },
      },
      "getChatMember",
      {},
    );
    const api = makeApi(() => Promise.reject(migrate));
    const onMigrate = vi.fn().mockResolvedValue(undefined);

    const result = await probeChatReachability(api, CHAT_ID, { onMigrate });

    // A migrated chat is alive under a new id — never an orphan.
    expect(result).toBe("unknown");
    expect(onMigrate).toHaveBeenCalledWith(CHAT_ID, -1002222333444n);
  });

  it("caches a result and serves it without re-probing", async () => {
    const api = makeApi(() => Promise.resolve({ status: "kicked" }));

    await probeChatReachability(api, CHAT_ID);
    await probeChatReachability(api, CHAT_ID);

    expect(
      (api as unknown as { getChatMember: ReturnType<typeof vi.fn> }).getChatMember,
    ).toHaveBeenCalledTimes(1);
  });

  it("never caches an unknown result", async () => {
    const api = makeApi(() => Promise.reject(new Error("fetch failed")));

    await probeChatReachability(api, CHAT_ID);
    await probeChatReachability(api, CHAT_ID);

    expect(
      (api as unknown as { getChatMember: ReturnType<typeof vi.fn> }).getChatMember,
    ).toHaveBeenCalledTimes(2);
  });

  it("re-probes fresh when asked, bypassing a cached dead verdict", async () => {
    let status = "kicked";
    const api = makeApi(() => Promise.resolve({ status }));

    await expect(probeChatReachability(api, CHAT_ID)).resolves.toBe("dead");
    status = "member";
    await expect(probeChatReachability(api, CHAT_ID, { fresh: true })).resolves.toBe("reachable");
  });

  it("drops a cached dead verdict when the bot is re-added", async () => {
    let status = "kicked";
    const api = makeApi(() => Promise.resolve({ status }));

    await expect(probeChatReachability(api, CHAT_ID)).resolves.toBe("dead");
    // my_chat_member update arrives: the bot is back in the chat.
    invalidateReachabilityCache(CHAT_ID);
    status = "administrator";

    await expect(probeChatReachability(api, CHAT_ID)).resolves.toBe("reachable");
  });
});
