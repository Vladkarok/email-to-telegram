/**
 * Alias mutations behind the alias menu's buttons that hold a rule of their
 * own: a check before the write, a read-modify-write, or a branch on the
 * outcome. Handlers that are only "guard, one repo call, render" call the
 * repo directly. Routing changes go through `aliasRouting.ts` and its
 * version CAS.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import type { EmailAddress } from "../db/schema.js";
import {
  findAliasById,
  updateAliasBodyDedup,
  updateAliasPrivacyMode,
  updateAliasRenderMode,
} from "../db/repos/aliases.js";
import { softDeleteAliasWithCas } from "../db/repos/aliasRouting.js";

type Db = NodePgDatabase<typeof schema>;

export type AliasDeleteResult =
  | { kind: "deleted"; alias: EmailAddress }
  | { kind: "not_found" }
  | { kind: "routing_changed" };

/**
 * Deletes an alias against the routing version its confirmation screen was
 * built from. `alias` in the result is the row read before the delete.
 */
export async function deleteAliasAtVersion(
  db: Db,
  input: { aliasId: string; expectedVersion: number },
): Promise<AliasDeleteResult> {
  const alias = await findAliasById(db, input.aliasId);
  if (!alias) return { kind: "not_found" };
  // Version-guarded against the state the CONFIRMATION SCREEN was built
  // from (carried in the callback data), not the current row — otherwise
  // the CAS could never fail and a stale delete would win a move race.
  const deletion = await softDeleteAliasWithCas(db, {
    aliasId: alias.id,
    expectedVersion: input.expectedVersion,
  });
  if (!deletion.ok) return { kind: "routing_changed" };
  return { kind: "deleted", alias };
}

const RENDER_MODES = ["plaintext", "html"] as const;
type RenderMode = (typeof RENDER_MODES)[number];

/** Sets the render mode, refusing anything but the two supported modes. */
export async function setAliasRenderMode(
  db: Db,
  aliasId: string,
  mode: string,
): Promise<{ kind: "updated"; mode: RenderMode } | { kind: "invalid_mode" }> {
  if (!(RENDER_MODES as readonly string[]).includes(mode)) return { kind: "invalid_mode" };
  await updateAliasRenderMode(db, aliasId, mode as RenderMode);
  return { kind: "updated", mode: mode as RenderMode };
}

export type AliasToggleResult = { kind: "toggled"; enabled: boolean } | { kind: "not_found" };

/** Flips body-hash dedup; `enabled` is the value written. */
export async function toggleAliasBodyDedup(db: Db, aliasId: string): Promise<AliasToggleResult> {
  const alias = await findAliasById(db, aliasId);
  if (!alias) return { kind: "not_found" };
  const enabled = !alias.bodyDedupEnabled;
  await updateAliasBodyDedup(db, aliasId, enabled);
  return { kind: "toggled", enabled };
}

/** Flips privacy mode; `enabled` is the value written. */
export async function toggleAliasPrivacyMode(db: Db, aliasId: string): Promise<AliasToggleResult> {
  const alias = await findAliasById(db, aliasId);
  if (!alias) return { kind: "not_found" };
  const enabled = !alias.privacyModeEnabled;
  await updateAliasPrivacyMode(db, aliasId, enabled);
  return { kind: "toggled", enabled };
}
