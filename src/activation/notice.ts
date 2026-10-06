/**
 * First-bounce notice: tells the owner of a not-yet-working alias that mail
 * bounced because no allow rule matched, and offers a one-tap "Allow
 * <domain>" when that domain authenticated the message.
 *
 * A job runs these phases, each bounded (see `bounds.ts`):
 *
 * 1. Gate and claim, one transaction. The gate passes only for an active
 *    alias that is not working and is either at most 7 days old or owned by
 *    someone who never had mail accepted; any error means no notice. The
 *    claim spends the 24 h window and one of the 3 lifetime claims before
 *    any DNS or Telegram work, so concurrent bounces authenticate and send
 *    once.
 * 2. Raw stage with held MIME: authenticate the header From domain; on an
 *    authenticated pass, store the domain on this claim.
 * 3. Revalidate right before the send: same active alias, owner and routing
 *    version as at the claim, the claim's token still current, still not
 *    working.
 * 4. Send to the owner's private chat, then record the acknowledgement.
 *
 * Logs carry identifiers only, never the sender domain.
 */
import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import { randomBytes } from "crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { getDb } from "../db/client.js";
import { getApi } from "../telegram/api.js";
import {
  claimActivationNotice,
  readActivationGate,
  readActivationRevalidation,
  recordActivationNoticeSent,
  setActivationDomain,
  type ActivationGateRow,
  type ActivationRevalidationRow,
} from "../db/repos/aliasActivation.js";
import { authenticateSender, type SenderAuthResult } from "../email/authenticateSender.js";
import { parseAllowValue } from "../telegram/allowValue.js";
import { CB_ACTIVATION_ALLOW, CB_ALLOW_RULES } from "../telegram/callbacks.js";
import { DEFAULT_LOCALE, getMessages, normalizeLocale, type Messages } from "../i18n/index.js";
import { escapeHtml } from "../utils/html.js";
import { getLogger } from "../utils/logger.js";
import type { ActivationNoticeResult, ActivationNoticeStage } from "../observability/metrics.js";
import { NOTICE_BOUNDS, type NoticeBounds } from "./bounds.js";
import {
  ActivationNoticeQueue,
  type ActivationNoticeJob,
  type NoticeJobContext,
  type NoticeRunner,
} from "./noticeQueue.js";
import { withBoundedTransaction } from "./transaction.js";

type Db = NodePgDatabase<typeof schema>;
type GrammySignal = Parameters<Api["sendMessage"]>[3];

// ─── Pure policy ─────────────────────────────────────────────────────────────

/** Gate: noise control for an alias that has not delivered yet. */
export function passesActivationGate(gate: ActivationGateRow): boolean {
  return (
    gate.status === "active" && !gate.working && (gate.recentlyCreated || gate.ownerNeverAccepted)
  );
}

/**
 * The header From domain as a rule value, or null when it is not one (an
 * address without a domain, a malformed or non-ASCII domain).
 */
export function usableFromDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = parseAllowValue(value);
  return parsed && parsed.matchType === "domain" && parsed.normalized.length <= 253
    ? parsed.normalized
    : null;
}

/**
 * The domain the one-tap button may add: only on an authenticated pass of
 * exactly that header From domain, the evaluator's own bar.
 */
export function oneTapDomainFor(auth: SenderAuthResult, headerFromDomain: string): string | null {
  const domain = usableFromDomain(headerFromDomain);
  if (!domain || auth.status !== "pass") return null;
  if (usableFromDomain(auth.headerFromDomain) !== domain) return null;
  return auth.authenticatedDomains.some((d) => d.trim().toLowerCase() === domain) ? domain : null;
}

export interface NoticeClaim {
  token: string;
  gate: ActivationGateRow;
}

/** Revalidation: nothing about the alias or the claim changed since the claim. */
export function isStillEligible(
  row: ActivationRevalidationRow | null,
  claim: NoticeClaim,
): row is ActivationRevalidationRow {
  return (
    row !== null &&
    row.status === "active" &&
    row.ownerId === claim.gate.ownerId &&
    row.chatId === claim.gate.chatId &&
    row.routingVersion === claim.gate.routingVersion &&
    row.token === claim.token &&
    !row.working
  );
}

export interface ActivationNoticeMessage {
  text: string;
  keyboard: InlineKeyboard;
}

