import { describe, expect, it, vi } from "vitest";
import {
  findHostedInboundBlock,
  normalizeInboundBlockValue,
  senderDomainFromEmail,
} from "../../../../src/db/repos/hostedInboundBlocks.js";

function makeDb(results: unknown[][]) {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  let queryIndex = 0;
  limit.mockImplementation(() => Promise.resolve(results[queryIndex++] ?? []));

  return {
    db: { select },
    mocks: { select, from, where, limit },
  } as unknown as {
    db: Parameters<typeof findHostedInboundBlock>[0];
    mocks: {
      select: ReturnType<typeof vi.fn>;
      from: ReturnType<typeof vi.fn>;
      where: ReturnType<typeof vi.fn>;
      limit: ReturnType<typeof vi.fn>;
    };
  };
}

describe("hosted inbound block repo", () => {
  it("normalizes block values", () => {
    expect(normalizeInboundBlockValue("  Alerts@Example.COM ")).toBe("alerts@example.com");
  });

  it("extracts sender domains case-insensitively", () => {
    expect(senderDomainFromEmail("Sender@Example.COM")).toBe("example.com");
    expect(senderDomainFromEmail("missing-at")).toBeNull();
  });

  it("returns exact sender email blocks first", async () => {
    const block = {
      id: "block-1",
      blockType: "sender_email",
      value: "sender@example.com",
      reason: null,
      createdAt: new Date(),
    };
    const { db, mocks } = makeDb([[block]]);

    await expect(
      findHostedInboundBlock(db, {
        localPart: "Alerts",
        recipientDomain: "Mail.Example.com",
        envelopeFrom: "Sender@Example.COM",
      }),
    ).resolves.toBe(block);

    expect(mocks.limit).toHaveBeenCalledTimes(1);
  });

  it("falls through to sender domain blocks", async () => {
    const block = {
      id: "block-1",
      blockType: "sender_domain",
      value: "attacker.com",
      reason: null,
      createdAt: new Date(),
    };
    const { db, mocks } = makeDb([[], [block]]);

    await expect(
      findHostedInboundBlock(db, {
        localPart: "alerts",
        recipientDomain: "mail.example.com",
        envelopeFrom: "spam@Attacker.COM",
      }),
    ).resolves.toBe(block);

    expect(mocks.limit).toHaveBeenCalledTimes(2);
  });

  it("checks recipient domain and local part blocks", async () => {
    const recipientBlock = {
      id: "block-recipient",
      blockType: "recipient_domain",
      value: "mail.example.com",
      reason: null,
      createdAt: new Date(),
    };
    const { db: domainDb, mocks: domainMocks } = makeDb([[recipientBlock]]);

    await expect(
      findHostedInboundBlock(domainDb, {
        localPart: "alerts",
        recipientDomain: "Mail.Example.COM",
      }),
    ).resolves.toBe(recipientBlock);
    expect(domainMocks.limit).toHaveBeenCalledTimes(1);

    const localBlock = {
      id: "block-local",
      blockType: "local_part",
      value: "alerts",
      reason: null,
      createdAt: new Date(),
    };
    const { db: localDb, mocks: localMocks } = makeDb([[], [localBlock]]);

    await expect(
      findHostedInboundBlock(localDb, {
        localPart: "Alerts",
        recipientDomain: "safe.example.com",
      }),
    ).resolves.toBe(localBlock);
    expect(localMocks.limit).toHaveBeenCalledTimes(2);
  });

  it("returns null when no candidates match", async () => {
    const { db, mocks } = makeDb([[], [], [], []]);

    await expect(
      findHostedInboundBlock(db, {
        localPart: "alerts",
        recipientDomain: "mail.example.com",
        envelopeFrom: "sender@example.com",
      }),
    ).resolves.toBeNull();

    expect(mocks.limit).toHaveBeenCalledTimes(4);
  });
});
