import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { parse as parseQs } from "querystring";
import { registerRoutes } from "../../../src/http/routes/index.js";

const mockFindUserById = vi.fn();
const mockListOrganizationMembershipsForUser = vi.fn();
const mockListOrganizationMembers = vi.fn();
const mockFindOrganizationById = vi.fn();
const mockCountActiveAliasesByOrganization = vi.fn();
const mockGetOrganizationUsageMonth = vi.fn();
const mockListManualBillingEventsForOrganization = vi.fn();
const mockGrantManualOrganizationPlan = vi.fn();

vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../../src/db/repos/users.js", () => ({
  findUserById: (...args: unknown[]): unknown => mockFindUserById(...args),
}));
vi.mock("../../../src/db/repos/organizationMembers.js", () => ({
  listOrganizationMembershipsForUser: (...args: unknown[]): unknown =>
    mockListOrganizationMembershipsForUser(...args),
  listOrganizationMembers: (...args: unknown[]): unknown => mockListOrganizationMembers(...args),
}));
vi.mock("../../../src/db/repos/organizations.js", () => ({
  findOrganizationById: (...args: unknown[]): unknown => mockFindOrganizationById(...args),
}));
vi.mock("../../../src/db/repos/aliases.js", () => ({
  countActiveAliasesByOrganization: (...args: unknown[]): unknown =>
    mockCountActiveAliasesByOrganization(...args),
}));
vi.mock("../../../src/db/repos/usage.js", () => ({
  getOrganizationUsageMonth: (...args: unknown[]): unknown =>
    mockGetOrganizationUsageMonth(...args),
  usageMonthForDate: () => "2026-05",
}));
vi.mock("../../../src/db/repos/manualBillingEvents.js", () => ({
  listManualBillingEventsForOrganization: (...args: unknown[]): unknown =>
    mockListManualBillingEventsForOrganization(...args),
}));
vi.mock("../../../src/billing/manual.js", () => ({
  grantManualOrganizationPlan: (...args: unknown[]): unknown =>
    mockGrantManualOrganizationPlan(...args),
}));
vi.mock("../../../src/telegram/health.js", () => ({
  isBotHealthy: () => true,
}));
vi.mock("../../../src/email/pipeline.js", () => ({
  queueInboundEmail: vi.fn(),
  deliverQueuedEmail: vi.fn(),
}));
vi.mock("../../../src/storage/disk.js", () => ({
  writeRawEmail: vi.fn(),
  writePendingRawEmailMeta: vi.fn(),
  deletePendingRawEmailMeta: vi.fn(),
  deleteFile: vi.fn(),
}));
vi.mock("../../../src/db/repos/allowRules.js", () => ({
  checkAllowRule: vi.fn(),
}));
vi.mock("../../../src/db/repos/deliveryLogs.js", () => ({
  countRecentDeliveriesByAlias: vi.fn(),
}));
vi.mock("../../../src/billing/limits.js", () => ({
  checkInboundLimit: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../../../src/db/repos/hostedInboundBlocks.js", () => ({
  findHostedInboundBlock: vi.fn().mockResolvedValue(null),
}));

const ADMIN_SECRET = "super-secret-admin-key-at-least-16";

const ADMIN_CONFIG = {
  publicBaseUrl: "https://mail.example.com",
  attachmentDir: "/tmp/attachments",
  attachmentTtlHours: 24,
  rawEmailDir: "/tmp/rawemails",
  rawEmailTtlHours: 24,
  maxSizeBytes: 1024 * 1024,
  adminEnabled: true,
  adminSecret: ADMIN_SECRET,
  adminSessionSecret: undefined,
  nodeEnv: "test",
  adminSessionTtlMinutes: 60,
};

const DISABLED_CONFIG = {
  ...ADMIN_CONFIG,
  adminEnabled: false,
  adminSecret: undefined,
};

async function buildApp(config = ADMIN_CONFIG) {
  const app = Fastify({ logger: false });
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "buffer" },
    (_req, body: Buffer, done) => {
      try {
        done(null, parseQs(body.toString("utf-8")));
      } catch (err: unknown) {
        done(err instanceof Error ? err : new Error(String(err)));
      }
    },
  );
  await registerRoutes(app, config);
  await app.ready();
  return app;
}

