import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { isHostedMode } from "../hostedMode.js";
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
  if (!isHostedMode()) return null;
  if (input.userId == null) return null;
  return findHostedInboundBlock(db, input);
}
