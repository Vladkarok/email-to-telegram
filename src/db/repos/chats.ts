import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { chats, type Chat } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export async function upsertChat(
  db: Db,
  data: { id: bigint; title: string; type: string },
): Promise<void> {
  await db
    .insert(chats)
    .values({ id: data.id, title: data.title, type: data.type, isActive: true })
    .onConflictDoUpdate({
      target: chats.id,
      set: { title: data.title, isActive: true, updatedAt: new Date() },
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
