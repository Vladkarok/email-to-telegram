import type { ParsedEmail } from "./types.js";
import {
  renderStructuredEmailHtml,
  sanitizeTelegramHtml,
  stripHtml,
  type StructuredHtmlResult,
} from "../utils/telegramHtml.js";
import { escapeHtml, escapeHtmlAttribute } from "../utils/html.js";

const MAX_LEN = 4096;
const TRUNCATION_NOTICE = "\n[... truncated]";
const SEPARATOR = "\n\n";
const MAX_RICH_TEXT_CHARACTERS = 32_768;
const MAX_RICH_BLOCKS = 500;

export interface AttachmentLink {
  filename: string;
  sizeBytes: number;
  url: string;
}

export type RenderMode = "plaintext" | "html" | "markdown";

type HtmlParseMode = "HTML";

type SelectedBody =
  | { kind: "text"; content: string }
  | { kind: "html"; content: string; structured?: StructuredHtmlResult }
  | { kind: "markdown"; content: string };

export interface RenderedEmailForDelivery {
  text: string;
  parseMode: HtmlParseMode | undefined;
  /** Safe Telegram Rich HTML. Omitted for plaintext, linked, or over-budget content. */
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
  const from = email.headerFrom ?? email.envelopeFrom ?? "unknown";
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
    hasAttachmentLinks: attachmentLinks.length > 0,
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
  const sender = escapeHtml(extractSenderHint(email));
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
    if (mode === "html" || mode === "markdown") {
      // Use anchor tags so filenames are HTML-safe and URLs are clickable.
      return `<a href="${escapeHtmlAttribute(a.url)}">${escapeHtml(a.filename)}</a>`;
    }
    return `${a.filename}: ${a.url}`;
  });
  return "Attachments:\n" + items.join("\n");
}

function extractSenderHint(email: ParsedEmail): string {
  const source = email.headerFrom ?? email.envelopeFrom ?? "unknown sender";
  const lowered = source.toLowerCase();
  const angleMatch = lowered.match(/<([^>]+)>/);
  const address = angleMatch?.[1] ?? lowered.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/)?.[0];
  if (!address) return source;
  const [, domain] = address.split("@");
  return domain ?? address;
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

// Strip newlines/CR, ASCII control characters, and Unicode BiDi overrides so
// a crafted Subject/From cannot inject a forged second header block or flip
// the apparent direction of the rendered header.
function sanitizeHeaderField(value: string): string {
  return (
    value
      .replace(/[\r\n]+/g, " ")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
      .replace(/[‪-‮⁦-⁩]/g, "")
  );
}

function buildHeader(mode: RenderMode, from: string, to: string, subject: string): string {
  const f = sanitizeHeaderField(from);
  const t = sanitizeHeaderField(to);
  const s = sanitizeHeaderField(subject);
  if (mode === "html" || mode === "markdown") {
    const e = escapeHtml;
    return `From: ${e(f)}\nTo: ${e(t)}\nSubject: ${e(s)}`;
  }
  // plaintext — no parse_mode, no escaping needed
  return `From: ${f}\nTo: ${t}\nSubject: ${s}`;
}

function selectBodySource(email: ParsedEmail, mode: RenderMode): SelectedBody {
  if (mode === "html") {
    if (email.htmlBody) return { kind: "html", content: email.htmlBody };
    return { kind: "text", content: email.textBody ?? "" };
  }

  if (mode === "markdown") {
    const textBody = normalizeLineEndings(email.textBody ?? "");
    if (textBody && looksLikeMarkdown(textBody)) {
      return { kind: "markdown", content: textBody };
    }
    if (email.htmlBody) {
      const structured = renderStructuredEmailHtml(email.htmlBody);
      if (structured.hasVisibleContent || !textBody) {
        return { kind: "html", content: email.htmlBody, structured };
      }
    }
    return { kind: "text", content: textBody };
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
    return {
      classic:
        selectedBody.kind === "html" ? stripHtml(selectedBody.content) : selectedBody.content,
      structured: null,
    };
  }

  if (selectedBody.kind === "text") {
    // Raw text must be escaped before Telegram parses it as HTML.
    return { classic: escapeHtml(selectedBody.content), structured: null };
  }

  const safeSource =
    selectedBody.kind === "markdown"
      ? renderMarkdownToStructuredHtml(selectedBody.content)
      : selectedBody.content;
  const structured =
    selectedBody.kind === "html" && selectedBody.structured
      ? selectedBody.structured
      : renderStructuredEmailHtml(safeSource);
  return { classic: structured.classicHtml, structured };
}

