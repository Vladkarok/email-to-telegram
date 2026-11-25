/**
 * The creation checks that run before any query, so they stay pinned in a
 * plain `npm test` without TEST_DATABASE_URL. Everything past them runs on
 * Postgres in tests/db/aliasOperations.pg.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createAliasForChat, type AliasDomainConfig } from "../../../src/aliases/creation.js";

const HOSTED: AliasDomainConfig = {
  appMode: "hosted",
  mailDomain: "legacy.example.com",
  hostedMailDomain: "inbox.example.com",
};

// Any query would touch this handle and throw.
const noDb = new Proxy(
  {},
  {
    get(): never {
      throw new Error("unexpected database access");
    },
  },
) as Parameters<typeof createAliasForChat>[0];

const savedAppMode = process.env["APP_MODE"];

afterEach(() => {
  if (savedAppMode === undefined) delete process.env["APP_MODE"];
  else process.env["APP_MODE"] = savedAppMode;
});

function create(requestedName: string): ReturnType<typeof createAliasForChat> {
  return createAliasForChat(
    noDb,
    { createdBy: 1n, chatId: -100n, threadId: null, requestedName },
    HOSTED,
  );
}

describe("alias creation checks before the database", () => {
  it("refuses a name over 32 characters before checking its characters", async () => {
    process.env["APP_MODE"] = "hosted";
    expect(await create("A".repeat(33))).toEqual({ kind: "name_too_long" });
    expect(await create("a".repeat(33))).toEqual({ kind: "name_too_long" });
  });

  it("refuses a name outside [a-z0-9._-]", async () => {
    process.env["APP_MODE"] = "hosted";
    expect(await create("Alerts")).toEqual({ kind: "invalid_name" });
    expect(await create("alerts@bad")).toEqual({ kind: "invalid_name" });
  });

  it("refuses an impersonating name in hosted mode only", async () => {
    process.env["APP_MODE"] = "hosted";
    expect(await create("postmaster")).toEqual({ kind: "impersonation" });

    process.env["APP_MODE"] = "self-hosted";
    await expect(create("postmaster")).rejects.toThrow("unexpected database access");
  });
});
