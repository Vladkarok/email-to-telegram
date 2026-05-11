import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpServer } from "../../../src/http/server.js";
import { resetMetricsForTests } from "../../../src/observability/metrics.js";
import type { AppConfig } from "../../../src/config.js";

const mockCountOrganizationsByPlan = vi.fn();

vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../../src/db/repos/organizations.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/db/repos/organizations.js")>(
    "../../../src/db/repos/organizations.js",
  );
  return {
    ...actual,
    countOrganizationsByPlan: (...args: unknown[]): unknown =>
      mockCountOrganizationsByPlan(...args),
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
};

describe("GET /metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMetricsForTests();
    mockCountOrganizationsByPlan.mockResolvedValue([
      { planCode: "free", count: 2 },
      { planCode: "pro", count: 1 },
    ]);
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
    expect(res.body).toContain("email_to_telegram_active_organizations");
    expect(res.body).toContain('plan="free"');
    expect(mockCountOrganizationsByPlan).toHaveBeenCalledOnce();
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
