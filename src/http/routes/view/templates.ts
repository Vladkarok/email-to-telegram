/**
 * HTML template functions for the privacy email view route.
 *
 * All user-supplied values MUST pass through escapeHtml / escapeHtmlAttribute
 * before being interpolated — verified by snapshot tests.
 */
import sanitizeHtml from "sanitize-html";
import { escapeHtml, escapeHtmlAttribute } from "../../../utils/html.js";
import type { parseEmail } from "../../../email/parser.js";

// ─── Utility helpers ──────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * Returns the earlier of the attachment TTL expiry and the raw-email TTL expiry.
 * Privacy-mode attachment links must not outlive the raw email they were derived from.
 */
export function buildPrivacyAttachmentExpiry(
  receivedAt: Date,
  attachmentTtlHours: number,
  rawEmailTtlHours: number,
): Date {
  const attachmentExpiry = new Date(receivedAt.getTime() + attachmentTtlHours * 60 * 60 * 1000);
  const rawEmailExpiry = new Date(receivedAt.getTime() + rawEmailTtlHours * 60 * 60 * 1000);
  return attachmentExpiry <= rawEmailExpiry ? attachmentExpiry : rawEmailExpiry;
}

// ─── Email body renderer ──────────────────────────────────────────────────────

export function renderEmailBodyHtml(
  parsed: Awaited<ReturnType<typeof parseEmail>>,
): string {
  if (parsed.htmlBody) {
    const sanitized = sanitizeHtml(parsed.htmlBody, {
      allowedTags: [
        "a",
        "b",
        "blockquote",
        "br",
        "code",
        "del",
        "div",
        "em",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "hr",
        "i",
        "li",
        "ol",
        "p",
        "pre",
        "s",
        "strong",
        "table",
        "tbody",
        "td",
        "th",
        "thead",
        "tr",
        "u",
        "ul",
      ],
      allowedAttributes: { a: ["href"] },
      allowedSchemes: ["http", "https", "mailto"],
      disallowedTagsMode: "discard",
    }).trim();

    if (sanitized) return sanitized;
  }

  if (parsed.textBody) {
    return `<pre>${escapeHtml(parsed.textBody)}</pre>`;
  }

  return '<p class="muted">(empty body)</p>';
}

// ─── Page templates ───────────────────────────────────────────────────────────

/** Gate page shown on GET /view/:token — prompts the user to confirm before viewing. */
export function renderPrivacyGatePage(token: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow,noarchive" />
    <title>Open Private Email</title>
  </head>
  <body style="font:16px/1.5 Georgia,serif;background:#f7f4ee;color:#1d1917;padding:32px;">
    <main style="max-width:680px;margin:0 auto;background:#fffdf9;border:1px solid #ddd2c3;border-radius:16px;padding:24px;">
      <h1 style="margin-top:0;">Open Private Email</h1>
      <p>This privacy link opens the email body once in the browser instead of storing it in Telegram.</p>
      <p>The email will only be marked as viewed after you confirm below.</p>
      <form method="post" action="/view/${encodeURIComponent(token)}">
        <button type="submit" style="background:#8b5e34;color:#fff;border:0;border-radius:999px;padding:12px 18px;font:inherit;cursor:pointer;">Open email</button>
      </form>
    </main>
  </body>
</html>`;
}

export interface PrivacyPageInput {
  from: string;
  subject: string;
  receivedAt: Date;
  bodyHtml: string;
  attachments: Array<{ filename: string; sizeBytes: number; url: string }>;
}

/** Full email view page shown on POST /view/:token after the user confirms. */
export function renderPrivacyPage(input: PrivacyPageInput): string {
  const attachmentsHtml =
    input.attachments.length > 0
      ? `<section><h2>Attachments</h2><ul>${input.attachments
          .map(
            (attachment) =>
              `<li><a href="${escapeHtmlAttribute(attachment.url)}">${escapeHtml(attachment.filename)}</a> <span class="muted">(${formatBytes(attachment.sizeBytes)})</span></li>`,
          )
          .join("")}</ul></section>`
      : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow,noarchive" />
    <title>Email View</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4f1ea;
        --panel: #fffdf8;
        --ink: #171514;
        --muted: #6b645c;
        --line: #d9d0c4;
        --accent: #8b5e34;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: linear-gradient(180deg, #efe6d8 0%, var(--bg) 45%, #f8f5ee 100%);
        color: var(--ink);
        font: 16px/1.55 Georgia, "Times New Roman", serif;
      }
      main {
        max-width: 860px;
        margin: 0 auto;
        padding: 32px 18px 56px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 22px;
        box-shadow: 0 12px 35px rgba(57, 46, 32, 0.08);
      }
      h1, h2 { margin: 0 0 12px; line-height: 1.15; }
      h1 { font-size: 1.8rem; }
      h2 { font-size: 1.1rem; margin-top: 28px; }
      dl { margin: 0; display: grid; gap: 10px; }
      dt { font-size: 0.82rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
      dd { margin: 2px 0 0; }
      .meta-row { padding-bottom: 10px; border-bottom: 1px solid var(--line); }
      .meta-row:last-of-type { border-bottom: 0; }
      .body { margin-top: 22px; }
      .body pre {
        white-space: pre-wrap;
        word-break: break-word;
        background: #f6f1e8;
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 14px;
      }
      .body table {
        width: 100%;
        border-collapse: collapse;
        margin: 16px 0;
      }
      .body th, .body td {
        border: 1px solid var(--line);
        padding: 8px 10px;
        vertical-align: top;
      }
      .body blockquote {
        margin: 16px 0;
        padding-left: 14px;
        border-left: 3px solid #ceb99e;
        color: #433c35;
      }
      .muted { color: var(--muted); }
      a { color: var(--accent); }
    </style>
  </head>
  <body>
    <main>
      <div class="panel">
        <h1>Email View</h1>
        <p class="muted">Opened from a one-time privacy-mode link. This page is not stored in Telegram history.</p>
        <dl>
          <div class="meta-row">
            <dt>From</dt>
            <dd>${escapeHtml(input.from)}</dd>
          </div>
          <div class="meta-row">
            <dt>Subject</dt>
            <dd>${escapeHtml(input.subject)}</dd>
          </div>
          <div class="meta-row">
            <dt>Received</dt>
            <dd>${escapeHtml(input.receivedAt.toISOString())}</dd>
          </div>
        </dl>
        <section class="body">
          <h2>Body</h2>
          ${input.bodyHtml}
        </section>
        ${attachmentsHtml}
      </div>
    </main>
  </body>
</html>`;
}

/** Error page for validation failures (404, 403, 410, 500). */
export function renderErrorPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow,noarchive" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="font:16px/1.5 Georgia,serif;background:#f7f4ee;color:#1d1917;padding:32px;">
    <main style="max-width:680px;margin:0 auto;background:#fffdf9;border:1px solid #ddd2c3;border-radius:16px;padding:24px;">
      <h1 style="margin-top:0;">${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`;
}
