import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerRoutes } from "../../../src/http/routes/index.js";

vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockVerifyBillingAccessToken = vi.fn();
vi.mock("../../../src/billing/accessTokens.js", () => ({
  verifyBillingAccessToken: (...args: unknown[]): unknown => mockVerifyBillingAccessToken(...args),
}));

const mockCreateCheckoutSession = vi.fn();
vi.mock("../../../src/billing/checkout.js", () => ({
  BillingCheckoutConflictError: class BillingCheckoutConflictError extends Error {},
  createCheckoutSession: (...args: unknown[]): unknown => mockCreateCheckoutSession(...args),
}));

const mockCreateCustomerPortalSession = vi.fn();
vi.mock("../../../src/billing/customerPortal.js", () => ({
  createCustomerPortalSession: (...args: unknown[]): unknown =>
    mockCreateCustomerPortalSession(...args),
}));

const mockConstructWebhookEvent = vi.fn();
const mockIsStripePriceKey = vi.fn((value: string) => value === "pro_monthly");
vi.mock("../../../src/billing/stripe.js", () => ({
  constructWebhookEvent: (...args: unknown[]): unknown => mockConstructWebhookEvent(...args),
  isStripePriceKey: (...args: unknown[]): unknown => mockIsStripePriceKey(...args),
}));

const mockProcessStripeWebhookEvent = vi.fn();
vi.mock("../../../src/billing/webhooks.js", () => ({
  processStripeWebhookEvent: (...args: unknown[]): unknown =>
    mockProcessStripeWebhookEvent(...args),
}));

const mockUserHasOrganizationRole = vi.fn();
vi.mock("../../../src/db/repos/organizationMembers.js", () => ({
  userHasOrganizationRole: (...args: unknown[]): unknown => mockUserHasOrganizationRole(...args),
}));

vi.mock("../../../src/email/pipeline.js", () => ({
  queueInboundEmail: vi.fn(),
  deliverQueuedEmail: vi.fn(),
}));
vi.mock("../../../src/db/repos/aliases.js", () => ({
  findAliasByLocalPart: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("../../../src/billing/limits.js", () => ({
  checkInboundLimit: vi.fn(() => Promise.resolve({ ok: true })),
}));

const TEST_CONFIG = {
  publicBaseUrl: "https://mail.example.com",
  attachmentDir: "/tmp/attachments",
  attachmentTtlHours: 24,
  rawEmailDir: "/tmp/rawemails",
  rawEmailTtlHours: 24,
  maxSizeBytes: 1024 * 1024,
  adminEnabled: false,
  adminSecret: undefined,
  adminSessionSecret: undefined,
  adminSessionTtlMinutes: 60,
};

async function buildApp() {
  const app = Fastify({ logger: false });
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body: Buffer, done) => {
    req.rawBody = body;
    done(null, JSON.parse(body.toString("utf8")) as Record<string, unknown>);
  });
  await registerRoutes(app, TEST_CONFIG);
  return app;
}

describe("billing routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyBillingAccessToken.mockReturnValue({
      telegramUserId: "123",
      organizationId: "org-1",
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    mockUserHasOrganizationRole.mockResolvedValue(true);
    mockCreateCheckoutSession.mockResolvedValue("https://checkout.stripe.test/session");
    mockCreateCustomerPortalSession.mockResolvedValue("https://billing.stripe.test/portal");
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_1",
      type: "customer.subscription.updated",
    });
    mockProcessStripeWebhookEvent.mockResolvedValue("processed");
  });

  it("creates checkout sessions for owner/admin users", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      payload: { token: "signed-token", priceKey: "pro_monthly" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: "https://checkout.stripe.test/session" });
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      "pro_monthly",
    );
  });

  it("rejects checkout when the token is invalid", async () => {
    mockVerifyBillingAccessToken.mockReturnValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      payload: { token: "bad-token", priceKey: "pro_monthly" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects checkout when the user lacks org ownership", async () => {
    mockUserHasOrganizationRole.mockResolvedValue(false);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      payload: { token: "signed-token", priceKey: "pro_monthly" },
    });

    expect(res.statusCode).toBe(403);
  });

  it("rejects checkout when the requested price key is invalid", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      payload: { token: "signed-token", priceKey: "bad_price" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid request" });
  });

  it("returns 409 when the organization already has a Stripe subscription", async () => {
    const { BillingCheckoutConflictError } = await import("../../../src/billing/checkout.js");
    mockCreateCheckoutSession.mockRejectedValue(new BillingCheckoutConflictError());

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      payload: { token: "signed-token", priceKey: "pro_monthly" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "subscription already exists" });
  });

  it("returns 409 from portal when no Stripe customer exists", async () => {
    mockCreateCustomerPortalSession.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/billing/portal",
      payload: { token: "signed-token" },
    });

    expect(res.statusCode).toBe(409);
  });

  it("creates a portal session for owner/admin users", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/billing/portal",
      payload: { token: "signed-token" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: "https://billing.stripe.test/portal" });
  });

  it("rejects portal when the token is invalid", async () => {
    mockVerifyBillingAccessToken.mockReturnValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/billing/portal",
      payload: { token: "bad-token" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects portal when the user lacks org ownership", async () => {
    mockUserHasOrganizationRole.mockResolvedValue(false);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/billing/portal",
      payload: { token: "signed-token" },
    });

    expect(res.statusCode).toBe(403);
  });

  it("verifies and processes Stripe webhooks from the raw body", async () => {
    const app = await buildApp();
    const body = Buffer.from(JSON.stringify({ id: "evt_1" }));
    const res = await app.inject({
      method: "POST",
      url: "/billing/stripe/webhook",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "sig",
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(mockConstructWebhookEvent).toHaveBeenCalledWith(body, "sig");
    expect(mockProcessStripeWebhookEvent).toHaveBeenCalled();
    expect(res.json()).toEqual({ status: "processed" });
  });

  it("rejects webhook requests without a Stripe signature", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/billing/stripe/webhook",
      headers: {
        "content-type": "application/json",
      },
      payload: Buffer.from(JSON.stringify({ id: "evt_1" })),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid webhook request" });
  });

  it("rejects webhook requests with an invalid signature", async () => {
    mockConstructWebhookEvent.mockImplementation(() => {
      throw new Error("bad signature");
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/billing/stripe/webhook",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "sig",
      },
      payload: Buffer.from(JSON.stringify({ id: "evt_1" })),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid signature" });
  });
});
