import { Readable, Transform } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import sanitizeHtml from "sanitize-html";
import { checkEgressLimit, withOrganizationQuotaLock } from "../../billing/limits.js";
import { getDb } from "../../db/client.js";
import {
  type DeliveryViewLinkWithLog,
  findDeliveryViewLinkByTokenHash,
  markDeliveryViewLinkViewed,
} from "../../db/repos/deliveryViewLinks.js";
import { listAttachmentsByDeliveryLogId } from "../../db/repos/attachments.js";
import { createAttachmentLink } from "../../db/repos/attachmentLinks.js";
import {
  decrementOrganizationUsageMonth,
  incrementOrganizationUsageMonth,
  usageMonthForDate,
} from "../../db/repos/usage.js";
import { parseEmail } from "../../email/parser.js";
import { readRawEmail } from "../../storage/disk.js";
import {
  generateDownloadTokenForExpiry,
  hashStoredToken,
  verifyDeliveryViewToken,
} from "../../utils/tokens.js";
import { getLogger } from "../../utils/logger.js";
import { readDeliveryLogMetadata } from "../../security/deliveryLogMetadata.js";
import { escapeHtml, escapeHtmlAttribute } from "../../utils/html.js";

export function deliveryViewRoute(
  app: FastifyInstance,
  config: { publicBaseUrl: string; attachmentTtlHours: number; rawEmailTtlHours: number },
): void {
  app.get(
    "/view/:token",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { token } = req.params as { token: string };
      const state = await loadAndValidateLink(token);
      if (state.status !== "ok") {
        await sendValidationError(reply, state.status);
        return;
      }

      await sendHtml(reply, 200, renderPrivacyGatePage(token));
    },
  );

  app.post(
    "/view/:token",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { token } = req.params as { token: string };
      const state = await loadAndValidateLink(token);
      if (state.status !== "ok") {
        await sendValidationError(reply, state.status);
        return;
      }
      const { link } = state;

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
        rawEmail = await readRawEmail(link.deliveryLog.rawEmailPath, {
          rawEmailEncryptionMode: link.deliveryLog.rawEmailEncryptionMode,
          rawEmailWrappedDek: link.deliveryLog.rawEmailWrappedDek,
          rawEmailKekKeyId: link.deliveryLog.rawEmailKekKeyId,
        });
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
      let deliveryMetadata;
      try {
        deliveryMetadata = await readDeliveryLogMetadata({
          id: link.deliveryLog.id,
          envelopeFrom: link.deliveryLog.envelopeFrom,
          headerFrom: link.deliveryLog.headerFrom,
          subject: link.deliveryLog.subject,
          metadataCiphertext: link.deliveryLog.metadataCiphertext,
          metadataEncryptionMode:
            link.deliveryLog.metadataEncryptionMode === "local-v1" ? "local-v1" : "none",
          metadataWrappedDek: link.deliveryLog.metadataWrappedDek,
          metadataKekKeyId: link.deliveryLog.metadataKekKeyId,
          metadataEncryptedAt: link.deliveryLog.metadataEncryptedAt,
        });
      } catch (err: unknown) {
        getLogger().error(
          { err, deliveryLogId: link.deliveryLog.id },
          "failed to decrypt delivery-log metadata",
        );
        await sendHtml(
          reply,
          500,
          renderErrorPage("View failed", "The server could not prepare this email view."),
        );
        return;
      }
      const now = new Date();
      const quotaMonth = usageMonthForDate(now);
      const attachmentExpiresAt = buildPrivacyAttachmentExpiry(
        link.deliveryLog.receivedAt,
        config.attachmentTtlHours,
        config.rawEmailTtlHours,
      );
      const attachmentsStillAvailable = attachmentExpiresAt > now;
      const storedAttachments = await listAttachmentsByDeliveryLogId(getDb(), link.deliveryLog.id);
      const plannedAttachments = (attachmentsStillAvailable ? storedAttachments : []).map(
        (attachment) => {
          const { token: attachmentToken, expiresAt } = generateDownloadTokenForExpiry(
            attachment.id,
            attachmentExpiresAt,
          );
          return {
            attachmentId: attachment.id,
            token: attachmentToken,
            expiresAt,
            filename: attachment.originalFilename ?? "attachment",
            sizeBytes: attachment.sizeBytes ?? 0,
            url: `${config.publicBaseUrl}/dl/${attachmentToken}`,
          };
        },
      );

      const from = deliveryMetadata.headerFrom ?? deliveryMetadata.envelopeFrom ?? "unknown";
      const subject = deliveryMetadata.subject ?? parsed.subject ?? "(no subject)";
      const bodyHtml = renderEmailBodyHtml(parsed);
      const quotaExceededError = new Error("privacy_view_egress_limit_exceeded");
      const alreadyClaimedError = new Error("privacy_view_already_claimed");
      const viewResult = await withOrganizationQuotaLock(
        getDb(),
        link.deliveryLog.organizationId,
        async (
          tx,
        ): Promise<
          | { status: "already_claimed" }
          | { status: "quota_exceeded" }
          | { status: "ok"; html: string; htmlBytes: number }
        > => {
          const activeAttachments: Array<{ filename: string; sizeBytes: number; url: string }> = [];
          for (const attachment of plannedAttachments) {
            try {
              await createAttachmentLink(
                tx,
                attachment.attachmentId,
                attachment.token,
                attachment.expiresAt,
              );
              activeAttachments.push({
                filename: attachment.filename,
                sizeBytes: attachment.sizeBytes,
                url: attachment.url,
              });
            } catch (err: unknown) {
              getLogger().warn(
                { err, attachmentId: attachment.attachmentId, deliveryLogId: link.deliveryLog.id },
                "failed to create attachment download link for privacy view",
              );
            }
          }

          const html = renderPrivacyPage({
            from,
            subject,
            receivedAt: link.deliveryLog.receivedAt,
            bodyHtml,
            attachments: activeAttachments,
          });
          const htmlBytes = Buffer.byteLength(html);
          const egressLimit = await checkEgressLimit(
            tx,
            link.deliveryLog.organizationId,
            BigInt(htmlBytes),
            quotaMonth,
          );
          if (!egressLimit.ok) {
            throw quotaExceededError;
          }

          const claimed = await markDeliveryViewLinkViewed(tx, link.id, now);
          if (!claimed) {
            throw alreadyClaimedError;
          }

          if (link.deliveryLog.organizationId && htmlBytes > 0) {
            await incrementOrganizationUsageMonth(tx, {
              organizationId: link.deliveryLog.organizationId,
              month: quotaMonth,
              egressBytes: BigInt(htmlBytes),
            });
          }

          return { status: "ok" as const, html, htmlBytes };
        },
      ).catch((err: unknown) => {
        if (err === quotaExceededError) {
          return { status: "quota_exceeded" as const };
        }
        if (err === alreadyClaimedError) {
          return { status: "already_claimed" as const };
        }
        throw err;
      });
      if (viewResult.status === "quota_exceeded") {
        await sendHtml(
          reply,
          403,
          renderErrorPage(
            "Download unavailable",
            "This organization has reached its monthly email view quota.",
          ),
        );
        return;
      }
      if (viewResult.status === "already_claimed") {
        await sendHtml(
          reply,
          410,
          renderErrorPage("Link expired", "This email view link has expired or was already used."),
        );
        return;
      }

      const htmlBuffer = Buffer.from(viewResult.html, "utf8");
      const trackedStream = trackReservedEgressUsage(
        htmlBuffer,
        reply,
        link.deliveryLog.organizationId,
        quotaMonth,
      );
      await reply
        .status(200)
        .type("text/html; charset=utf-8")
        .header("Content-Length", htmlBuffer.length)
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .send(trackedStream);
    },
  );

  async function loadAndValidateLink(
    token: string,
  ): Promise<
    | { status: "ok"; link: DeliveryViewLinkWithLog }
    | { status: "not_found" | "expired" | "invalid" }
  > {
    const link = await findDeliveryViewLinkByTokenHash(getDb(), hashStoredToken(token));
    if (!link) return { status: "not_found" };

    const now = new Date();
    if (link.expiresAt <= now || link.viewedAt) return { status: "expired" };
    if (!verifyDeliveryViewToken(token, link.deliveryLogId, link.expiresAt)) {
      return { status: "invalid" };
    }
    return { status: "ok", link };
  }
}

