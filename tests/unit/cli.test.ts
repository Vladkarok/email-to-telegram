import { describe, expect, it } from "vitest";
import { parseStartupOptions } from "../../src/cli.js";

describe("parseStartupOptions", () => {
  it("defaults to normal startup", () => {
    expect(parseStartupOptions([])).toEqual({ migrateOnly: false });
  });

  it("accepts --migrate-only", () => {
    expect(parseStartupOptions(["--migrate-only"])).toEqual({ migrateOnly: true });
  });

  it("rejects unknown arguments", () => {
    expect(() => parseStartupOptions(["--wat"])).toThrow("Unknown CLI arguments: --wat");
  });
});
