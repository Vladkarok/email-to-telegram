import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerRoutes } from "../../../src/http/routes/index.js";
import { generateDeliveryViewToken } from "../../../src/utils/tokens.js";

vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockFindDeliveryViewLink = vi.fn();
const mockMarkDeliveryViewLinkViewed = vi.fn();
const mockListAttachments = vi.fn();
const mockCreateAttachmentLink = vi.fn();
const mockReadRawEmail = vi.fn();

vi.mock("../../../src/db/repos/deliveryViewLinks.js", () => ({
  findDeliveryViewLinkByToken: (...args: unknown[]): unknown => mockFindDeliveryViewLink(...args),
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

describe("GET /view/:token", () => {
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

  it("renders a one-time privacy view page", async () => {
    const { token, expiresAt } = generateDeliveryViewToken("log-uuid-1", 24);
    mockFindDeliveryViewLink.mockResolvedValue({
      id: "view-link-1",
      token,
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
    });
    mockListAttachments.mockResolvedValue([
      {
        id: "att-1",
        originalFilename: "report.pdf",
        sizeBytes: 1234,
      },
    ]);

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/view/${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toContain("Email View");
    expect(res.body).toContain("Hello secure world");
    expect(res.body).toContain("report.pdf");
    expect(res.body).toContain("/dl/");
    expect(mockMarkDeliveryViewLinkViewed).toHaveBeenCalledWith(expect.anything(), "view-link-1");
  });

  it("returns 410 when the view link is already used", async () => {
    const { token, expiresAt } = generateDeliveryViewToken("log-uuid-1", 24);
    mockFindDeliveryViewLink.mockResolvedValue({
      id: "view-link-1",
      token,
      expiresAt,
      viewedAt: new Date(),
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
    });

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/view/${token}` });

    expect(res.statusCode).toBe(410);
    expect(res.body).toContain("expired or was already used");
  });
});
