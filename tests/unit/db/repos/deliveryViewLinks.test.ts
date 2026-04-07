import { describe, expect, it, vi } from "vitest";
import { createDeliveryViewLink } from "../../../../src/db/repos/deliveryViewLinks.js";
import { deliveryViewLinks } from "../../../../src/db/schema.js";

describe("createDeliveryViewLink", () => {
  it("upserts a single active privacy link per delivery log", async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    const db = { insert } as unknown as Parameters<typeof createDeliveryViewLink>[0];
    const expiresAt = new Date("2026-04-08T12:00:00Z");

    await createDeliveryViewLink(db, "log-uuid-1", "hash-123", expiresAt);

    expect(insert).toHaveBeenCalledWith(deliveryViewLinks);
    expect(values).toHaveBeenCalledWith({
      deliveryLogId: "log-uuid-1",
      tokenHash: "hash-123",
      expiresAt,
      viewedAt: null,
    });
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
    const firstCall = onConflictDoUpdate.mock.calls[0] as
      | [
          {
            target: unknown;
            set: { tokenHash: string; expiresAt: Date; viewedAt: null; createdAt: Date };
          },
        ]
      | undefined;
    expect(firstCall).toBeDefined();
    if (!firstCall) throw new Error("missing onConflictDoUpdate call");
    const [arg] = firstCall;
    expect(arg.target).toBe(deliveryViewLinks.deliveryLogId);
    expect(arg.set.tokenHash).toBe("hash-123");
    expect(arg.set.expiresAt).toBe(expiresAt);
    expect(arg.set.viewedAt).toBeNull();
    expect(arg.set.createdAt).toBeInstanceOf(Date);
  });
});
