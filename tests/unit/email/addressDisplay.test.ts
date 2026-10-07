import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import {
  formatAddressDisplay,
  mailboxDomainForDisplay,
} from "../../../src/email/addressDisplay.js";

const encodedWord = (text: string): string =>
  `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;

async function displayFor(fromHeader: string): Promise<string | null> {
  const parsed = await simpleParser(
    Buffer.from(`From: ${fromHeader}\r\nTo: alerts@example.com\r\nSubject: s\r\n\r\nBody`),
  );
  return parsed.from ? formatAddressDisplay(parsed.from.value) : null;
}

describe("formatAddressDisplay over real mailparser output", () => {
  it.each<[string, string, string | null]>([
    ["a quoted name", '"GitHub" <noreply@github.com>', "GitHub <noreply@github.com>"],
    ["an unquoted name", "GitHub <noreply@github.com>", "GitHub <noreply@github.com>"],
    ["a bare address", "noreply@github.com", "noreply@github.com"],
    ["a bracketed address", "<noreply@github.com>", "noreply@github.com"],
    ["a name with a comma", '"Doe, John" <john@example.com>', '"Doe, John" <john@example.com>'],
    [
      "a name with escaped quotes",
      '"John \\"JJ\\" Doe" <john@example.com>',
      'John "JJ" Doe <john@example.com>',
    ],
    [
      "a name with a colon and a backslash",
      '"C:\\\\Users" <a@example.com>',
      '"C:\\\\Users" <a@example.com>',
    ],
    [
      "a name with only a backslash",
      '"Back\\\\slash" <a@example.com>',
      "Back\\slash <a@example.com>",
    ],
    [
      "several addresses",
      '"A" <a@example.com>, B <b@example.com>',
      "A <a@example.com>, B <b@example.com>",
    ],
    [
      "a group",
      'Team: a@example.com, "Bob" <b@example.com>;',
      "Team: a@example.com, Bob <b@example.com>;",
    ],
    ["an empty group", "undisclosed-recipients:;", "undisclosed-recipients:;"],
    [
      "a B-encoded name",
      `${encodedWord("Привет")} <privet@example.com>`,
      "Привет <privet@example.com>",
    ],
    [
      "a Q-encoded name",
      "=?UTF-8?Q?Caf=C3=A9_Bot?= <cafe@example.com>",
      "Café Bot <cafe@example.com>",
    ],
    ["a comment as the name", "john@example.com (John Doe)", "John Doe <john@example.com>"],
    [
      "a name that looks like another address",
      '"support@paypal.com" <attacker@evil.com>',
      '"support@paypal.com" <attacker@evil.com>',
    ],
    [
      "a name equal to the address in another case",
      '"JOHN@example.com" <john@example.com>',
      "john@example.com",
    ],
    [
      "an encoded name holding a bracketed address",
      `${encodedWord("Support <help@bank.com>")} <real@evil.com>`,
      '"Support <help@bank.com>" <real@evil.com>',
    ],
    [
      "an encoded name that tries to close the quotes",
      `${encodedWord('Evil" <bank@bank.com>')} <real@evil.com>`,
      '"Evil\\" <bank@bank.com>" <real@evil.com>',
    ],
    [
      "an encoded name with a line break and a header",
      `${encodedWord("Alice\r\nSubject: forged")} <a@example.com>`,
      // Quoted for the colon; the renderer's header sanitizer removes the CR/LF.
      '"Alice\r\nSubject: forged" <a@example.com>',
    ],
    [
      "an encoded name with a directional override",
      `${encodedWord("Ali\u202eecilce")} <a@example.com>`,
      // The renderer's header sanitizer strips U+202E.
      "Ali\u202eecilce <a@example.com>",
    ],
    [
      "an encoded name that is only an NBSP",
      `${encodedWord("\u00a0")} <a@example.com>`,
      "a@example.com",
    ],
    [
      "a name with a full-width at sign",
      `${encodedWord("help\uff20bank.com")} <x@evil.com>`,
      '"help\uff20bank.com" <x@evil.com>',
    ],
    [
      "a name with full-width angle brackets",
      `${encodedWord("PayPal \uff1cservice\uff20paypal.com\uff1e")} <x@evil.com>`,
      '"PayPal \uff1cservice\uff20paypal.com\uff1e" <x@evil.com>',
    ],
    [
      "a name with a small comma",
      `${encodedWord("Doe\ufe50 John")} <j@example.com>`,
      '"Doe\ufe50 John" <j@example.com>',
    ],
    ["a name without an address", '"Just A Name"', '"Just A Name"'],
    ["a name-only From shaped like a domain", "bank.com", '"bank.com"'],
    ["a bracketed domain with no at sign", "<security.bank.com>", '"security.bank.com"'],
    ["a name with an empty address", '"bank.com" <>', '"bank.com"'],
    ["a name-only From with a full-width at sign", "help\uff20bank.com", '"help\uff20bank.com"'],
    ["an empty header", "", null],
    ["an empty address", "<>", null],
    [
      "a name with a period",
      "John Q. Public <jqp@example.com>",
      "John Q. Public <jqp@example.com>",
    ],
    ["a name with parentheses", '"John (Work)" <j@example.com>', "John (Work) <j@example.com>"],
    ["an IDN domain", "info@xn--80ak6aa92e.com", "info@аррӏе.com"],
  ])("formats %s", async (_label, fromHeader, expected) => {
    expect(await displayFor(fromHeader)).toBe(expected);
  });
});

describe("formatAddressDisplay over hand-built values", () => {
  it("returns null for an empty list", () => {
    expect(formatAddressDisplay([])).toBeNull();
  });

  it("skips entries with neither a name nor an address", () => {
    expect(
      formatAddressDisplay([
        { name: "", address: "" },
        { name: "  ", address: "a@example.com" },
        { name: "", group: [] },
      ]),
    ).toBe("a@example.com");
  });

  it("lists the members of an unnamed group without group syntax", () => {
    expect(
      formatAddressDisplay([
        { name: "", group: [{ name: "Bob", address: "b@example.com" }] },
        { name: "Carol", address: "c@example.com" },
      ]),
    ).toBe("Bob <b@example.com>, Carol <c@example.com>");
  });

  it("quotes a group name that needs it", () => {
    expect(
      formatAddressDisplay([
        { name: "Ops; Infra", group: [{ name: "", address: "o@example.com" }] },
      ]),
    ).toBe('"Ops; Infra": o@example.com;');
  });
});

describe("mailboxDomainForDisplay", () => {
  const longLabel = "a".repeat(63);
  const tooLong = `x@${[longLabel, longLabel, longLabel, longLabel].join(".")}.com`;

  it.each<[string, string, string | null]>([
    ["a plain address", "help@bank.com", "bank.com"],
    ["an empty quoted local part", '""@bank.com', "bank.com"],
    ["a punycode domain", "a@xn--bcher-kva.example", "xn--bcher-kva.example"],
    ["a Unicode IDN domain", "a@b\u00fccher.example", "b\u00fccher.example"],
    ["a hyphen inside a label", "a@my-bank.com", "my-bank.com"],
    ["a 63-character label", `a@${longLabel}.com`, `${longLabel}.com`],
    ["no at sign", "bank.com", null],
    ["an empty local part", "@bank.com", null],
    ["an empty domain", "a@", null],
    ["a second at sign", "a@evil.com@bank.com", null],
    ["text after a quoted local part", '"a@b"x@bank.com', null],
    ["a trailing dot", "a@bank.com.", null],
    ["an empty label", "a@bank..com", null],
    ["a leading hyphen", "a@-bank.com", null],
    ["a trailing hyphen", "a@bank-.com", null],
    ["an underscore", "a@bank_x.com", null],
    ["a space", "a@bank .com", null],
    ["a numeric last label", "a@192.0.2.1", null],
    ["an IPv4 shorthand", "a@0x7f.1", null],
    ["a soft hyphen", "a@ba\u00adnk.com", null],
    ["a right-to-left mark", "a@bank.com\u200f", null],
    ["a 64-character label", `a@${longLabel}a.com`, null],
    ["a domain over 253 characters", tooLong, null],
  ])("handles %s", (_label, address, expected) => {
    expect(mailboxDomainForDisplay(address)).toBe(expected);
  });
});

describe("mailboxDomainForDisplay with an ACE label that does not decode", () => {
  // ICU decides whether "xn--zz" decodes, and Node 22 and Node 24 disagree.
  // Either outcome is safe for the alert: the ASCII form or "unknown sender".
  it("returns the ASCII form or null, never anything else", () => {
    expect(["xn--zz.com", null]).toContain(mailboxDomainForDisplay("a@xn--zz.com"));
  });
});
