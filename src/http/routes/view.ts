import type { FastifyInstance, FastifyReply } from "fastify";
import sanitizeHtml from "sanitize-html";
import { getDb } from "../../db/client.js";
import {
  findDeliveryViewLinkByToken,
  markDeliveryViewLinkViewed,
} from "../../db/repos/deliveryViewLinks.js";
import { listAttachmentsByDeliveryLogId } from "../../db/repos/attachments.js";
import { createAttachmentLink } from "../../db/repos/attachmentLinks.js";
import { parseEmail } from "../../email/parser.js";
import { readRawEmail } from "../../storage/disk.js";
import { generateDownloadToken, verifyDeliveryViewToken } from "../../utils/tokens.js";
import { getLogger } from "../../utils/logger.js";

export function deliveryViewRoute(
  app: FastifyInstance,
  config: { publicBaseUrl: string; attachmentTtlHours: number },
): void {
  app.get(
    "/view/:token",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { token } = req.params as { token: string };

      const link = await findDeliveryViewLinkByToken(getDb(), token);
      if (!link) {
        await sendHtml(
          reply,
          404,
          renderErrorPage("Link not found", "This view link does not exist."),
        );
        return;
      }

      const now = new Date();
      if (link.expiresAt <= now || link.viewedAt) {
        await sendHtml(
          reply,
          410,
          renderErrorPage("Link expired", "This email view link has expired or was already used."),
        );
        return;
      }

      if (!verifyDeliveryViewToken(token, link.deliveryLogId, link.expiresAt)) {
        await sendHtml(
          reply,
          403,
          renderErrorPage("Invalid link", "This email view link is invalid."),
        );
        return;
      }

      if (!link.deliveryLog.rawEmailPath) {
        await sendHtml(
          reply,
          410,
          renderErrorPage(
            "Email unavailable",
            "The original email content is no longer available.",
          ),
        );
        return;
      }

      let rawEmail: Buffer;
      try {
        rawEmail = await readRawEmail(link.deliveryLog.rawEmailPath);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          await sendHtml(
            reply,
            410,
            renderErrorPage(
              "Email unavailable",
              "The original email content is no longer available.",
            ),
          );
          return;
        }

        getLogger().error({ err, deliveryLogId: link.deliveryLog.id }, "failed to read raw email");
        await sendHtml(
          reply,
          500,
          renderErrorPage("View failed", "The server could not prepare this email view."),
        );
        return;
      }

      const parsed = await parseEmail(rawEmail, rawEmail.length);
      const storedAttachments = await listAttachmentsByDeliveryLogId(getDb(), link.deliveryLog.id);
      const attachmentLinks = await Promise.all(
        storedAttachments.map(async (attachment) => {
          try {
            const { token: attachmentToken, expiresAt } = generateDownloadToken(
              attachment.id,
              config.attachmentTtlHours,
            );
            await createAttachmentLink(getDb(), attachment.id, attachmentToken, expiresAt);
            return {
              filename: attachment.originalFilename ?? "attachment",
              sizeBytes: attachment.sizeBytes ?? 0,
              url: `${config.publicBaseUrl}/dl/${attachmentToken}`,
            };
          } catch (err: unknown) {
            getLogger().warn(
              { err, attachmentId: attachment.id, deliveryLogId: link.deliveryLog.id },
              "failed to create attachment download link for privacy view",
            );
            return null;
          }
        }),
      );

      const claimed = await markDeliveryViewLinkViewed(getDb(), link.id);
      if (!claimed) {
        await sendHtml(
          reply,
          410,
          renderErrorPage("Link expired", "This email view link has expired or was already used."),
        );
        return;
      }

      await sendHtml(
        reply,
        200,
        renderPrivacyPage({
          from: link.deliveryLog.headerFrom ?? link.deliveryLog.envelopeFrom ?? "unknown",
          subject: link.deliveryLog.subject ?? parsed.subject ?? "(no subject)",
          receivedAt: link.deliveryLog.receivedAt,
          bodyHtml: renderEmailBodyHtml(parsed),
          attachments: attachmentLinks.filter(
            (item): item is NonNullable<typeof item> => item !== null,
          ),
        }),
      );
    },
  );
}

async function sendHtml(reply: FastifyReply, statusCode: number, html: string): Promise<void> {
  await reply
    .status(statusCode)
    .type("text/html; charset=utf-8")
    .header("Cache-Control", "no-store")
    .send(html);
}

function renderPrivacyPage(input: {
  from: string;
  subject: string;
  receivedAt: Date;
  bodyHtml: string;
  attachments: Array<{ filename: string; sizeBytes: number; url: string }>;
}): string {
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

function renderErrorPage(title: string, message: string): string {
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

function renderEmailBodyHtml(parsed: Awaited<ReturnType<typeof parseEmail>>): string {
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

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}
