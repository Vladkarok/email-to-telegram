/**
 * Move-target validation (alias-chat-mobility contract §Scenario 4).
 *
 * A move redirects mail, so both ends are checked FRESH at confirm time —
 * never from the authorization cache. Two independent questions:
 *
 *  1. Can the BOT actually deliver to the target? (`canBotSendToChat`)
 *  2. May the ACTOR point an alias at it? (`canActorUseMoveTarget`)
 *
 * Every denial is a distinct reason so the UI can explain what to fix, and
 * every unknown — a failed probe, an unrecognized status — denies. Reachability
 * is never assumed.
 */
import type { Api } from "grammy";

export type MoveTargetChatType = "private" | "group" | "supergroup" | "channel";

export type SendabilityDenial =
  | "not_admin"
  | "cannot_post"
  | "not_member"
  | "cannot_send"
  | "foreign_dm"
  | "dm_not_here"
  | "probe_failed";

export type MoveTargetDenial = SendabilityDenial | "actor_not_admin";

export type SendabilityResult = { ok: true } | { ok: false; reason: SendabilityDenial };
export type MoveTargetResult = { ok: true } | { ok: false; reason: MoveTargetDenial };

export interface MoveTargetProbe {
  chatId: bigint;
  chatType: MoveTargetChatType;
  /** Telegram user id of the person performing the move. */
  actorId?: number;
  /**
   * Chat the confirmation itself arrived from. For an own-DM target this is
   * the evidence that the DM is live: a user who never started the bot, or
   * who blocked it, cannot be tapping a button inside it.
   */
  interactionChatId?: bigint;
}

interface ChatMemberShape {
  status: string;
  can_post_messages?: boolean;
  can_send_messages?: boolean;
  is_member?: boolean;
}

async function getMember(
  api: Api,
  chatId: bigint,
  userId: number,
): Promise<ChatMemberShape | null> {
  try {
    return (await api.getChatMember(Number(chatId), userId)) as unknown as ChatMemberShape;
  } catch {
    // Timeouts, chat-not-found, bot-removed — all indistinguishable here and
    // all disqualifying. The orphan probe (layer 3) is the place that cares
    // about the difference between transient and definitive.
    return null;
  }
}

/**
 * Whether the bot can deliver mail to this chat right now, per chat type.
 *
 * A private chat is only ever valid when it IS the actor's own DM AND the
 * confirmation arrived from that DM. The contract waives the membership probe
 * here on the premise that "the actor is necessarily talking to the bot at
 * confirm time" — this requires that premise instead of assuming it, because
 * it is false when the button is tapped from a group. Requiring the
 * interaction to happen in the DM is also strictly stronger than probing:
 * a user who blocked the bot cannot interact with it at all, whereas
 * `getChat` would still succeed for them.
 */
export async function canBotSendToChat(
  api: Api,
  probe: MoveTargetProbe,
): Promise<SendabilityResult> {
  if (probe.chatType === "private") {
    const isOwnDm = probe.actorId !== undefined && probe.chatId === BigInt(probe.actorId);
    if (!isOwnDm) return { ok: false, reason: "foreign_dm" };
    return probe.interactionChatId === probe.chatId
      ? { ok: true }
      : { ok: false, reason: "dm_not_here" };
  }

  const me = await api.getMe();
  const member = await getMember(api, probe.chatId, me.id);
  if (!member) return { ok: false, reason: "probe_failed" };

  if (probe.chatType === "channel") {
    if (member.status !== "administrator") return { ok: false, reason: "not_admin" };
    return member.can_post_messages === true ? { ok: true } : { ok: false, reason: "cannot_post" };
  }

  // group / supergroup
  if (member.status === "administrator" || member.status === "member") return { ok: true };
  if (member.status === "restricted") {
    if (member.is_member !== true) return { ok: false, reason: "not_member" };
    return member.can_send_messages === true ? { ok: true } : { ok: false, reason: "cannot_send" };
  }
  // left, kicked, and anything unrecognized.
  return { ok: false, reason: "not_member" };
}

/**
 * Full confirm-time gate for a move target: the actor must administer it (own
 * DM excepted) AND the bot must be able to send there. Both probes are live.
 */
export async function canActorUseMoveTarget(
  api: Api,
  probe: MoveTargetProbe & { actorId: number },
): Promise<MoveTargetResult> {
  if (probe.chatType === "private") {
    // Ownership of the DM is implied by the id match; deliverability is not,
    // so defer to canBotSendToChat's liveness check rather than short-circuit.
    return canBotSendToChat(api, probe);
  }

  const actorMember = await getMember(api, probe.chatId, probe.actorId);
  if (!actorMember) return { ok: false, reason: "probe_failed" };
  if (!["creator", "administrator"].includes(actorMember.status)) {
    return { ok: false, reason: "actor_not_admin" };
  }

  return canBotSendToChat(api, probe);
}
