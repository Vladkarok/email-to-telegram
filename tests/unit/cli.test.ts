import { describe, expect, it } from "vitest";
import { parseStartupOptions } from "../../src/cli.js";

describe("parseStartupOptions", () => {
  it("defaults to normal startup", () => {
    expect(parseStartupOptions([])).toEqual({
      migrateOnly: false,
      rewrapStorageKeys: false,
      backfillStorageEncryption: false,
    });
  });

  it("accepts --migrate-only", () => {
    expect(parseStartupOptions(["--migrate-only"])).toEqual({
      migrateOnly: true,
      rewrapStorageKeys: false,
      backfillStorageEncryption: false,
    });
  });

  it("accepts --rewrap-storage-keys", () => {
    expect(parseStartupOptions(["--rewrap-storage-keys"])).toEqual({
      migrateOnly: false,
      rewrapStorageKeys: true,
      backfillStorageEncryption: false,
    });
  });

  it("accepts --backfill-storage-encryption", () => {
    expect(parseStartupOptions(["--backfill-storage-encryption"])).toEqual({
      migrateOnly: false,
      rewrapStorageKeys: false,
      backfillStorageEncryption: true,
    });
  });

  it("rejects multiple startup operation flags", () => {
    expect(() => parseStartupOptions(["--migrate-only", "--rewrap-storage-keys"])).toThrow(
      /Choose only one startup operation flag/i,
    );
  });

  it("rejects unknown arguments", () => {
    expect(() => parseStartupOptions(["--wat"])).toThrow("Unknown CLI arguments: --wat");
  });
});
