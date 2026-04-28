import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { loadConfig } from "../config.js";
import { findAliasByLocalPart, findAliasByLocalPartAndDomainId } from "../db/repos/aliases.js";
import { findInboundDomainByDomain } from "../db/repos/inboundDomains.js";
import type { EmailAddress } from "../db/schema.js";
import type * as schema from "../db/schema.js";

type Db = NodePgDatabase<typeof schema>;

export interface InboundAliasLookup {
  localPart: string;
  recipientDomain?: string | null;
}

export async function findAliasForInbound(
  db: Db,
  input: InboundAliasLookup,
): Promise<EmailAddress | null> {
  if (!shouldUseHostedDomainRouting()) {
    return findAliasByLocalPart(db, input.localPart);
  }

  if (!input.recipientDomain) return null;

  const domain = await findInboundDomainByDomain(db, input.recipientDomain);
  if (!domain || domain.status !== "active") return null;

  return findAliasByLocalPartAndDomainId(db, input.localPart, domain.id);
}

export function shouldUseHostedDomainRouting(): boolean {
  const appMode = process.env["APP_MODE"];
  if (appMode === "hosted") return true;
  if (appMode === "self-hosted") return false;

  try {
    return loadConfig().appMode === "hosted";
  } catch {
    return false;
  }
}
