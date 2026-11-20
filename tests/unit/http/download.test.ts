import { Readable } from "stream";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { registerRoutes } from "../../../src/http/routes/index.js";
import { generateDownloadToken } from "../../../src/utils/tokens.js";
import { getLogger } from "../../../src/utils/logger.js";

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
  withUserQuotaLock: (...args: unknown[]): unknown => mockWithOrganizationQuotaLock(...args),
}));

const mockFindLink = vi.fn();
const mockMarkDownloaded = vi.fn();
const mockReleaseLinkDownload = vi.fn();
const mockDisposeOpened = vi.fn();
vi.mock("../../../src/db/repos/attachmentLinks.js", () => ({
  findAttachmentLinkByToken: (...args: unknown[]): unknown => mockFindLink(...args),
  markLinkDownloaded: (...args: unknown[]): unknown => mockMarkDownloaded(...args),
  releaseLinkDownload: (...args: unknown[]): unknown => mockReleaseLinkDownload(...args),
}));

const mockOpenAttachment = vi.fn();
vi.mock("../../../src/storage/disk.js", () => ({
  openAttachmentStream: (...args: unknown[]): unknown => mockOpenAttachment(...args),
}));

const mockIncrementUserUsageMonth = vi.fn();
const mockDecrementOrganizationUsageMonth = vi.fn();
const mockDecrementUserUsageMonth = vi.fn();
vi.mock("../../../src/db/repos/usage.js", () => ({
  incrementUserUsageMonth: (...args: unknown[]): unknown => mockIncrementUserUsageMonth(...args),
  decrementOrganizationUsageMonth: (...args: unknown[]): unknown =>
    mockDecrementOrganizationUsageMonth(...args),
  decrementUserUsageMonth: (...args: unknown[]): unknown => mockDecrementUserUsageMonth(...args),
  usageMonthForDate: vi.fn(() => "2026-04"),
}));

const HMAC_SECRET = "test-secret-that-is-long-enough-abc";

function ownedLink(id: string, attachmentId: string, expiresAt: Date, sizeBytes: number) {
  return {
    id,
    expiresAt,
    downloadedAt: null,
    attachmentId,
    attachment: {
      id: attachmentId,
      userId: 1n as bigint | null,
      storagePath: "/data/attachments/file.bin",
      originalFilename: "file.bin" as string | null,
      contentType: "application/octet-stream",
      sizeBytes,
    },
  };
}

function* chunked(data: Buffer, chunkSize: number): Generator<Buffer> {
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    yield data.subarray(offset, offset + chunkSize);
  }
}

