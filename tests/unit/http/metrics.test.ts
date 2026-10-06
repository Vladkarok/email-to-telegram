import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpServer } from "../../../src/http/server.js";
import { resetMetricsForTests } from "../../../src/observability/metrics.js";
import type { AppConfig } from "../../../src/config.js";

const mockCountOrganizationsByPlan = vi.fn();
const mockCountUsers = vi.fn();
const mockCountChats = vi.fn();
const mockCountAliasesByStatus = vi.fn();
const mockCountAttachmentStorage = vi.fn();
const mockCountUsersWithAlias = vi.fn();
const mockCountUsersWithAcceptedMailInMonth = vi.fn();
const mockCountUsersEverDelivered = vi.fn();
const mockSummarizeDeliveryBacklog = vi.fn();

vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../../src/db/repos/deliveryLogs.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/db/repos/deliveryLogs.js")>(
    "../../../src/db/repos/deliveryLogs.js",
  );
  return {
    ...actual,
    summarizeDeliveryBacklog: (...args: unknown[]): unknown =>
      mockSummarizeDeliveryBacklog(...args),
  };
});
vi.mock("../../../src/db/repos/users.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/db/repos/users.js")>(
    "../../../src/db/repos/users.js",
  );
  return {
    ...actual,
    countUsersByPlan: (...args: unknown[]): unknown => mockCountOrganizationsByPlan(...args),
    countUsers: (...args: unknown[]): unknown => mockCountUsers(...args),
  };
});
vi.mock("../../../src/db/repos/chats.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/db/repos/chats.js")>(
    "../../../src/db/repos/chats.js",
  );
  return { ...actual, countChats: (...args: unknown[]): unknown => mockCountChats(...args) };
});
vi.mock("../../../src/db/repos/aliases.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/db/repos/aliases.js")>(
    "../../../src/db/repos/aliases.js",
  );
  return {
    ...actual,
    countAliasesByStatus: (...args: unknown[]): unknown => mockCountAliasesByStatus(...args),
    countUsersWithAlias: (...args: unknown[]): unknown => mockCountUsersWithAlias(...args),
  };
});
vi.mock("../../../src/db/repos/usage.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/db/repos/usage.js")>(
    "../../../src/db/repos/usage.js",
  );
  return {
    ...actual,
    countUsersWithAcceptedMailInMonth: (...args: unknown[]): unknown =>
      mockCountUsersWithAcceptedMailInMonth(...args),
    countUsersEverDelivered: (...args: unknown[]): unknown => mockCountUsersEverDelivered(...args),
  };
});
vi.mock("../../../src/db/repos/attachments.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/db/repos/attachments.js")>(
    "../../../src/db/repos/attachments.js",
  );
  return {
    ...actual,
    countAttachmentStorage: (...args: unknown[]): unknown => mockCountAttachmentStorage(...args),
  };
});

const METRICS_TOKEN = "test-metrics-token-32-characters";

const BASE_CONFIG: AppConfig = {
  appMode: "self-hosted",
  billingProvider: "none",
  databaseUrl: "postgres://app:pass@localhost:5432/db",
  telegramBotToken: "123456:ABC",
  telegramRichMessagesEnabled: true,
  mailDomain: "mail.example.com",
  hostedMailDomain: undefined,
  publicBaseUrl: "https://mail.example.com",
  httpPort: 3000,
  hmacSecret: "h".repeat(32),
  workerSecret: "w".repeat(32),
  attachmentDir: "/tmp/attachments",
  rawEmailDir: "/tmp/rawemails",
  attachmentTtlHours: 24,
  rawEmailTtlHours: 24,
  deliveryLogRetentionDays: 30,
  storageEncryptionMode: "none",
  masterEncryptionKey: undefined,
  masterEncryptionKeyId: "local-env-v1",
  masterEncryptionKeyring: {},
  maxSizeBytes: 1024 * 1024,
  logLevel: "silent",
  nodeEnv: "test",
  initialAllowedUsers: [],
  healthchecksUrl: undefined,
  alertChatId: undefined,
  backupDir: undefined,
  backupArchiveEncryption: "off",
  stripeSecretKey: undefined,
  stripeWebhookSecret: undefined,
  stripePriceIds: undefined,
  billingSuccessUrl: undefined,
  billingCancelUrl: undefined,
  adminEnabled: false,
  adminSecret: undefined,
  adminSessionSecret: undefined,
  adminSessionTtlMinutes: 60,
  metricsEnabled: false,
  metricsToken: undefined,
  trustProxy: false,
};

