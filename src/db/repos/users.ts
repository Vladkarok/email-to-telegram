import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { users, type User, type NewUser } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export async function upsertUser(db: Db, data: Pick<NewUser, "id" | "username">): Promise<User> {
  const [user] = await db
    .insert(users)
    .values({ id: data.id, username: data.username, isAllowed: false })
    .onConflictDoUpdate({
      target: users.id,
      set: { username: data.username, updatedAt: new Date() },
    })
    .returning();
  if (!user) throw new Error(`upsertUser: no row returned for id=${data.id}`);
  return user;
}

export async function findUserById(db: Db, id: bigint): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  return user ?? null;
}

export async function allowUser(db: Db, id: bigint): Promise<void> {
  await db.update(users).set({ isAllowed: true, updatedAt: new Date() }).where(eq(users.id, id));
}

export async function upsertAllowedUser(db: Db, id: bigint): Promise<void> {
  await db
    .insert(users)
    .values({ id, username: null, isAllowed: true })
    .onConflictDoUpdate({
      target: users.id,
      set: { isAllowed: true, updatedAt: new Date() },
    });
}
