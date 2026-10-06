/**
 * The one-tap "Allow <domain>" button of a first-bounce notice.
 *
 * 1. Fresh authorization (no cached admin status), bounded by a timeout,
 *    outside any transaction.
 * 2. One bounded transaction, in hosted and self-hosted mode alike: read the
 *    alias's owner, lock the owner (the per-user advisory lock every alias
 *    writer takes first), then the alias row `FOR UPDATE`; spend the token;
 *    check the alias is still
 *    active on the chat and routing version of the claim; then, inside a
 *    savepoint, add the rule under the usual limits. An insert error rolls
 *    back to the savepoint and the transaction still commits the spent token,
 *    so a failed add spends the button. Only a failed commit leaves the
 *    button usable.
 * 3. Telegram replies, after the transaction.
 *
 * The notice's "Allow rules" button (`rl:`) opens the allow-rules menu as a
 * new message, so the bounce explanation and its one-tap button stay.
 */
import type { CallbackQueryContext, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { emailAddresses, type EmailAddress } from "../db/schema.js";
import { getDb } from "../db/client.js";
import { findAliasById } from "../db/repos/aliases.js";
import { consumeActivationToken } from "../db/repos/aliasActivation.js";
import { insertAllowRule } from "../telegram/commands/allow.js";
import { assertAliasAccess } from "../telegram/middleware/authorization.js";
import { sendAllowRulesMenu } from "../telegram/menu/allowRulesMenu.js";
import { parseAllowValue } from "../telegram/allowValue.js";
import { CB_ACTIVATION_RULES } from "../telegram/callbacks.js";
import { getMessages, resolveLocale, type Messages } from "../i18n/index.js";
import { escapeHtml } from "../utils/html.js";
import { getLogger } from "../utils/logger.js";
import { recordActivationAllow } from "../observability/metrics.js";
import { NOTICE_BOUNDS, type NoticeBounds } from "./bounds.js";
import { withBoundedTransaction } from "./transaction.js";

type Db = NodePgDatabase<typeof schema>;

export type ActivationAllowOutcome =
  | { kind: "added"; alias: EmailAddress; domain: string }
  | { kind: "duplicate"; alias: EmailAddress; domain: string }
  | { kind: "limit"; alias: EmailAddress; domain: string; limit: number | null }
  | { kind: "failed"; alias: EmailAddress; domain: string }
  | { kind: "expired" };

/**
 * The transaction behind the button. Throws only when the transaction itself
 * fails (including its commit); the token is then not spent.
 */
export async function applyActivationAllow(
  db: Db,
  input: { aliasId: string; token: string },
  bounds: Pick<NoticeBounds, "statementTimeout" | "lockTimeout"> = NOTICE_BOUNDS,
): Promise<ActivationAllowOutcome> {
  return withBoundedTransaction(db, bounds, async (tx) => {
    // The owner comes first in the lock order, so read it (unlocked) first.
    const before = await findAliasById(tx, input.aliasId);
    if (!before) return { kind: "expired" as const };
    const ownerId = before.createdBy;
    await tx.execute(sql`select pg_advisory_xact_lock(${ownerId})`);
    const [alias] = await tx
      .select()
      .from(emailAddresses)
      .where(eq(emailAddresses.id, input.aliasId))
      .for("update");

    const claim = await consumeActivationToken(tx, input);
    if (!claim) return { kind: "expired" as const };

    const rule = claim.domain ? parseAllowValue(claim.domain) : null;
    if (
      !alias ||
      alias.createdBy !== ownerId ||
      alias.status !== "active" ||
      claim.chatId === null ||
      claim.routingVersion === null ||
      alias.chatId !== claim.chatId ||
      alias.routingVersion !== claim.routingVersion ||
      !rule ||
      rule.matchType !== "domain"
    ) {
      // The token stays spent: this button belongs to a state that is gone.
      return { kind: "expired" as const };
    }
    const domain = rule.normalized;
    const expected = { chatId: claim.chatId, routingVersion: claim.routingVersion };

    try {
      const inserted = await tx.transaction((savepoint) =>
        insertAllowRule(savepoint as Db, { aliasId: alias.id, ownerId, rule, expected }),
      );
      switch (inserted.kind) {
        case "added":
          return { kind: "added" as const, alias, domain };
        case "duplicate":
          return { kind: "duplicate" as const, alias, domain };
        case "limit":
          return {
            kind: "limit" as const,
            alias,
            domain,
            limit:
              inserted.limit.code === "allow_rule_limit" ? (inserted.limit.limit ?? null) : null,
          };
        case "stale":
          return { kind: "expired" as const };
      }
    } catch (err: unknown) {
      // Rolled back to the savepoint; the spent token still commits.
      getLogger().warn(
        { err, aliasId: alias.id, userId: ownerId.toString() },
        "activation.allow.insert_failed",
      );
      return { kind: "failed" as const, alias, domain };
    }
  });
}

function allowRulesOnlyKeyboard(messages: Messages, aliasId: string): InlineKeyboard {
  return new InlineKeyboard().text(
    messages.aliasMenu.allowRulesButton,
    CB_ACTIVATION_RULES.build(aliasId),
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** rn:{aliasId}:{token} */
export async function activationAllowCallback(
  ctx: CallbackQueryContext<Context>,
  bounds: NoticeBounds = NOTICE_BOUNDS,
): Promise<void> {
  const aliasId = ctx.match[1] ?? "";
  const token = ctx.match[2] ?? "";
  const db = getDb();
  const log = getLogger();
  const messages = getMessages(await resolveLocale(ctx, db));

  // 1. Fresh authorization, bounded, outside any transaction. A denial
  //    answers the query itself.
  const access = await withTimeout(
    assertAliasAccess(ctx, aliasId, { fresh: true }).catch(() => false),
    bounds.buttonAccessCheckTimeoutMs,
  );
  if (access !== true) {
    if (access === "timeout") {
      await ctx.answerCallbackQuery(messages.common.accessDenied).catch(() => {});
    }
    return;
  }

  // 2. The transaction.
  let outcome: ActivationAllowOutcome;
  try {
    outcome = await applyActivationAllow(db, { aliasId, token }, bounds);
  } catch (err: unknown) {
    log.warn({ err, aliasId, userId: ctx.from?.id }, "activation.allow.failed");
    recordActivationAllow("failed");
    await ctx.answerCallbackQuery(messages.activationNotice.tryAgainToast).catch(() => {});
    return;
  }
  recordActivationAllow(
    outcome.kind === "added" || outcome.kind === "duplicate"
      ? "added"
      : outcome.kind === "expired"
        ? "expired"
        : "failed",
  );
  log.info({ aliasId, userId: ctx.from?.id, result: outcome.kind }, "activation.allow");

  // 3. Replies. The button is spent in every outcome here, so drop it.
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx
    .editMessageReplyMarkup({ reply_markup: allowRulesOnlyKeyboard(messages, aliasId) })
    .catch(() => {});

  if (outcome.kind === "expired") {
    await ctx.reply(messages.activationNotice.expired);
    await sendAllowRulesMenu(ctx, db, aliasId);
    return;
  }

  const address = escapeHtml(outcome.alias.fullAddress);
  const domain = escapeHtml(outcome.domain);
  switch (outcome.kind) {
    case "added":
      await ctx.reply(messages.activationNotice.added(address, domain), { parse_mode: "HTML" });
      return;
    case "duplicate":
      await ctx.reply(messages.activationNotice.alreadyAllowed(address, domain), {
        parse_mode: "HTML",
      });
      return;
    case "limit":
      await ctx.reply(
        outcome.limit === null
          ? messages.activationNotice.addFailed(address, domain)
          : messages.activationNotice.ruleLimit(address, domain, outcome.limit),
        { parse_mode: "HTML" },
      );
      await sendAllowRulesMenu(ctx, db, aliasId);
      return;
    case "failed":
      await ctx.reply(messages.activationNotice.addFailed(address, domain), { parse_mode: "HTML" });
      await sendAllowRulesMenu(ctx, db, aliasId);
      return;
  }
}

/**
 * rl:{aliasId} — the notice's "Allow rules" button. Read-only, so the cached
 * access check is enough (as for the alias menu's own button); the menu
 * arrives as a new message and the notice stays as it is.
 */
export async function activationRulesCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  const aliasId = ctx.match[1] ?? "";
  if (!(await assertAliasAccess(ctx, aliasId))) return;
  await ctx.answerCallbackQuery();
  await sendAllowRulesMenu(ctx, getDb(), aliasId);
}
