/**
 * Download-link claim and release against a real Postgres (TEST_DATABASE_URL,
 * see tests/helpers/pgTestDb.ts): a released claim makes the link usable
 * again, and a release never undoes a claim made by another request.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPgTestDatabase, hasTestDatabase, type PgTestDatabase } from "../helpers/pgTestDb.js";
import { markLinkDownloaded, releaseLinkDownload } from "../../src/db/repos/attachmentLinks.js";

const OWNER = 7101n;

describe.skipIf(!hasTestDatabase)("attachment link claim on real Postgres", () => {
  let t: PgTestDatabase;
  let linkId: string;

  beforeAll(async () => {
    t = await createPgTestDatabase();
    await t.migrate();
  });

  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    await t.pool.query("truncate users, email_addresses, delivery_logs cascade");
    await t.pool.query("insert into users (id, is_allowed, locale) values ($1, true, 'en')", [
      OWNER.toString(),
    ]);
    const alias = await t.pool.query<{ id: string }>(
      `insert into email_addresses (local_part, full_address, chat_id, created_by, status)
       values ('inbox', 'inbox@mail.example.com', $1, $1, 'active') returning id`,
      [OWNER.toString()],
    );
    const log = await t.pool.query<{ id: string }>(
      "insert into delivery_logs (email_address_id, user_id) values ($1, $2) returning id",
      [alias.rows[0].id, OWNER.toString()],
    );
    const attachment = await t.pool.query<{ id: string }>(
      "insert into attachments (delivery_log_id, storage_path) values ($1, '/data/a.bin') returning id",
      [log.rows[0].id],
    );
    const link = await t.pool.query<{ id: string }>(
      `insert into attachment_links (attachment_id, token_hash, expires_at)
       values ($1, 'hash', now() + interval '1 day') returning id`,
      [attachment.rows[0].id],
    );
    linkId = link.rows[0].id;
  });

  async function downloadedAt(): Promise<Date | null> {
    const { rows } = await t.pool.query<{ downloaded_at: Date | null }>(
      "select downloaded_at from attachment_links where id = $1",
      [linkId],
    );
    return rows[0].downloaded_at;
  }

  it("makes the link claimable again after the claiming request releases it", async () => {
    const claimedAt = new Date();
    expect(await markLinkDownloaded(t.db, linkId, claimedAt)).toBe(true);
    expect(await markLinkDownloaded(t.db, linkId)).toBe(false);

    expect(await releaseLinkDownload(t.db, linkId, claimedAt)).toBe(true);
    expect(await downloadedAt()).toBeNull();

    expect(await markLinkDownloaded(t.db, linkId)).toBe(true);
  });

  it("does not release a claim made by another request", async () => {
    const firstClaim = new Date("2026-04-07T10:00:00.123Z");
    const secondClaim = new Date("2026-04-07T10:00:05.456Z");
    expect(await markLinkDownloaded(t.db, linkId, firstClaim)).toBe(true);
    expect(await releaseLinkDownload(t.db, linkId, firstClaim)).toBe(true);
    expect(await markLinkDownloaded(t.db, linkId, secondClaim)).toBe(true);

    // A late or repeated release from the first request must be a no-op.
    expect(await releaseLinkDownload(t.db, linkId, firstClaim)).toBe(false);
    expect(await downloadedAt()).toEqual(secondClaim);
  });

  it("lets exactly one of two concurrent requests claim the link", async () => {
    const results = await Promise.all([
      markLinkDownloaded(t.db, linkId, new Date("2026-04-07T10:00:00.000Z")),
      markLinkDownloaded(t.db, linkId, new Date("2026-04-07T10:00:00.001Z")),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
