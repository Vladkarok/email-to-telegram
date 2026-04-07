import type { ParsedEmail } from "./types.js";
import { sanitizeTelegramHtml, stripHtml } from "../utils/telegramHtml.js";

const MAX_LEN = 4096;
const TRUNCATION_NOTICE = "\n[... truncated]";
const SEPARATOR = "\n\n";

export interface AttachmentLink {
  filename: string;
  sizeBytes: number;
  url: string;
}

export type RenderMode = "plaintext" | "html" | "markdown";

type HtmlParseMode = "HTML";

export function renderEmail(
  email: ParsedEmail,
  mode: RenderMode,
  aliasFullAddress: string,
  attachmentLinks: AttachmentLink[],
): string {
  const from = email.headerFrom ?? email.envelopeFrom ?? "unknown";
  const subject = email.subject ?? "(no subject)";

  const header = buildHeader(mode, from, aliasFullAddress, subject);

  // Attachments section is built with mode-appropriate escaping so filenames
  // and URLs are safe in rich Telegram parse modes.
  const attachmentsSection = buildAttachmentsSection(attachmentLinks, mode);

  const fixedCost =
    header.length +
    SEPARATOR.length +
    (attachmentsSection ? SEPARATOR.length + attachmentsSection.length : 0);

  const bodyBudget = MAX_LEN - fixedCost;

  const rawBody = extractBody(email, mode);
  const body = truncateToBudget(rawBody, bodyBudget, mode);

  const parts = [header, body];
  if (attachmentsSection) parts.push(attachmentsSection);

  // Safety clamp: if header + attachments alone exceed MAX_LEN (many attachments),
  // drop trailing attachment entries until the message fits.
  return clampToMaxLen(parts, mode);
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

function buildHeader(mode: RenderMode, from: string, to: string, subject: string): string {
  if (mode === "html" || mode === "markdown") {
    const e = escapeHtml;
    return `From: ${e(from)}\nTo: ${e(to)}\nSubject: ${e(subject)}`;
  }
  // plaintext — no parse_mode, no escaping needed
  return `From: ${from}\nTo: ${to}\nSubject: ${subject}`;
}

function extractBody(email: ParsedEmail, mode: RenderMode): string {
  if (mode === "html") {
    if (email.htmlBody) {
      return sanitizeTelegramHtml(email.htmlBody);
    }
    // Plain-text fallback must be HTML-escaped; raw text with < > & would be
    // parsed as tags or entity refs by Telegram's HTML parser.
    return escapeHtml(email.textBody ?? "");
  }

  if (mode === "markdown") {
    return extractMarkdownBody(email);
  }

  // plaintext — sent with no parse_mode, no escaping required
  if (email.textBody) return email.textBody;
  if (email.htmlBody) return stripHtml(email.htmlBody);
  return "";
}

function extractMarkdownBody(email: ParsedEmail): string {
  const textBody = normalizeLineEndings(email.textBody ?? "");

  if (email.htmlBody && !looksLikeMarkdown(textBody)) {
    const renderedHtml = sanitizeTelegramHtml(email.htmlBody);
    if (renderedHtml || !textBody) {
      return renderedHtml;
    }
  }

  if (textBody) {
    return renderMarkdownToTelegramHtml(textBody);
  }

  if (email.htmlBody) {
    return sanitizeTelegramHtml(email.htmlBody);
  }

  return "";
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

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

function renderMarkdownToTelegramHtml(text: string): string {
  const normalized = normalizeLineEndings(text).trimEnd();
  if (!normalized) return "";

  const lines = normalized.split("\n");
  const rendered: string[] = [];
  let codeFence: string[] | null = null;

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (codeFence) {
        rendered.push(`<pre>${escapeHtml(codeFence.join("\n"))}</pre>`);
        codeFence = null;
      } else {
        codeFence = [];
      }
      continue;
    }

    if (codeFence) {
      codeFence.push(line);
      continue;
    }

    rendered.push(renderMarkdownLine(line));
  }

  if (codeFence) {
    rendered.push(`<pre>${escapeHtml(codeFence.join("\n"))}</pre>`);
  }

  return sanitizeTelegramHtml(
    rendered
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

function renderMarkdownLine(line: string): string {
  if (!line.trim()) return "";

  const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
  if (heading) {
    return `<b>${renderMarkdownInline(heading[1]?.trim() ?? "")}</b>`;
  }

  const quote = line.match(/^\s{0,3}>\s?(.*)$/);
  if (quote) {
    return `&gt; ${renderMarkdownInline(quote[1] ?? "")}`;
  }

  const ordered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
  if (ordered) {
    return `${ordered[1]}. ${renderMarkdownInline(ordered[2] ?? "")}`;
  }

  const unordered = line.match(/^\s*[-*+]\s+(.*)$/);
  if (unordered) {
    return `• ${renderMarkdownInline(unordered[1] ?? "")}`;
  }

  if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
    return "────────";
  }

  return renderMarkdownInline(line);
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

function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

function finalizeTruncatedRichText(text: string, mode: RenderMode): string {
  if (mode === "plaintext") return text;
  return sanitizeTelegramHtml(text);
}
