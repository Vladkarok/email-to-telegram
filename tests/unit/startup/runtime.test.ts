import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRetryWorkerOptions,
  loadStartupConfig,
  nextPollingStartOptions,
} from "../../../src/startup/runtime.js";
import { applyPlanLimitOverrides, getPlanDefinition } from "../../../src/billing/plans.js";

describe("startup runtime helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    applyPlanLimitOverrides({});
  });

  it("makes PLAN_LIMITS effective while loading the startup config", () => {
    vi.stubEnv("DATABASE_URL", "postgres://app:pass@localhost:5432/db");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:ABC");
    vi.stubEnv("MAIL_DOMAIN", "tgmail.example.com");
    vi.stubEnv("PUBLIC_BASE_URL", "https://tgmail.example.com");
    vi.stubEnv("HTTP_PORT", "3000");
    vi.stubEnv("HMAC_SECRET", "a".repeat(32));
    vi.stubEnv("WORKER_SECRET", "b".repeat(32));
    vi.stubEnv("ATTACHMENT_DIR", "/tmp/attachments");
    vi.stubEnv("RAW_EMAIL_DIR", "/tmp/rawemails");
    vi.stubEnv("PLAN_LIMITS", '{"free":{"deliveredEmailsMonth":300}}');

    loadStartupConfig();

    expect(getPlanDefinition("free").limits.deliveredEmailsMonth).toBe(300);
  });

  it("never drops pending updates, the first polling start included", () => {
    const first = nextPollingStartOptions(true);
    const second = nextPollingStartOptions(first.nextIsInitialPollingStart);

    expect(first).toEqual({ dropPendingUpdates: false, nextIsInitialPollingStart: false });
    expect(second).toEqual({ dropPendingUpdates: false, nextIsInitialPollingStart: false });
  });

  it("builds retry worker options with the recovery directories", () => {
    expect(
      buildRetryWorkerOptions({
        attachmentDir: "/data/attachments",
        attachmentTtlHours: 24,
        publicBaseUrl: "https://mail.example.com",
        rawEmailDir: "/data/rawemails",
        rawEmailTtlHours: 48,
        telegramRichMessagesEnabled: false,
      }),
    ).toEqual({
      attachmentDir: "/data/attachments",
      attachmentTtlHours: 24,
      publicBaseUrl: "https://mail.example.com",
      rawEmailDir: "/data/rawemails",
      rawEmailTtlHours: 48,
      telegramRichMessagesEnabled: false,
    });
  });
});
