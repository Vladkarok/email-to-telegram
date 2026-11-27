/**
 * Scenario 2: the per-alias hourly cap. Over the cap at preflight the Worker
 * is told to defer (429, a temporary SMTP failure). A cap that fills between
 * a passed preflight and the raw upload is acknowledged (202) and the mail
 * is kept on disk for raw recovery, as the rejection policy's rate_limited
 * row says. Neither is a quota rejection, so no counter moves and no notice
 * goes out; nothing reaches the chat.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasTestDatabase } from "../helpers/pgTestDb.js";
import { getPlanDefinition, markBotHealthy } from "./entrypoints.js";
import {
  ALIAS_ADDRESS,
  ALIAS_CHAT,
  ALLOWED_DOMAIN,
  ALLOWED_SENDER,
  SCENARIO_TEST_TIMEOUT_MS,
  envelopeFor,
  useScenarioHarness,
} from "./harness.js";
import { buildMail } from "./mail.js";

describe.skipIf(!hasTestDatabase)(
  "scenario: hourly cap",
  { timeout: SCENARIO_TEST_TIMEOUT_MS },
  () => {
    const h = useScenarioHarness();
    const envelope = envelopeFor(ALLOWED_SENDER);
    const cap = (): number => getPlanDefinition("free").limits.aliasEmailsPerHour;

    function mail(): Promise<Buffer> {
      return buildMail({
        from: ALLOWED_SENDER,
        to: ALIAS_ADDRESS,
        subject: "One too many",
        text: "This mail arrives after the alias's hourly cap.",
        signAs: ALLOWED_DOMAIN,
      });
    }

    it("defers at preflight once the alias accepted its cap this hour", async () => {
      const alias = await h.seedAlias();
      await h.seedRecentDeliveries(alias.id, cap());

      const preflight = await h.preflight(envelope);
      expect(preflight.statusCode).toBe(429);
      expect(preflight.json()).toEqual({ error: "rate limited" });

      expect(await h.deliveryLogs()).toHaveLength(cap());
      expect(await h.usage()).toEqual({ delivered: 0, rejected: 0, egressBytes: 0 });
      expect(await h.quotaNotices()).toEqual([]);
      expect(await h.rawFiles()).toEqual([]);
      expect(h.telegram.calls).toEqual([]);
    });

    it("accepts one under the cap, and counts mail older than the hour out", async () => {
      const alias = await h.seedAlias();
      await h.seedRecentDeliveries(alias.id, cap() - 1);
      await h.seedRecentDeliveries(alias.id, 5, 61);

      const preflight = await h.preflight(envelope);
      expect(preflight.statusCode).toBe(200);
      expect(preflight.json()).toEqual({ accept: true });
    });

    it("keeps the mail for recovery when the cap fills after a passed preflight", async () => {
      const alias = await h.seedAlias();
      const body = await mail();

      const preflight = await h.preflight(envelope);
      expect(preflight.statusCode).toBe(200);
      expect(preflight.json()).toEqual({ accept: true });

      // Other mail fills the hour while the Worker reads this one.
      await h.seedRecentDeliveries(alias.id, cap(), 0);

      const raw = await h.raw(body, envelope);
      expect(raw.statusCode).toBe(202);
      expect(raw.json()).toEqual({ status: "accepted" });
      await h.waitForSettledDeliveries();

      // No log for it, no charge, no notice, nothing sent.
      const logs = await h.deliveryLogs();
      expect(logs).toHaveLength(cap());
      expect(logs.every((log) => log.raw_email_path === null)).toBe(true);
      expect(await h.usage()).toEqual({ delivered: 0, rejected: 0, egressBytes: 0 });
      expect(await h.quotaNotices()).toEqual([]);
      expect(h.telegram.calls).toEqual([]);

      // The .eml and its pending marker stay for raw recovery.
      const files = await h.rawFiles();
      expect(files).toHaveLength(2);
      const eml = files.find((file) => file.endsWith(".eml"));
      expect(eml).toBeDefined();
      expect(files).toContain(`${eml}.pending.json`);
      expect(await readFile(join(h.rawEmailDir, eml ?? ""))).toEqual(body);
      const pending = JSON.parse(
        await readFile(join(h.rawEmailDir, `${eml}.pending.json`), "utf8"),
      ) as Record<string, unknown>;
      expect(pending).toMatchObject({
        localPart: envelope.localPart,
        recipientDomain: envelope.recipientDomain,
        envelopeFrom: envelope.envelopeFrom,
      });

      // Once the hour has passed and the marker is old enough, the retry
      // worker's raw recovery delivers the kept mail.
      await h.query("delete from delivery_logs");
      const pendingPath = join(h.rawEmailDir, `${eml}.pending.json`);
      const createdAt = new Date(Date.now() - 3 * 60 * 1000).toISOString();
      await writeFile(pendingPath, JSON.stringify({ ...pending, createdAt }));
      markBotHealthy();
      await h.runRetryWorker();
      await h.waitForSettledDeliveries();

      const recovered = await h.deliveryLogs();
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        final_status: "delivered",
        raw_email_path: join(h.rawEmailDir, eml ?? ""),
      });
      const sends = h.telegram.callsTo("sendMessage", ALIAS_CHAT);
      expect(sends).toHaveLength(1);
      expect(String(sends[0].payload["text"])).toContain("One too many");
      expect(await h.rawFiles()).toEqual([eml]);
      expect((await h.usage()).delivered).toBe(1);
    });
  },
);
