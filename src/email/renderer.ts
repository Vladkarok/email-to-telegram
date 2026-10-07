import type { ParsedEmail } from "./types.js";
import {
  renderStructuredEmailHtml,
  sanitizeTelegramHtml,
  stripHtml,
  type StructuredHtmlResult,
} from "../utils/telegramHtml.js";
import { escapeHtml, escapeHtmlAttribute } from "../utils/html.js";
import { mailboxDomainForDisplay } from "./addressDisplay.js";

const MAX_LEN = 4096;
const TRUNCATION_NOTICE = "\n[... truncated]";
const SEPARATOR = "\n\n";
const MAX_RICH_TEXT_CHARACTERS = 32_768;
const MAX_RICH_BLOCKS = 500;
/** Blocks the rich header costs against MAX_RICH_BLOCKS: blockquote + hr. */
const RICH_HEADER_BLOCKS = 2;
/** The privacy alert's Sender line when the From has no valid domain. */
const UNKNOWN_SENDER = "unknown sender";

export interface AttachmentLink {
  filename: string;
  sizeBytes: number;
  url: string;
}

export type RenderMode = "plaintext" | "html";

/**
 * Stored render modes are free text in the database. "markdown" existed until
 * v1.9 and never had production users; any such row now renders as html.
 */
export function normalizeRenderMode(value: string | null | undefined): RenderMode {
  return value === "html" || value === "markdown" ? "html" : "plaintext";
}

type HtmlParseMode = "HTML";

type SelectedBody =
  | { kind: "text"; content: string }
  | { kind: "html"; content: string; structured?: StructuredHtmlResult };

export interface RenderedEmailForDelivery {
  text: string;
  parseMode: HtmlParseMode | undefined;
  /** Safe Telegram Rich HTML. Omitted for plaintext mode and over-budget content. */
  richHtml?: string;
}

export function renderEmail(
  email: ParsedEmail,
  mode: RenderMode,
  aliasFullAddress: string,
  attachmentLinks: AttachmentLink[],
): string {
  return renderEmailForDelivery(email, mode, aliasFullAddress, attachmentLinks).text;
}

/**
 * Select one MIME body source, then derive both Telegram transports from it.
 * This keeps the rich primary and classic fallback semantically identical.
 */
export function renderEmailForDelivery(
  email: ParsedEmail,
  mode: RenderMode,
  aliasFullAddress: string,
  attachmentLinks: AttachmentLink[],
): RenderedEmailForDelivery {
  // headerFromDisplay is null only when the From header has no address or
  // name at all, and then headerFrom and envelopeFrom are empty as well.
  const from = email.headerFromDisplay ?? "unknown";
  const subject = email.subject ?? "(no subject)";
  const selectedBody = selectBodySource(email, mode);
  const header = buildHeader(mode, from, aliasFullAddress, subject);

  // Attachments section is built with mode-appropriate escaping so filenames
  // and URLs are safe in rich Telegram parse modes.
  const attachmentsSection = buildAttachmentsSection(attachmentLinks, mode);

  const fixedCost =
    header.length +
    SEPARATOR.length +
    (attachmentsSection ? SEPARATOR.length + attachmentsSection.length : 0);

  const bodyBudget = MAX_LEN - fixedCost;

  const renderedBody = renderSelectedBody(selectedBody, mode);
  const rawBody = renderedBody.classic;
  const body = truncateToBudget(rawBody, bodyBudget, mode);

  const parts = [header, body];
  if (attachmentsSection) parts.push(attachmentsSection);

  // Safety clamp: if header + attachments alone exceed MAX_LEN (many attachments),
  // drop trailing attachment entries until the message fits.
  const text = clampToMaxLen(parts, mode);
  const richHtml = buildRichDeliveryHtml({
    mode,
    from,
    to: aliasFullAddress,
    subject,
    renderedBody,
    attachmentLinks,
  });

  return {
    text,
    parseMode: parseModeForRenderMode(mode),
    ...(richHtml ? { richHtml } : {}),
  };
}

export function parseModeForRenderMode(mode: RenderMode): HtmlParseMode | undefined {
  return mode === "plaintext" ? undefined : "HTML";
}

export function renderAttachmentFallback(
  links: AttachmentLink[],
  intro = "Some image attachments could not be uploaded to Telegram. Download them here:",
): string {
  if (links.length === 0) return intro;
  return [intro, "", "Attachments:", ...links.map((a) => `${a.filename}: ${a.url}`)].join("\n");
}

