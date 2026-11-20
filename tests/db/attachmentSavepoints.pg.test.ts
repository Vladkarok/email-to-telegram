/**
 * Attachment inserts against a real Postgres (TEST_DATABASE_URL, see
 * tests/helpers/pgTestDb.ts). A failed statement aborts the transaction it
 * runs in, and a mock cannot show that: only a savepoint around each insert
 * keeps the delivery transaction, the other attachments and the storage
 * compensation alive.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema.js";
import { createPgTestDatabase, hasTestDatabase, type PgTestDatabase } from "../helpers/pgTestDb.js";
import { createLogger, setLogger } from "../../src/utils/logger.js";
import { deliverQueuedEmail } from "../../src/email/pipeline.js";
import type { QueuedInboundEmail } from "../../src/email/pipeline/types.js";

setLogger(createLogger("silent"));

const OWNER = 7001n;

describe.skipIf(!hasTestDatabase)("attachment inserts on real Postgres", () => {
  let t: PgTestDatabase;
  let attachmentDir: string;
  const savedHmacSecret = process.env["HMAC_SECRET"];

  beforeAll(async () => {
    t = await createPgTestDatabase();
    await t.migrate();
    attachmentDir = await mkdtemp(join(tmpdir(), "etg-att-"));
    process.env["HMAC_SECRET"] = "test-secret-that-is-long-enough-abc";
  });

  afterAll(async () => {
    await t?.drop();
    await rm(attachmentDir, { recursive: true, force: true });
    if (savedHmacSecret === undefined) delete process.env["HMAC_SECRET"];
    else process.env["HMAC_SECRET"] = savedHmacSecret;
  });

  beforeEach(async () => {
    await t.pool.query("truncate users, email_addresses, delivery_logs cascade");
    await t.pool.query("insert into users (id, is_allowed, locale) values ($1, true, 'en')", [
      OWNER.toString(),
    ]);
  });

  function attachment(filename: string, body: string) {
    const content = Buffer.from(body);
    return {
      filename,
      contentType: "application/pdf",
      sizeBytes: content.length,
      sha256: "0".repeat(64),
      content,
    };
  }

  async function seedJob(
    attachments: ReturnType<typeof attachment>[],
  ): Promise<QueuedInboundEmail> {
    const [alias] = await t.db
      .insert(schema.emailAddresses)
      .values({
        localPart: "inbox",
        fullAddress: "inbox@mail.example.com",
        chatId: OWNER,
        createdBy: OWNER,
        status: "active",
      })
      .returning();
    const [deliveryLog] = await t.db
      .insert(schema.deliveryLogs)
      .values({ emailAddressId: alias.id, userId: OWNER, finalStatus: "received" })
      .returning();
    // What the queue step reserves for these attachments.
    const reserved = attachments.reduce((sum, att) => sum + att.sizeBytes, 0);
    await t.db
      .insert(schema.userStorageUsage)
      .values({ userId: OWNER, rawEmailBytes: 0n, attachmentBytes: BigInt(reserved) });

    return {
      alias,
      deliveryLog,
      envelopeFrom: "sender@example.com",
      parsed: {
        messageId: "<id@test>",
        subject: "Attachments",
        envelopeFrom: "sender@example.com",
        headerFrom: "sender@example.com",
        headerFromDisplay: "sender@example.com",
        headerFromEmail: "sender@example.com",
        headerFromDomain: "example.com",
        textBody: "hello",
        htmlBody: null,
        bodySha256: null,
        attachments,
        rawSizeBytes: 100,
      },
      publicBaseUrl: "https://mail.example.com",
      attachmentDir,
      attachmentTtlHours: 24,
      rawEmailTtlHours: 24,
      telegramRichMessagesEnabled: false,
    };
  }

  it("keeps the other attachments when one insert fails", async () => {
    // The parser caps filenames; this job skips it, so the middle insert
    // really fails with 22001 (value too long for varchar(255)).
    const tooLong = attachment("x".repeat(300) + ".pdf", "does not fit");
    const job = await seedJob([
      attachment("first.pdf", "first file"),
      tooLong,
      attachment("last.pdf", "last file!"),
    ]);

    const result = await deliverQueuedEmail(t.db, null, job);

    expect(result).toEqual({ ok: true });
    const rows = await t.db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.deliveryLogId, job.deliveryLog.id));
    expect(rows.map((row) => row.originalFilename).sort()).toEqual(["first.pdf", "last.pdf"]);
    const links = await t.db.select().from(schema.attachmentLinks);
    expect(links.map((link) => link.attachmentId).sort()).toEqual(rows.map((row) => row.id).sort());

    // The transaction committed: the log moved on and the stored files stay.
    const [log] = await t.db
      .select()
      .from(schema.deliveryLogs)
      .where(eq(schema.deliveryLogs.id, job.deliveryLog.id));
    expect(log?.finalStatus).toBe("processing");
    for (const row of rows) expect(existsSync(row.storagePath)).toBe(true);

    // The failed attachment is compensated: file removed, reservation released.
    expect(await readdir(join(attachmentDir, job.deliveryLog.id))).toHaveLength(2);
    const [usage] = await t.db
      .select()
      .from(schema.userStorageUsage)
      .where(eq(schema.userStorageUsage.userId, OWNER));
    expect(usage?.attachmentBytes).toBe(BigInt("first file".length + "last file!".length));
  });

  it("keeps the attachment row when only its link insert fails", async () => {
    const job = await seedJob([attachment("report.pdf", "report")]);
    // Any link insert now fails, inside its own savepoint.
    await t.pool.query(
      "alter table attachment_links add constraint test_no_links check (false) not valid",
    );

    try {
      const result = await deliverQueuedEmail(t.db, null, job);
      expect(result).toEqual({ ok: true });
    } finally {
      await t.pool.query("alter table attachment_links drop constraint test_no_links");
    }

    const rows = await t.db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.deliveryLogId, job.deliveryLog.id));
    expect(rows).toHaveLength(1);
    expect(existsSync(rows[0].storagePath)).toBe(true);
    expect(await t.db.select().from(schema.attachmentLinks)).toHaveLength(0);
    // The row and its file exist, so the reservation is still owed.
    const [usage] = await t.db
      .select()
      .from(schema.userStorageUsage)
      .where(eq(schema.userStorageUsage.userId, OWNER));
    expect(usage?.attachmentBytes).toBe(BigInt("report".length));
  });
});
