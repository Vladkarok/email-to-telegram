/**
 * Scenarios 4 and 5: Telegram failures on the first send and what the retry
 * worker makes of them.
 *
 * - Flood wait (429): the sender's three immediate tries fail, the log is
 *   left `failed`, and one retry-worker run delivers it as attempt 2. The
 *   mail is charged once, at acceptance.
 * - Bot kicked (403): permanent at once, no retry, and the charge refunded.
 * - Chat migrated (400 migrate_to_chat_id): the alias is re-pointed to the
 *   new chat and the retry delivers there.
 */
import { describe, expect, it } from "vitest";
import { hasTestDatabase } from "../helpers/pgTestDb.js";
import { markBotHealthy } from "./entrypoints.js";
import {
  ALIAS_ADDRESS,
  ALIAS_CHAT,
  ALLOWED_DOMAIN,
  ALLOWED_SENDER,
  SCENARIO_TEST_TIMEOUT_MS,
  envelopeFor,
  useScenarioHarness,
} from "./harness.js";
import { TELEGRAM_ERRORS } from "./fakeTelegram.js";
import { buildMail } from "./mail.js";

/** A basic group about to become a supergroup. */
const LEGACY_GROUP = -5_001n;
const SUPERGROUP = -1_005_000_000_001n;

describe.skipIf(!hasTestDatabase)(
  "scenario: Telegram failure and retry",
  { timeout: SCENARIO_TEST_TIMEOUT_MS },
  () => {
    const h = useScenarioHarness();
    const envelope = envelopeFor(ALLOWED_SENDER);

    async function acceptMail(subject: string): Promise<string> {
      const mail = await buildMail({
        from: ALLOWED_SENDER,
        to: ALIAS_ADDRESS,
        subject,
        text: `${subject}: body.`,
        signAs: ALLOWED_DOMAIN,
      });
      const preflight = await h.preflight(envelope);
      expect(preflight.json()).toEqual({ accept: true });
      const raw = await h.raw(mail, envelope);
      expect(raw.statusCode).toBe(202);
      await h.waitForSettledDeliveries();
      const logs = await h.deliveryLogs();
      expect(logs).toHaveLength(1);
      return logs[0].id;
    }

    /** A retry-worker run as the timer would start it once the log is due. */
    async function retryWhenDue(): Promise<void> {
      await h.backdateDeliveries(3);
      markBotHealthy();
      await h.runRetryWorker();
    }

    it("leaves a flood-waited mail failed, then delivers it on retry as attempt 2", async () => {
      await h.seedAlias();
      h.telegram.failNext("sendMessage", TELEGRAM_ERRORS.floodWait, {
        times: 3,
        chatId: ALIAS_CHAT,
      });

      const logId = await acceptMail("Flood wait");
      expect((await h.deliveryLogs())[0].final_status).toBe("failed");
      expect(await h.attempts(logId)).toEqual([
        {
          attempt_no: 1,
          status: "failed",
          target_chat_id: ALIAS_CHAT.toString(),
          error_class: "flood_wait",
        },
      ]);
      expect(h.telegram.callsTo("sendMessage", ALIAS_CHAT)).toHaveLength(3);
      expect((await h.usage()).delivered).toBe(1);

      // The worker leaves a log alone until it is two minutes old, so a run
      // right away cannot race the live sender.
      markBotHealthy();
      await h.runRetryWorker();
      expect((await h.deliveryLogs())[0].final_status).toBe("failed");
      expect(await h.attempts(logId)).toHaveLength(1);
      expect(h.telegram.callsTo("sendMessage", ALIAS_CHAT)).toHaveLength(3);

      await retryWhenDue();

      expect((await h.deliveryLogs())[0].final_status).toBe("delivered");
      expect(await h.attempts(logId)).toEqual([
        {
          attempt_no: 1,
          status: "failed",
          target_chat_id: ALIAS_CHAT.toString(),
          error_class: "flood_wait",
        },
        {
          attempt_no: 2,
          status: "succeeded",
          target_chat_id: ALIAS_CHAT.toString(),
          error_class: null,
        },
      ]);
      const sends = h.telegram.callsTo("sendMessage", ALIAS_CHAT);
      expect(sends).toHaveLength(4);
      expect(String(sends[3].payload["text"])).toContain("Flood wait");
      expect(sends.filter((call) => call.messageId !== undefined)).toHaveLength(1);
      expect((await h.usage()).delivered).toBe(1);

      // A later run finds nothing left to do.
      await h.runRetryWorker();
      expect(h.telegram.callsTo("sendMessage", ALIAS_CHAT)).toHaveLength(4);
      expect(await h.attempts(logId)).toHaveLength(2);
    });

    it("closes a mail to a chat that kicked the bot at once and refunds the charge", async () => {
      await h.seedAlias();
      h.telegram.failNext("sendMessage", TELEGRAM_ERRORS.botKicked, { chatId: ALIAS_CHAT });

      const logId = await acceptMail("Kicked");
      expect((await h.deliveryLogs())[0].final_status).toBe("permanently_failed");
      expect(await h.attempts(logId)).toEqual([
        {
          attempt_no: 1,
          status: "failed",
          target_chat_id: ALIAS_CHAT.toString(),
          error_class: "forbidden",
        },
      ]);
      expect(h.telegram.callsTo("sendMessage", ALIAS_CHAT)).toHaveLength(1);
      expect((await h.usage()).delivered).toBe(0);

      await retryWhenDue();

      expect((await h.deliveryLogs())[0].final_status).toBe("permanently_failed");
      expect(await h.attempts(logId)).toHaveLength(1);
      expect(h.telegram.callsTo("sendMessage", ALIAS_CHAT)).toHaveLength(1);
      expect((await h.usage()).delivered).toBe(0);
    });

    it("re-points the alias when the chat migrated and delivers there on retry", async () => {
      const alias = await h.seedAlias({ chatId: LEGACY_GROUP, chatType: "group" });
      h.telegram.failNext("sendMessage", TELEGRAM_ERRORS.migrated(SUPERGROUP), {
        chatId: LEGACY_GROUP,
      });

      const logId = await acceptMail("Migrated");
      expect((await h.deliveryLogs())[0].final_status).toBe("failed");
      expect(await h.attempts(logId)).toEqual([
        {
          attempt_no: 1,
          status: "failed",
          target_chat_id: LEGACY_GROUP.toString(),
          error_class: "migrated",
        },
      ]);
      expect(h.telegram.callsTo("sendMessage", LEGACY_GROUP)).toHaveLength(1);
      expect(await h.aliasChatId(alias.id)).toBe(SUPERGROUP.toString());
      expect(
        await h.query(
          "select id::text as id, is_active from chats where id in ($1, $2) order by id",
          [LEGACY_GROUP.toString(), SUPERGROUP.toString()],
        ),
      ).toEqual([
        { id: SUPERGROUP.toString(), is_active: true },
        { id: LEGACY_GROUP.toString(), is_active: false },
      ]);

      await retryWhenDue();

      expect((await h.deliveryLogs())[0].final_status).toBe("delivered");
      expect(
        (await h.attempts(logId)).map((a) => [a.attempt_no, a.status, a.target_chat_id]),
      ).toEqual([
        [1, "failed", LEGACY_GROUP.toString()],
        [2, "succeeded", SUPERGROUP.toString()],
      ]);
      const delivered = h.telegram.callsTo("sendMessage", SUPERGROUP);
      expect(delivered).toHaveLength(1);
      expect(String(delivered[0].payload["text"])).toContain("Migrated");
      expect(h.telegram.callsTo("sendMessage", LEGACY_GROUP)).toHaveLength(1);
      expect((await h.usage()).delivered).toBe(1);
    });
  },
);
