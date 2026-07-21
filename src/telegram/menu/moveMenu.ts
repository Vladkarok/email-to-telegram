/**
 * Alias move UX (alias-chat-mobility contract, layer 2).
 *
 * Three steps, each a callback: picker → confirm → execute. The confirm and
 * execute callbacks carry the alias `routing_version` they were built
 * against, so a confirmation authorized against one routing state can never
 * apply to another (an A→B→A round trip invalidates it — chat id alone would
 * not).
 *
 * Nothing here trusts the authorization cache: `executeAliasMove` re-checks
 * the source alias and the target chat live before mutating.
 */
import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/schema.js";
import { findAliasById } from "../../db/repos/aliases.js";
import { moveAliasWithCas } from "../../db/repos/aliasRouting.js";
import { findChatById } from "../../db/repos/chats.js";
import { getAccessibleChats, canManageAlias } from "../authorization.js";
import { canRecoverOrphanAlias } from "../orphanRecovery.js";
import { withChatMigrationLock } from "../chatMigration.js";
import { canActorUseMoveTarget, type MoveTargetChatType } from "../moveTarget.js";
import { escapeHtml } from "../../utils/html.js";
import { getMessages, resolveLocale } from "../../i18n/index.js";
import { getLogger } from "../../utils/logger.js";
import { CB_ALIAS_DETAIL, CB_ALIAS_MOVE_CONFIRM, CB_ALIAS_MOVE_TARGET } from "../callbacks.js";

type Db = NodePgDatabase<typeof schema>;

function chatIcon(type: string): string {
  if (type === "channel") return "📢";
  if (type === "private") return "👤";
  return "👥";
}

/**
 * Which authorization path, if any, lets this actor move this alias:
 * normal admin rights, or the purpose-scoped orphan fallback (creator of an
 * alias whose chat is definitively dead). `null` means no path — deny.
 *
 * The admin check runs first so a live chat is always handled by the normal
 * rules; the orphan fallback is only ever reached when the chat is dead.
 */