async function loginSession(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/admin/login",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: `secret=${encodeURIComponent(ADMIN_SECRET)}`,
  });
  expect(res.statusCode).toBe(302);
  const cookies = res.headers["set-cookie"];
  return Array.isArray(cookies) ? cookies.join("; ") : (cookies ?? "");
}

const ORG_ID = "00000000-0000-0000-0000-000000000001";

const MOCK_ORG_UPDATED_AT = new Date("2026-01-15T10:00:00.000Z");

const MOCK_ORG = {
  id: ORG_ID,
  name: "Test Org",
  planCode: "personal",
  subscriptionStatus: "active",
  paidThroughAt: new Date("2026-06-01"),
  createdAt: new Date("2025-01-01"),
  updatedAt: MOCK_ORG_UPDATED_AT,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
};

function extractCsrfToken(html: string): string {
  const match = html.match(/name="csrf-token" content="([a-f0-9]{64})"/);
  return match?.[1] ?? "";
}

function extractOrgVersion(html: string): string {
  const match = html.match(/name="_org_version" value="([^"]+)"/);
  return match?.[1] ?? "";
}

function makeGrantSuccess(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    idempotent: false,
    updated: true,
    organizationId: ORG_ID,
    telegramUserId: null,
    planCode: "pro",
    subscriptionStatus: "active",
    paidThroughAt: "2026-12-31T00:00:00.000Z",
    paymentReference: null,
    note: null,
    keptStripeLink: false,
    manualBillingEventId: "evt-1",
    operatorSource: "admin:abcdef1234567890",
    ...overrides,
  };
}

beforeEach(() => {
  mockFindUserById.mockReset();
  mockListOrganizationMembershipsForUser.mockReset().mockResolvedValue([]);
  mockListOrganizationMembers.mockReset().mockResolvedValue([]);
  mockFindOrganizationById.mockReset();
  mockCountActiveAliasesByOrganization.mockReset().mockResolvedValue(0);
  mockGetOrganizationUsageMonth.mockReset().mockResolvedValue(null);
  mockListManualBillingEventsForOrganization.mockReset().mockResolvedValue([]);
  mockGrantManualOrganizationPlan.mockReset();
});

describe("admin routes disabled", () => {
  it("returns 404 for /admin when disabled", async () => {
    const app = await buildApp(DISABLED_CONFIG);
    const res = await app.inject({ method: "GET", url: "/admin" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for /admin/login when disabled", async () => {
    const app = await buildApp(DISABLED_CONFIG);
    const res = await app.inject({ method: "GET", url: "/admin/login" });
    expect(res.statusCode).toBe(404);
  });
});

describe("admin login", () => {
  it("renders login page on GET /admin/login", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/admin/login" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Admin Login");
  });

  it("rejects invalid secret", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/admin/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "secret=wrong-secret",
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain("Invalid secret");
  });

  it("accepts valid secret and redirects to /admin", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/admin/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `secret=${encodeURIComponent(ADMIN_SECRET)}`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("/admin");
    expect(res.headers["set-cookie"]).toBeDefined();
  });
});

describe("admin auth guard", () => {
  it("redirects unauthenticated requests to /admin/login", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/admin" });
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("/admin/login");
  });

  it("allows authenticated requests", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const res = await app.inject({
      method: "GET",
      url: "/admin",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Admin Dashboard");
  });
});

describe("admin logout", () => {
  it("destroys session and redirects to login", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const res = await app.inject({
      method: "GET",
      url: "/admin/logout",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("/admin/login");

    const res2 = await app.inject({
      method: "GET",
      url: "/admin",
      headers: { cookie },
    });
    expect(res2.statusCode).toBe(302);
    expect(res2.headers["location"]).toBe("/admin/login");
  });
});

describe("admin user search", () => {
  it("renders search page without results when no query", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const res = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("User Search");
    expect(res.body).not.toContain("No users found");
  });

  it("returns search results for numeric query", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);

    mockFindUserById.mockResolvedValue(null);

    const { getDb } = await import("../../../src/db/client.js");
    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([
            {
              id: 12345n,
              username: "testuser",
              isAllowed: true,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ]),
        }),
      }),
    });
    vi.mocked(getDb).mockReturnValue({ select: mockSelect } as unknown as ReturnType<typeof getDb>);

    const res = await app.inject({
      method: "GET",
      url: "/admin/users?q=12345",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("12345");
  });
});

