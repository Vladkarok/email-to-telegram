import { domainToASCII, domainToUnicode } from "node:url";
import type { EmailAddress } from "mailparser";

/**
 * Left unquoted, a name with one of these could pass for an address (`<>@`)
 * or look like a second entry or a group (`,;:`), so it keeps its quotes.
 * Checked after NFKC normalisation, which folds lookalikes such as the
 * full-width `＠` and `＜` into these characters.
 */
const NAME_NEEDS_QUOTES = /[<>@,;:]/;

/**
 * Formats parsed From addresses for display: `Name <address>`, without the
 * quotes mailparser's `text` puts around every name. Display only: the value
 * is never stored and never used for allow-rule matching. Returns null when
 * nothing displayable is left (an empty `From:` or `From: <>`).
 */
export function formatAddressDisplay(addresses: readonly EmailAddress[]): string | null {
  const text = formatList(addresses);
  return text === "" ? null : text;
}

function formatList(list: readonly EmailAddress[]): string {
  return list
    .map(formatEntry)
    .filter((entry) => entry !== "")
    .join(", ");
}

function formatEntry(entry: EmailAddress): string {
  // mailparser trims before decoding encoded words, so a decoded name can
  // still be just whitespace (an encoded NBSP); treat that as no name.
  const name = (entry.name ?? "").trim();
  if (entry.group) {
    const members = formatList(entry.group);
    if (!name) return members;
    return `${displayName(name)}:${members ? ` ${members}` : ""};`;
  }
  const address = entry.address?.trim() ?? "";
  if (!name || name.toLowerCase() === address.toLowerCase()) return address;
  // A name with no address beside it stays quoted, so it cannot be taken for
  // an address or a domain.
  return address ? `${displayName(name)} <${address}>` : quoted(name);
}

function displayName(name: string): string {
  return NAME_NEEDS_QUOTES.test(name.normalize("NFKC")) ? quoted(name) : name;
}

function quoted(name: string): string {
  return `"${name.replace(/[\\"]/g, "\\$&")}"`;
}

/**
 * Control, format (BiDi overrides, zero-width), whitespace, private-use,
 * unassigned and default-ignorable characters: none belongs in a domain,
 * and each can hide or reorder what the reader sees.
 */
const HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\p{Z}\p{Co}\p{Cs}\p{Cn}\p{Default_Ignorable_Code_Point}]/u;
const LDH_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const MAX_DOMAIN_LENGTH = 253;

/**
 * The domain of a parsed mailbox, for display. Returns null unless the
 * address is `local@domain` with exactly one `@` outside a quoted local
 * part, and the domain is a DNS name of two or more letter-digit-hyphen
 * labels whose last label starts with a letter, written in ASCII or as an
 * IDN in its canonical Unicode form. mailparser accepts malformed mailboxes
 * such as `a@evil.com@bank.com` or `a@bank.com;evil.com`; those return null.
 */
export function mailboxDomainForDisplay(address: string): string | null {
  const domain = domainPart(address.toLowerCase());
  if (!domain || HIDDEN_CHARACTER.test(domain)) return null;
  // domainToASCII applies the IDNA mapping, which drops or folds some
  // characters (full-width letters, soft hyphens). Requiring a round trip
  // keeps only domains already in canonical form.
  const ascii = domainToASCII(domain);
  if (domain !== ascii && domain !== domainToUnicode(ascii)) return null;
  const labels = ascii.split(".");
  const valid =
    ascii.length <= MAX_DOMAIN_LENGTH &&
    labels.length >= 2 &&
    labels.every((label) => LDH_LABEL.test(label)) &&
    /^[a-z]/.test(labels[labels.length - 1] ?? "");
  return valid ? domain : null;
}

function domainPart(address: string): string | null {
  const localEnd = address.startsWith('"') ? closingQuoteIndex(address) + 1 : address.indexOf("@");
  if (localEnd <= 0 || address[localEnd] !== "@") return null;
  const domain = address.slice(localEnd + 1);
  return domain.includes("@") ? null : domain;
}

/** Index of the quote that closes a quoted local part, or -1 if none does. */
function closingQuoteIndex(address: string): number {
  for (let i = 1; i < address.length; i++) {
    if (address[i] === "\\") i++;
    else if (address[i] === '"') return i;
  }
  return -1;
}
