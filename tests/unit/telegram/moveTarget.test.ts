import { describe, it, expect, vi, beforeEach } from "vitest";
import { canBotSendToChat, canActorUseMoveTarget } from "../../../src/telegram/moveTarget.js";

const BOT_ID = 555;
const ACTOR_ID = 42;

function makeApi(members: Record<string, unknown>) {
  return {
    getMe: vi.fn().mockResolvedValue({ id: BOT_ID }),
    getChatMember: vi.fn((chatId: string | number, userId: number) => {
      const key = `${chatId}:${userId}`;
      const member = members[key];
      if (member === undefined) return Promise.reject(new Error("member not found"));
      if (member instanceof Error) return Promise.reject(member);
      return Promise.resolve(member);
    }),
  } as never;
}

describe("canBotSendToChat — channels", () => {
  it("allows an administrator that can post", async () => {
    const api = makeApi({
      [`-100777:${BOT_ID}`]: { status: "administrator", can_post_messages: true },
    });
    await expect(canBotSendToChat(api, { chatId: -100777n, chatType: "channel" })).resolves.toEqual(
      { ok: true },
    );
  });

  it("denies an administrator without can_post_messages", async () => {
    const api = makeApi({
      [`-100777:${BOT_ID}`]: { status: "administrator", can_post_messages: false },
    });
    await expect(canBotSendToChat(api, { chatId: -100777n, chatType: "channel" })).resolves.toEqual(
      { ok: false, reason: "cannot_post" },
    );
  });

  it("denies a plain member of a channel", async () => {
    const api = makeApi({ [`-100777:${BOT_ID}`]: { status: "member" } });
    await expect(canBotSendToChat(api, { chatId: -100777n, chatType: "channel" })).resolves.toEqual(
      { ok: false, reason: "not_admin" },
    );
  });
});

describe("canBotSendToChat — groups and supergroups", () => {
  it.each(["group", "supergroup"] as const)("allows an administrator in a %s", async (chatType) => {
    const api = makeApi({ [`-100888:${BOT_ID}`]: { status: "administrator" } });
    await expect(canBotSendToChat(api, { chatId: -100888n, chatType })).resolves.toEqual({
      ok: true,
    });
  });

  it("allows a plain member", async () => {
    const api = makeApi({ [`-100888:${BOT_ID}`]: { status: "member" } });
    await expect(
      canBotSendToChat(api, { chatId: -100888n, chatType: "supergroup" }),
    ).resolves.toEqual({ ok: true });
  });

  it("allows a restricted member that is still in the chat and can send", async () => {
    const api = makeApi({
      [`-100888:${BOT_ID}`]: { status: "restricted", is_member: true, can_send_messages: true },
    });
    await expect(
      canBotSendToChat(api, { chatId: -100888n, chatType: "supergroup" }),
    ).resolves.toEqual({ ok: true });
  });

  it("denies a restricted member that cannot send", async () => {
    const api = makeApi({
      [`-100888:${BOT_ID}`]: { status: "restricted", is_member: true, can_send_messages: false },
    });
    await expect(
      canBotSendToChat(api, { chatId: -100888n, chatType: "supergroup" }),
    ).resolves.toEqual({ ok: false, reason: "cannot_send" });
  });

  it("denies a restricted non-member even when can_send_messages is true", async () => {
    const api = makeApi({
      [`-100888:${BOT_ID}`]: { status: "restricted", is_member: false, can_send_messages: true },
    });
    await expect(
      canBotSendToChat(api, { chatId: -100888n, chatType: "supergroup" }),
    ).resolves.toEqual({ ok: false, reason: "not_member" });
  });

  it.each(["left", "kicked"] as const)("denies status %s", async (status) => {
    const api = makeApi({ [`-100888:${BOT_ID}`]: { status } });
    await expect(
      canBotSendToChat(api, { chatId: -100888n, chatType: "supergroup" }),
    ).resolves.toEqual({ ok: false, reason: "not_member" });
  });

  it("denies when the membership probe fails — never assume reachability", async () => {
    const api = makeApi({});
    await expect(
      canBotSendToChat(api, { chatId: -100888n, chatType: "supergroup" }),
    ).resolves.toEqual({ ok: false, reason: "probe_failed" });
  });
});

