import { describe, expect, it, vi } from "vitest";
import { ensureSharedInboundDomain } from "../../../../src/db/repos/inboundDomains.js";

function makeDb(existing: unknown[], created: unknown[] = []) {
  const where = vi.fn().mockResolvedValueOnce(existing).mockResolvedValueOnce(existing);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const returning = vi.fn().mockResolvedValue(created);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));

  return {
    db: { select, insert },
    mocks: { select, insert, values, onConflictDoNothing, returning },
  } as unknown as {
    db: Parameters<typeof ensureSharedInboundDomain>[0];
    mocks: {
      select: ReturnType<typeof vi.fn>;
      insert: ReturnType<typeof vi.fn>;
      values: ReturnType<typeof vi.fn>;
      onConflictDoNothing: ReturnType<typeof vi.fn>;
      returning: ReturnType<typeof vi.fn>;
    };
  };
}

describe("inbound domain repo", () => {
  it("returns an existing active shared domain", async () => {
    const existing = {
      id: "domain-1",
      domain: "inbox.example.com",
      kind: "shared",
      status: "active",
    };
    const { db, mocks } = makeDb([existing]);

    await expect(ensureSharedInboundDomain(db, "Inbox.Example.COM")).resolves.toBe(existing);

    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("creates a missing shared domain in lowercase", async () => {
    const created = {
      id: "domain-1",
      domain: "inbox.example.com",
      kind: "shared",
      status: "active",
    };
    const { db, mocks } = makeDb([], [created]);

    await expect(ensureSharedInboundDomain(db, "Inbox.Example.COM")).resolves.toBe(created);

    expect(mocks.values).toHaveBeenCalledWith({
      domain: "inbox.example.com",
      kind: "shared",
      status: "active",
    });
  });

  it("rejects existing disabled or custom rows", async () => {
    await expect(
      ensureSharedInboundDomain(
        makeDb([
          {
            id: "domain-1",
            domain: "inbox.example.com",
            kind: "shared",
            status: "disabled",
          },
        ]).db,
        "inbox.example.com",
      ),
    ).rejects.toThrow(/not active/i);

    await expect(
      ensureSharedInboundDomain(
        makeDb([
          {
            id: "domain-2",
            domain: "inbox.example.com",
            kind: "custom",
            status: "active",
          },
        ]).db,
        "inbox.example.com",
      ),
    ).rejects.toThrow(/not active/i);
  });
});
