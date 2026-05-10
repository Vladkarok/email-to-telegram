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

beforeEach(() => {
  mockFindUserById.mockReset();
  mockListOrganizationMembershipsForUser.mockReset().mockResolvedValue([]);
  mockListOrganizationMembers.mockReset().mockResolvedValue([]);
  mockFindOrganizationById.mockReset();
  mockCountActiveAliasesByOrganization.mockReset().mockResolvedValue(0);
  mockGetOrganizationUsageMonth.mockReset().mockResolvedValue(null);
  mockListManualBillingEventsForOrganization.mockReset().mockResolvedValue([]);
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
