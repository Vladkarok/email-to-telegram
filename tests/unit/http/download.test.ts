import { Readable } from "stream";
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

const mockCheckInboundLimit = vi.fn().mockResolvedValue({ ok: true });
const mockCheckEgressLimit = vi.fn().mockResolvedValue({ ok: true });
const mockWithOrganizationQuotaLock = vi.fn(
  async (_db: unknown, _organizationId: string | null, work: (tx: unknown) => Promise<unknown>) =>
    work({}),
);
vi.mock("../../../src/billing/limits.js", () => ({
  checkInboundLimit: (...args: unknown[]): unknown => mockCheckInboundLimit(...args),
  checkEgressLimit: (...args: unknown[]): unknown => mockCheckEgressLimit(...args),
  withOrganizationQuotaLock: (...args: unknown[]): unknown =>
    mockWithOrganizationQuotaLock(...args),
}));

const mockFindLink = vi.fn();
const mockMarkDownloaded = vi.fn();
const mockDisposeOpened = vi.fn();
vi.mock("../../../src/db/repos/attachmentLinks.js", () => ({
  findAttachmentLinkByToken: (...args: unknown[]): unknown => mockFindLink(...args),
  markLinkDownloaded: (...args: unknown[]): unknown => mockMarkDownloaded(...args),
}));

const mockOpenAttachment = vi.fn();
vi.mock("../../../src/storage/disk.js", () => ({
  openAttachmentStream: (...args: unknown[]): unknown => mockOpenAttachment(...args),
}));

