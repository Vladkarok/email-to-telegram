import { describe, expect, it } from "vitest";
import type { StartupOptions } from "../../../src/cli.js";
import type { AppConfig } from "../../../src/config.js";
import {
  assertHostedDataLifecycleAllowed,
  hasHostedDataLifecycleOperation,
  hostedDeleteExitCode,
} from "../../../src/startup/hostedDataLifecycle.js";

describe("hosted data lifecycle startup helpers", () => {
  it("detects hosted data lifecycle operations", () => {
    expect(hasHostedDataLifecycleOperation(startupOptions({}))).toBe(false);
    expect(
      hasHostedDataLifecycleOperation(
        startupOptions({
          hostedExportOrganizationId: "org_123",
          hostedExportOutputPath: "out.json",
        }),
      ),
    ).toBe(true);
    expect(
      hasHostedDataLifecycleOperation(startupOptions({ hostedDeleteOrganizationId: "org_123" })),
    ).toBe(true);
  });

  it("rejects hosted data lifecycle operations outside hosted mode", () => {
    expect(() => assertHostedDataLifecycleAllowed(appConfig("self-hosted"))).toThrow(
      "Hosted data lifecycle commands require APP_MODE=hosted",
    );
    expect(() => assertHostedDataLifecycleAllowed(appConfig("hosted"))).not.toThrow();
  });

  it("fails deletion command exit status when records are missing or files remain", () => {
    expect(
      hostedDeleteExitCode({
        deleted: true,
        rawEmailFiles: 1,
        attachmentFiles: 1,
        failedFileDeletes: [],
      }),
    ).toBe(0);
    expect(
      hostedDeleteExitCode({
        deleted: false,
        rawEmailFiles: 0,
        attachmentFiles: 0,
        failedFileDeletes: [],
      }),
    ).toBe(1);
    expect(
      hostedDeleteExitCode({
        deleted: true,
        rawEmailFiles: 1,
        attachmentFiles: 1,
        failedFileDeletes: ["/data/raw/missing.eml"],
      }),
    ).toBe(1);
  });
});

function startupOptions(overrides: Partial<StartupOptions>): StartupOptions {
  return {
    migrateOnly: false,
    rewrapStorageKeys: false,
    backfillStorageEncryption: false,
    hostedExportOrganizationId: null,
    hostedExportOutputPath: null,
    hostedDeleteOrganizationId: null,
    ...overrides,
  };
}

function appConfig(appMode: AppConfig["appMode"]): AppConfig {
  return { appMode } as AppConfig;
}
