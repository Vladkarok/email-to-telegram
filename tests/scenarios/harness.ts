/**
 * The scenario harness: the real HTTP server (createHttpServer driven with
 * app.inject), a real Postgres database (TEST_DATABASE_URL, see
 * tests/helpers/pgTestDb.ts), real files in a temp directory, and the fake
 * Telegram of fakeTelegram.ts. Worker requests are signed with
 * signWorkerRequest exactly as cloudflare-worker/src/worker.ts signs them.
 *
 * A test file calls `useScenarioHarness()` inside its
 * `describe.skipIf(!hasTestDatabase)` block: one database per file, and per
 * test a fresh server, temp directories, empty tables and reset singletons.
 *
 * Reads go through plain SQL on table and column names, never through src
 * repos, so the same assertions hold on any revision with the same schema.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { createPgTestDatabase, type PgTestDatabase } from "../helpers/pgTestDb.js";
import {
  buildRetryWorkerOptions,
  closeDb,
  configureStorageEncryption,
  createHttpServer,
  getActivationNoticeQueue,
  getApi,
  getDb,
  initDb,
  loadStartupConfig,
  markBotUnhealthy,
  pipelineTracker,
  runRetryWorker,
  setActivationNoticeQueue,
  setApi,
  setLogger,
  shutdownActivationNotices,
  signWorkerRequest,
  type AppConfig,
} from "./entrypoints.js";
import { FakeTelegram } from "./fakeTelegram.js";
import { publishSenderDomain, stubSenderDns } from "./mail.js";

export const OWNER = 7_001n;
/** The group the alias forwards to; the owner's private chat is OWNER. */
export const ALIAS_CHAT = -1_001_700_000_001n;
export const HOSTED_DOMAIN = "mail.example.net";
export const LOCAL_PART = "inbox";
export const ALIAS_ADDRESS = `${LOCAL_PART}@${HOSTED_DOMAIN}`;
export const PUBLIC_BASE_URL = "https://relay.example.net";
/** Publishes a DKIM key and p=reject DMARC in the stubbed DNS. */
export const ALLOWED_DOMAIN = "sender.example.org";
export const ALLOWED_SENDER = `alerts@${ALLOWED_DOMAIN}`;
/** Also authenticates, but no allow rule names it. */
export const OTHER_DOMAIN = "other.example.org";
export const OTHER_SENDER = `news@${OTHER_DOMAIN}`;

const WORKER_SECRET = "scenario-worker-secret-0123456789abcdef";
const HMAC_SECRET = "scenario-hmac-secret-0123456789abcdef";

/** How long a wait helper polls before it fails with the state it saw. */
const SETTLED_TIMEOUT_MS = 10_000;
/**
 * Per-test timeout for every scenario file (pass it to the describe block).
 * Well above twice SETTLED_TIMEOUT_MS, so a hang fails with the harness's
 * message, not vitest's, and well above the sender's real 1 s + 2 s backoff.
 */
export const SCENARIO_TEST_TIMEOUT_MS = 30_000;

export interface Envelope {
  localPart: string;
  recipientDomain: string;
  envelopeFrom: string;
}

export interface AllowRule {
  matchType: "exact_email" | "domain";
  matchValue: string;
}

export interface SeededAlias {
  id: string;
  chatId: bigint;
}

export interface DeliveryLogRow {
  id: string;
  final_status: string;
  has_attachments: boolean;
  raw_email_path: string | null;
}

export interface AttemptRow {
  attempt_no: number;
  status: string;
  target_chat_id: string;
  error_class: string | null;
}

export interface AttachmentRow {
  id: string;
  original_filename: string | null;
  content_type: string | null;
  size_bytes: number | null;
  storage_path: string;
}

export interface UsageTotals {
  delivered: number;
  rejected: number;
  egressBytes: number;
}

export function envelopeFor(sender: string): Envelope {
  return { localPart: LOCAL_PART, recipientDomain: HOSTED_DOMAIN, envelopeFrom: sender };
}

export class ScenarioHarness {
  readonly telegram = new FakeTelegram();
  private pgdb: PgTestDatabase | null = null;
  private server: FastifyInstance | null = null;
  private appConfig: AppConfig | null = null;
  private root = "";
  private savedEnv: Record<string, string | undefined> = {};