describe("GET /metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMetricsForTests();
    mockCountOrganizationsByPlan.mockResolvedValue([
      { planCode: "free", count: 2 },
      { planCode: "pro", count: 1 },
    ]);
    mockCountUsers.mockResolvedValue({ total: 5, allowed: 3 });
    mockCountChats.mockResolvedValue({ total: 4, active: 4 });
    mockCountAliasesByStatus.mockResolvedValue([
      { status: "active", count: 7 },
      { status: "paused", count: 1 },
    ]);
    mockCountAttachmentStorage.mockResolvedValue({ count: 12, bytes: 34567 });
    mockCountUsersWithAlias.mockResolvedValue(4);
    mockCountUsersWithAcceptedMailInMonth.mockResolvedValue(2);
    mockCountUsersEverDelivered.mockResolvedValue(3);
    mockSummarizeDeliveryBacklog.mockResolvedValue({
      counts: { failed: 2, received: 1 },
      oldestReceivedAt: new Date(Date.now() - 10 * 60 * 1000),
    });
  });

  it("returns 404 when metrics are disabled", async () => {
    const app = await createHttpServer(BASE_CONFIG);
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(404);
  });

  it("rejects missing or invalid bearer tokens", async () => {
    const app = await createHttpServer({
      ...BASE_CONFIG,
      metricsEnabled: true,
      metricsToken: METRICS_TOKEN,
    });

    const missing = await app.inject({ method: "GET", url: "/metrics" });
    expect(missing.statusCode).toBe(401);

    const invalid = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer wrong" },
    });
    expect(invalid.statusCode).toBe(401);
  });

  it("returns Prometheus metrics for a valid bearer token", async () => {
    const app = await createHttpServer({
      ...BASE_CONFIG,
      metricsEnabled: true,
      metricsToken: METRICS_TOKEN,
    });

    await app.inject({ method: "GET", url: "/healthz" });
    const res = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain("email_to_telegram_http_requests_total");
    expect(res.body).toContain('route="/healthz"');
    expect(res.body).toContain("email_to_telegram_active_users_by_plan");
    expect(res.body).toContain('plan="free"');
    expect(res.body).toMatch(/email_to_telegram_users_total\{[^}]*\} 3/);
    expect(res.body).toMatch(/email_to_telegram_users\{[^}]*state="total"[^}]*\} 5/);
    expect(res.body).toMatch(/email_to_telegram_users\{[^}]*state="allowed"[^}]*\} 3/);
    expect(res.body).toMatch(/email_to_telegram_users\{[^}]*state="with_alias"[^}]*\} 4/);
    expect(res.body).toMatch(
      /email_to_telegram_users\{[^}]*state="accepted_mail_this_month"[^}]*\} 2/,
    );
    expect(res.body).toMatch(/email_to_telegram_chats\{[^}]*state="active"[^}]*\} 4/);
    expect(res.body).toMatch(/email_to_telegram_aliases\{[^}]*status="active"[^}]*\} 7/);
    expect(res.body).toMatch(/email_to_telegram_attachments_stored\{[^}]*\} 12/);
    expect(res.body).toMatch(/email_to_telegram_attachments_stored_bytes\{[^}]*\} 34567/);
    expect(res.body).toMatch(/email_to_telegram_users\{[^}]*state="ever_delivered"[^}]*\} 3/);
    expect(mockCountOrganizationsByPlan).toHaveBeenCalledOnce();
    expect(mockCountUsers).toHaveBeenCalledOnce();
    expect(mockCountChats).toHaveBeenCalledOnce();
    expect(mockCountAliasesByStatus).toHaveBeenCalledOnce();
    expect(mockCountAttachmentStorage).toHaveBeenCalledOnce();
    expect(mockCountUsersWithAlias).toHaveBeenCalledOnce();
    expect(mockCountUsersWithAcceptedMailInMonth).toHaveBeenCalledOnce();
    expect(mockCountUsersEverDelivered).toHaveBeenCalledOnce();
    expect(mockSummarizeDeliveryBacklog).toHaveBeenCalledOnce();
  });

  it("exposes the delivery backlog per non-final state with the oldest age", async () => {
    const app = await createHttpServer({
      ...BASE_CONFIG,
      metricsEnabled: true,
      metricsToken: METRICS_TOKEN,
    });

    const res = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/email_to_telegram_delivery_backlog\{[^}]*state="failed"[^}]*\} 2/);
    expect(res.body).toMatch(/email_to_telegram_delivery_backlog\{[^}]*state="received"[^}]*\} 1/);
    // States without rows still get a series, at 0.
    expect(res.body).toMatch(
      /email_to_telegram_delivery_backlog\{[^}]*state="processing"[^}]*\} 0\n/,
    );
    expect(res.body).toMatch(
      /email_to_telegram_delivery_backlog\{[^}]*state="retrying"[^}]*\} 0\n/,
    );
    const age = Number(
      /email_to_telegram_delivery_backlog_oldest_age_seconds\{[^}]*\} ([\d.]+)/.exec(res.body)?.[1],
    );
    expect(age).toBeGreaterThanOrEqual(600);
    expect(age).toBeLessThan(660);
  });

  it("drops a drained backlog to 0 with an oldest age of 0", async () => {
    const app = await createHttpServer({
      ...BASE_CONFIG,
      metricsEnabled: true,
      metricsToken: METRICS_TOKEN,
    });
    const scrape = async (): Promise<string> =>
      (
        await app.inject({
          method: "GET",
          url: "/metrics",
          headers: { authorization: `Bearer ${METRICS_TOKEN}` },
        })
      ).body;

    await scrape();
    mockSummarizeDeliveryBacklog.mockResolvedValueOnce({ counts: {}, oldestReceivedAt: null });
    const body = await scrape();

    expect(body).toMatch(/email_to_telegram_delivery_backlog\{[^}]*state="failed"[^}]*\} 0\n/);
    expect(body).toMatch(/email_to_telegram_delivery_backlog_oldest_age_seconds\{[^}]*\} 0\n/);
  });

  it("exposes build info with the package.json version", async () => {
    const { version } = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const app = await createHttpServer({
      ...BASE_CONFIG,
      metricsEnabled: true,
      metricsToken: METRICS_TOKEN,
    });

    const res = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });

    expect(res.body).toMatch(
      new RegExp(`email_to_telegram_build_info\\{[^}]*version="${version}"[^}]*\\} 1\\n`),
    );
  });

  it("exposes known counter label sets at 0 before any event", async () => {
    const app = await createHttpServer({
      ...BASE_CONFIG,
      metricsEnabled: true,
      metricsToken: METRICS_TOKEN,
    });

    const res = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });

    for (const series of [
      /email_to_telegram_inbound_preflight_total\{result="accepted",reason="accepted"[^}]*\} 0\n/,
      /email_to_telegram_inbound_preflight_total\{result="deferred",reason="rate_limited"[^}]*\} 0\n/,
      /email_to_telegram_inbound_preflight_total\{result="rejected",reason="monthly_email_limit"[^}]*\} 0\n/,
      /email_to_telegram_raw_inbound_total\{result="rejected",reason="sender_auth_failed"[^}]*\} 0\n/,
      /email_to_telegram_delivery_attempts_total\{result="succeeded"[^}]*\} 0\n/,
      /email_to_telegram_retry_attempts_total\{result="permanently_failed"[^}]*\} 0\n/,
      /email_to_telegram_telegram_send_failures_total\{error_class="forbidden"[^}]*\} 0\n/,
      /email_to_telegram_rich_messages_total\{result="fallback"[^}]*\} 0\n/,
      /email_to_telegram_quota_rejections_total\{reason="storage_limit"[^}]*\} 0\n/,
      /email_to_telegram_delivery_latency_seconds_count\{[^}]*path="initial"[^}]*\} 0\n/,
      /email_to_telegram_delivery_latency_seconds_count\{[^}]*path="retry"[^}]*\} 0\n/,
    ]) {
      expect(res.body).toMatch(series);
    }
  });

  it("still serves metrics when business gauge refresh fails", async () => {
    mockCountUsers.mockRejectedValueOnce(new Error("db down"));
    const app = await createHttpServer({
      ...BASE_CONFIG,
      metricsEnabled: true,
      metricsToken: METRICS_TOKEN,
    });

    const res = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("email_to_telegram_http_requests_total");
  });

  it("preserves last-known business gauge values when a refresh fails", async () => {
    const app = await createHttpServer({
      ...BASE_CONFIG,
      metricsEnabled: true,
      metricsToken: METRICS_TOKEN,
    });

    const primed = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });
    expect(primed.statusCode).toBe(200);
    expect(primed.body).toMatch(/email_to_telegram_aliases\{[^}]*status="active"[^}]*\} 7/);

    mockCountAliasesByStatus.mockRejectedValueOnce(new Error("db hiccup"));
    mockCountUsers.mockResolvedValueOnce({ total: 999, allowed: 999 });
    mockCountChats.mockResolvedValueOnce({ total: 999, active: 999 });
    mockCountUsersWithAlias.mockResolvedValueOnce(999);
    mockCountUsersWithAcceptedMailInMonth.mockResolvedValueOnce(999);
    mockCountUsersEverDelivered.mockResolvedValueOnce(999);
    mockSummarizeDeliveryBacklog.mockResolvedValueOnce({
      counts: { failed: 999 },
      oldestReceivedAt: null,
    });

    const stale = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });
    expect(stale.statusCode).toBe(200);
    // All-or-nothing: aliases AND every other business gauge must retain
    // the primed values, not the new mocked ones that would have applied
    // had the refresh succeeded.
    expect(stale.body).toMatch(/email_to_telegram_aliases\{[^}]*status="active"[^}]*\} 7/);
    expect(stale.body).toMatch(/email_to_telegram_users\{[^}]*state="total"[^}]*\} 5/);
    expect(stale.body).toMatch(/email_to_telegram_chats\{[^}]*state="active"[^}]*\} 4/);
    expect(stale.body).toMatch(/email_to_telegram_users\{[^}]*state="with_alias"[^}]*\} 4/);
    expect(stale.body).toMatch(
      /email_to_telegram_users\{[^}]*state="accepted_mail_this_month"[^}]*\} 2/,
    );
    expect(stale.body).toMatch(/email_to_telegram_users\{[^}]*state="ever_delivered"[^}]*\} 3/);
    expect(stale.body).toMatch(/email_to_telegram_delivery_backlog\{[^}]*state="failed"[^}]*\} 2/);
    expect(stale.body).not.toMatch(/email_to_telegram_users\{[^}]*state="total"[^}]*\} 999/);
  });

  it("rate limits metrics scrapes", async () => {
    const app = await createHttpServer({
      ...BASE_CONFIG,
      metricsEnabled: true,
      metricsToken: METRICS_TOKEN,
    });

    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/metrics",
        headers: { authorization: `Bearer ${METRICS_TOKEN}` },
      });
      lastStatus = res.statusCode;
    }

    expect(lastStatus).toBe(429);
  });
});