describe("admin user detail", () => {
  it("returns 404 for unknown user", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    mockFindUserById.mockResolvedValue(null);
    const res = await app.inject({
      method: "GET",
      url: "/admin/users/99999",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("renders user detail page", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);

    mockFindUserById.mockResolvedValue({
      id: 12345n,
      username: "testuser",
      isAllowed: true,
      createdAt: new Date("2025-01-01"),
      updatedAt: new Date(),
    });
    mockListOrganizationMembershipsForUser.mockResolvedValue([]);

    const res = await app.inject({
      method: "GET",
      url: "/admin/users/12345",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("12345");
    expect(res.body).toContain("testuser");
  });

  it("rejects non-numeric user IDs", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const res = await app.inject({
      method: "GET",
      url: "/admin/users/abc",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("admin organization detail", () => {
  it("returns 404 for unknown organization", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    mockFindOrganizationById.mockResolvedValue(null);
    const res = await app.inject({
      method: "GET",
      url: "/admin/organizations/00000000-0000-0000-0000-000000000000",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("renders organization detail page", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);

    const orgId = "00000000-0000-0000-0000-000000000001";
    mockFindOrganizationById.mockResolvedValue({
      id: orgId,
      name: "Test Org",
      planCode: "personal",
      subscriptionStatus: "active",
      paidThroughAt: new Date("2026-06-01"),
      createdAt: new Date("2025-01-01"),
      updatedAt: new Date(),
    });
    mockListOrganizationMembers.mockResolvedValue([]);
    mockCountActiveAliasesByOrganization.mockResolvedValue(3);
    mockGetOrganizationUsageMonth.mockResolvedValue({
      deliveredCount: 42,
      rejectedCount: 5,
    });
    mockListManualBillingEventsForOrganization.mockResolvedValue([]);

    const res = await app.inject({
      method: "GET",
      url: `/admin/organizations/${orgId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Test Org");
    expect(res.body).toContain("personal");
    expect(res.body).toContain("42 delivered");
  });
});

describe("admin CSRF protection", () => {
  it("verifyCsrfToken rejects missing token", async () => {
    const { verifyCsrfToken } = await import("../../../src/http/routes/admin/auth.js");
    const req = {
      session: { admin: { csrfToken: "abc123" } },
      body: {},
    } as unknown as import("fastify").FastifyRequest;
    expect(verifyCsrfToken(req)).toBe(false);
  });

  it("verifyCsrfToken rejects wrong token", async () => {
    const { verifyCsrfToken } = await import("../../../src/http/routes/admin/auth.js");
    const req = {
      session: { admin: { csrfToken: "correct-token" } },
      body: { _csrf: "wrong-token" },
    } as unknown as import("fastify").FastifyRequest;
    expect(verifyCsrfToken(req)).toBe(false);
  });

  it("verifyCsrfToken accepts matching token", async () => {
    const { verifyCsrfToken, generateCsrfToken } =
      await import("../../../src/http/routes/admin/auth.js");
    const token = generateCsrfToken();
    const req = {
      session: { admin: { csrfToken: token } },
      body: { _csrf: token },
    } as unknown as import("fastify").FastifyRequest;
    expect(verifyCsrfToken(req)).toBe(true);
  });

  it("does not apply CSRF check to login POST", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/admin/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "secret=wrong",
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("admin auth module", () => {
  it("verifyAdminSecret uses constant-time comparison", async () => {
    const { verifyAdminSecret } = await import("../../../src/http/routes/admin/auth.js");
    expect(verifyAdminSecret("correct-secret-here", "correct-secret-here")).toBe(true);
    expect(verifyAdminSecret("wrong", "correct-secret-here")).toBe(false);
    expect(verifyAdminSecret("", "correct-secret-here")).toBe(false);
  });

  it("generateCsrfToken returns hex string", async () => {
    const { generateCsrfToken } = await import("../../../src/http/routes/admin/auth.js");
    const token = generateCsrfToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });
});

async function getCsrfAndVersion(
  app: FastifyInstance,
  cookie: string,
): Promise<{ csrf: string; orgVersion: string }> {
  mockFindOrganizationById.mockResolvedValueOnce(MOCK_ORG);
  const res = await app.inject({
    method: "GET",
    url: `/admin/organizations/${ORG_ID}`,
    headers: { cookie },
  });
  return { csrf: extractCsrfToken(res.body), orgVersion: extractOrgVersion(res.body) };
}

async function getCsrfToken(app: FastifyInstance, cookie: string): Promise<string> {
  const { csrf } = await getCsrfAndVersion(app, cookie);
  return csrf;
}

describe("admin billing mutations", () => {
  it("grants a plan and redirects with billing=granted flash", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const { csrf, orgVersion } = await getCsrfAndVersion(app, cookie);

    mockGrantManualOrganizationPlan.mockResolvedValue(makeGrantSuccess());

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&_org_version=${encodeURIComponent(orgVersion)}&plan=pro&status=active&paid_through=2026-12-31&payment_reference=wise-2026-001`,
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe(`/admin/organizations/${ORG_ID}?billing=granted`);
    expect(mockGrantManualOrganizationPlan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG_ID,
        planCode: "pro",
        subscriptionStatus: "active",
        paymentReference: "wise-2026-001",
        operatorSource: expect.stringMatching(/^admin:/) as unknown,
      }),
    );
  });

  it("redirects with billing=idempotent when payment reference already exists", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const { csrf, orgVersion } = await getCsrfAndVersion(app, cookie);

    mockGrantManualOrganizationPlan.mockResolvedValue(
      makeGrantSuccess({ idempotent: true, updated: false }),
    );

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&_org_version=${encodeURIComponent(orgVersion)}&plan=pro&status=active&paid_through=2026-12-31&payment_reference=wise-2026-001`,
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe(`/admin/organizations/${ORG_ID}?billing=idempotent`);
  });

  it("shows success flash on GET after redirect", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    mockFindOrganizationById.mockResolvedValue(MOCK_ORG);

    const res = await app.inject({
      method: "GET",
      url: `/admin/organizations/${ORG_ID}?billing=granted`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Plan updated successfully");
  });

  it("shows idempotent flash on GET after redirect", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    mockFindOrganizationById.mockResolvedValue(MOCK_ORG);

    const res = await app.inject({
      method: "GET",
      url: `/admin/organizations/${ORG_ID}?billing=idempotent`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("payment reference already exists");
  });

  it("shows error when payment reference is already used for a different organization", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const { csrf, orgVersion } = await getCsrfAndVersion(app, cookie);

    mockGrantManualOrganizationPlan.mockResolvedValue({
      ok: false,
      code: "payment_reference_conflict",
    });

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&_org_version=${encodeURIComponent(orgVersion)}&plan=pro&status=active&paid_through=2026-12-31&payment_reference=wise-cross-org-001`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("already used for a different organization");
  });

  it("rejects POST without CSRF token with 403", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: "plan=pro&status=active&paid_through=2026-12-31",
    });

    expect(res.statusCode).toBe(403);
  });

  it("rejects unauthenticated POST with 403 (CSRF check fires before auth guard)", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "plan=pro&status=active",
    });

    // No session → no CSRF token in session → CSRF preHandler rejects before auth guard
    expect(res.statusCode).toBe(403);
  });

  it("shows error when downgrading to free without confirmation", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const csrf = await getCsrfToken(app, cookie);

    mockFindOrganizationById.mockResolvedValue(MOCK_ORG);

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&plan=free&status=free`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("confirmation");
    expect(mockGrantManualOrganizationPlan).not.toHaveBeenCalled();
  });

  it("shows error when canceling a paid plan without confirmation", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const csrf = await getCsrfToken(app, cookie);

    mockFindOrganizationById.mockResolvedValue(MOCK_ORG);

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&plan=pro&status=canceled`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("confirmation");
    expect(mockGrantManualOrganizationPlan).not.toHaveBeenCalled();
  });

  it("allows cancellation when confirmation checkbox is checked", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const { csrf, orgVersion } = await getCsrfAndVersion(app, cookie);

    mockGrantManualOrganizationPlan.mockResolvedValue(
      makeGrantSuccess({ planCode: "pro", subscriptionStatus: "canceled", paidThroughAt: null }),
    );

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&_org_version=${encodeURIComponent(orgVersion)}&plan=pro&status=canceled&payment_reference=cancel-ref-001&_confirm_downgrade=yes`,
    });

    expect(res.statusCode).toBe(302);
    expect(mockGrantManualOrganizationPlan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ planCode: "pro", subscriptionStatus: "canceled" }),
    );
  });

  it("allows downgrade to free when confirmation checkbox is checked", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const { csrf, orgVersion } = await getCsrfAndVersion(app, cookie);

    mockGrantManualOrganizationPlan.mockResolvedValue(
      makeGrantSuccess({ planCode: "free", subscriptionStatus: "free", paidThroughAt: null }),
    );

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&_org_version=${encodeURIComponent(orgVersion)}&plan=free&status=free&payment_reference=downgrade-ref-001&_confirm_downgrade=yes`,
    });

    expect(res.statusCode).toBe(302);
    expect(mockGrantManualOrganizationPlan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ planCode: "free", subscriptionStatus: "free" }),
    );
  });

  it("re-renders form with error on service validation failure", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const { csrf, orgVersion } = await getCsrfAndVersion(app, cookie);

    mockGrantManualOrganizationPlan.mockResolvedValue({
      ok: false,
      code: "paid_through_required",
    });
    mockFindOrganizationById.mockResolvedValue(MOCK_ORG);

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&_org_version=${encodeURIComponent(orgVersion)}&plan=pro&status=active&payment_reference=wise-test-001`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Paid-through date is required");
  });

  it("uses operatorSource with admin: prefix when calling the billing service", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const { csrf, orgVersion } = await getCsrfAndVersion(app, cookie);

    mockGrantManualOrganizationPlan.mockResolvedValue(makeGrantSuccess());

    await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&_org_version=${encodeURIComponent(orgVersion)}&plan=pro&status=active&paid_through=2026-12-31&payment_reference=wise-2026-001`,
    });

    const callArgs = mockGrantManualOrganizationPlan.mock.calls[0][1] as Record<string, unknown>;
    expect(typeof callArgs["operatorSource"]).toBe("string");
    expect((callArgs["operatorSource"] as string).startsWith("admin:")).toBe(true);
  });

  it("clears paid_through when downgrading to free even if form submits a date", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const { csrf, orgVersion } = await getCsrfAndVersion(app, cookie);

    mockGrantManualOrganizationPlan.mockResolvedValue(
      makeGrantSuccess({ planCode: "free", subscriptionStatus: "free", paidThroughAt: null }),
    );

    await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&_org_version=${encodeURIComponent(orgVersion)}&plan=free&status=free&paid_through=2026-06-01&payment_reference=downgrade-ref-001&_confirm_downgrade=yes`,
    });

    expect(mockGrantManualOrganizationPlan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ planCode: "free", paidThroughAt: null }),
    );
  });

  it("rejects invalid calendar date like 2026-02-31", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const { csrf, orgVersion } = await getCsrfAndVersion(app, cookie);

    mockFindOrganizationById.mockResolvedValue(MOCK_ORG);

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&_org_version=${encodeURIComponent(orgVersion)}&plan=pro&status=active&paid_through=2026-02-31&payment_reference=wise-test-001`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Invalid paid-through date");
    expect(mockGrantManualOrganizationPlan).not.toHaveBeenCalled();
  });

  it("rejects non-YYYY-MM-DD paid_through format", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const { csrf, orgVersion } = await getCsrfAndVersion(app, cookie);

    mockFindOrganizationById.mockResolvedValue(MOCK_ORG);

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&_org_version=${encodeURIComponent(orgVersion)}&plan=pro&status=active&paid_through=December+31+2026&payment_reference=wise-test-001`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Invalid paid-through date");
    expect(mockGrantManualOrganizationPlan).not.toHaveBeenCalled();
  });

  it("rejects payment_reference exceeding 255 characters", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const csrf = await getCsrfToken(app, cookie);

    mockFindOrganizationById.mockResolvedValue(MOCK_ORG);
    const longRef = "x".repeat(256);

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&plan=pro&status=active&paid_through=2026-12-31&payment_reference=${longRef}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("255 characters");
    expect(mockGrantManualOrganizationPlan).not.toHaveBeenCalled();
  });

  it("rejects note exceeding 1000 characters", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const csrf = await getCsrfToken(app, cookie);

    mockFindOrganizationById.mockResolvedValue(MOCK_ORG);
    const longNote = "x".repeat(1001);

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&plan=pro&status=active&paid_through=2026-12-31&payment_reference=wise-test-001&note=${longNote}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("1000 characters");
    expect(mockGrantManualOrganizationPlan).not.toHaveBeenCalled();
  });

  it("rejects missing payment_reference", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const csrf = await getCsrfToken(app, cookie);

    mockFindOrganizationById.mockResolvedValue(MOCK_ORG);

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&plan=pro&status=active&paid_through=2026-12-31`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Payment reference is required");
    expect(mockGrantManualOrganizationPlan).not.toHaveBeenCalled();
  });

  it("rejects duplicate form fields (array values)", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const csrf = await getCsrfToken(app, cookie);

    mockFindOrganizationById.mockResolvedValue(MOCK_ORG);

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&plan=pro&status=active&paid_through=2026-12-31&payment_reference=ref-a&payment_reference=ref-b`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("duplicate form fields");
    expect(mockGrantManualOrganizationPlan).not.toHaveBeenCalled();
  });

  it("returns 403 (not 500) when _csrf field is duplicated", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: "_csrf=bad&_csrf=alsoBad&plan=pro&status=active",
    });

    expect(res.statusCode).toBe(403);
    expect(mockGrantManualOrganizationPlan).not.toHaveBeenCalled();
  });

  it("rejects paid plan with free subscription status", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const csrf = await getCsrfToken(app, cookie);

    mockFindOrganizationById.mockResolvedValue(MOCK_ORG);

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&plan=pro&status=free&payment_reference=wise-test-001`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Only the free plan can have");
    expect(mockGrantManualOrganizationPlan).not.toHaveBeenCalled();
  });

  it("rejects malformed keep_stripe_link=1 instead of silently clearing Stripe link", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const csrf = await getCsrfToken(app, cookie);

    mockFindOrganizationById.mockResolvedValue(MOCK_ORG);

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&plan=business&status=active&payment_reference=ref-001&keep_stripe_link=1`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("unexpected value for keep_stripe_link");
    expect(mockGrantManualOrganizationPlan).not.toHaveBeenCalled();
  });

  it("rejects duplicate keep_stripe_link fields instead of silently clearing Stripe link", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const csrf = await getCsrfToken(app, cookie);

    mockFindOrganizationById.mockResolvedValue(MOCK_ORG);

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&plan=business&status=active&payment_reference=ref-001&keep_stripe_link=on&keep_stripe_link=on`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("duplicate form fields");
    expect(mockGrantManualOrganizationPlan).not.toHaveBeenCalled();
  });

  it("preserves keep_stripe_link=checked state on validation error re-render", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const csrf = await getCsrfToken(app, cookie);

    mockFindOrganizationById.mockResolvedValue(MOCK_ORG);

    // Submit with keep_stripe_link=on but trigger a validation error (missing payment_reference)
    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&plan=business&status=active&paid_through=2026-12-31&keep_stripe_link=on`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Payment reference is required");
    // Checkbox should be rendered as checked to avoid accidental Stripe-link loss on retry
    expect(res.body).toContain('name="keep_stripe_link" checked');
  });

  it("preserves submitted plan, status, paid_through, payment_reference, note on validation error re-render", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const csrf = await getCsrfToken(app, cookie);

    mockFindOrganizationById.mockResolvedValue(MOCK_ORG);

    // Submit valid fields except note is too long (triggers server-side error after _org_version check)
    // Use a simpler trigger: missing payment_reference (caught before _org_version)
    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&plan=pro&status=active&paid_through=2026-06-30&payment_reference=wise-rerender-test&note=my+note`,
    });

    expect(res.statusCode).toBe(200);
    // Missing _org_version triggers re-render — submitted values should be preserved
    expect(res.body).toContain("Missing page version token");
    expect(res.body).toContain('value="pro" selected');
    expect(res.body).toContain('value="active" selected');
    expect(res.body).toContain('value="2026-06-30"');
    expect(res.body).toContain('value="wise-rerender-test"');
    expect(res.body).toContain("my note");
  });

  it("renders keep_stripe_link unchecked on error re-render when not submitted", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const csrf = await getCsrfToken(app, cookie);

    mockFindOrganizationById.mockResolvedValue(MOCK_ORG);

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&plan=pro&status=active&paid_through=2026-12-31`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Payment reference is required");
    // Checkbox must NOT be checked when it was not submitted
    expect(res.body).not.toContain('name="keep_stripe_link" checked');
  });

  it("defaults keep_stripe_link checkbox to checked only for business plan with Stripe IDs", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);

    const bizOrgWithStripe = {
      ...MOCK_ORG,
      planCode: "business",
      subscriptionStatus: "active",
      paidThroughAt: null,
      stripeCustomerId: "cus_abc123",
      stripeSubscriptionId: "sub_xyz",
    };
    mockFindOrganizationById.mockResolvedValueOnce(bizOrgWithStripe);

    const res = await app.inject({
      method: "GET",
      url: `/admin/organizations/${ORG_ID}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="keep_stripe_link" checked');
    expect(res.body).toContain("current: ");
  });

  it("defaults keep_stripe_link checkbox to unchecked for non-business plan with Stripe IDs", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);

    const nonBizOrgWithStripe = {
      ...MOCK_ORG, // planCode: "personal"
      stripeCustomerId: "cus_abc123",
      stripeSubscriptionId: "sub_xyz",
    };
    mockFindOrganizationById.mockResolvedValueOnce(nonBizOrgWithStripe);

    const res = await app.inject({
      method: "GET",
      url: `/admin/organizations/${ORG_ID}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('name="keep_stripe_link" checked');
    expect(res.body).toContain("current: ");
  });

  it("defaults keep_stripe_link checkbox to unchecked when org has no Stripe IDs", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);

    mockFindOrganizationById.mockResolvedValueOnce(MOCK_ORG); // stripeCustomerId: null

    const res = await app.inject({
      method: "GET",
      url: `/admin/organizations/${ORG_ID}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('name="keep_stripe_link" checked');
  });

  it("renders Stripe-managed status as a disabled selected option in billing form", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);

    mockFindOrganizationById.mockResolvedValueOnce({
      ...MOCK_ORG,
      planCode: "pro",
      subscriptionStatus: "past_due",
    });

    const res = await app.inject({
      method: "GET",
      url: `/admin/organizations/${ORG_ID}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    // Current Stripe-managed status shown as a disabled read-only option
    expect(res.body).toContain('value="past_due" selected disabled');
    // Manual-edit options still present
    expect(res.body).toContain('value="active"');
    expect(res.body).toContain('value="canceled"');
  });

  it("rejects POST when _org_version is missing", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const csrf = await getCsrfToken(app, cookie);

    mockFindOrganizationById.mockResolvedValue(MOCK_ORG);

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&plan=pro&status=active&paid_through=2026-12-31&payment_reference=wise-test-001`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Missing page version token");
    expect(mockGrantManualOrganizationPlan).not.toHaveBeenCalled();
  });

  it("rejects POST when service returns concurrent_update (stale-page guard)", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const { csrf, orgVersion } = await getCsrfAndVersion(app, cookie);

    // Service detects updatedAt mismatch inside the transaction
    mockGrantManualOrganizationPlan.mockResolvedValue({ ok: false, code: "concurrent_update" });
    mockFindOrganizationById.mockResolvedValue(MOCK_ORG);

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&_org_version=${encodeURIComponent(orgVersion)}&plan=pro&status=active&paid_through=2026-12-31&payment_reference=wise-test-001`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("updated since this page was loaded");
  });

  it("concurrent_update re-render does not preserve submitted keep_stripe_link", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const { csrf, orgVersion } = await getCsrfAndVersion(app, cookie);

    mockGrantManualOrganizationPlan.mockResolvedValue({ ok: false, code: "concurrent_update" });
    mockFindOrganizationById.mockResolvedValue(MOCK_ORG);

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&_org_version=${encodeURIComponent(orgVersion)}&plan=business&status=active&payment_reference=wise-test-001&keep_stripe_link=on`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("updated since this page was loaded");
    // Must NOT preserve submitted checkbox — the user must reload to see current org state first.
    expect(res.body).not.toContain('name="keep_stripe_link" checked');
  });

  it("concurrent_update re-render shows org state, not submitted plan/payment_reference", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const { csrf, orgVersion } = await getCsrfAndVersion(app, cookie);

    mockGrantManualOrganizationPlan.mockResolvedValue({ ok: false, code: "concurrent_update" });
    // MOCK_ORG has planCode: "free" — submitted plan is "business"
    mockFindOrganizationById.mockResolvedValue(MOCK_ORG);

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&_org_version=${encodeURIComponent(orgVersion)}&plan=business&status=active&payment_reference=wise-stale-ref&note=stale+note`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("updated since this page was loaded");
    // Submitted reference and note must NOT appear — operator must reload and review
    expect(res.body).not.toContain("wise-stale-ref");
    expect(res.body).not.toContain("stale note");
  });

  it("accepts POST when org version matches (no stale conflict)", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const { csrf, orgVersion } = await getCsrfAndVersion(app, cookie);

    mockGrantManualOrganizationPlan.mockResolvedValue(makeGrantSuccess());

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&_org_version=${encodeURIComponent(orgVersion)}&plan=pro&status=active&paid_through=2026-12-31&payment_reference=wise-test-001`,
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe(`/admin/organizations/${ORG_ID}?billing=granted`);
  });

  it("preserves submitted _org_version in re-rendered form on validation error (stale-guard regression)", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const csrf = await getCsrfToken(app, cookie);

    // Stale version — different from MOCK_ORG_UPDATED_AT ("2026-01-15T10:00:00.000Z")
    const staleOrgVersion = "2025-03-01T00:00:00.000Z";

    mockGrantManualOrganizationPlan.mockResolvedValue({
      ok: false,
      code: "paid_through_required",
    });
    mockFindOrganizationById.mockResolvedValue(MOCK_ORG);

    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&_org_version=${encodeURIComponent(staleOrgVersion)}&plan=personal&status=active&payment_reference=wise-test-stale`,
    });

    expect(res.statusCode).toBe(200);
    // Re-rendered form must show the submitted stale version, not the fresh DB value
    const rerenderedVersion = extractOrgVersion(res.body);
    expect(rerenderedVersion).toBe(staleOrgVersion);
    expect(rerenderedVersion).not.toBe(MOCK_ORG_UPDATED_AT.toISOString());
  });

  it("does not log billing.mutated for idempotent replay (redirects with idempotent flash)", async () => {
    const app = await buildApp();
    const cookie = await loginSession(app);
    const { csrf, orgVersion } = await getCsrfAndVersion(app, cookie);

    mockGrantManualOrganizationPlan.mockResolvedValue(
      makeGrantSuccess({ idempotent: true, updated: false }),
    );

    // Should redirect to idempotent flash without any error
    const res = await app.inject({
      method: "POST",
      url: `/admin/organizations/${ORG_ID}/billing`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `_csrf=${csrf}&_org_version=${encodeURIComponent(orgVersion)}&plan=pro&status=active&paid_through=2026-12-31&payment_reference=wise-2026-001`,
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe(`/admin/organizations/${ORG_ID}?billing=idempotent`);
  });
});
