/**
 * SQL for the first-bounce notice (`alias_activation`).
 *
 * Every statement here is a single round trip. The claim is one
 * INSERT … ON CONFLICT DO UPDATE … WHERE, so concurrent bounces on the same
 * alias serialize on the row and exactly one of them wins a claim; the
 * budget and the rolling window are spent at claim time, before any DNS or
 * Telegram work, whatever happens to the send afterwards.
 *
 * Expired tokens and domains are ignored by every read (`expires_at > now()`)
 * and nulled by the cleanup loop.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { asc, eq, sql } from "drizzle-orm";
import { aliasActivation, emailAddresses } from "../schema.js";
import type * as schema from "../schema.js";
import { SIDE_WORK_TIMEOUTS, withBoundedTransaction } from "../boundedTransaction.js";

type Db = NodePgDatabase<typeof schema>;

/** Lifetime claim budget per alias. */
export const ACTIVATION_CLAIM_BUDGET = 3;
/** Minimum hours between two claims on one alias (a claim at exactly this age is allowed). */
export const ACTIVATION_CLAIM_WINDOW_HOURS = 24;
/** How long a claim's one-tap token and stored domain stay valid. */
export const ACTIVATION_TOKEN_TTL_DAYS = 7;
/** An alias at most this old passes the gate even when its owner had mail accepted before. */
export const ACTIVATION_NEW_ALIAS_DAYS = 7;

