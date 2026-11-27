/**
 * Scenario 1: a signed mail with an image and a PDF goes through preflight,
 * raw upload and delivery; the PDF's one-time download link serves the
 * stored bytes once and charges egress.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasTestDatabase } from "../helpers/pgTestDb.js";
import {
  ALIAS_ADDRESS,
  ALIAS_CHAT,
  ALLOWED_DOMAIN,
  ALLOWED_SENDER,
  PUBLIC_BASE_URL,
  SCENARIO_TEST_TIMEOUT_MS,
  envelopeFor,
  useScenarioHarness,
} from "./harness.js";
import { PDF_BYTES, PNG_BYTES, buildMail } from "./mail.js";

describe.skipIf(!hasTestDatabase)(
  "scenario: mail with attachments",
  { timeout: SCENARIO_TEST_TIMEOUT_MS },
  () => {
    const h = useScenarioHarness();

    it("delivers the text, the photo and a download link that serves the file once", async () => {
      const alias = await h.seedAlias();
      const mail = await buildMail({
        from: `Alerts <${ALLOWED_SENDER}>`,
        to: ALIAS_ADDRESS,
        subject: "Monthly report",
        text: "The report and the chart are attached.",
        attachments: [
          { filename: "chart.png", contentType: "image/png", content: PNG_BYTES },
          { filename: "report.pdf", contentType: "application/pdf", content: PDF_BYTES },
        ],
        signAs: ALLOWED_DOMAIN,
      });
      const envelope = envelopeFor(ALLOWED_SENDER);

      const preflight = await h.preflight(envelope);
      expect(preflight.statusCode).toBe(200);
      expect(preflight.json()).toEqual({ accept: true });

      const raw = await h.raw(mail, envelope);
      expect(raw.statusCode).toBe(202);
      expect(raw.json()).toEqual({ status: "accepted" });
      await h.waitForSettledDeliveries();

      // The log, its one attempt and the charge.
      const logs = await h.deliveryLogs();
      expect(logs).toHaveLength(1);
      const [log] = logs;
      expect(log).toMatchObject({ final_status: "delivered", has_attachments: true });
      expect(await h.attempts(log.id)).toEqual([
        {
          attempt_no: 1,
          status: "succeeded",
          target_chat_id: ALIAS_CHAT.toString(),
          error_class: null,
        },
      ]);
      expect((await h.usage()).delivered).toBe(1);

      // Telegram: the text with the PDF link, then the image as a photo replying to it.
      const texts = h.telegram.callsTo("sendMessage", ALIAS_CHAT);
      expect(texts).toHaveLength(1);
      const text = String(texts[0].payload["text"]);
      expect(text).toContain("Monthly report");
      expect(text).toContain("report.pdf");
      expect(text).not.toContain("chart.png");
      const links = text.match(/https:\/\/\S+\/dl\/[^\s"<>]+/g) ?? [];
      expect(links).toHaveLength(1);
      const link = links[0] ?? "";
      expect(link.startsWith(`${PUBLIC_BASE_URL}/dl/`)).toBe(true);

      const photos = h.telegram.callsTo("sendPhoto", ALIAS_CHAT);
      expect(photos).toHaveLength(1);
      expect(photos[0].files).toEqual([
        { field: "photo", filename: "chart.png", bytes: PNG_BYTES },
      ]);
      expect(photos[0].payload["reply_parameters"]).toEqual({ message_id: texts[0].messageId });
      expect(h.telegram.callsToChat(ALIAS_CHAT)).toHaveLength(2);

      // Both attachments are stored as rows and as files with the original bytes.
      const attachments = await h.attachments(log.id);
      expect(
        attachments.map(({ original_filename, content_type, size_bytes }) => ({
          original_filename,
          content_type,
          size_bytes,
        })),
      ).toEqual([
        { original_filename: "chart.png", content_type: "image/png", size_bytes: PNG_BYTES.length },
        {
          original_filename: "report.pdf",
          content_type: "application/pdf",
          size_bytes: PDF_BYTES.length,
        },
      ]);
      const [png, pdf] = attachments;
      expect(png.storage_path.startsWith(join(h.attachmentDir, log.id))).toBe(true);
      expect(await readFile(png.storage_path)).toEqual(PNG_BYTES);
      expect(await readFile(pdf.storage_path)).toEqual(PDF_BYTES);
      const [linkRow] = await h.query<{ n: number }>(
        "select count(*)::int as n from attachment_links where attachment_id = $1",
        [pdf.id],
      );
      expect(linkRow.n).toBe(1);

      // The raw mail stays on disk for the log (retry, privacy view), its pending marker gone.
      expect(log.raw_email_path).not.toBeNull();
      expect(await readFile(log.raw_email_path ?? "")).toEqual(mail);
      expect(await h.rawFiles()).toHaveLength(1);

      // The link serves the exact bytes once and charges them as egress.
      const egressBefore = (await h.usage()).egressBytes;
      const download = await h.download(link);
      expect(download.statusCode).toBe(200);
      expect(download.rawPayload).toEqual(PDF_BYTES);
      expect(download.headers["content-disposition"]).toContain('filename="report.pdf"');
      expect((await h.usage()).egressBytes).toBe(egressBefore + PDF_BYTES.length);

      const reuse = await h.download(link);
      expect(reuse.statusCode).toBe(410);
      expect(reuse.json()).toEqual({ error: "link expired or already used" });
      expect((await h.usage()).egressBytes).toBe(egressBefore + PDF_BYTES.length);

      // Nothing was sent anywhere but the alias's chat.
      expect(h.telegram.calls.every((call) => call.chatId === ALIAS_CHAT.toString())).toBe(true);
      expect(await h.aliasChatId(alias.id)).toBe(ALIAS_CHAT.toString());
    });
  },
);