function buildRichDeliveryHtml(input: {
  mode: RenderMode;
  from: string;
  to: string;
  subject: string;
  renderedBody: { classic: string; structured: StructuredHtmlResult | null };
  hasAttachmentLinks: boolean;
}): string | undefined {
  const structured = input.renderedBody.structured;
  if (
    input.mode === "plaintext" ||
    input.hasAttachmentLinks ||
    !structured?.richHtml ||
    structured.hasLinks
  ) {
    return undefined;
  }

  const from = sanitizeHeaderField(input.from);
  const to = sanitizeHeaderField(input.to);
  const subject = sanitizeHeaderField(input.subject);
  const headerText = `From: ${from}\nTo: ${to}\nSubject: ${subject}`;
  if (
    structured.stats.textCharacters + Array.from(headerText).length > MAX_RICH_TEXT_CHARACTERS ||
    structured.stats.blocks + 1 > MAX_RICH_BLOCKS
  ) {
    return undefined;
  }

  const header = `<p>From: ${escapeHtml(from)}<br>To: ${escapeHtml(to)}<br>Subject: ${escapeHtml(subject)}</p>`;
  return `${header}${structured.richHtml}`;
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

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function looksLikeMarkdown(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  return [
    /^\s{0,3}#{1,6}\s+\S/m,
    /^\s*>+\s*\S/m,
    /^\s*[-*+]\s+\S/m,
    /^\s*\d+[.)]\s+\S/m,
    /```[\s\S]+```/,
    /`[^`\n]+`/,
    /\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)]+\)/,
    /(^|[^\w])(?:\*\*|__)(?=\S).+?\S(?:\*\*|__)(?!\w)/,
    /(^|[^\w])(?:\*|_)(?=\S).+?\S(?:\*|_)(?!\w)/,
    /~~(?=\S).+?\S~~/,
  ].some((pattern) => pattern.test(trimmed));
}

function renderMarkdownToStructuredHtml(text: string): string {
  const normalized = normalizeLineEndings(text).trimEnd();
  if (!normalized) return "";

  const lines = normalized.split("\n");
  const rendered: string[] = [];
  let codeFence: string[] | null = null;
  let paragraphLines: string[] = [];
  let listRun: { ordered: boolean; start: number; items: string[] } | null = null;

  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) return;
    rendered.push(`<p>${paragraphLines.map((line) => renderMarkdownInline(line)).join(" ")}</p>`);
    paragraphLines = [];
  };

  const flushList = (): void => {
    if (!listRun) return;
    const tag = listRun.ordered ? "ol" : "ul";
    const start = listRun.ordered && listRun.start !== 1 ? ` start="${listRun.start}"` : "";
    rendered.push(
      `<${tag}${start}>${listRun.items.map((item) => `<li>${item}</li>`).join("")}</${tag}>`,
    );
    listRun = null;
  };

  for (const line of lines) {
    if (codeFence) {
      if (/^\s*```/.test(line)) {
        rendered.push(`<pre>${escapeHtml(codeFence.join("\n"))}</pre>`);
        codeFence = null;
      } else {
        codeFence.push(line);
      }
      continue;
    }

    if (/^\s*```/.test(line)) {
      flushParagraph();
      flushList();
      codeFence = [];
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      rendered.push("");
      continue;
    }

    const listItem = parseMarkdownListItem(line);
    if (listItem) {
      flushParagraph();
      if (!listRun || listRun.ordered !== listItem.ordered) {
        flushList();
        listRun = { ordered: listItem.ordered, start: listItem.number, items: [] };
      }
      listRun.items.push(renderMarkdownInline(listItem.content));
      continue;
    }

    flushList();
    if (isMarkdownBlockLine(line)) {
      flushParagraph();
      rendered.push(renderMarkdownLine(line));
    } else {
      paragraphLines.push(line.trim());
    }
  }

  flushParagraph();
  flushList();
  if (codeFence) {
    rendered.push(`<pre>${escapeHtml(codeFence.join("\n"))}</pre>`);
  }

  return rendered
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseMarkdownListItem(
  line: string,
): { ordered: boolean; number: number; content: string } | null {
  const ordered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
  if (ordered) {
    const number = Number(ordered[1]);
    if (Number.isSafeInteger(number) && number <= 1_000_000) {
      return { ordered: true, number, content: ordered[2] ?? "" };
    }
  }

  const unordered = line.match(/^\s*[-*+]\s+(.*)$/);
  return unordered ? { ordered: false, number: 1, content: unordered[1] ?? "" } : null;
}

function isMarkdownBlockLine(line: string): boolean {
  return (
    /^\s{0,3}#{1,6}\s+/.test(line) ||
    /^\s{0,3}>\s?/.test(line) ||
    /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)
  );
}

function renderMarkdownLine(line: string): string {
  if (!line.trim()) return "";

  const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
  if (heading) {
    const level = heading[1]?.length ?? 1;
    return `<h${level}>${renderMarkdownInline(heading[2]?.trim() ?? "")}</h${level}>`;
  }

  const quote = line.match(/^\s{0,3}>\s?(.*)$/);
  if (quote) {
    return `<blockquote>${renderMarkdownInline(quote[1] ?? "")}</blockquote>`;
  }

  if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
    return "<hr>";
  }

  return `<p>${renderMarkdownInline(line)}</p>`;
}

function renderMarkdownInline(text: string): string {
  const stash: string[] = [];
  const stashHtml = (html: string): string => {
    const token = `@@MDTOKEN_${stash.length}@@`;
    stash.push(html);
    return token;
  };

  let rendered = text.replace(/\\([\\`*_#[\]()~>+\-=|{}.!])/g, (_match, char: string) =>
    stashHtml(escapeHtml(char)),
  );

  rendered = rendered.replace(/`([^`\n]+)`/g, (_match, code: string) =>
    stashHtml(`<code>${escapeHtml(code)}</code>`),
  );

  rendered = rendered.replace(
    /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^)]+)\)/g,
    (_match, label: string, url: string) =>
      stashHtml(`<a href="${escapeHtmlAttribute(url)}">${escapeHtml(label)}</a>`),
  );

  rendered = escapeHtml(rendered);

  rendered = replaceDelimited(rendered, /(\*\*\*|___)(?=\S)(.+?\S)\1/g, (content) => {
    return `<b><i>${content}</i></b>`;
  });
  rendered = replaceDelimited(rendered, /(\*\*|__)(?=\S)(.+?\S)\1/g, (content) => {
    return `<b>${content}</b>`;
  });
  rendered = replaceDelimited(rendered, /(~~)(?=\S)(.+?\S)\1/g, (content) => {
    return `<s>${content}</s>`;
  });
  rendered = replaceDelimited(
    rendered,
    /(^|[^\w>])(\*|_)(?=\S)(.+?\S)\2(?!\w)/g,
    (content, prefix) => {
      return `${prefix}<i>${content}</i>`;
    },
  );

  return rendered.replace(
    /@@MDTOKEN_(\d+)@@/g,
    (_match, index: string) => stash[Number(index)] ?? "",
  );
}

function replaceDelimited(
  text: string,
  pattern: RegExp,
  formatter: (content: string, prefix: string) => string,
): string {
  return text.replace(pattern, (match: string, ...captures: unknown[]) => {
    const groups = captures.slice(0, -2) as string[];
    if (groups.length === 2) {
      const [delimiter, content] = groups;
      void delimiter;
      return formatter(content ?? "", "");
    }
    if (groups.length === 3) {
      const [prefix, delimiter, content] = groups;
      void delimiter;
      return formatter(content ?? "", prefix ?? "");
    }
    return match;
  });
}

function finalizeTruncatedRichText(text: string, mode: RenderMode): string {
  if (mode === "plaintext") return text;
  return sanitizeTelegramHtml(text);
}
