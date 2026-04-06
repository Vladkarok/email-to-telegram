import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { registerRoutes } from "../../../src/http/routes/index.js";
import { generateDownloadToken } from "../../../src/utils/tokens.js";

vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../../src/email/pipeline.js", () => ({
  processInboundEmail: vi.fn(() => Promise.resolve({ ok: true })),
}));
vi.mock("../../../src/db/repos/aliases.js", () => ({
  findAliasByLocalPart: vi.fn(() => Promise.resolve(null)),
}));

const mockFindLink = vi.fn();
const mockMarkDownloaded = vi.fn();
vi.mock("../../../src/db/repos/attachmentLinks.js", () => ({
  findAttachmentLinkByToken: (...args: unknown[]): unknown => mockFindLink(...args),
  markLinkDownloaded: (...args: unknown[]): unknown => mockMarkDownloaded(...args),
}));

const mockReadAttachment = vi.fn();
vi.mock("../../../src/storage/disk.js", () => ({
  readAttachmentStream: (...args: unknown[]): unknown => mockReadAttachment(...args),
}));

const HMAC_SECRET = "test-secret-that-is-long-enough-abc";

function buildApp() {
  const app = Fastify({ logger: false });
  registerRoutes(app, {
    publicBaseUrl: "https://example.com",
    attachmentDir: "/tmp/attachments",
    attachmentTtlHours: 336,
    rawEmailDir: "/tmp/raw",
    maxSizeBytes: 10_485_760,
  });
  return app;
}

describe("GET /dl/:token", () => {
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env["HMAC_SECRET"];
    process.env["HMAC_SECRET"] = HMAC_SECRET;
    mockFindLink.mockReset();
    mockMarkDownloaded.mockReset();
    mockReadAttachment.mockReset();
  });

  afterEach(() => {
    process.env["HMAC_SECRET"] = savedSecret;
  });

  it("returns 404 when token is not found in DB", async () => {
    mockFindLink.mockResolvedValue(null);
    const { token } = generateDownloadToken("attach-uuid-1");
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });
    expect(res.statusCode).toBe(404);
  });

  it("returns 410 when token has already been downloaded", async () => {
    const { token, expiresAt } = generateDownloadToken("attach-uuid-2");
    mockFindLink.mockResolvedValue({
      id: "link-1",
      token,
      expiresAt,
      downloadedAt: new Date(), // already downloaded
      attachment: {
        storagePath: "/data/attachments/file.pdf",
        originalFilename: "file.pdf",
        contentType: "application/pdf",
      },
    });
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });
    expect(res.statusCode).toBe(410);
  });

  it("returns 410 when token is expired", async () => {
    const { token } = generateDownloadToken("attach-uuid-3");
    const expiredAt = new Date(Date.now() - 1000);
    mockFindLink.mockResolvedValue({
      id: "link-1",
      token,
      expiresAt: expiredAt,
      downloadedAt: null,
      attachment: {
        storagePath: "/data/attachments/file.pdf",
        originalFilename: "file.pdf",
        contentType: "application/pdf",
      },
    });
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });
    expect(res.statusCode).toBe(410);
  });

  it("returns 200 and streams file for a valid unused token", async () => {
    const attachmentId = "attach-uuid-4";
    const { token, expiresAt } = generateDownloadToken(attachmentId);
    const fileContent = Buffer.from("PDF content here");

    mockFindLink.mockResolvedValue({
      id: "link-1",
      token,
      expiresAt,
      downloadedAt: null,
      attachmentId,
      attachment: {
        storagePath: "/data/attachments/report.pdf",
        originalFilename: "report.pdf",
        contentType: "application/pdf",
        sizeBytes: fileContent.length,
      },
    });
    mockMarkDownloaded.mockResolvedValue(true); // atomic claim succeeded
    mockReadAttachment.mockResolvedValue(fileContent);

    const app = buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(mockMarkDownloaded).toHaveBeenCalledOnce();
  });

  it("returns 410 when a concurrent request already claimed the token", async () => {
    const attachmentId = "attach-uuid-5";
    const { token, expiresAt } = generateDownloadToken(attachmentId);

    mockFindLink.mockResolvedValue({
      id: "link-2",
      token,
      expiresAt,
      downloadedAt: null,
      attachmentId,
      attachment: {
        storagePath: "/data/attachments/doc.pdf",
        originalFilename: "doc.pdf",
        contentType: "application/pdf",
        sizeBytes: 100,
      },
    });
    mockMarkDownloaded.mockResolvedValue(false); // another request beat us

    const app = buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });
    expect(res.statusCode).toBe(410);
  });
});
