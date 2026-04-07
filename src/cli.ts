export interface StartupOptions {
  migrateOnly: boolean;
  rewrapStorageKeys: boolean;
  backfillStorageEncryption: boolean;
}

export function parseStartupOptions(argv: readonly string[]): StartupOptions {
  const allowed = new Set([
    "--migrate-only",
    "--rewrap-storage-keys",
    "--backfill-storage-encryption",
  ]);
  const unknown = argv.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) {
    throw new Error(`Unknown CLI arguments: ${unknown.join(", ")}`);
  }

  const operationFlags = argv.filter((arg) =>
    ["--migrate-only", "--rewrap-storage-keys", "--backfill-storage-encryption"].includes(arg),
  );
  if (operationFlags.length > 1) {
    throw new Error(
      `Choose only one startup operation flag, received: ${operationFlags.join(", ")}`,
    );
  }

  return {
    migrateOnly: argv.includes("--migrate-only"),
    rewrapStorageKeys: argv.includes("--rewrap-storage-keys"),
    backfillStorageEncryption: argv.includes("--backfill-storage-encryption"),
  };
}
