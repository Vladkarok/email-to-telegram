import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { count, eq, sql } from "drizzle-orm";
import { chats, type Chat } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export async function countChats(db: Db): Promise<{ total: number; active: number }> {
  const [row] = await db
    .select({
      total: count(),
      active: sql<number>`count(*) filter (where ${chats.isActive} = true)`,
    })
    .from(chats);
  return { total: Number(row?.total ?? 0), active: Number(row?.active ?? 0) };
}

export async function upsertChat(
  db: Db,
  data: { id: bigint; title: string; type: string },
): Promise<void> {
  await db
    .insert(chats)
    .values({
      id: data.id,
      title: data.title,
      type: data.type,
      isActive: true,
    })
    .onConflictDoUpdate({
      target: chats.id,
      set: {
        title: data.title,
        // A group→supergroup migration changes the type of a known chat id's
        // successor; keep it current alongside the title.
        type: data.type,
        isActive: true,
        updatedAt: new Date(),
      },
    });
}

export async function deactivateChat(db: Db, id: bigint): Promise<void> {
  await db.update(chats).set({ isActive: false, updatedAt: new Date() }).where(eq(chats.id, id));
}

export async function findActiveChats(db: Db): Promise<Chat[]> {
  return db.select().from(chats).where(eq(chats.isActive, true));
}

export async function findChatById(db: Db, id: bigint): Promise<Chat | null> {
  const [chat] = await db.select().from(chats).where(eq(chats.id, id));
  return chat ?? null;
}
