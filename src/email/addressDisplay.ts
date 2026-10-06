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
