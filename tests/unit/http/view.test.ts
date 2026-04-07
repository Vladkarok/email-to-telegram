import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerRoutes } from "../../../src/http/routes/index.js";
import { generateDeliveryViewToken } from "../../../src/utils/tokens.js";

vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockFindDeliveryViewLinkByTokenHash = vi.fn();
const mockMarkDeliveryViewLinkViewed = vi.fn();
const mockListAttachments = vi.fn();
const mockCreateAttachmentLink = vi.fn();
const mockReadRawEmail = vi.fn();

vi.mock("../../../src/db/repos/deliveryViewLinks.js", () => ({
  findDeliveryViewLinkByTokenHash: (...args: unknown[]): unknown =>
    mockFindDeliveryViewLinkByTokenHash(...args),
  markDeliveryViewLinkViewed: (...args: unknown[]): unknown =>
    mockMarkDeliveryViewLinkViewed(...args),
}));
vi.mock("../../../src/db/repos/attachments.js", () => ({
  listAttachmentsByDeliveryLogId: (...args: unknown[]): unknown => mockListAttachments(...args),
}));
vi.mock("../../../src/db/repos/attachmentLinks.js", () => ({
  createAttachmentLink: (...args: unknown[]): unknown => mockCreateAttachmentLink(...args),
}));
vi.mock("../../../src/storage/disk.js", async () => {
  const actual = await vi.importActual("../../../src/storage/disk.js");
  return {
    ...actual,
    readRawEmail: (...args: unknown[]): unknown => mockReadRawEmail(...args),
    writeRawEmail: vi.fn(),
    writePendingRawEmailMeta: vi.fn(),
    deletePendingRawEmailMeta: vi.fn(),
    deleteFile: vi.fn(),
  };
});

const TEST_CONFIG = {
  publicBaseUrl: "https://mail.example.com",
  attachmentDir: "/tmp/attachments",
  attachmentTtlHours: 24,
  rawEmailDir: "/tmp/rawemails",
  rawEmailTtlHours: 24,
  maxSizeBytes: 1024 * 1024,
};

const RAW_EMAIL = Buffer.from(
  "From: sender@example.com\r\nTo: alerts@example.com\r\nSubject: Privacy Test\r\n\r\nHello secure world",
);

function viewLinkRow(expiresAt: Date, overrides: Record<string, unknown> = {}) {
  return {
    id: "view-link-1",
    tokenHash: "hashed-token",
    expiresAt,
    viewedAt: null,
    deliveryLogId: "log-uuid-1",
    deliveryLog: {
      id: "log-uuid-1",
      emailAddressId: "alias-uuid-1",
      rawEmailPath: "/tmp/rawemails/privacy.eml",
      envelopeFrom: "sender@example.com",
      headerFrom: "sender@example.com",
      subject: "Privacy Test",
      receivedAt: new Date("2026-04-07T12:00:00Z"),
    },
    ...overrides,
  };
}

async function buildApp() {
  const app = Fastify({ logger: false });
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => {
      done(null, body);
    },
  );
  registerRoutes(app, TEST_CONFIG);
  return app;
}

describe("/view/:token", () => {
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env["HMAC_SECRET"];
    process.env["HMAC_SECRET"] = "test-secret-that-is-long-enough-abc";
    vi.clearAllMocks();
    mockMarkDeliveryViewLinkViewed.mockResolvedValue(true);
    mockCreateAttachmentLink.mockResolvedValue(undefined);
    mockReadRawEmail.mockResolvedValue(RAW_EMAIL);
    mockListAttachments.mockResolvedValue([]);
  });

  afterEach(() => {
    process.env["HMAC_SECRET"] = savedSecret;
  });

  it("renders a confirmation page on GET without consuming the link", async () => {
    const { token, expiresAt } = generateDeliveryViewToken("log-uuid-1", 24);
    mockFindDeliveryViewLinkByTokenHash.mockResolvedValue(viewLinkRow(expiresAt));

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/view/${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.body).toContain("Open Private Email");
    expect(mockReadRawEmail).not.toHaveBeenCalled();
    expect(mockMarkDeliveryViewLinkViewed).not.toHaveBeenCalled();
  });

  it("renders the email body on POST after claiming the link", async () => {
    const { token, expiresAt } = generateDeliveryViewToken("log-uuid-1", 24);
    mockFindDeliveryViewLinkByTokenHash.mockResolvedValue(viewLinkRow(expiresAt));
    mockListAttachments.mockResolvedValue([
      {
        id: "att-1",
        originalFilename: "report.pdf",
        sizeBytes: 1234,
      },
    ]);

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: `/view/${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Email View");
    expect(res.body).toContain("Hello secure world");
    expect(res.body).toContain("report.pdf");
    expect(res.body).toContain("/dl/");
    expect(mockMarkDeliveryViewLinkViewed).toHaveBeenCalledWith(
      expect.anything(),
      "view-link-1",
      expect.any(Date),
    );
  });

  it("returns 410 when the view link is already used", async () => {
    const { token, expiresAt } = generateDeliveryViewToken("log-uuid-1", 24);
    mockFindDeliveryViewLinkByTokenHash.mockResolvedValue(
      viewLinkRow(expiresAt, { viewedAt: new Date() }),
    );

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/view/${token}` });

    expect(res.statusCode).toBe(410);
    expect(res.body).toContain("expired or was already used");
  });

  it("returns 410 when another request claims the link first", async () => {
    const { token, expiresAt } = generateDeliveryViewToken("log-uuid-1", 24);
    mockFindDeliveryViewLinkByTokenHash.mockResolvedValue(viewLinkRow(expiresAt));
    mockMarkDeliveryViewLinkViewed.mockResolvedValue(false);

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: `/view/${token}` });

    expect(res.statusCode).toBe(410);
    expect(mockCreateAttachmentLink).not.toHaveBeenCalled();
  });

  it("returns 410 when the raw email file is unavailable", async () => {
    const { token, expiresAt } = generateDeliveryViewToken("log-uuid-1", 24);
    mockFindDeliveryViewLinkByTokenHash.mockResolvedValue(viewLinkRow(expiresAt));
    mockReadRawEmail.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: `/view/${token}` });

    expect(res.statusCode).toBe(410);
    expect(mockMarkDeliveryViewLinkViewed).not.toHaveBeenCalled();
  });
});
