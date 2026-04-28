import { describe, expect, it } from "vitest";
import { parseStartupOptions } from "../../src/cli.js";

describe("parseStartupOptions", () => {
  it("defaults to normal startup", () => {
    expect(parseStartupOptions([])).toEqual({
      migrateOnly: false,
      rewrapStorageKeys: false,
      backfillStorageEncryption: false,
      hostedExportOrganizationId: null,
      hostedExportOutputPath: null,
      hostedDeleteOrganizationId: null,
    });
  });

  it("accepts --migrate-only", () => {
    expect(parseStartupOptions(["--migrate-only"])).toEqual({
      migrateOnly: true,
      rewrapStorageKeys: false,
      backfillStorageEncryption: false,
      hostedExportOrganizationId: null,
      hostedExportOutputPath: null,
      hostedDeleteOrganizationId: null,
    });
  });

  it("accepts --rewrap-storage-keys", () => {
    expect(parseStartupOptions(["--rewrap-storage-keys"])).toEqual({
      migrateOnly: false,
      rewrapStorageKeys: true,
      backfillStorageEncryption: false,
      hostedExportOrganizationId: null,
      hostedExportOutputPath: null,
      hostedDeleteOrganizationId: null,
    });
  });

  it("accepts --backfill-storage-encryption", () => {
    expect(parseStartupOptions(["--backfill-storage-encryption"])).toEqual({
      migrateOnly: false,
      rewrapStorageKeys: false,
      backfillStorageEncryption: true,
      hostedExportOrganizationId: null,
      hostedExportOutputPath: null,
      hostedDeleteOrganizationId: null,
    });
  });

  it("accepts hosted organization export arguments", () => {
    expect(
      parseStartupOptions([
        "--hosted-export-organization",
        "org_123",
        "--hosted-export-output",
        "/secure/org_123.json",
      ]),
    ).toEqual({
      migrateOnly: false,
      rewrapStorageKeys: false,
      backfillStorageEncryption: false,
      hostedExportOrganizationId: "org_123",
      hostedExportOutputPath: "/secure/org_123.json",
      hostedDeleteOrganizationId: null,
    });
  });

  it("accepts hosted organization delete arguments", () => {
    expect(parseStartupOptions(["--hosted-delete-organization", "org_123"])).toEqual({
      migrateOnly: false,
      rewrapStorageKeys: false,
      backfillStorageEncryption: false,
      hostedExportOrganizationId: null,
      hostedExportOutputPath: null,
      hostedDeleteOrganizationId: "org_123",
    });
  });

  it("rejects multiple startup operation flags", () => {
    expect(() => parseStartupOptions(["--migrate-only", "--rewrap-storage-keys"])).toThrow(
      /Choose only one startup operation flag/i,
    );
  });

  it("rejects combining hosted export and delete operations", () => {
    expect(() =>
      parseStartupOptions([
        "--hosted-export-organization",
        "org_123",
        "--hosted-export-output",
        "/secure/org_123.json",
        "--hosted-delete-organization",
        "org_123",
      ]),
    ).toThrow(/Choose only one startup operation flag/i);
  });

  it("rejects hosted export without an output path", () => {
    expect(() => parseStartupOptions(["--hosted-export-organization", "org_123"])).toThrow(
      /--hosted-export-output is required/i,
    );
  });

  it("rejects hosted export output without an export operation", () => {
    expect(() => parseStartupOptions(["--hosted-export-output", "/secure/org_123.json"])).toThrow(
      /requires --hosted-export-organization/i,
    );
  });

  it("rejects missing values for valued arguments", () => {
    expect(() => parseStartupOptions(["--hosted-delete-organization"])).toThrow(
      "Missing value for CLI argument: --hosted-delete-organization",
    );
  });

  it("rejects repeated valued arguments", () => {
    expect(() =>
      parseStartupOptions([
        "--hosted-delete-organization",
        "org_123",
        "--hosted-delete-organization",
        "org_456",
      ]),
    ).toThrow("CLI argument cannot be repeated: --hosted-delete-organization");
  });

  it("rejects unknown arguments", () => {
    expect(() => parseStartupOptions(["--wat"])).toThrow("Unknown CLI arguments: --wat");
  });
});