export function renderPrivacyAlert(
  email: ParsedEmail,
  aliasFullAddress: string,
  viewUrl: string,
  hasAttachments: boolean,
): string {
  const sender = escapeHtml(sanitizeHeaderField(extractSenderHint(email)) || UNKNOWN_SENDER);
  const alias = escapeHtml(aliasFullAddress);
  const attachmentLine = hasAttachments ? "\nAttachments: hidden by privacy mode" : "";

  return [
    "<b>Private email alert</b>",
    `Alias: <code>${alias}</code>`,
    `Sender: ${sender}`,
    "Subject: hidden by privacy mode",
    attachmentLine ? attachmentLine.trimStart() : "",
    `Open: <a href="${escapeHtmlAttribute(viewUrl)}">view email</a>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildAttachmentsSection(links: AttachmentLink[], mode: RenderMode): string {
  if (links.length === 0) return "";
  const items = links.map((a) => {
    if (mode === "html") {
      // Use anchor tags so filenames are HTML-safe and URLs are clickable.
      return `<a href="${escapeHtmlAttribute(a.url)}">${escapeHtml(a.filename)}</a>`;
    }
    return `${a.filename}: ${a.url}`;
  });
  return "Attachments:\n" + items.join("\n");
}

/**
 * The privacy alert names only the domain of the first parsed From address,
 * the address the From line shows. Nothing else from the From text reaches
 * the Sender line: a display name such as "Support <help@bank.com>", a
 * name-only From such as "bank.com", an address with no `@` such as
 * "Support <bank.com>" or a malformed one such as "a@evil.com@bank.com"
 * would otherwise look like a real sender domain. These show as "unknown
 * sender". The domain is what the header claims, not a verified sender.
 */
function extractSenderHint(email: ParsedEmail): string {
  const address = email.headerFromEmail || email.envelopeFrom || "";
  return mailboxDomainForDisplay(address) ?? UNKNOWN_SENDER;
}

function clampToMaxLen(parts: string[], mode: RenderMode): string {
  const joined = parts.join(SEPARATOR);
  if (joined.length <= MAX_LEN) return joined;

  // Drop trailing attachment entries one by one until the message fits.
  // parts = [header, body, attachmentsSection?]
  if (parts.length < 3) return finalizeTruncatedRichText(joined.slice(0, MAX_LEN), mode);

  const attLines = parts[2].split("\n"); // "Attachments:\nline1\nline2..."
  while (attLines.length > 1 && parts.join(SEPARATOR).length > MAX_LEN) {
    attLines.pop();
    parts[2] = attLines.join("\n");
  }

  const result = parts.join(SEPARATOR);
  // Last resort: if even the label line alone overflows, hard-slice.
  if (result.length <= MAX_LEN) return result;
  return finalizeTruncatedRichText(result.slice(0, MAX_LEN), mode);
}

/**
 * Longest header field (code points) rendered into a message. Caps a
 * sender-controlled Subject/From so the header alone can never overflow the
 * 4096 limit and force the last-resort slice, which would cut into header
 * markup.
 */
const MAX_HEADER_FIELD_LENGTH = 512;

// Strip newlines/CR, ASCII control characters, and Unicode BiDi overrides so
// a crafted Subject/From cannot inject a forged second header block or flip
// the apparent direction of the rendered header.
function sanitizeHeaderField(value: string): string {
  const cleaned = value
    .replace(/[\r\n]+/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/[‪-‮⁦-⁩]/g, "");
  const points = Array.from(cleaned);
  if (points.length <= MAX_HEADER_FIELD_LENGTH) return cleaned;
  return `${points.slice(0, MAX_HEADER_FIELD_LENGTH - 1).join("")}…`;
}

function buildHeader(mode: RenderMode, from: string, to: string, subject: string): string {
  const f = sanitizeHeaderField(from);
  const t = sanitizeHeaderField(to);
  const s = sanitizeHeaderField(subject);
  if (mode === "html") {
    const e = escapeHtml;
    // Quote block + bold labels: the header reads as a distinct block from
    // the body in the classic HTML transport (no <hr> there).
    return `<blockquote><b>From:</b> ${e(f)}\n<b>To:</b> ${e(t)}\n<b>Subject:</b> ${e(s)}</blockquote>`;
  }
  // plaintext — no parse_mode, no escaping needed
  return `From: ${f}\nTo: ${t}\nSubject: ${s}`;
}

function selectBodySource(email: ParsedEmail, mode: RenderMode): SelectedBody {
  if (mode === "html") {
    if (email.htmlBody) return { kind: "html", content: email.htmlBody };
    return { kind: "text", content: email.textBody ?? "" };
  }

  if (email.textBody) return { kind: "text", content: email.textBody };
  if (email.htmlBody) return { kind: "html", content: email.htmlBody };
  return { kind: "text", content: "" };
}

function renderSelectedBody(
  selectedBody: SelectedBody,
  mode: RenderMode,
): { classic: string; structured: StructuredHtmlResult | null } {
  if (mode === "plaintext") {
    // Classic stays literal text (no parse_mode). The rich transport still
    // gets the shared frame (header, divider) with the same text as
    // paragraphs, so every alias looks alike.
    const text =
      selectedBody.kind === "html" ? stripHtml(selectedBody.content) : selectedBody.content;
    return { classic: text, structured: structuredFromText(text) };
  }

  if (selectedBody.kind === "text") {
    // Raw text must be escaped before Telegram parses it as HTML.
    return {
      classic: escapeHtml(selectedBody.content),
      structured: structuredFromText(selectedBody.content),
    };
  }

  const structured = selectedBody.structured ?? renderStructuredEmailHtml(selectedBody.content);
  return { classic: structured.classicHtml, structured };
}

/**
 * Plain text as structured blocks for the rich transport: blank lines split
 * paragraphs, single newlines become line breaks, everything is escaped
 * before the structured parser sees it (so markup in a text email stays
 * literal) and bare URLs get the same rich-only linkification as HTML mail.
 * Classic output is never derived from this.
 */
function structuredFromText(text: string): StructuredHtmlResult | null {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return null;
  // A blank line may carry spaces, tabs or NBSP and still separates paragraphs.
  const html = normalized
    .split(/\n[ \t\u00a0]*\n(?:[ \t\u00a0]*\n)*/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const structured = renderStructuredEmailHtml(html);
  return structured.richHtml ? structured : null;
}

function buildRichDeliveryHtml(input: {
  mode: RenderMode;
  from: string;
  to: string;
  subject: string;
  renderedBody: { classic: string; structured: StructuredHtmlResult | null };
  attachmentLinks: AttachmentLink[];
}): string | undefined {
  const structured = input.renderedBody.structured;
  if (!structured?.richHtml) return undefined;

  const from = sanitizeHeaderField(input.from);
  const to = sanitizeHeaderField(input.to);
  const subject = sanitizeHeaderField(input.subject);
  const headerText = `From: ${from}\nTo: ${to}\nSubject: ${subject}`;
  const textBudget =
    MAX_RICH_TEXT_CHARACTERS - structured.stats.textCharacters - Array.from(headerText).length;
  const blocksUsed = structured.stats.blocks + RICH_HEADER_BLOCKS;
  if (textBudget < 0 || blocksUsed > MAX_RICH_BLOCKS) return undefined;

  const attachments = buildRichAttachmentsSection(input.attachmentLinks, textBudget);
  if (attachments === undefined) return undefined;
  if (attachments && blocksUsed + 1 > MAX_RICH_BLOCKS) return undefined;

  // Header is bot-generated and identical for every sender: a quote block
  // with bold labels, then a divider so the body starts on a visible boundary.
  const header =
    `<blockquote><b>From:</b> ${escapeHtml(from)}<br><b>To:</b> ${escapeHtml(to)}` +
    `<br><b>Subject:</b> ${escapeHtml(subject)}</blockquote><hr>`;
  return `${header}${structured.richHtml}${attachments ?? ""}`;
}

const RICH_ATTACHMENTS_LABEL = "Attachments:";

/**
 * One paragraph (one rich block) listing the same TTL-bearing links the
 * classic message carries. Returns null when there are no attachments and
 * undefined when not a single entry fits the remaining text budget, which
 * sends the message classic. Over budget, whole trailing entries are dropped
 * and the omission is stated; links are never cut.
 */
function buildRichAttachmentsSection(
  links: AttachmentLink[],
  textBudget: number,
): string | null | undefined {
  if (links.length === 0) return null;
  const names = links.map((link) => sanitizeFilename(link.filename));
  const cost = (count: number, omitted: number): number =>
    codePoints(RICH_ATTACHMENTS_LABEL) +
    names.slice(0, count).reduce((sum, name) => sum + 1 + codePoints(name), 0) +
    (omitted > 0 ? 1 + codePoints(omissionNotice(omitted)) : 0);

  let keep = links.length;
  while (keep > 0 && cost(keep, links.length - keep) > textBudget) keep -= 1;
  // No download link fitting at all: classic keeps the links and trims the
  // body instead, which serves the reader better than a notice alone.
  if (keep === 0) return undefined;

  const lines = links
    .slice(0, keep)
    .map(
      (link, i) => `<a href="${escapeHtmlAttribute(link.url)}">${escapeHtml(names[i] ?? "")}</a>`,
    );
  if (keep < links.length) lines.push(escapeHtml(omissionNotice(links.length - keep)));
  return `<p><b>${RICH_ATTACHMENTS_LABEL}</b><br>${lines.join("<br>")}</p>`;
}

function omissionNotice(count: number): string {
  return `${count} attachment${count === 1 ? "" : "s"} omitted`;
}

function sanitizeFilename(value: string): string {
  // Control characters break the line structure; directional controls can
  // disguise an extension ("invoice\u202Efdp.exe" reads as "invoiceexe.pdf").
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "")
    .trim();
  return cleaned || "attachment";
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

function truncateToBudget(text: string, budget: number, mode: RenderMode): string {
  if (budget <= 0) return TRUNCATION_NOTICE;
  if (text.length <= budget) return text;
  const cutLen = budget - TRUNCATION_NOTICE.length;
  if (cutLen <= 0) return TRUNCATION_NOTICE;
  const truncated = text.slice(0, cutLen) + TRUNCATION_NOTICE;
  if (mode === "plaintext") return truncated;
  return sanitizeTelegramHtml(truncated);
}

function finalizeTruncatedRichText(text: string, mode: RenderMode): string {
  if (mode === "plaintext") return text;
  return sanitizeTelegramHtml(text);
}
