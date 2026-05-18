import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { loadConfig } from "../config.js";
import {
  findHostedInboundBlock,
  type HostedInboundBlockInput,
} from "../db/repos/hostedInboundBlocks.js";
import type * as schema from "../db/schema.js";

type Db = NodePgDatabase<typeof schema>;

export async function findHostedInboundRejection(
  db: Db,
  input: HostedInboundBlockInput & { userId?: bigint | null },
) {
  if (!shouldCheckHostedInboundBlocklist()) return null;
  if (input.userId == null) return null;
  return findHostedInboundBlock(db, input);
}

function shouldCheckHostedInboundBlocklist(): boolean {
  const appMode = process.env["APP_MODE"];
  if (appMode === "hosted") return true;
  if (appMode === "self-hosted") return false;

  try {
    return loadConfig().appMode === "hosted";
  } catch {
    return false;
  }
}