const mockIncrementOrganizationUsageMonth = vi.fn();
const mockDecrementOrganizationUsageMonth = vi.fn();
vi.mock("../../../src/db/repos/usage.js", () => ({
  incrementOrganizationUsageMonth: (...args: unknown[]): unknown =>
    mockIncrementOrganizationUsageMonth(...args),
  decrementOrganizationUsageMonth: (...args: unknown[]): unknown =>
    mockDecrementOrganizationUsageMonth(...args),
  usageMonthForDate: vi.fn(() => "2026-04"),
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
    mockOpenAttachment.mockReset();
    mockDisposeOpened.mockReset();
    mockCheckInboundLimit.mockReset();
    mockCheckInboundLimit.mockResolvedValue({ ok: true });
    mockCheckEgressLimit.mockReset();
    mockCheckEgressLimit.mockResolvedValue({ ok: true });
    mockWithOrganizationQuotaLock.mockClear();
    mockIncrementOrganizationUsageMonth.mockReset();
    mockIncrementOrganizationUsageMonth.mockResolvedValue(undefined);
    mockDecrementOrganizationUsageMonth.mockReset();
    mockDecrementOrganizationUsageMonth.mockResolvedValue(undefined);
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
        organizationId: "org-1",
        storagePath: "/data/attachments/report.pdf",
        originalFilename: "report.pdf",
        contentType: "application/pdf",
        sizeBytes: fileContent.length,
      },
    });
    mockMarkDownloaded.mockResolvedValue(true); // atomic claim succeeded
    mockOpenAttachment.mockResolvedValue({
      stream: Readable.from(fileContent),
      size: fileContent.length,
    });

    const app = buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(mockMarkDownloaded).toHaveBeenCalledOnce();
    expect(mockIncrementOrganizationUsageMonth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: "org-1",
        month: "2026-04",
        egressBytes: BigInt(fileContent.length),
      }),
    );
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
        organizationId: "org-1",
        storagePath: "/data/attachments/doc.pdf",
        originalFilename: "doc.pdf",
        contentType: "application/pdf",
        sizeBytes: 100,
      },
    });
    mockOpenAttachment.mockResolvedValue({
      stream: Readable.from(Buffer.from("doc")),
      size: 3,
      dispose: mockDisposeOpened,
    });
    mockMarkDownloaded.mockResolvedValue(false); // another request beat us

    const app = buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });
    expect(res.statusCode).toBe(410);
    expect(mockDisposeOpened).toHaveBeenCalledOnce();
  });

  it("returns 403 and keeps the link unused when the org egress limit is exhausted", async () => {
    const attachmentId = "attach-uuid-egress";
    const { token, expiresAt } = generateDownloadToken(attachmentId);

    mockFindLink.mockResolvedValue({
      id: "link-egress",
      token,
      expiresAt,
      downloadedAt: null,
      attachmentId,
      attachment: {
        id: attachmentId,
        organizationId: "org-1",
        storagePath: "/data/attachments/cap.pdf",
        originalFilename: "cap.pdf",
        contentType: "application/pdf",
        sizeBytes: 4,
      },
    });
    mockOpenAttachment.mockResolvedValue({
      stream: Readable.from(Buffer.from("cap!")),
      size: 4,
      dispose: mockDisposeOpened,
    });
    mockCheckEgressLimit.mockResolvedValue({ ok: false, code: "egress_limit" });

    const app = buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "download quota exceeded" });
    expect(mockMarkDownloaded).not.toHaveBeenCalled();
    expect(mockIncrementOrganizationUsageMonth).not.toHaveBeenCalled();
    expect(mockDisposeOpened).toHaveBeenCalledOnce();
  });

  it("returns 500 when attachment storage cannot be opened or decrypted", async () => {
    const attachmentId = "attach-uuid-6";
    const { token, expiresAt } = generateDownloadToken(attachmentId);

    mockFindLink.mockResolvedValue({
      id: "link-3",
      token,
      expiresAt,
      downloadedAt: null,
      attachmentId,
      attachment: {
        organizationId: "org-1",
        id: attachmentId,
        storagePath: "/data/attachments/broken.bin",
        originalFilename: "broken.pdf",
        contentType: "application/pdf",
        sizeBytes: 42,
        encryptionMode: "local-v1",
        wrappedDek: "wrapped",
        kekKeyId: "test-key",
      },
    });
    mockMarkDownloaded.mockResolvedValue(true);
    mockOpenAttachment.mockRejectedValue(new Error("decrypt failed"));

    const app = buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "download failed" });
    expect(mockMarkDownloaded).not.toHaveBeenCalled();
  });

  it("returns 403 when the token HMAC does not match the stored attachment", async () => {
    const { token, expiresAt } = generateDownloadToken("attach-uuid-7");

    mockFindLink.mockResolvedValue({
      id: "link-4",
      token,
      expiresAt,
      downloadedAt: null,
      attachmentId: "different-attachment-id",
      attachment: {
        organizationId: "org-1",
        storagePath: "/data/attachments/report.pdf",
        originalFilename: "report.pdf",
        contentType: "application/pdf",
        sizeBytes: 10,
      },
    });

    const app = buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });

    expect(res.statusCode).toBe(403);
    expect(mockOpenAttachment).not.toHaveBeenCalled();
    expect(mockMarkDownloaded).not.toHaveBeenCalled();
  });

  it("preserves safe text mime charsets and sanitizes attachment filenames", async () => {
    const attachmentId = "attach-uuid-8";
    const { token, expiresAt } = generateDownloadToken(attachmentId);
    const fileContent = Buffer.from("plain text");

    mockFindLink.mockResolvedValue({
      id: "link-5",
      token,
      expiresAt,
      downloadedAt: null,
      attachmentId,
      attachment: {
        organizationId: "org-1",
        storagePath: "/data/attachments/note.txt",
        originalFilename: 'report"\r\n2026.txt',
        contentType: "text/plain; charset=iso-8859-1",
        sizeBytes: fileContent.length,
      },
    });
    mockMarkDownloaded.mockResolvedValue(true);
    mockOpenAttachment.mockResolvedValue({
      stream: Readable.from(fileContent),
      size: fileContent.length,
    });

    const app = buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain; charset=iso-8859-1");
    expect(res.headers["content-disposition"]).toContain(
      'attachment; filename="report___2026.txt"',
    );
  });

  it("preserves safe csv mime variants", async () => {
    const attachmentId = "attach-uuid-9";
    const { token, expiresAt } = generateDownloadToken(attachmentId);
    const fileContent = Buffer.from("a,b\n1,2\n");

    mockFindLink.mockResolvedValue({
      id: "link-6",
      token,
      expiresAt,
      downloadedAt: null,
      attachmentId,
      attachment: {
        storagePath: "/data/attachments/report.csv",
        originalFilename: null,
        contentType: "text/csv; charset=utf-8",
        sizeBytes: fileContent.length,
      },
    });
    mockMarkDownloaded.mockResolvedValue(true);
    mockOpenAttachment.mockResolvedValue({
      stream: Readable.from(fileContent),
      size: fileContent.length,
    });

    const app = buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toContain('attachment; filename="attachment"');
  });

  it("falls back to octet-stream for unsafe mime types", async () => {
    const attachmentId = "attach-uuid-10";
    const { token, expiresAt } = generateDownloadToken(attachmentId);
    const fileContent = Buffer.from("<svg />");

    mockFindLink.mockResolvedValue({
      id: "link-7",
      token,
      expiresAt,
      downloadedAt: null,
      attachmentId,
      attachment: {
        storagePath: "/data/attachments/image.svg",
        originalFilename: "image.svg",
        contentType: "image/svg+xml",
        sizeBytes: fileContent.length,
      },
    });
    mockMarkDownloaded.mockResolvedValue(true);
    mockOpenAttachment.mockResolvedValue({
      stream: Readable.from(fileContent),
      size: fileContent.length,
    });

    const app = buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/octet-stream");
  });
});