describe("canBotSendToChat — private chats", () => {
  it("allows the actor's own DM when the confirmation came FROM that DM", async () => {
    const api = makeApi({});
    const result = await canBotSendToChat(api, {
      chatId: BigInt(ACTOR_ID),
      chatType: "private",
      actorId: ACTOR_ID,
      interactionChatId: BigInt(ACTOR_ID),
    });

    expect(result).toEqual({ ok: true });
    // Tapping a button inside the DM IS the liveness evidence — no probe.
    expect(
      (api as unknown as { getChatMember: ReturnType<typeof vi.fn> }).getChatMember,
    ).not.toHaveBeenCalled();
  });

  it("denies any other private chat — mail must not be redirected to a stranger's DM", async () => {
    const api = makeApi({});
    await expect(
      canBotSendToChat(api, { chatId: 999n, chatType: "private", actorId: ACTOR_ID }),
    ).resolves.toEqual({ ok: false, reason: "foreign_dm" });
  });

  it("denies a private target when no actor is supplied", async () => {
    const api = makeApi({});
    await expect(canBotSendToChat(api, { chatId: 999n, chatType: "private" })).resolves.toEqual({
      ok: false,
      reason: "foreign_dm",
    });
  });

  it("denies the own DM when the confirmation came from somewhere else", async () => {
    // Confirming from a GROUP proves nothing about the DM: the actor may never
    // have started the bot, or may have blocked it, and mail would silently go
    // nowhere. A blocked user cannot tap a button in the DM at all, so
    // requiring the interaction there is stronger than any probe.
    const api = makeApi({});
    await expect(
      canBotSendToChat(api, {
        chatId: BigInt(ACTOR_ID),
        chatType: "private",
        actorId: ACTOR_ID,
        interactionChatId: -100888n,
      }),
    ).resolves.toEqual({ ok: false, reason: "dm_not_here" });
  });

  it("denies the own DM when no interaction chat is known", async () => {
    const api = makeApi({});
    await expect(
      canBotSendToChat(api, {
        chatId: BigInt(ACTOR_ID),
        chatType: "private",
        actorId: ACTOR_ID,
      }),
    ).resolves.toEqual({ ok: false, reason: "dm_not_here" });
  });
});

describe("canActorUseMoveTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires the actor to be creator or administrator of a non-private target", async () => {
    const api = makeApi({
      [`-100888:${ACTOR_ID}`]: { status: "administrator" },
      [`-100888:${BOT_ID}`]: { status: "member" },
    });

    await expect(
      canActorUseMoveTarget(api, { chatId: -100888n, chatType: "supergroup", actorId: ACTOR_ID }),
    ).resolves.toEqual({ ok: true });
  });

  it("denies an actor who only just lost admin (checked fresh, not cached)", async () => {
    const api = makeApi({
      [`-100888:${ACTOR_ID}`]: { status: "member" },
      [`-100888:${BOT_ID}`]: { status: "administrator" },
    });

    await expect(
      canActorUseMoveTarget(api, { chatId: -100888n, chatType: "supergroup", actorId: ACTOR_ID }),
    ).resolves.toEqual({ ok: false, reason: "actor_not_admin" });
  });

  it("denies when the actor qualifies but the bot cannot send", async () => {
    const api = makeApi({
      [`-100777:${ACTOR_ID}`]: { status: "creator" },
      [`-100777:${BOT_ID}`]: { status: "administrator", can_post_messages: false },
    });

    await expect(
      canActorUseMoveTarget(api, { chatId: -100777n, chatType: "channel", actorId: ACTOR_ID }),
    ).resolves.toEqual({ ok: false, reason: "cannot_post" });
  });

  it("accepts the actor's own DM when confirmed from that DM, without a probe", async () => {
    const api = makeApi({});

    await expect(
      canActorUseMoveTarget(api, {
        chatId: BigInt(ACTOR_ID),
        chatType: "private",
        actorId: ACTOR_ID,
        interactionChatId: BigInt(ACTOR_ID),
      }),
    ).resolves.toEqual({ ok: true });
    expect(
      (api as unknown as { getChatMember: ReturnType<typeof vi.fn> }).getChatMember,
    ).not.toHaveBeenCalled();
  });
});
