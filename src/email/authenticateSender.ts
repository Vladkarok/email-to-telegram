import { promises as dns } from "node:dns";
import { simpleParser } from "mailparser";
import { authenticate, type AuthenticateResult, type DNSResolver } from "mailauth";

const AUTH_DNS_TIMEOUT_MS = 5_000;

export interface SenderAuthResult {
  headerFromEmail: string | null;
  headerFromDomain: string | null;
  dkimPassDomains: string[];
  dmarcPass: boolean;
  authenticatedDomains: string[];
  status: "pass" | "fail" | "temperror" | "permerror";
  reason: string;
}

export async function authenticateSender(
  rawEmail: Buffer,
  envelopeFrom: string | null,
): Promise<SenderAuthResult> {
  const parsed = await simpleParser(rawEmail);
  const fromValues = parsed.from?.value ?? [];
  if (fromValues.length !== 1) {
    return {
      headerFromEmail: null,
      headerFromDomain: null,
      dkimPassDomains: [],
      dmarcPass: false,
      authenticatedDomains: [],
      status: "permerror",
      reason: fromValues.length === 0 ? "header_from_missing" : "header_from_multiple",
    };
  }

  const headerFromEmail = normalizeEmail(fromValues[0]?.address);
  const headerFromDomain = domainFromEmail(headerFromEmail);
  if (!headerFromEmail || !headerFromDomain) {
    return {
      headerFromEmail,
      headerFromDomain,
      dkimPassDomains: [],
      dmarcPass: false,
      authenticatedDomains: [],
      status: "permerror",
      reason: "header_from_invalid",
    };
  }

  let result: AuthenticateResult;
  try {
    result = await authenticate(rawEmail, {
      sender: envelopeFrom ?? undefined,
      resolver: resolveAuthDns,
      disableArc: true,
      disableBimi: true,
      mta: "email-to-telegram",
    });
  } catch (err: unknown) {
    return {
      headerFromEmail,
      headerFromDomain,
      dkimPassDomains: [],
      dmarcPass: false,
      authenticatedDomains: [],
      status: "temperror",
      reason: err instanceof Error ? err.message : "sender_auth_exception",
    };
  }

  const dkimPassDomains = result.dkim.results
    .filter((row) => row.status.result === "pass")
    .map((row) => row.signingDomain.toLowerCase());
  const alignedDkimPass = result.dkim.results.some(
    (row) => row.status.result === "pass" && row.status.aligned === true,
  );
  const dmarcPass = result.dmarc !== false && result.dmarc.status.result === "pass";
  const hasTempError =
    result.dkim.results.some((row) => isTempAuthResult(row.status.result)) ||
    (result.dmarc !== false && isTempAuthResult(result.dmarc.status.result));

  const authenticatedDomains = alignedDkimPass || dmarcPass ? [headerFromDomain] : [];
  if (authenticatedDomains.length > 0) {
    return {
      headerFromEmail,
      headerFromDomain,
      dkimPassDomains,
      dmarcPass,
      authenticatedDomains,
      status: "pass",
      reason: "authenticated",
    };
  }

  if (hasTempError) {
    return {
      headerFromEmail,
      headerFromDomain,
      dkimPassDomains,
      dmarcPass,
      authenticatedDomains: [],
      status: "temperror",
      reason: "sender_auth_temperror",
    };
  }

  return {
    headerFromEmail,
    headerFromDomain,
    dkimPassDomains,
    dmarcPass,
    authenticatedDomains,
    status: "fail",
    reason: "sender_auth_failed",
  };
}

const resolveAuthDns: DNSResolver = async (domain, rrtype) => {
  return (await withTimeout(
    dns.resolve(domain, rrtype),
    AUTH_DNS_TIMEOUT_MS,
    `DNS ${rrtype} lookup timed out for ${domain}`,
  )) as string[][] | string[];
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isTempAuthResult(value: string): boolean {
  return value === "temperror" || value === "temperr";
}

function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.includes("@") ? normalized : null;
}

function domainFromEmail(email: string | null): string | null {
  return email?.split("@")[1] ?? null;
}
