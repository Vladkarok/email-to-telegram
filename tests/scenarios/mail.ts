/**
 * Real .eml bodies for the scenarios, DKIM-signed with a key generated per
 * test file, and the DNS answers that make the signature check deterministic.
 *
 * Sender authentication stays real (mailauth verifies the signature and
 * evaluates DMARC); only its DNS lookups are answered from the table here.
 * `stubSenderDns()` spies on `dns.promises.resolve`, the one call
 * src/email/authenticateSender.ts makes, so no src module is mocked and no
 * lookup leaves the process: a name the table does not know is ENOTFOUND.
 */
import dns from "node:dns";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { dkimSign } from "mailauth";
import { vi } from "vitest";

const SELECTOR = "scenario";

/** A 1x1 transparent PNG. */
export const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

export const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n",
  "latin1",
);

export interface Attachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface MailInput {
  from: string;
  to: string;
  subject: string;
  text: string;
  attachments?: Attachment[];
  /** Sign as this domain; omitted means unsigned. */
  signAs?: string;
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC_KEY_B64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");

/** Domains whose DKIM key and DMARC policy (p=reject) the stubbed DNS publishes. */
const signingDomains = new Set<string>();

export function publishSenderDomain(domain: string): void {
  signingDomains.add(domain.toLowerCase());
}

/** DNS TXT strings are at most 255 bytes; long records come back in chunks. */
function txt(value: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += 255) chunks.push(value.slice(i, i + 255));
  return chunks;
}

function notFound(name: string, rrtype: string): Error {
  return Object.assign(new Error(`query${rrtype} ENOTFOUND ${name}`), {
    code: "ENOTFOUND",
    hostname: name,
  });
}

function answer(name: string, rrtype: string): string[][] {
  const lower = name.toLowerCase().replace(/\.$/, "");
  if (rrtype === "TXT") {
    for (const domain of signingDomains) {
      if (lower === `${SELECTOR}._domainkey.${domain}`) {
        return [txt(`v=DKIM1; k=rsa; p=${PUBLIC_KEY_B64}`)];
      }
      if (lower === `_dmarc.${domain}`) return [txt("v=DMARC1; p=reject")];
    }
  }
  throw notFound(name, rrtype);
}

/** Answers every `dns.promises.resolve` from the table above. Restore with vi.restoreAllMocks(). */
export function stubSenderDns(): void {
  vi.spyOn(dns.promises, "resolve").mockImplementation(((name: string, rrtype: string = "A") =>
    Promise.resolve().then(() => answer(name, rrtype))) as typeof dns.promises.resolve);
}

function base64Lines(content: Buffer): string {
  return (content.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
}

/** Builds the MIME message (CRLF line ends), DKIM-signed when `signAs` is set. */
export async function buildMail(input: MailInput): Promise<Buffer> {
  const boundary = `scenario-${randomUUID()}`;
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@scenario.test>`,
    "MIME-Version: 1.0",
  ];
  const attachments = input.attachments ?? [];
  let body: string[];
  if (attachments.length === 0) {
    headers.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 7bit");
    body = [input.text];
  } else {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 7bit",
      "",
      input.text,
      ...attachments.flatMap((attachment) => [
        `--${boundary}`,
        `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
        `Content-Disposition: attachment; filename="${attachment.filename}"`,
        "Content-Transfer-Encoding: base64",
        "",
        base64Lines(attachment.content),
      ]),
      `--${boundary}--`,
    ];
  }
  const message = Buffer.from([...headers, "", ...body, ""].join("\r\n"));
  if (!input.signAs) return message;

  const signed = await dkimSign(message, {
    canonicalization: "relaxed/relaxed",
    signatureData: [
      { signingDomain: input.signAs, selector: SELECTOR, privateKey: PRIVATE_KEY_PEM },
    ],
  });
  if (!signed.signatures) {
    throw new Error(`DKIM signing failed: ${JSON.stringify(signed.errors)}`);
  }
  return Buffer.concat([Buffer.from(signed.signatures.replace(/\r?\n/g, "\r\n")), message]);
}
