import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        // Entrypoints — require full runtime
        "src/index.ts",
        "src/cli.ts",
        "src/backupArchiveCli.ts",
        // DB bootstrap
        "src/db/migrate.ts",
        "src/db/client.ts",
        "src/db/schema.ts",
        // DB repos — integration-test territory (need real Postgres)
        "src/db/repos/**",
        // CLI commands — integration-test territory (need real DB + runtime)
        "src/cli/**",
        // Storage — integration-test territory (need real filesystem)
        "src/storage/**",
        // HTTP server setup — integration-test territory
        "src/http/server.ts",
        // Bot wiring — registers handlers, logic tested in individual handler files
        "src/telegram/bot.ts",
        // Alias resolver — queries DB directly, integration-test territory
        "src/telegram/aliasResolver.ts",
        // Pure type declarations (no executable code)
        "src/email/types.ts",
        // i18n message catalogs — data files with template functions per locale.
        // Coverage of these would require exercising every string under every
        // language, which is not a meaningful test signal.
        "src/i18n/locales/**",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        // vitest 4.x's v8 coverage counts more branch types than 2.x did
        // (optional chaining, nullish coalescing, logical assignment).
        // The actual code coverage is unchanged — only the measurement is.
        branches: 78,
        statements: 80,
      },
    },
  },
});
