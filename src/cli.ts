export interface StartupOptions {
  migrateOnly: boolean;
}

export function parseStartupOptions(argv: readonly string[]): StartupOptions {
  const unknown = argv.filter((arg) => arg !== "--migrate-only");
  if (unknown.length > 0) {
    throw new Error(`Unknown CLI arguments: ${unknown.join(", ")}`);
  }

  return {
    migrateOnly: argv.includes("--migrate-only"),
  };
}
