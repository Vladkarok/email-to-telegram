import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpServer } from "../../../src/http/server.js";
import { resetMetricsForTests } from "../../../src/observability/metrics.js";
import type { AppConfig } from "../../../src/config.js";

const mockCountOrganizationsByPlan = vi.fn();
const mockCountUsers = vi.fn();
const mockCountChats = vi.fn();
const mockCountAliasesByStatus = vi.fn();
const mockCountAttachmentStorage = vi.fn();

vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));
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
    expect(res.body).toMatch(/email_to_telegram_chats\{[^}]*state="active"[^}]*\} 4/);
    expect(res.body).toMatch(/email_to_telegram_aliases\{[^}]*status="active"[^}]*\} 7/);
    expect(res.body).toMatch(/email_to_telegram_attachments_stored\{[^}]*\} 12/);
    expect(res.body).toMatch(/email_to_telegram_attachments_stored_bytes\{[^}]*\} 34567/);
    expect(mockCountOrganizationsByPlan).toHaveBeenCalledOnce();
    expect(mockCountUsers).toHaveBeenCalledOnce();
    expect(mockCountChats).toHaveBeenCalledOnce();
    expect(mockCountAliasesByStatus).toHaveBeenCalledOnce();
    expect(mockCountAttachmentStorage).toHaveBeenCalledOnce();
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