async function buildApp() {
  const app = Fastify({ logger: false });
  await registerRoutes(app, {
    publicBaseUrl: "https://example.com",
    attachmentDir: "/tmp/attachments",
    attachmentTtlHours: 336,
    rawEmailDir: "/tmp/raw",
    rawEmailTtlHours: 336,
    maxSizeBytes: 10_485_760,
    adminEnabled: false,
    adminSecret: undefined,
    adminSessionSecret: undefined,
    adminSessionTtlMinutes: 60,
    nodeEnv: "test",
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
    mockDisposeOpened.mockResolvedValue(undefined);
    mockReleaseLinkDownload.mockReset();
    mockReleaseLinkDownload.mockResolvedValue(true);
    mockDecrementUserUsageMonth.mockReset();
    mockDecrementUserUsageMonth.mockResolvedValue(undefined);
    mockCheckInboundLimit.mockReset();
    mockCheckInboundLimit.mockResolvedValue({ ok: true });
    mockCheckEgressLimit.mockReset();
    mockCheckEgressLimit.mockResolvedValue({ ok: true });
    mockWithOrganizationQuotaLock.mockClear();
    mockIncrementUserUsageMonth.mockReset();
    mockIncrementUserUsageMonth.mockResolvedValue(undefined);
    mockDecrementOrganizationUsageMonth.mockReset();
    mockDecrementOrganizationUsageMonth.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env["HMAC_SECRET"] = savedSecret;
  });

  it("returns 404 when token is not found in DB", async () => {
    mockFindLink.mockResolvedValue(null);
    const { token } = generateDownloadToken("attach-uuid-1");
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });
    expect(res.statusCode).toBe(404);
  });

  it("returns 410 when token has already been downloaded", async () => {
    const { token, expiresAt } = generateDownloadToken("attach-uuid-2");
    mockFindLink.mockResolvedValue({
      id: "link-1",
      expiresAt,
      downloadedAt: new Date(), // already downloaded
      attachment: {
        storagePath: "/data/attachments/file.pdf",
        originalFilename: "file.pdf",
        contentType: "application/pdf",
      },
    });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });
    expect(res.statusCode).toBe(410);
  });

  it("returns 410 when token is expired", async () => {
    const { token } = generateDownloadToken("attach-uuid-3");
    const expiredAt = new Date(Date.now() - 1000);
    mockFindLink.mockResolvedValue({
      id: "link-1",
      expiresAt: expiredAt,
      downloadedAt: null,
      attachment: {
        storagePath: "/data/attachments/file.pdf",
        originalFilename: "file.pdf",
        contentType: "application/pdf",
      },
    });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });
    expect(res.statusCode).toBe(410);
  });

  it("returns 200 and streams file for a valid unused token", async () => {
    const attachmentId = "attach-uuid-4";
    const { token, expiresAt } = generateDownloadToken(attachmentId);
    const fileContent = Buffer.from("PDF content here");

    mockFindLink.mockResolvedValue({
      id: "link-1",
      expiresAt,
      downloadedAt: null,
      attachmentId,
      attachment: {
        userId: 1n,
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

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/octet-stream");
    expect(mockMarkDownloaded).toHaveBeenCalledOnce();
    expect(mockIncrementUserUsageMonth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 1n,
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

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });
    expect(res.statusCode).toBe(410);
    expect(mockOpenAttachment).not.toHaveBeenCalled();
  });

  it("returns 403 and keeps the link unused when the org egress limit is exhausted", async () => {
    const attachmentId = "attach-uuid-egress";
    const { token, expiresAt } = generateDownloadToken(attachmentId);

    mockFindLink.mockResolvedValue({
      id: "link-egress",
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

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "download quota exceeded" });
    expect(mockMarkDownloaded).not.toHaveBeenCalled();
    expect(mockIncrementUserUsageMonth).not.toHaveBeenCalled();
    expect(mockOpenAttachment).not.toHaveBeenCalled();
  });

  it("returns 500 when attachment storage cannot be opened or decrypted", async () => {
    const attachmentId = "attach-uuid-6";
    const { token, expiresAt } = generateDownloadToken(attachmentId);

    mockFindLink.mockResolvedValue({
      id: "link-3",
      expiresAt,
      downloadedAt: null,
      attachmentId,
      attachment: {
        userId: 7n,
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

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "download failed" });
    expect(mockMarkDownloaded).toHaveBeenCalledOnce();
    // The claim is released with the timestamp it was made with, so only this
    // request's own claim can be undone.
    const claimedAt = (mockMarkDownloaded.mock.calls[0] as unknown[])[2];
    expect(claimedAt).toBeInstanceOf(Date);
    expect(mockReleaseLinkDownload).toHaveBeenCalledOnce();
    expect(mockReleaseLinkDownload).toHaveBeenCalledWith(expect.anything(), "link-3", claimedAt);
    expect(mockDecrementUserUsageMonth).toHaveBeenCalledOnce();
    expect(mockDecrementUserUsageMonth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 7n, month: "2026-04", egressBytes: 42n }),
    );
  });

  it("still returns 500 and logs when releasing the claim fails", async () => {
    const attachmentId = "attach-uuid-release-fails";
    const { token, expiresAt } = generateDownloadToken(attachmentId);
    mockFindLink.mockResolvedValue(ownedLink("link-release-fails", attachmentId, expiresAt, 42));
    mockMarkDownloaded.mockResolvedValue(true);
    mockOpenAttachment.mockRejectedValue(new Error("decrypt failed"));
    const releaseError = new Error("db down");
    mockReleaseLinkDownload.mockRejectedValue(releaseError);
    const logError = vi.spyOn(getLogger(), "error").mockImplementation(() => undefined);

    try {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: `/dl/${token}` });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: "download failed" });
      expect(logError).toHaveBeenCalledWith(
        expect.objectContaining({ err: releaseError, linkId: "link-release-fails" }),
        "failed to release download claim",
      );
    } finally {
      logError.mockRestore();
    }
  });

  it("disposes the opened attachment after a completed download and keeps the claim", async () => {
    const attachmentId = "attach-uuid-dispose-ok";
    const { token, expiresAt } = generateDownloadToken(attachmentId);
    const fileContent = Buffer.from("complete body");
    mockFindLink.mockResolvedValue(
      ownedLink("link-dispose-ok", attachmentId, expiresAt, fileContent.length),
    );
    mockMarkDownloaded.mockResolvedValue(true);
    mockOpenAttachment.mockResolvedValue({
      stream: Readable.from(fileContent),
      size: fileContent.length,
      dispose: mockDisposeOpened,
    });

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(fileContent);
    await vi.waitFor(() => expect(mockDisposeOpened).toHaveBeenCalledOnce());
    expect(mockReleaseLinkDownload).not.toHaveBeenCalled();
    expect(mockDecrementUserUsageMonth).not.toHaveBeenCalled();
  });

  it("releases the reserved egress and disposes when the filename cannot be encoded", async () => {
    const attachmentId = "attach-uuid-surrogate";
    const { token, expiresAt } = generateDownloadToken(attachmentId);
    const link = ownedLink("link-surrogate", attachmentId, expiresAt, 9);
    link.attachment.originalFilename = "bad\ud800name.pdf";
    mockFindLink.mockResolvedValue(link);
    mockMarkDownloaded.mockResolvedValue(true);
    const source = Readable.from(Buffer.from("surrogate"));
    mockOpenAttachment.mockResolvedValue({ stream: source, size: 9, dispose: mockDisposeOpened });

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });

    expect(res.statusCode).toBe(500);
    await vi.waitFor(() => expect(mockDisposeOpened).toHaveBeenCalledOnce());
    expect(mockDecrementUserUsageMonth).toHaveBeenCalledOnce();
    expect(mockDecrementUserUsageMonth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 1n, egressBytes: 9n }),
    );
    // The file opened fine; a broken name is not a reason to reopen the link.
    expect(mockReleaseLinkDownload).not.toHaveBeenCalled();
  });

  describe("over a real socket", () => {
    let app: Awaited<ReturnType<typeof buildApp>>;
    let agent: http.Agent;
    let port: number;

    beforeEach(async () => {
      app = await buildApp();
      await app.listen({ host: "127.0.0.1", port: 0 });
      port = (app.server.address() as AddressInfo).port;
      agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    });

    afterEach(async () => {
      agent.destroy();
      await app.close();
    });

    function get(path: string): Promise<{ status: number; body: Buffer }> {
      return new Promise((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path, agent }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
            );
            res.on("error", reject);
          })
          .on("error", reject);
      });
    }

    it("delivers the whole body on a keep-alive connection before disposing", async () => {
      // Larger than one stream chunk, so an early dispose would truncate it.
      const fileContent = Buffer.alloc(3 * 1024 * 1024, 0x61);
      const sources: Readable[] = [];
      mockMarkDownloaded.mockResolvedValue(true);
      mockOpenAttachment.mockImplementation(() => {
        const source = Readable.from(chunked(fileContent, 64 * 1024));
        sources.push(source);
        return Promise.resolve({
          stream: source,
          size: fileContent.length,
          dispose: () => {
            source.destroy();
            return mockDisposeOpened() as Promise<void>;
          },
        });
      });

      for (const attachmentId of ["attach-uuid-socket-1", "attach-uuid-socket-2"]) {
        const { token, expiresAt } = generateDownloadToken(attachmentId);
        mockFindLink.mockResolvedValue(
          ownedLink(`link-${attachmentId}`, attachmentId, expiresAt, fileContent.length),
        );
        const res = await get(`/dl/${token}`);
        expect(res.status).toBe(200);
        expect(res.body.equals(fileContent)).toBe(true);
      }

      await vi.waitFor(() => expect(mockDisposeOpened).toHaveBeenCalledTimes(2));
      expect(sources).toHaveLength(2);
      expect(mockDecrementUserUsageMonth).not.toHaveBeenCalled();
      expect(mockReleaseLinkDownload).not.toHaveBeenCalled();
    });

    it("disposes when the client left while the attachment was still being opened", async () => {
      const attachmentId = "attach-uuid-abort-during-open";
      const { token, expiresAt } = generateDownloadToken(attachmentId);
      mockFindLink.mockResolvedValue(ownedLink("link-abort-open", attachmentId, expiresAt, 5));
      mockMarkDownloaded.mockResolvedValue(true);
      let finishOpen: () => void = () => undefined;
      const opening = new Promise<void>((resolve) => {
        finishOpen = resolve;
      });
      const openStarted = new Promise<void>((resolve) => {
        mockOpenAttachment.mockImplementation(async () => {
          resolve();
          await opening;
          return {
            stream: Readable.from(Buffer.from("late!")),
            size: 5,
            dispose: mockDisposeOpened,
          };
        });
      });
      const sockets: Socket[] = [];
      app.server.on("connection", (socket) => sockets.push(socket));

      const req = http.get({ host: "127.0.0.1", port, path: `/dl/${token}`, agent });
      req.on("error", () => undefined);
      await openStarted;
      req.destroy();
      await vi.waitFor(() => expect(sockets[0]?.destroyed).toBe(true));
      finishOpen();

      await vi.waitFor(() => expect(mockDisposeOpened).toHaveBeenCalledOnce());
    });

    it.each([
      ["with a dispose (encrypted attachment)", true],
      ["without a dispose (plain attachment)", false],
    ])(
      "closes the source when the client aborts an owned download %s",
      async (_name, encrypted) => {
        const attachmentId = `attach-uuid-abort-${String(encrypted)}`;
        const { token, expiresAt } = generateDownloadToken(attachmentId);
        const size = 64 * 1024 * 1024;
        mockFindLink.mockResolvedValue(ownedLink("link-abort", attachmentId, expiresAt, size));
        mockMarkDownloaded.mockResolvedValue(true);
        // Never ends on its own: only a destroy from the route can close it.
        const source = new Readable({
          read() {
            this.push(Buffer.alloc(16 * 1024));
          },
        });
        mockDisposeOpened.mockImplementation(() => {
          source.destroy();
          return Promise.resolve();
        });
        mockOpenAttachment.mockResolvedValue({
          stream: source,
          size,
          ...(encrypted ? { dispose: mockDisposeOpened } : {}),
        });

        await new Promise<void>((resolve, reject) => {
          const req = http.get({ host: "127.0.0.1", port, path: `/dl/${token}`, agent }, (res) => {
            res.once("data", () => {
              req.destroy();
              resolve();
            });
            res.on("error", () => undefined);
          });
          req.on("error", (err) => {
            if (!req.destroyed) reject(err);
          });
        });

        await vi.waitFor(() => expect(source.destroyed).toBe(true));
        if (encrypted) expect(mockDisposeOpened).toHaveBeenCalledOnce();
        // The unsent part of the reservation is still refunded exactly once.
        await vi.waitFor(() => expect(mockDecrementUserUsageMonth).toHaveBeenCalledOnce());
        const [, refund] = mockDecrementUserUsageMonth.mock.calls[0] as [
          unknown,
          { egressBytes: bigint },
        ];
        expect(refund.egressBytes).toBeGreaterThan(0n);
        expect(refund.egressBytes).toBeLessThan(BigInt(size));
        expect(mockReleaseLinkDownload).not.toHaveBeenCalled();
      },
    );
  });

  it("returns 403 when the token HMAC does not match the stored attachment", async () => {
    const { token, expiresAt } = generateDownloadToken("attach-uuid-7");

    mockFindLink.mockResolvedValue({
      id: "link-4",
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

    const app = await buildApp();
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

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/octet-stream");
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

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/octet-stream");
    expect(res.headers["content-disposition"]).toContain('attachment; filename="attachment"');
  });

  it("falls back to octet-stream for unsafe mime types", async () => {
    const attachmentId = "attach-uuid-10";
    const { token, expiresAt } = generateDownloadToken(attachmentId);
    const fileContent = Buffer.from("<svg />");

    mockFindLink.mockResolvedValue({
      id: "link-7",
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

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/dl/${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/octet-stream");
  });
});
