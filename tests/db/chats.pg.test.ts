/**
 * findActiveChatsForUser against a real Postgres (TEST_DATABASE_URL, see
 * tests/helpers/pgTestDb.ts): the filter is on chat type, so it has to be
 * checked where the SQL actually runs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema.js";
import { createPgTestDatabase, hasTestDatabase, type PgTestDatabase } from "../helpers/pgTestDb.js";
import { findActiveChatsForUser } from "../../src/db/repos/chats.js";

const CALLER = 8001n;
const OTHER_USER = 8002n;
const GROUP = -8003n;
const SUPERGROUP = -1008004n;
const INACTIVE_GROUP = -8005n;
// A positive id that is not a private chat: the filter must go by type, not sign.
const POSITIVE_NON_PRIVATE = 8006n;

describe.skipIf(!hasTestDatabase)("findActiveChatsForUser (postgres)", () => {
  let testDb: PgTestDatabase;

  beforeAll(async () => {
    testDb = await createPgTestDatabase();
    await testDb.migrate();
    await testDb.db.insert(schema.chats).values([
      { id: CALLER, title: "Caller DM", type: "private", isActive: true },
      { id: OTHER_USER, title: "Other DM", type: "private", isActive: true },
      { id: GROUP, title: "Group", type: "group", isActive: true },
      { id: SUPERGROUP, title: "Supergroup", type: "supergroup", isActive: true },
      { id: INACTIVE_GROUP, title: "Left group", type: "group", isActive: false },
      { id: POSITIVE_NON_PRIVATE, title: "Odd row", type: "channel", isActive: true },
    ]);
  });

  afterAll(async () => {
    await testDb.drop();
  });

  const idsFor = async (userId: bigint): Promise<bigint[]> =>
    (await findActiveChatsForUser(testDb.db, userId)).map((chat) => chat.id).sort();

  it("returns the caller's own DM and every active non-private chat", async () => {
    expect(await idsFor(CALLER)).toEqual([CALLER, GROUP, SUPERGROUP, POSITIVE_NON_PRIVATE].sort());
  });

  it("leaves out other users' DMs and inactive chats", async () => {
    const ids = await idsFor(CALLER);
    expect(ids).not.toContain(OTHER_USER);
    expect(ids).not.toContain(INACTIVE_GROUP);
  });

  it("returns only the non-private chats for a user with no DM row", async () => {
    expect(await idsFor(9999n)).toEqual([GROUP, SUPERGROUP, POSITIVE_NON_PRIVATE].sort());
  });
});
