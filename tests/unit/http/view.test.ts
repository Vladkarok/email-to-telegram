import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerRoutes } from "../../../src/http/routes/index.js";
import { generateDeliveryViewToken, verifyDownloadToken } from "../../../src/utils/tokens.js";
import {
  configureStorageEncryption,
  resetStorageEncryptionForTests,
} from "../../../src/security/encryption.js";
import { prepareDeliveryLogMetadataWrite } from "../../../src/security/deliveryLogMetadata.js";

vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

// What a nested tx.transaction() hands its callback: the savepoint handle.
const SAVEPOINT = { savepoint: true };
const mockSavepoint = vi.fn();
// The charge itself (lock, check, claim, count, rollback of refused charges)
// is covered on Postgres in tests/db/egressCharge.pg.test.ts; here it runs
// the route's own prepare and claim steps on a handle that records savepoints.
const CHARGE_MONTH = "2026-03";
type ChargeInput = {
  ownerUserId: bigint | null;
  at?: Date;
  onRefusal: "commit" | "rollback";
  prepare: (tx: unknown) => Promise<{ egressBytes: bigint; value: unknown }>;
  claim: (tx: unknown) => Promise<boolean>;
};
async function runCharge(_db: unknown, input: ChargeInput): Promise<unknown> {
  const tx = {
    transaction: async (fn: (savepoint: unknown) => Promise<unknown>) => {
      mockSavepoint();
      return fn(SAVEPOINT);
    },
  };
  const { egressBytes, value } = await input.prepare(tx);
  if (!(await input.claim(tx))) return { status: "claim_lost", month: CHARGE_MONTH };
  return { status: "charged", month: CHARGE_MONTH, egressBytes, value };
}
const mockChargeEgress = vi.fn(runCharge);
vi.mock("../../../src/billing/egressCharge.js", () => ({
  chargeEgress: (...args: Parameters<typeof runCharge>): unknown => mockChargeEgress(...args),
}));

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