  get pg(): PgTestDatabase {
    if (!this.pgdb) throw new Error("harness database not started");
    return this.pgdb;
  }

  get app(): FastifyInstance {
    if (!this.server) throw new Error("harness server not started");
    return this.server;
  }

  get config(): AppConfig {
    if (!this.appConfig) throw new Error("harness config not loaded");
    return this.appConfig;
  }

  get attachmentDir(): string {
    return join(this.root, "attachments");
  }

  get rawEmailDir(): string {
    return join(this.root, "raw");
  }

  async startFile(): Promise<void> {
    setLogger(pino({ level: process.env["SCENARIO_LOG_LEVEL"] ?? "silent" }));
    stubSenderDns();
    publishSenderDomain(ALLOWED_DOMAIN);
    publishSenderDomain(OTHER_DOMAIN);
    this.pgdb = await createPgTestDatabase();
    await this.pgdb.migrate();
  }

  async stopFile(): Promise<void> {
    vi.restoreAllMocks();
    await this.pgdb?.drop();
    this.pgdb = null;
  }

  async startTest(): Promise<void> {
    // A delivery a failed test left running would otherwise wake inside this
    // test and write into its tables or its fake Telegram. Checked first, so
    // a throw here leaves no temp dir or env behind.
    try {
      await pipelineTracker.drain(SETTLED_TIMEOUT_MS);
    } catch {
      throw new Error("a previous scenario left deliveries in flight");
    }
    this.root = await mkdtemp(join(tmpdir(), "etg-scenario-"));
    this.setEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      APP_MODE: "hosted",
      HOSTED_MAIL_DOMAIN: HOSTED_DOMAIN,
      MAIL_DOMAIN: HOSTED_DOMAIN,
      DATABASE_URL: this.pg.url,
      TELEGRAM_BOT_TOKEN: "123456:scenario-fake-token",
      TELEGRAM_RICH_MESSAGES_ENABLED: "false",
      HTTP_PORT: "3000",
      PUBLIC_BASE_URL,
      ATTACHMENT_DIR: this.attachmentDir,
      RAW_EMAIL_DIR: this.rawEmailDir,
      WORKER_SECRET,
      HMAC_SECRET,
      STORAGE_ENCRYPTION_MODE: "none",
      BILLING_PROVIDER: "none",
      PLAN_LIMITS: undefined,
    });
    // Applies PLAN_LIMITS (none), so a test's plan overrides never leak.
    this.appConfig = loadStartupConfig();
    configureStorageEncryption({ mode: this.appConfig.storageEncryptionMode });

    await this.truncateAll();
    initDb(this.appConfig.databaseUrl);
    this.telegram.reset();
    setApi(this.telegram.api);
    markBotUnhealthy();
    setActivationNoticeQueue(null);
    this.server = await createHttpServer(this.appConfig);
    await this.server.ready();
  }

  /**
   * Every step runs even when an earlier one throws (a drain that timed out,
   * say), so a failed test never leaks its server, pool, files or env into
   * the next; the first error is rethrown at the end.
   */
  async stopTest(): Promise<void> {
    const errors: unknown[] = [];
    const step = async (work: () => unknown): Promise<void> => {
      try {
        await work();
      } catch (err: unknown) {
        errors.push(err);
      }
    };
    await step(() => pipelineTracker.drain(SETTLED_TIMEOUT_MS));
    // Waits for (or stops) a first-bounce notice still running, then lets
    // the next test create a fresh queue.
    await step(() => shutdownActivationNotices());
    await step(() => setActivationNoticeQueue(null));
    await step(() => this.server?.close());
    this.server = null;
    await step(() => closeDb());
    const root = this.root;
    this.root = "";
    if (root) await step(() => rm(root, { recursive: true, force: true }));
    this.restoreEnv();
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "scenario teardown failed");
  }

  // ── Seeding ──────────────────────────────────────────────────────────────

  /** The owner, their chats, the shared hosted domain and one active alias with `allow` rules. */
  async seedAlias({
    allow = [{ matchType: "domain", matchValue: ALLOWED_DOMAIN }],
    chatId = ALIAS_CHAT,
    chatType = "supergroup",
  }: { allow?: AllowRule[]; chatId?: bigint; chatType?: string } = {}): Promise<SeededAlias> {
    await this.query("insert into users (id, is_allowed, locale) values ($1, true, 'en')", [
      OWNER.toString(),
    ]);
    await this.query(
      "insert into chats (id, title, type) values ($1, 'Owner', 'private'), ($2, 'Alerts', $3)",
      [OWNER.toString(), chatId.toString(), chatType],
    );
    const [domain] = await this.query<{ id: string }>(
      "insert into inbound_domains (domain, kind, status) values ($1, 'shared', 'active') returning id",
      [HOSTED_DOMAIN],
    );
    const [alias] = await this.query<{ id: string }>(
      `insert into email_addresses (local_part, full_address, domain_id, chat_id, created_by, status)
       values ($1, $2, $3, $4, $5, 'active') returning id`,
      [LOCAL_PART, ALIAS_ADDRESS, domain.id, chatId.toString(), OWNER.toString()],
    );
    for (const rule of allow) {
      await this.query(
        "insert into allow_rules (email_address_id, match_type, match_value) values ($1, $2, $3)",
        [alias.id, rule.matchType, rule.matchValue],
      );
    }
    return { id: alias.id, chatId };
  }

  /** `count` delivery logs for the alias, received `minutesAgo` minutes ago (inside the hourly window). */
  async seedRecentDeliveries(aliasId: string, count: number, minutesAgo = 5): Promise<void> {
    await this.query(
      `insert into delivery_logs (email_address_id, user_id, final_status, received_at)
       select $1, $2, 'delivered', now() - make_interval(mins => $3::int)
       from generate_series(1, $4::int)`,
      [aliasId, OWNER.toString(), minutesAgo, count],
    );
  }

  // ── Worker requests ──────────────────────────────────────────────────────

  /** POST /inbound/preflight as the Worker sends it. */
  async preflight(envelope: Envelope): Promise<LightMyRequestResponse> {
    const body = Buffer.from(
      JSON.stringify({
        localPart: envelope.localPart,
        recipientDomain: envelope.recipientDomain,
        envelopeFrom: envelope.envelopeFrom,
      }),
    );
    const { signature, timestamp } = signWorkerRequest(body);
    return this.app.inject({
      method: "POST",
      url: "/inbound/preflight",
      headers: {
        "content-type": "application/json",
        "x-worker-sig": signature,
        "x-worker-ts": timestamp,
      },
      payload: body,
    });
  }

  /** POST /inbound/raw as the Worker sends it: v2 signature over the routing headers and the bytes. */
  async raw(mail: Buffer, envelope: Envelope): Promise<LightMyRequestResponse> {
    const { signature, timestamp, signatureVersion } = signWorkerRequest(mail, envelope);
    return this.app.inject({
      method: "POST",
      url: "/inbound/raw",
      headers: {
        "content-type": "application/octet-stream",
        "x-worker-sig": signature,
        "x-worker-sig-v": signatureVersion,
        "x-worker-ts": timestamp,
        "x-local-part": envelope.localPart,
        "x-recipient-domain": envelope.recipientDomain,
        "x-envelope-from": envelope.envelopeFrom,
      },
      payload: mail,
    });
  }

  async download(url: string): Promise<LightMyRequestResponse> {
    const { pathname } = new URL(url);
    return this.app.inject({ method: "GET", url: pathname });
  }

  // ── Waiting ──────────────────────────────────────────────────────────────

  /**
   * The raw route answers 202 and delivers afterwards; waits until no log is
   * still received or processing, then for the in-flight work (photos) to end.
   */
  async waitForSettledDeliveries(): Promise<void> {
    const deadline = Date.now() + SETTLED_TIMEOUT_MS;
    for (;;) {
      const [row] = await this.query<{ open: number }>(
        "select count(*)::int as open from delivery_logs where final_status in ('received', 'processing')",
      );
      if (row.open === 0) break;
      if (Date.now() > deadline) throw new Error(`${row.open} deliveries did not settle`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // The last status write lands just before the tracker decrements, so the
    // drain keeps a small floor even when the poll used up the deadline.
    await pipelineTracker.drain(Math.max(500, deadline - Date.now()));
  }

  /**
   * Waits for the first-bounce notices a bounced raw upload admits after its
   * response (src/activation/notice.ts) to finish, so a test sees every
   * Telegram message the bounce leads to, or that none was sent.
   */
  async waitForNotices(): Promise<void> {
    // The route admits the notice synchronously right after its awaited
    // response is sent, which is before inject() resolves, so the job is
    // already in the queue here. getActivationNoticeQueue() creates an empty,
    // idle queue when no notice was admitted.
    const queue = getActivationNoticeQueue();
    if (!queue) return;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${queue.admitted} first-bounce notices did not settle`)),
        SETTLED_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([queue.whenIdle(), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Moves every log's received_at back, past the retry worker's two-minute wait. */
  async backdateDeliveries(minutes: number): Promise<void> {
    await this.query(
      "update delivery_logs set received_at = received_at - make_interval(mins => $1::int)",
      [minutes],
    );
  }

  /** One retry-worker run, as the app's five-minute timer starts it. */
  async runRetryWorker(): Promise<void> {
    await runRetryWorker(getDb(), getApi(), buildRetryWorkerOptions(this.config));
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async query<T extends object = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const result = await this.pg.pool.query<T>(text, params);
    return result.rows;
  }

  async deliveryLogs(): Promise<DeliveryLogRow[]> {
    return this.query<DeliveryLogRow>(
      "select id, final_status, has_attachments, raw_email_path from delivery_logs order by received_at, id",
    );
  }

  async attempts(deliveryLogId: string): Promise<AttemptRow[]> {
    return this.query<AttemptRow>(
      `select attempt_no, status, target_chat_id::text as target_chat_id, error_class
       from delivery_attempts where delivery_log_id = $1 order by attempt_no`,
      [deliveryLogId],
    );
  }

  async attachments(deliveryLogId: string): Promise<AttachmentRow[]> {
    return this.query<AttachmentRow>(
      `select id, original_filename, content_type, size_bytes, storage_path
       from attachments where delivery_log_id = $1 order by original_filename`,
      [deliveryLogId],
    );
  }

  /** The owner's usage over every month (a backdated log may sit in another month). */
  async usage(): Promise<UsageTotals> {
    const [row] = await this.query<UsageTotals>(
      `select coalesce(sum(delivered_count), 0)::int as delivered,
              coalesce(sum(rejected_count), 0)::int as rejected,
              coalesce(sum(egress_bytes), 0)::int as "egressBytes"
       from user_usage_months where user_id = $1`,
      [OWNER.toString()],
    );
    return row;
  }

  async quotaNotices(): Promise<string[]> {
    const rows = await this.query<{ reason: string }>(
      "select reason from user_quota_notifications where user_id = $1 order by reason",
      [OWNER.toString()],
    );
    return rows.map((row) => row.reason);
  }

  async aliasChatId(aliasId: string): Promise<string> {
    const [row] = await this.query<{ chat_id: string }>(
      "select chat_id::text as chat_id from email_addresses where id = $1",
      [aliasId],
    );
    return row.chat_id;
  }

  /** Every file under the raw email directory, relative to it, sorted. */
  async rawFiles(): Promise<string[]> {
    return listFiles(this.rawEmailDir);
  }

  /** Every file under the attachment directory, relative to it, sorted. */
  async attachmentFiles(): Promise<string[]> {
    return listFiles(this.attachmentDir);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async truncateAll(): Promise<void> {
    const tables = await this.query<{ name: string }>(
      `select quote_ident(tablename) as name from pg_tables
       where schemaname = 'public' and tablename not like '\\_\\_drizzle%'`,
    );
    if (tables.length === 0) return;
    await this.query(`truncate ${tables.map((t) => t.name).join(", ")} cascade`);
  }

  private setEnv(values: Record<string, string | undefined>): void {
    for (const [key, value] of Object.entries(values)) {
      this.savedEnv[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  private restoreEnv(): void {
    for (const [key, value] of Object.entries(this.savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    this.savedEnv = {};
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return [];
      throw err;
    },
  );
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/** Registers the per-file and per-test hooks and returns the harness they drive. */
export function useScenarioHarness(): ScenarioHarness {
  const harness = new ScenarioHarness();
  beforeAll(() => harness.startFile());
  afterAll(() => harness.stopFile());
  beforeEach(() => harness.startTest());
  afterEach(() => harness.stopTest());
  return harness;
}