export function buildActivationNotice(
  messages: Messages,
  input: {
    stage: ActivationNoticeStage;
    aliasId: string;
    address: string;
    fromDomain: string | null;
    oneTap: { domain: string; token: string } | null;
  },
): ActivationNoticeMessage {
  const address = escapeHtml(input.address);
  const text =
    input.stage === "preflight"
      ? messages.activationNotice.bouncedNoRules(address)
      : input.fromDomain
        ? messages.activationNotice.bouncedFromDomain(address, escapeHtml(input.fromDomain))
        : messages.activationNotice.bouncedNoSender(address);
  const keyboard = new InlineKeyboard();
  if (input.oneTap) {
    keyboard
      .text(
        messages.activationNotice.allowDomainButton(input.oneTap.domain),
        CB_ACTIVATION_ALLOW.build(input.aliasId, input.oneTap.token),
      )
      .row();
  }
  keyboard.text(messages.aliasMenu.allowRulesButton, CB_ALLOW_RULES.build(input.aliasId));
  return { text, keyboard };
}

/** 16 random bytes, base64url: 22 characters, no padding, never a `:`. */
export function generateActivationToken(): string {
  return randomBytes(16).toString("base64url");
}

// ─── Job runner ──────────────────────────────────────────────────────────────

export interface NoticeRunnerDeps {
  getDb: () => Db;
  getApi: () => Api | null;
  authenticate: (rawEmail: Buffer, envelopeFrom: string | null) => Promise<SenderAuthResult>;
  generateToken: () => string;
  bounds: NoticeBounds;
}

const DEFAULT_DEPS: NoticeRunnerDeps = {
  getDb: () => getDb(),
  getApi: () => getApi(),
  authenticate: authenticateSender,
  generateToken: generateActivationToken,
  bounds: NOTICE_BOUNDS,
};

export function createNoticeRunner(overrides: Partial<NoticeRunnerDeps> = {}): NoticeRunner {
  const deps: NoticeRunnerDeps = { ...DEFAULT_DEPS, ...overrides };
  return (job, ctx) => runNotice(deps, job, ctx);
}

