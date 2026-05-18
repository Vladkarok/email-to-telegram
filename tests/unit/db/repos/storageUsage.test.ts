import { describe, expect, it } from "vitest";
import {
  decrementUserStorageUsage,
  incrementUserStorageUsage,
} from "../../../../src/db/repos/storageUsage.js";

describe("user storage usage repos", () => {
  it("rejects negative increment deltas before touching the database", async () => {
    await expect(
      incrementUserStorageUsage({} as never, 1n, { rawEmailBytes: -1n }),
    ).rejects.toThrow(/non-negative/i);
  });

  it("rejects negative decrement deltas before touching the database", async () => {
    await expect(
      decrementUserStorageUsage({} as never, 1n, { attachmentBytes: -1n }),
    ).rejects.toThrow(/non-negative/i);
  });
});
