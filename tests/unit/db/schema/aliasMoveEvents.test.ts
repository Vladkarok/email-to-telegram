import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { aliasMoveEvents, emailAddresses } from "../../../../src/db/schema.js";

describe("alias_move_events schema", () => {
  const table = getTableConfig(aliasMoveEvents);
  const columns = new Map(table.columns.map((c) => [c.name, c]));

  it("has NO foreign keys — the audit must outlive alias and user rows", () => {
    // Contract (cycle-3 finding): a hard delete via tombstone purge must not
    // cascade away the audit, and ownership must stay traceable afterwards.
    expect(table.foreignKeys).toHaveLength(0);
  });

  it("denormalizes both the alias id and its owner", () => {
    expect(columns.get("alias_id")?.notNull).toBe(true);
    expect(columns.get("alias_owner_id")?.notNull).toBe(true);
  });

  it("allows a null actor (migration events, and GDPR anonymisation)", () => {
    expect(columns.get("actor_id")?.notNull).toBe(false);
  });

  it("groups one migration's per-alias events under a shared operation id", () => {
    expect(columns.get("operation_id")?.notNull).toBe(true);
  });

  it("records the authorization path and the full old→new route", () => {
    expect(columns.get("authz_path")?.notNull).toBe(true);
    expect(columns.get("old_chat_id")?.notNull).toBe(true);
    expect(columns.get("new_chat_id")?.notNull).toBe(true);
    // Thread ids are forensics-only and nullable (General has no thread).
    expect(columns.get("old_thread_id")?.notNull).toBe(false);
    expect(columns.get("new_thread_id")?.notNull).toBe(false);
    expect(columns.get("outcome")?.notNull).toBe(true);
  });

  it("indexes the two query paths the feature needs", () => {
    const indexNames = table.indexes.map((i) => i.config.name);
    // Per-alias history (audit trail) and per-owner erasure/export (GDPR).
    expect(indexNames).toContain("idx_alias_move_events_alias_time");
    expect(indexNames).toContain("idx_alias_move_events_owner");
  });

  it("constrains authz_path to the three defined paths", () => {
    const checkNames = table.checks.map((c) => c.name);
    expect(checkNames).toContain("chk_alias_move_events_authz_path");
  });
});

describe("email_addresses.routing_version", () => {
  const columns = new Map(getTableConfig(emailAddresses).columns.map((c) => [c.name, c]));

  it("is NOT NULL so the CAS token can never be missing", () => {
    // Contract: authorization is bound to the state it authorized; a NULL
    // version would make `routing_version = ?` unsatisfiable and silently
    // turn every CAS mutation into a no-op.
    expect(columns.get("routing_version")?.notNull).toBe(true);
  });

  it("defaults to 0 so the migration is backfill-free", () => {
    expect(columns.get("routing_version")?.default).toBe(0);
  });
});