function trackReservedEgressUsage(
  body: Buffer,
  reply: FastifyReply,
  organizationId: string | null,
  month: string,
): NodeJS.ReadableStream {
  const egressBytes = BigInt(body.length);
  if (egressBytes <= 0n) {
    return Readable.from([]);
  }
  const source = Readable.from(splitBuffer(body, 16 * 1024));
  if (!organizationId) return source;

  let completed = false;
  let observedBytes = 0n;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      observedBytes += BigInt(
        Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk)),
      );
      callback(null, chunk);
    },
  });
  source.on("error", (err: unknown) =>
    meter.destroy(err instanceof Error ? err : new Error("privacy view stream failed")),
  );
  reply.raw.once("finish", () => {
    completed = true;
  });
  reply.raw.once("close", () => {
    if (completed) return;
    const rollbackBytes = egressBytes > observedBytes ? egressBytes - observedBytes : 0n;
    if (rollbackBytes <= 0n) return;
    void decrementOrganizationUsageMonth(getDb(), {
      organizationId,
      month,
      egressBytes: rollbackBytes,
    }).catch((err: unknown) => {
      getLogger().error(
        { err, organizationId, month, egressBytes, observedBytes, rollbackBytes },
        "failed to release reserved egress usage",
      );
    });
  });
  return source.pipe(meter);
}

function splitBuffer(buffer: Buffer, chunkSize: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    chunks.push(buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length)));
  }
  return chunks;
}

async function sendHtml(reply: FastifyReply, statusCode: number, html: string): Promise<void> {
  await reply
    .status(statusCode)
    .type("text/html; charset=utf-8")
    .header("Cache-Control", "no-store")
    .header("Referrer-Policy", "no-referrer")
    .send(html);
}

async function sendValidationError(
  reply: FastifyReply,
  status: "not_found" | "expired" | "invalid",
): Promise<void> {
  if (status === "not_found") {
    await sendHtml(reply, 404, renderErrorPage("Link not found", "This view link does not exist."));
    return;
  }
  if (status === "invalid") {
    await sendHtml(reply, 403, renderErrorPage("Invalid link", "This email view link is invalid."));
    return;
  }
  await sendHtml(
    reply,
    410,
    renderErrorPage("Link expired", "This email view link has expired or was already used."),
  );
}

function renderPrivacyGatePage(token: string): string {
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

function buildPrivacyAttachmentExpiry(
  receivedAt: Date,
  attachmentTtlHours: number,
  rawEmailTtlHours: number,
): Date {
  const attachmentExpiry = new Date(receivedAt.getTime() + attachmentTtlHours * 60 * 60 * 1000);
  const rawEmailExpiry = new Date(receivedAt.getTime() + rawEmailTtlHours * 60 * 60 * 1000);
  return attachmentExpiry <= rawEmailExpiry ? attachmentExpiry : rawEmailExpiry;
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


