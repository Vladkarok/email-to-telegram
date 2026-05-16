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
        // Entrypoint and DB bootstrap — require full runtime
        "src/index.ts",
        "src/db/migrate.ts",
        "src/db/client.ts",
        "src/db/schema.ts",
        // DB repos — integration-test territory (need real Postgres)
        "src/db/repos/**",
        // Storage — integration-test territory (need real filesystem)
        "src/storage/**",
        // HTTP server setup — integration-test territory
        "src/http/server.ts",
        // Bot wiring — registers handlers, logic tested in individual handler files
        "src/telegram/bot.ts",
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
        branches: 80,
        statements: 80,
      },
    },
  },
});
