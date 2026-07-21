import { describe, expect, it, vi } from "vitest";
import { upsertChat } from "../../../../src/db/repos/chats.js";
import { chats } from "../../../../src/db/schema.js";

describe("upsertChat", () => {
  function makeInsertDb() {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    return {
      db: { insert } as unknown as Parameters<typeof upsertChat>[0],
      insert,
      values,
      onConflictDoUpdate,
    };
  }

  it("updates title AND type on conflict (supergroup upgrades change the type)", async () => {
    const { db, insert, values, onConflictDoUpdate } = makeInsertDb();

    await upsertChat(db, { id: -100123n, title: "Upgraded", type: "supergroup" });

    expect(insert).toHaveBeenCalledWith(chats);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ id: -100123n, title: "Upgraded", type: "supergroup" }),
    );
    const [conflictArg] = onConflictDoUpdate.mock.calls[0] as [
      { target: unknown; set: { title: string; type: string; isActive: boolean } },
    ];
    expect(conflictArg.set.title).toBe("Upgraded");
    expect(conflictArg.set.type).toBe("supergroup");
    expect(conflictArg.set.isActive).toBe(true);
  });
});
