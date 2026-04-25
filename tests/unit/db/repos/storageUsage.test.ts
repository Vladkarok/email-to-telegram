import { describe, expect, it } from "vitest";
import {
  decrementOrganizationStorageUsage,
  incrementOrganizationStorageUsage,
} from "../../../../src/db/repos/storageUsage.js";

describe("organization storage usage repos", () => {
  it("rejects negative increment deltas before touching the database", async () => {
    await expect(
      incrementOrganizationStorageUsage({} as never, "org-1", { rawEmailBytes: -1n }),
    ).rejects.toThrow(/non-negative/i);
  });

  it("rejects negative decrement deltas before touching the database", async () => {
    await expect(
      decrementOrganizationStorageUsage({} as never, "org-1", { attachmentBytes: -1n }),
    ).rejects.toThrow(/non-negative/i);
  });
});