async function runNotice(
  deps: NoticeRunnerDeps,
  job: ActivationNoticeJob,
  ctx: NoticeJobContext,
): Promise<ActivationNoticeResult> {
  const log = getLogger();
  const db = deps.getDb();
  const tx = <T>(work: (tx: Db) => Promise<T>): Promise<T> =>
    withBoundedTransaction(db, deps.bounds, work);

  // 1. Gate and claim. Any error here means no notice.
  ctx.beginPhase();
  let claimResult: NoticeClaim | "gated" | "not_claimed";
  try {
    claimResult = await tx(async (t) => {
      const gate = await readActivationGate(t, job.aliasId);
      if (!gate || !passesActivationGate(gate)) return "gated" as const;
      const token = deps.generateToken();
      const won = await claimActivationNotice(t, {
        aliasId: gate.aliasId,
        token,
        chatId: gate.chatId,
        routingVersion: gate.routingVersion,
      });
      return won ? { token, gate } : ("not_claimed" as const);
    });
  } catch (err: unknown) {
    log.warn({ err, aliasId: job.aliasId }, "activation.notice.claim_failed");
    return "failed";
  }
  if (claimResult === "gated" || claimResult === "not_claimed") return claimResult;
  const claim: NoticeClaim = claimResult;
  const ownerId = claim.gate.ownerId;

  // 2. Authenticate the From domain (raw stage, MIME held).
  const fromDomain = job.stage === "raw" ? usableFromDomain(job.headerFromDomain) : null;
  if (fromDomain && job.mime) {
    const mime = job.mime;
    const auth = await ctx.authenticate(() => deps.authenticate(mime, job.envelopeFrom));
    const domain = auth.ok ? oneTapDomainFor(auth.value, fromDomain) : null;
    if (domain) {
      ctx.beginPhase();
      try {
        await tx((t) =>
          setActivationDomain(t, { aliasId: job.aliasId, token: claim.token, domain }),
        );
      } catch (err: unknown) {
        // The notice still goes out, without the one-tap button.
        log.warn(
          { err, aliasId: job.aliasId, userId: ownerId.toString() },
          "activation.notice.domain_store_failed",
        );
      }
    }
  }

  // 3. Revalidate right before the send.
  ctx.beginPhase();
  let current: ActivationRevalidationRow | null;
  try {
    current = await tx((t) => readActivationRevalidation(t, job.aliasId));
  } catch (err: unknown) {
    log.warn(
      { err, aliasId: job.aliasId, userId: ownerId.toString() },
      "activation.notice.revalidate_failed",
    );
    return "failed";
  }
  if (!isStillEligible(current, claim)) {
    log.info({ aliasId: job.aliasId, userId: ownerId.toString() }, "activation.notice.stale");
    return "stale";
  }

  // 4. Send to the owner's private chat.
  const api = deps.getApi();
  if (!api) return "failed";
  ctx.beginPhase();
  const messages = getMessages(normalizeLocale(current.ownerLocale) ?? DEFAULT_LOCALE);
  const oneTapDomain = fromDomain && current.domain === fromDomain ? fromDomain : null;
  const notice = buildActivationNotice(messages, {
    stage: job.stage,
    aliasId: job.aliasId,
    address: current.fullAddress,
    fromDomain,
    oneTap: oneTapDomain ? { domain: oneTapDomain, token: claim.token } : null,
  });
  try {
    await ctx.withSendSignal((signal) =>
      api.sendMessage(
        ownerId.toString(),
        notice.text,
        {
          parse_mode: "HTML",
          reply_markup: notice.keyboard,
          link_preview_options: { is_disabled: true },
        },
        // grammY types its signal with the abort-controller shim; at runtime
        // it bridges any AbortSignal through addEventListener.
        signal as unknown as GrammySignal,
      ),
    );
  } catch (err: unknown) {
    log.warn(
      { err, aliasId: job.aliasId, userId: ownerId.toString() },
      "activation.notice.send_failed",
    );
    return "failed";
  }

  // The budget was spent at claim time; this only records the acknowledgement.
  try {
    await tx((t) => recordActivationNoticeSent(t, job.aliasId));
  } catch (err: unknown) {
    log.warn(
      { err, aliasId: job.aliasId, userId: ownerId.toString() },
      "activation.notice.ack_failed",
    );
  }
  log.info(
    {
      aliasId: job.aliasId,
      userId: ownerId.toString(),
      stage: job.stage,
      oneTap: oneTapDomain !== null,
    },
    "activation.notice.sent",
  );
  return "sent";
}

// ─── Process-wide queue ──────────────────────────────────────────────────────

let queue: ActivationNoticeQueue | null = null;

export function getActivationNoticeQueue(): ActivationNoticeQueue {
  queue ??= new ActivationNoticeQueue(createNoticeRunner());
  return queue;
}

/** Replaces the process-wide queue (tests). */
export function setActivationNoticeQueue(next: ActivationNoticeQueue | null): void {
  queue = next;
}

/**
 * Raw upload answered with a `sender_not_allowed` bounce. Call after the
 * response is sent. Constant-time, never throws.
 */
export function admitRawSenderRejection(input: {
  aliasId: string;
  headerFromDomain: string | null;
  envelopeFrom: string | null;
  rawMime: Buffer;
}): void {
  try {
    getActivationNoticeQueue().admit({
      stage: "raw",
      aliasId: input.aliasId,
      headerFromDomain: usableFromDomain(input.headerFromDomain),
      envelopeFrom: input.envelopeFrom,
      rawMime: input.rawMime,
    });
  } catch {
    // The notice is best-effort; the inbound response is already sent.
  }
}

/**
 * Preflight bounced because the alias has no allow rules. Only the envelope
 * is known there (often a bounce domain), so the notice names no sender.
 * Call after the response is sent. Constant-time, never throws.
 */
export function admitPreflightNoRules(aliasId: string): void {
  try {
    getActivationNoticeQueue().admit({
      stage: "preflight",
      aliasId,
      headerFromDomain: null,
      envelopeFrom: null,
      rawMime: null,
    });
  } catch {
    // Best-effort, as above.
  }
}

/** Shutdown hook: see ActivationNoticeQueue.shutdown(). Never throws. */
export async function shutdownActivationNotices(): Promise<void> {
  try {
    await queue?.shutdown();
  } catch {
    // Shutdown must proceed regardless.
  }
}
