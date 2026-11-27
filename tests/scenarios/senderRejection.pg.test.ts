/**
 * Scenario 3: sender rejection. Preflight only sees the envelope, so it
 * accepts any alias with allow rules; the raw upload checks the
 * authenticated MIME From against the rules and bounces (403) a sender the
 * rules do not name, or a From that claims an allowed domain without
 * authenticating. A bounced mail leaves no delivery log, no file and no
 * charge, and nothing reaches the alias's chat. The two reasons differ in
 * what the owner hears: a sender the rules do not name (sender_not_allowed)
 * gets the owner of this new alias one first-bounce notice in their private
 * chat, naming the alias and the From domain; a From that failed
 * authentication (sender_auth_failed) gets no notice at all.
 */
import { describe, expect, it } from "vitest";
import { hasTestDatabase } from "../helpers/pgTestDb.js";
import {
  ALIAS_ADDRESS,
  ALIAS_CHAT,
  ALLOWED_DOMAIN,
  ALLOWED_SENDER,
  OTHER_DOMAIN,
  OWNER,
  OTHER_SENDER,
  SCENARIO_TEST_TIMEOUT_MS,
  envelopeFor,
  useScenarioHarness,
  type Envelope,
} from "./harness.js";
import { buildMail } from "./mail.js";

describe.skipIf(!hasTestDatabase)(
  "scenario: sender rejection",
  { timeout: SCENARIO_TEST_TIMEOUT_MS },
  () => {
    const h = useScenarioHarness();

    /**
     * `notice`: the From domain the owner's first-bounce notice names, or null
     * when the bounce must not notify anyone.
     */
    async function expectBounced(
      mail: Buffer,
      envelope: Envelope,
      { notice }: { notice: string | null },
    ): Promise<void> {
      const preflight = await h.preflight(envelope);
      expect(preflight.statusCode).toBe(200);
      expect(preflight.json()).toEqual({ accept: true });

      const raw = await h.raw(mail, envelope);
      expect(raw.statusCode).toBe(403);
      expect(raw.json()).toEqual({ error: "rejected" });
      await h.waitForSettledDeliveries();
      // The notice goes out after the response; wait for it before checking
      // what reached Telegram.
      await h.waitForNotices();

      expect(await h.deliveryLogs()).toEqual([]);
      expect(await h.rawFiles()).toEqual([]);
      expect(await h.attachmentFiles()).toEqual([]);
      expect(await h.usage()).toEqual({ delivered: 0, rejected: 0, egressBytes: 0 });
      expect(await h.quotaNotices()).toEqual([]);
      expect(h.telegram.callsToChat(ALIAS_CHAT)).toEqual([]);

      const toOwner = h.telegram.callsToChat(OWNER);
      if (notice === null) {
        expect(toOwner).toEqual([]);
        return;
      }
      expect(toOwner.map((call) => call.method)).toEqual(["sendMessage"]);
      const text = String(toOwner[0].payload["text"]);
      expect(text).toContain(ALIAS_ADDRESS);
      expect(text).toContain(notice);
      expect(h.telegram.calls).toHaveLength(1);
    }

    it("bounces an authenticated sender that no allow rule names", async () => {
      await h.seedAlias({ allow: [{ matchType: "exact_email", matchValue: ALLOWED_SENDER }] });
      const mail = await buildMail({
        from: OTHER_SENDER,
        to: ALIAS_ADDRESS,
        subject: "Newsletter",
        text: "Not from the allowed sender.",
        signAs: OTHER_DOMAIN,
      });

      await expectBounced(mail, envelopeFor(OTHER_SENDER), { notice: OTHER_DOMAIN });
    });

    it("bounces another authenticated address in the domain of an exact_email rule", async () => {
      await h.seedAlias({ allow: [{ matchType: "exact_email", matchValue: ALLOWED_SENDER }] });
      // Same domain, signed by it: only the address differs, so only an
      // exact_email match (not a domain match) bounces it.
      const sameDomainSender = `news@${ALLOWED_DOMAIN}`;
      const mail = await buildMail({
        from: sameDomainSender,
        to: ALIAS_ADDRESS,
        subject: "Newsletter",
        text: "Not the allowed address.",
        signAs: ALLOWED_DOMAIN,
      });

      await expectBounced(mail, envelopeFor(sameDomainSender), { notice: ALLOWED_DOMAIN });
    });

    it("bounces a From that claims the allowed domain without authenticating", async () => {
      await h.seedAlias();
      // The envelope and the From both name the allowed domain, but the mail
      // carries no signature, and the domain publishes p=reject.
      const mail = await buildMail({
        from: ALLOWED_SENDER,
        to: ALIAS_ADDRESS,
        subject: "Urgent: verify your account",
        text: "Spoofed.",
      });

      await expectBounced(mail, envelopeFor(ALLOWED_SENDER), { notice: null });
    });

    it("bounces a From signed by another domain behind an allowed envelope sender", async () => {
      await h.seedAlias();
      // The MIME From is what the rules match; an allowed envelope does not help.
      const mail = await buildMail({
        from: OTHER_SENDER,
        to: ALIAS_ADDRESS,
        subject: "Mismatched sender",
        text: "Envelope and From disagree.",
        signAs: OTHER_DOMAIN,
      });

      await expectBounced(mail, envelopeFor(`bounce@${ALLOWED_DOMAIN}`), { notice: OTHER_DOMAIN });
    });
  },
);
