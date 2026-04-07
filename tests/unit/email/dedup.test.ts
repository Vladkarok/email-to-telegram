import { describe, it, expect, vi, beforeEach } from "vitest";
import { isDuplicate } from "../../../src/email/dedup.js";

vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockFindByMessageId = vi.fn();
const mockFindByBodyHash = vi.fn();

vi.mock("../../../src/db/repos/deliveryLogs.js", () => ({
  findDeliveryLogByMessageId: (...args: unknown[]): unknown => mockFindByMessageId(...args),
  findDeliveryLogByBodyHash: (...args: unknown[]): unknown => mockFindByBodyHash(...args),
}));

describe("isDuplicate", () => {
  beforeEach(() => {
    mockFindByMessageId.mockReset();
    mockFindByBodyHash.mockReset();
  });

  it("returns false when no prior delivery exists", async () => {
    mockFindByMessageId.mockResolvedValue(null);
    mockFindByBodyHash.mockResolvedValue(null);
    const result = await isDuplicate({} as Parameters<typeof isDuplicate>[0], {
      messageId: "<new@example.com>",
      bodySha256: "abc123",
      aliasId: "uuid-1",
      bodyDedupEnabled: false,
    });
    expect(result).toBe(false);
  });

  it("returns true when message-ID matches a prior delivery", async () => {
    mockFindByMessageId.mockResolvedValue({ id: "existing-log" });
    const result = await isDuplicate({} as Parameters<typeof isDuplicate>[0], {
      messageId: "<duplicate@example.com>",
      bodySha256: "xyz",
      aliasId: "uuid-1",
      bodyDedupEnabled: false,
    });
    expect(result).toBe(true);
  });

  it("returns true when body hash matches a prior delivery and body dedup is enabled", async () => {
    mockFindByMessageId.mockResolvedValue(null);
    mockFindByBodyHash.mockResolvedValue({ id: "existing-log" });
    const result = await isDuplicate({} as Parameters<typeof isDuplicate>[0], {
      messageId: null,
      bodySha256: "hashofbody",
      aliasId: "uuid-1",
      bodyDedupEnabled: true,
    });
    expect(result).toBe(true);
  });

  it("skips message-ID check when messageId is null", async () => {
    mockFindByMessageId.mockResolvedValue(null);
    mockFindByBodyHash.mockResolvedValue(null);
    await isDuplicate({} as Parameters<typeof isDuplicate>[0], {
      messageId: null,
      bodySha256: "abc",
      aliasId: "uuid-1",
      bodyDedupEnabled: false,
    });
    expect(mockFindByMessageId).not.toHaveBeenCalled();
  });

  it("skips body-hash dedup when body dedup is disabled", async () => {
    mockFindByMessageId.mockResolvedValue(null);
    mockFindByBodyHash.mockResolvedValue({ id: "existing-log" });
    const result = await isDuplicate({} as Parameters<typeof isDuplicate>[0], {
      messageId: null,
      bodySha256: "hashofbody",
      aliasId: "uuid-1",
      bodyDedupEnabled: false,
    });
    expect(result).toBe(false);
    expect(mockFindByBodyHash).not.toHaveBeenCalled();
  });
});