const mockDecrementUserUsageMonth = vi.fn();
vi.mock("../../../src/db/repos/usage.js", () => ({
  decrementUserUsageMonth: (...args: unknown[]): unknown => mockDecrementUserUsageMonth(...args),
  usageMonthForDate: vi.fn(() => "2026-04"),
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
  adminEnabled: false,
  adminSecret: undefined,
  adminSessionSecret: undefined,
  nodeEnv: "test",
  adminSessionTtlMinutes: 60,
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
      userId: 1n,
      rawEmailPath: "/tmp/rawemails/privacy.eml",
      envelopeFrom: "sender@example.com",
      headerFrom: "sender@example.com",
      subject: "Privacy Test",
      receivedAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago — keep attachments in TTL window
      rawEmailEncryptionMode: "none",
      rawEmailWrappedDek: null,
      rawEmailKekKeyId: null,
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
  await registerRoutes(app, TEST_CONFIG);
  return app;
}

describe("/view/:token", () => {
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env["HMAC_SECRET"];
    process.env["HMAC_SECRET"] = "test-secret-that-is-long-enough-abc";
    vi.useRealTimers();
    vi.clearAllMocks();
    resetStorageEncryptionForTests();
    mockMarkDeliveryViewLinkViewed.mockResolvedValue(true);
    mockCreateAttachmentLink.mockResolvedValue(undefined);
    mockReadRawEmail.mockResolvedValue(RAW_EMAIL);
    mockListAttachments.mockResolvedValue([]);
    mockChargeEgress.mockImplementation(runCharge);
    mockDecrementUserUsageMonth.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env["HMAC_SECRET"] = savedSecret;
    resetStorageEncryptionForTests();
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
    const [, , , attachmentExpiresAt] = mockCreateAttachmentLink.mock.calls[0] as [
      unknown,
      string,
      string,
      Date,
    ];
    // expiry should be approximately receivedAt + 24h (the min of attachment/rawEmail TTL)
    const expectedExpiry = new Date(Date.now() - 60 * 60 * 1000 + 24 * 60 * 60 * 1000);
    expect(Math.abs(attachmentExpiresAt.getTime() - expectedExpiry.getTime())).toBeLessThan(5000);
    const urlMatch = res.body.match(/\/dl\/([^"]+)/);
    expect(urlMatch).not.toBeNull();
    if (!urlMatch) throw new Error("missing download link");
    expect(verifyDownloadToken(urlMatch[1], "att-1", attachmentExpiresAt)).toBe(true);
    expect(mockMarkDeliveryViewLinkViewed).toHaveBeenCalledWith(
      expect.anything(),
      "view-link-1",
      expect.any(Date),
    );
    expect(mockChargeEgress).toHaveBeenCalledOnce();
    const [, input] = mockChargeEgress.mock.calls[0];
    expect(input.ownerUserId).toBe(1n);
    // The month is fixed by the same instant the claim is stamped with.
    const [, , claimedAt] = mockMarkDeliveryViewLinkViewed.mock.calls[0] as [unknown, string, Date];
    expect(input.at).toBeInstanceOf(Date);
    expect(input.at).toBe(claimedAt);
    // A refusal must undo the attachment links the prepare step inserted.
    expect(input.onRefusal).toBe("rollback");
    // The charge is the byte length of the page actually served.
    const charge = (await mockChargeEgress.mock.results[0].value) as { egressBytes: bigint };
    expect(charge.egressBytes).toBe(BigInt(res.rawPayload.length));
    expect(mockDecrementUserUsageMonth).not.toHaveBeenCalled();
  });

  it("refunds the unsent part of an aborted POST in the month it was charged to", async () => {
    const { token, expiresAt } = generateDeliveryViewToken("log-uuid-1", 24);
    mockFindDeliveryViewLinkByTokenHash.mockResolvedValue(viewLinkRow(expiresAt));
    // A page far larger than the socket buffers, so an early abort leaves
    // most of it unsent.
    mockReadRawEmail.mockResolvedValue(
      Buffer.concat([
        Buffer.from("From: sender@example.com\r\nTo: alerts@example.com\r\nSubject: Big\r\n\r\n"),
        Buffer.alloc(16 * 1024 * 1024, 0x61),
      ]),
    );
    const app = await buildApp();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port, path: `/view/${token}`, method: "POST" },
          (res) => {
            res.once("data", () => {
              req.destroy();
              resolve();
            });
            res.on("error", () => undefined);
          },
        );
        req.on("error", (err) => {
          if (!req.destroyed) reject(err);
        });
        req.end();
      });

      await vi.waitFor(() => expect(mockDecrementUserUsageMonth).toHaveBeenCalledOnce());
      const charge = (await mockChargeEgress.mock.results[0].value) as { egressBytes: bigint };
      const [, refund] = mockDecrementUserUsageMonth.mock.calls[0] as [
        unknown,
        { userId: bigint; month: string; egressBytes: bigint },
      ];
      expect(refund.userId).toBe(1n);
      expect(refund.month).toBe(CHARGE_MONTH);
      expect(refund.egressBytes).toBeGreaterThan(0n);
      expect(refund.egressBytes).toBeLessThan(charge.egressBytes);
    } finally {
      await app.close();
    }
  });

  it("returns 403 when the egress charge is over the limit", async () => {
    const { token, expiresAt } = generateDeliveryViewToken("log-uuid-1", 24);
    mockFindDeliveryViewLinkByTokenHash.mockResolvedValue(viewLinkRow(expiresAt));
    mockChargeEgress.mockResolvedValue({
      status: "over_limit",
      month: CHARGE_MONTH,
      limit: { ok: false, code: "egress_limit" },
    });

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: `/view/${token}` });

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("monthly email view quota");
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

  it("returns 404 when the view link does not exist", async () => {
    const { token } = generateDeliveryViewToken("log-uuid-1", 24);
    mockFindDeliveryViewLinkByTokenHash.mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/view/${token}` });

    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("Link not found");
  });

  it("returns 403 when the signed token does not match the stored delivery log", async () => {
    const { token, expiresAt } = generateDeliveryViewToken("log-uuid-1", 24);
    mockFindDeliveryViewLinkByTokenHash.mockResolvedValue(
      viewLinkRow(expiresAt, { deliveryLogId: "different-log-id" }),
    );

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/view/${token}` });

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Invalid link");
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

  it("returns 410 when the delivery log no longer has a raw email path", async () => {
    const { token, expiresAt } = generateDeliveryViewToken("log-uuid-1", 24);
    mockFindDeliveryViewLinkByTokenHash.mockResolvedValue({
      ...viewLinkRow(expiresAt),
      deliveryLog: {
        ...viewLinkRow(expiresAt).deliveryLog,
        rawEmailPath: null,
      },
    });

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: `/view/${token}` });

    expect(res.statusCode).toBe(410);
    expect(res.body).toContain("Email unavailable");
  });

  it("returns 500 when reading the raw email fails unexpectedly", async () => {
    const { token, expiresAt } = generateDeliveryViewToken("log-uuid-1", 24);
    mockFindDeliveryViewLinkByTokenHash.mockResolvedValue(viewLinkRow(expiresAt));
    mockReadRawEmail.mockRejectedValue(new Error("boom"));

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: `/view/${token}` });

    expect(res.statusCode).toBe(500);
    expect(res.body).toContain("View failed");
  });

  it("returns 500 when encrypted delivery metadata cannot be decrypted", async () => {
    const { token, expiresAt } = generateDeliveryViewToken("log-uuid-1", 24);
    mockFindDeliveryViewLinkByTokenHash.mockResolvedValue({
      ...viewLinkRow(expiresAt),
      deliveryLog: {
        ...viewLinkRow(expiresAt).deliveryLog,
        envelopeFrom: null,
        headerFrom: null,
        subject: null,
        metadataCiphertext: null,
        metadataEncryptionMode: "local-v1",
        metadataWrappedDek: "wrapped",
        metadataKekKeyId: "key-id",
        metadataEncryptedAt: new Date(),
      },
    });

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: `/view/${token}` });

    expect(res.statusCode).toBe(500);
    expect(res.body).toContain("View failed");
  });

  it("does not issue privacy attachment links after attachment retention has already elapsed", async () => {
    const { token, expiresAt } = generateDeliveryViewToken("log-uuid-1", 72);
    const baseRow = viewLinkRow(expiresAt);
    mockFindDeliveryViewLinkByTokenHash.mockResolvedValue({
      ...baseRow,
      deliveryLog: {
        ...baseRow.deliveryLog,
        receivedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
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
    const res = await app.inject({ method: "POST", url: `/view/${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("/dl/");
    expect(res.body).not.toContain("report.pdf");
    expect(mockCreateAttachmentLink).not.toHaveBeenCalled();
  });

  it("skips attachments whose privacy download links fail to mint", async () => {
    const { token, expiresAt } = generateDeliveryViewToken("log-uuid-1", 24);
    mockFindDeliveryViewLinkByTokenHash.mockResolvedValue(viewLinkRow(expiresAt));
    mockListAttachments.mockResolvedValue([
      {
        id: "att-1",
        originalFilename: "report.pdf",
        sizeBytes: 1234,
      },
    ]);
    mockCreateAttachmentLink.mockRejectedValue(new Error("link mint failed"));

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: `/view/${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("report.pdf");
  });

  it("mints each privacy download link in its own savepoint", async () => {
    // One failed insert must not abort the transaction that also claims the
    // view link and holds the other attachments' links.
    const { token, expiresAt } = generateDeliveryViewToken("log-uuid-1", 24);
    mockFindDeliveryViewLinkByTokenHash.mockResolvedValue(viewLinkRow(expiresAt));
    mockListAttachments.mockResolvedValue([
      { id: "att-1", originalFilename: "gone.pdf", sizeBytes: 1234 },
      { id: "att-2", originalFilename: "kept.pdf", sizeBytes: 5678 },
    ]);
    mockCreateAttachmentLink.mockRejectedValueOnce(new Error("link mint failed"));

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: `/view/${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("gone.pdf");
    expect(res.body).toContain("kept.pdf");
    expect(mockSavepoint).toHaveBeenCalledTimes(2);
    expect(mockCreateAttachmentLink).toHaveBeenCalledTimes(2);
    for (const call of mockCreateAttachmentLink.mock.calls) expect(call[0]).toBe(SAVEPOINT);
    expect(mockMarkDeliveryViewLinkViewed).toHaveBeenCalledTimes(1);
  });

  it("decrypts stored delivery metadata for privacy views", async () => {
    configureStorageEncryption({
      mode: "local-v1",
      masterKey: Buffer.alloc(32, 5).toString("base64"),
      masterKeyId: "view-meta-key",
    });
    const encryptedMetadata = await prepareDeliveryLogMetadataWrite("log-uuid-1", {
      envelopeFrom: "relay@example.com",
      headerFrom: "Encrypted Sender <sender@example.com>",
      subject: "Encrypted Subject",
    });
    const { token, expiresAt } = generateDeliveryViewToken("log-uuid-1", 24);
    mockFindDeliveryViewLinkByTokenHash.mockResolvedValue({
      ...viewLinkRow(expiresAt),
      deliveryLog: {
        ...viewLinkRow(expiresAt).deliveryLog,
        envelopeFrom: encryptedMetadata.envelopeFrom,
        headerFrom: encryptedMetadata.headerFrom,
        subject: encryptedMetadata.subject,
        metadataCiphertext: encryptedMetadata.metadataCiphertext,
        metadataEncryptionMode: encryptedMetadata.metadataEncryptionMode,
        metadataWrappedDek: encryptedMetadata.metadataWrappedDek,
        metadataKekKeyId: encryptedMetadata.metadataKekKeyId,
        metadataEncryptedAt: encryptedMetadata.metadataEncryptedAt,
      },
    });
    mockReadRawEmail.mockResolvedValue(
      Buffer.from(
        "From: parsed@example.com\r\nTo: alerts@example.com\r\nSubject: Parsed Subject\r\n\r\nBody",
      ),
    );

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: `/view/${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Encrypted Sender &lt;sender@example.com&gt;");
    expect(res.body).toContain("Encrypted Subject");
    expect(res.body).not.toContain("Parsed Subject");
  });

  it("shows the stored From without mailparser's quotes when the raw email matches it", async () => {
    const { token, expiresAt } = generateDeliveryViewToken("log-uuid-1", 24);
    const row = viewLinkRow(expiresAt);
    mockFindDeliveryViewLinkByTokenHash.mockResolvedValue({
      ...row,
      deliveryLog: { ...row.deliveryLog, headerFrom: '"GitHub" <noreply@github.com>' },
    });
    mockReadRawEmail.mockResolvedValue(
      Buffer.from(
        'From: "GitHub" <noreply@github.com>\r\nTo: alerts@example.com\r\nSubject: Privacy Test\r\n\r\nBody',
      ),
    );

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: `/view/${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<dd>GitHub &lt;noreply@github.com&gt;</dd>");
    expect(res.body).not.toContain('"GitHub"');
  });

  it('shows "unknown" for an empty From, as Telegram does', async () => {
    const { token, expiresAt } = generateDeliveryViewToken("log-uuid-1", 24);
    const row = viewLinkRow(expiresAt);
    mockFindDeliveryViewLinkByTokenHash.mockResolvedValue({
      ...row,
      deliveryLog: { ...row.deliveryLog, headerFrom: "" },
    });
    mockReadRawEmail.mockResolvedValue(
      Buffer.from("From: <>\r\nTo: alerts@example.com\r\nSubject: Privacy Test\r\n\r\nBody"),
    );

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: `/view/${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<dd>unknown</dd>");
  });
});
