export interface StartupOptions {
  migrateOnly: boolean;
  rewrapStorageKeys: boolean;
  backfillStorageEncryption: boolean;
  hostedExportOrganizationId: string | null;
  hostedExportOutputPath: string | null;
  hostedDeleteOrganizationId: string | null;
}

const booleanOperationFlags = new Set([
  "--migrate-only",
  "--rewrap-storage-keys",
  "--backfill-storage-encryption",
]);

const valuedFlags = new Set([
  "--hosted-export-organization",
  "--hosted-export-output",
  "--hosted-delete-organization",
]);

export function parseStartupOptions(argv: readonly string[]): StartupOptions {
  const options: StartupOptions = {
    migrateOnly: false,
    rewrapStorageKeys: false,
    backfillStorageEncryption: false,
    hostedExportOrganizationId: null,
    hostedExportOutputPath: null,
    hostedDeleteOrganizationId: null,
  };
  const operationFlags: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (booleanOperationFlags.has(arg)) {
      operationFlags.push(arg);
      switch (arg) {
        case "--migrate-only":
          options.migrateOnly = true;
          break;
        case "--rewrap-storage-keys":
          options.rewrapStorageKeys = true;
          break;
        case "--backfill-storage-encryption":
          options.backfillStorageEncryption = true;
          break;
      }
      continue;
    }

    if (valuedFlags.has(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for CLI argument: ${arg}`);
      }
      index += 1;

      switch (arg) {
        case "--hosted-export-organization":
          if (options.hostedExportOrganizationId) {
            throw new Error("CLI argument cannot be repeated: --hosted-export-organization");
          }
          options.hostedExportOrganizationId = value;
          operationFlags.push(arg);
          break;
        case "--hosted-export-output":
          if (options.hostedExportOutputPath) {
            throw new Error("CLI argument cannot be repeated: --hosted-export-output");
          }
          options.hostedExportOutputPath = value;
          break;
        case "--hosted-delete-organization":
          if (options.hostedDeleteOrganizationId) {
            throw new Error("CLI argument cannot be repeated: --hosted-delete-organization");
          }
          options.hostedDeleteOrganizationId = value;
          operationFlags.push(arg);
          break;
      }
      continue;
    }

    throw new Error(`Unknown CLI arguments: ${arg}`);
  }

  if (operationFlags.length > 1) {
    throw new Error(
      `Choose only one startup operation flag, received: ${operationFlags.join(", ")}`,
    );
  }

  if (options.hostedExportOrganizationId && !options.hostedExportOutputPath) {
    throw new Error(
      "CLI argument --hosted-export-output is required with --hosted-export-organization",
    );
  }
  if (!options.hostedExportOrganizationId && options.hostedExportOutputPath) {
    throw new Error("CLI argument --hosted-export-output requires --hosted-export-organization");
  }

  return options;
}
