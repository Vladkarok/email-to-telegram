#!/usr/bin/env tsx
/**
 * Render an .eml the way the delivery pipeline would and print every transport.
 *
 *   npm run render:preview -- path/to/message.eml [--mode html|markdown|plaintext]
 *
 * Prints the classic text (what `sendMessage` gets), the rich HTML (what
 * `sendRichMessage` gets, or "none" with the reason it was not eligible), and
 * the plaintext rendering. No network, no database.
 */
import { readFile } from "node:fs/promises";
import { parseEmail } from "../src/email/parser.js";
import { renderEmailForDelivery, type RenderMode } from "../src/email/renderer.js";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const modeIndex = args.indexOf("--mode");
const mode = (modeIndex >= 0 ? args[modeIndex + 1] : "html") as RenderMode;
if (!file) {
  console.error("usage: render-preview <file.eml> [--mode html|markdown|plaintext]");
  process.exit(2);
}

const raw = await readFile(file);
const parsed = await parseEmail(raw, raw.length);
const rendered = renderEmailForDelivery(parsed, mode, "alias@example.net", []);

const rule = (title: string): void => console.log(`\n===== ${title} =====`);
rule(`parsed (${mode})`);
console.log(
  JSON.stringify(
    {
      subject: parsed.subject,
      headerFrom: parsed.headerFrom,
      hasText: parsed.textBody !== null,
      hasHtml: parsed.htmlBody !== null,
      attachments: parsed.attachments.length,
    },
    null,
    2,
  ),
);
rule(`classic text (parse_mode=${rendered.parseMode ?? "none"}, ${rendered.text.length} chars)`);
console.log(rendered.text);
rule(
  rendered.richHtml
    ? `rich html (${rendered.richHtml.length} chars)`
    : "rich html: none (not eligible)",
);
if (rendered.richHtml) console.log(rendered.richHtml);