function rowsOf<T>(result: unknown): T[] {
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function rowCountOf(result: unknown): number {
  return (result as { rowCount?: number | null } | null)?.rowCount ?? 0;
}

/** SQL fragment: does `alias` have a surviving succeeded delivery attempt? */
function succeededAttemptExists(aliasIdColumn: ReturnType<typeof sql.raw>) {
  return sql`exists (
    select 1 from delivery_logs dl
    join delivery_attempts da on da.delivery_log_id = dl.id
    where dl.email_address_id = ${aliasIdColumn} and da.status = 'succeeded'
  )`;
}

// ─── Working-alias marker ────────────────────────────────────────────────────

/**
 * Records that the alias delivered mail once. Idempotent; an existing marker
 * is never moved and the row is not rewritten when it is already set.
 *
 * Runs in its own bounded transaction (5 s statement, 2 s lock wait): it sits
 * on the delivery path, so a row held by a notice claim or a button tap must
 * cost at most a logged failure, never a stalled attachment follow-up or
 * retry cycle. The cleanup loop reconciles a marker that failed.
 */
export async function markAliasFirstDelivered(db: Db, aliasId: string): Promise<void> {
  await withBoundedTransaction(db, SIDE_WORK_TIMEOUTS, (tx) =>
    tx.execute(sql`
      insert into alias_activation (alias_id, first_delivered_at)
      values (${aliasId}, now())
      on conflict (alias_id) do update
        set first_delivered_at = coalesce(alias_activation.first_delivered_at, excluded.first_delivered_at)
        where alias_activation.first_delivered_at is null
    `),
  );
}

/**
 * Sets the marker for every alias that has a surviving succeeded delivery
 * attempt but no marker yet (a marker write that failed, or deliveries made
 * by a build without this feature). Returns the number of markers written.
 */
export async function reconcileFirstDeliveredMarkers(db: Db): Promise<number> {
  const result = await db.execute(sql`
    insert into alias_activation (alias_id, first_delivered_at)
    select dl.email_address_id, min(da.created_at)
    from delivery_attempts da
    join delivery_logs dl on dl.id = da.delivery_log_id
    where da.status = 'succeeded'
      and not exists (
        select 1 from alias_activation aa
        where aa.alias_id = dl.email_address_id and aa.first_delivered_at is not null
      )
    group by dl.email_address_id
    on conflict (alias_id) do update
      set first_delivered_at = excluded.first_delivered_at
      where alias_activation.first_delivered_at is null
  `);
  return rowCountOf(result);
}

/** Nulls the token and the stored domain of every expired claim. */
export async function clearExpiredActivationTokens(db: Db): Promise<number> {
  const result = await db.execute(sql`
    update alias_activation
    set token = null, domain = null
    where expires_at < now() and (token is not null or domain is not null)
  `);
  return rowCountOf(result);
}

// ─── Notice: gate, claim, domain, revalidation, acknowledgement ──────────────

export interface ActivationGateRow {
  aliasId: string;
  status: string;
  ownerId: bigint;
  chatId: bigint;
  routingVersion: number;
  /** Created at most ACTIVATION_NEW_ALIAS_DAYS ago. */
  recentlyCreated: boolean;
  /** Has the durable marker or a surviving succeeded attempt. */
  working: boolean;
  /** `coalesce(sum(delivered_count), 0) = 0` over the owner's usage months. */
  ownerNeverAccepted: boolean;
}

interface RawGateRow extends Record<string, unknown> {
  alias_id: string;
  status: string;
  owner_id: string;
  chat_id: string;
  routing_version: number;
  recently_created: boolean;
  marked: boolean;
  delivered: boolean;
  owner_never_accepted: boolean;
}

/** One statement: everything the gate needs about the alias and its owner. */
export async function readActivationGate(
  db: Db,
  aliasId: string,
): Promise<ActivationGateRow | null> {
  const result = await db.execute(sql`
    select
      a.id as alias_id,
      a.status,
      a.created_by::text as owner_id,
      a.chat_id::text as chat_id,
      a.routing_version,
      a.created_at >= now() - make_interval(days => ${ACTIVATION_NEW_ALIAS_DAYS}) as recently_created,
      exists (
        select 1 from alias_activation aa
        where aa.alias_id = a.id and aa.first_delivered_at is not null
      ) as marked,
      ${succeededAttemptExists(sql.raw("a.id"))} as delivered,
      (
        select coalesce(sum(u.delivered_count), 0) = 0
        from user_usage_months u
        where u.user_id = a.created_by
      ) as owner_never_accepted
    from email_addresses a
    where a.id = ${aliasId}
  `);
  const [row] = rowsOf<RawGateRow>(result);
  if (!row) return null;
  return {
    aliasId: row.alias_id,
    status: row.status,
    ownerId: BigInt(row.owner_id),
    chatId: BigInt(row.chat_id),
    routingVersion: Number(row.routing_version),
    recentlyCreated: row.recently_created === true,
    working: row.marked === true || row.delivered === true,
    ownerNeverAccepted: row.owner_never_accepted === true,
  };
}

/**
 * Takes the per-alias claim: inserts the row or, when the alias is still not
 * working, under budget and outside the 24 h window, spends one claim, issues
 * the new token and its expiry, clears the previous claim's domain and
 * snapshots the alias routing. Returns false when no claim was taken.
 */
export async function claimActivationNotice(
  db: Db,
  input: { aliasId: string; token: string; chatId: bigint; routingVersion: number },
): Promise<boolean> {
  const result = await db.execute(sql`
    insert into alias_activation (
      alias_id, claims_used, last_claim_at, first_notice_at, token, expires_at, domain,
      chat_id, routing_version
    )
    values (
      ${input.aliasId}, 1, now(), now(), ${input.token},
      now() + make_interval(days => ${ACTIVATION_TOKEN_TTL_DAYS}), null,
      ${input.chatId}, ${input.routingVersion}
    )
    on conflict (alias_id) do update set
      claims_used = alias_activation.claims_used + 1,
      last_claim_at = now(),
      first_notice_at = coalesce(alias_activation.first_notice_at, now()),
      token = excluded.token,
      expires_at = excluded.expires_at,
      domain = null,
      chat_id = excluded.chat_id,
      routing_version = excluded.routing_version
    where alias_activation.first_delivered_at is null
      and alias_activation.claims_used < ${ACTIVATION_CLAIM_BUDGET}
      and (
        alias_activation.last_claim_at is null
        or alias_activation.last_claim_at <= now() - make_interval(hours => ${ACTIVATION_CLAIM_WINDOW_HOURS})
      )
    returning token
  `);
  return rowsOf<{ token: string }>(result).some((row) => row.token === input.token);
}

/** Stores the authenticated From domain on the claim the token belongs to. */
export async function setActivationDomain(
  db: Db,
  input: { aliasId: string; token: string; domain: string },
): Promise<boolean> {
  const result = await db.execute(sql`
    update alias_activation
    set domain = ${input.domain}
    where alias_id = ${input.aliasId} and token = ${input.token} and expires_at > now()
  `);
  return rowCountOf(result) > 0;
}

export interface ActivationRevalidationRow {
  status: string;
  ownerId: bigint;
  chatId: bigint;
  routingVersion: number;
  fullAddress: string;
  ownerLocale: string | null;
  /** The live token (null when consumed, replaced by nothing, or expired). */
  token: string | null;
  /** The live stored domain (null when unset or expired). */
  domain: string | null;
  working: boolean;
}

interface RawRevalidationRow extends Record<string, unknown> {
  status: string;
  owner_id: string;
  chat_id: string;
  routing_version: number;
  full_address: string;
  owner_locale: string | null;
  token: string | null;
  domain: string | null;
  marked: boolean;
  delivered: boolean;
}

/** One statement: the alias, its claim row and the working check, right before the send. */
export async function readActivationRevalidation(
  db: Db,
  aliasId: string,
): Promise<ActivationRevalidationRow | null> {
  const result = await db.execute(sql`
    select
      a.status,
      a.created_by::text as owner_id,
      a.chat_id::text as chat_id,
      a.routing_version,
      a.full_address,
      u.locale as owner_locale,
      case when aa.expires_at > now() then aa.token end as token,
      case when aa.expires_at > now() then aa.domain end as domain,
      aa.first_delivered_at is not null as marked,
      ${succeededAttemptExists(sql.raw("a.id"))} as delivered
    from email_addresses a
    join alias_activation aa on aa.alias_id = a.id
    left join users u on u.id = a.created_by
    where a.id = ${aliasId}
  `);
  const [row] = rowsOf<RawRevalidationRow>(result);
  if (!row) return null;
  return {
    status: row.status,
    ownerId: BigInt(row.owner_id),
    chatId: BigInt(row.chat_id),
    routingVersion: Number(row.routing_version),
    fullAddress: row.full_address,
    ownerLocale: row.owner_locale,
    token: row.token,
    domain: row.domain,
    working: row.marked === true || row.delivered === true,
  };
}

/** Records an acknowledged send. The budget was spent at claim time. */
export async function recordActivationNoticeSent(db: Db, aliasId: string): Promise<void> {
  await db.execute(sql`
    update alias_activation
    set sent_at = now(), first_sent_at = coalesce(first_sent_at, now())
    where alias_id = ${aliasId}
  `);
}

// ─── One-tap button ──────────────────────────────────────────────────────────

export interface ConsumedActivationToken {
  domain: string | null;
  chatId: bigint | null;
  routingVersion: number | null;
}

/**
 * Spends the one-tap token. Only the live token of the alias's latest claim
 * matches; a second tap, an expired token or one replaced by a newer claim
 * returns null.
 */
export async function consumeActivationToken(
  db: Db,
  input: { aliasId: string; token: string },
): Promise<ConsumedActivationToken | null> {
  const result = await db.execute(sql`
    update alias_activation
    set token = null
    where alias_id = ${input.aliasId} and token = ${input.token} and expires_at > now()
    returning domain, chat_id::text as chat_id, routing_version
  `);
  const [row] = rowsOf<{
    domain: string | null;
    chat_id: string | null;
    routing_version: number | null;
  }>(result);
  if (!row) return null;
  return {
    domain: row.domain,
    chatId: row.chat_id == null ? null : BigInt(row.chat_id),
    routingVersion: row.routing_version == null ? null : Number(row.routing_version),
  };
}

// ─── Data rights ─────────────────────────────────────────────────────────────

/** Activation rows of every alias the user owns, deleted aliases included. */
export async function listAliasActivationForOwner(db: Db, userId: bigint) {
  return db
    .select({
      aliasId: aliasActivation.aliasId,
      firstDeliveredAt: aliasActivation.firstDeliveredAt,
      claimsUsed: aliasActivation.claimsUsed,
      lastClaimAt: aliasActivation.lastClaimAt,
      firstNoticeAt: aliasActivation.firstNoticeAt,
      token: aliasActivation.token,
      expiresAt: aliasActivation.expiresAt,
      domain: aliasActivation.domain,
      chatId: aliasActivation.chatId,
      routingVersion: aliasActivation.routingVersion,
      sentAt: aliasActivation.sentAt,
      firstSentAt: aliasActivation.firstSentAt,
    })
    .from(aliasActivation)
    .innerJoin(emailAddresses, eq(emailAddresses.id, aliasActivation.aliasId))
    .where(eq(emailAddresses.createdBy, userId))
    .orderBy(asc(aliasActivation.aliasId));
}