export async function resolveMoveAuthzPath(
  db: Db,
  ctx: Context,
  aliasId: string,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<"admin" | "orphan" | null> {
  if (!ctx.from) return null;
  if (await canManageAlias(db, ctx.api, ctx.from.id, aliasId, { fresh })) return "admin";
  if (await canRecoverOrphanAlias(db, ctx.api, ctx.from.id, aliasId, { fresh })) return "orphan";
  return null;
}

/** Step 1 — list the chats this user could move the alias to. */
export async function editMovePickerMenu(ctx: Context, db: Db, aliasId: string): Promise<void> {
  const messages = getMessages(await resolveLocale(ctx, db));
  const alias = await findAliasById(db, aliasId);
  if (!alias || !ctx.from) {
    await ctx.answerCallbackQuery(messages.common.aliasNotFoundShort);
    return;
  }

  const ownDmId = BigInt(ctx.from.id);
  const inOwnDm = ctx.chat?.id !== undefined && BigInt(ctx.chat.id) === ownDmId;

  const accessible = await getAccessibleChats(db, ctx.api, ctx.from.id);
  const targets = accessible.filter((chat) => {
    if (chat.id === alias.chatId) return false;
    // The user's own DM comes back from getAccessibleChats like any other
    // chat (canManageChat short-circuits it to true), so it must be filtered
    // here too — not just from the synthetic button below. Offering it from a
    // group would be a dead end: the confirm step rejects it with
    // `dm_not_here` because a live DM can only be proven from inside the DM.
    if (chat.id === ownDmId && !inOwnDm) return false;
    return true;
  });

  const keyboard = new InlineKeyboard();
  for (const chat of targets) {
    keyboard
      .text(
        `${chatIcon(chat.type)} ${chat.title}`,
        CB_ALIAS_MOVE_TARGET.build(alias.id, chat.id, alias.routingVersion),
      )
      .row();
  }
  // Fallback entry for a user whose DM was never registered as a chat row.
  if (inOwnDm && alias.chatId !== ownDmId && !targets.some((chat) => chat.id === ownDmId)) {
    keyboard
      .text(
        messages.aliasMenu.moveToOwnDm,
        CB_ALIAS_MOVE_TARGET.build(alias.id, ownDmId, alias.routingVersion),
      )
      .row();
  }
  keyboard.text(messages.aliasMenu.backButton, CB_ALIAS_DETAIL.build(alias.id));

  const text =
    targets.length === 0
      ? messages.aliasMenu.moveNoTargets(escapeHtml(alias.fullAddress))
      : messages.aliasMenu.movePickerHeader(escapeHtml(alias.fullAddress));

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
}

/** Step 2 — confirmation screen; the version travels in the callback data. */
export async function editMoveConfirmMenu(
  ctx: Context,
  db: Db,
  aliasId: string,
  targetChatId: bigint,
  expectedVersion: number,
): Promise<void> {
  const messages = getMessages(await resolveLocale(ctx, db));
  const alias = await findAliasById(db, aliasId);
  if (!alias) {
    await ctx.answerCallbackQuery(messages.common.aliasNotFoundShort);
    return;
  }

  const targetChat = await findChatById(db, targetChatId);
  const targetTitle = targetChat?.title ?? messages.aliasMenu.moveOwnDmTitle;

  const keyboard = new InlineKeyboard()
    .text(
      messages.aliasMenu.moveConfirmYes,
      CB_ALIAS_MOVE_CONFIRM.build(alias.id, targetChatId, expectedVersion),
    )
    .row()
    .text(messages.aliasMenu.moveConfirmCancel, CB_ALIAS_DETAIL.build(alias.id));

  await ctx.editMessageText(
    messages.aliasMenu.moveConfirmHeader(escapeHtml(alias.fullAddress), escapeHtml(targetTitle)),
    { parse_mode: "HTML", reply_markup: keyboard },
  );
}

/**
 * Step 3 — the mutation. Fresh authorization on BOTH ends, then the
 * version-CAS move. Any denial or conflict leaves routing untouched.
 */
export async function executeAliasMove(
  ctx: Context,
  db: Db,
  aliasId: string,
  targetChatId: bigint,
  expectedVersion: number,
): Promise<void> {
  const messages = getMessages(await resolveLocale(ctx, db));
  if (!ctx.from) return;

  const alias = await findAliasById(db, aliasId);
  if (!alias || alias.status === "deleted") {
    await ctx.answerCallbackQuery(messages.common.aliasNotFoundShort);
    return;
  }

  // Source end, cache-bypassing: a user who just lost admin must not be able
  // to redirect the alias on a stale confirmation. An orphan creator is
  // allowed here — and only here — via the purpose-scoped fallback.
  const authzPath = await resolveMoveAuthzPath(db, ctx, aliasId, { fresh: true });
  if (!authzPath) {
    await ctx.answerCallbackQuery(messages.aliasMenu.moveDeniedToast);
    return;
  }

  const targetChat = await findChatById(db, targetChatId);
  const chatType: MoveTargetChatType =
    targetChatId === BigInt(ctx.from.id)
      ? "private"
      : ((targetChat?.type ?? "supergroup") as MoveTargetChatType);

  const allowed = await canActorUseMoveTarget(ctx.api, {
    chatId: targetChatId,
    chatType,
    actorId: ctx.from.id,
    // Own-DM targets are accepted only when this confirmation came from the
    // DM itself; that is the live-DM evidence.
    interactionChatId: ctx.chat?.id !== undefined ? BigInt(ctx.chat.id) : undefined,
  });
  if (!allowed.ok) {
    await ctx.editMessageText(messages.aliasMenu.moveDenied(allowed.reason), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text(
        messages.aliasMenu.backButton,
        CB_ALIAS_DETAIL.build(alias.id),
      ),
    });
    return;
  }

  // Hold the TARGET chat's migration lock across the move: the contract
  // requires moves targeting a chat to serialize with that chat's migration
  // repair. Without it, a repair could deactivate the target and sweep its
  // aliases just before this move lands one on the now-dead id.
  const actorId = BigInt(ctx.from.id);
  const moved = await withChatMigrationLock(db, targetChatId, async (lockTx) => {
    const targetRow = await findChatById(lockTx, targetChatId);
    if (targetRow?.isActive === false)
      return { ok: false as const, reason: "chat_migrated" as const };

    return moveAliasWithCas(lockTx, {
      aliasId: alias.id,
      expectedVersion,
      newChatId: targetChatId,
      oldChatId: alias.chatId,
      oldThreadId: alias.messageThreadId,
      actorId,
      aliasOwnerId: alias.createdBy,
      authzPath,
    });
  });

  if (!moved.ok && moved.reason === "chat_migrated") {
    // The target migrated out from under the picker; the user re-picks.
    await ctx.editMessageText(messages.aliasMenu.moveDenied("chat_migrated"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text(
        messages.aliasMenu.backButton,
        CB_ALIAS_DETAIL.build(alias.id),
      ),
    });
    return;
  }

  if (!moved.ok) {
    await ctx.editMessageText(messages.aliasActions.routingChanged, { parse_mode: "HTML" });
    return;
  }

  getLogger().info(
    {
      aliasId: alias.id,
      oldChatId: alias.chatId.toString(),
      newChatId: targetChatId.toString(),
      oldThreadId: alias.messageThreadId?.toString() ?? null,
      newThreadId: null,
      actor: ctx.from.id,
      authzPath,
    },
    "alias.moved",
  );
  if (authzPath === "orphan") {
    getLogger().info(
      { aliasId: alias.id, action: "move", actor: ctx.from.id },
      "alias.orphan.recovered",
    );
  }

  const targetTitle = targetChat?.title ?? messages.aliasMenu.moveOwnDmTitle;
  await ctx.editMessageText(
    messages.aliasMenu.moveDone(escapeHtml(alias.fullAddress), escapeHtml(targetTitle)),
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text(
        messages.aliasMenu.backButton,
        CB_ALIAS_DETAIL.build(alias.id),
      ),
    },
  );
}
