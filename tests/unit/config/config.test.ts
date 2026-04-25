import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../../src/config.js";

const REQUIRED_ENV: Record<string, string> = {
  DATABASE_URL: "postgres://app:pass@localhost:5432/db",
  TELEGRAM_BOT_TOKEN: "123456:ABC",
  MAIL_DOMAIN: "tgmail.example.com",
  PUBLIC_BASE_URL: "https://tgmail.example.com",
  HTTP_PORT: "3000",
  HMAC_SECRET: "a".repeat(32),
  WORKER_SECRET: "b".repeat(32),
  ATTACHMENT_DIR: "/tmp/attachments",
  RAW_EMAIL_DIR: "/tmp/rawemails",
};

const OPTIONAL_ENV = [
  "ATTACHMENT_TTL_HOURS",
  "RAW_EMAIL_TTL_HOURS",
  "DELIVERY_LOG_RETENTION_DAYS",
  "STORAGE_ENCRYPTION_MODE",
  "MASTER_ENCRYPTION_KEY",
  "MASTER_ENCRYPTION_KEY_ID",
  "MASTER_ENCRYPTION_KEYRING",
  "MAX_SIZE_BYTES",
  "LOG_LEVEL",
  "NODE_ENV",
  "INITIAL_ALLOWED_USERS",
  "BACKUP_ARCHIVE_ENCRYPTION",
  "APP_MODE",
  "BILLING_PROVIDER",
  "HOSTED_MAIL_DOMAIN",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_PERSONAL_MONTHLY",
  "STRIPE_PRICE_PERSONAL_YEARLY",
  "STRIPE_PRICE_PRO_MONTHLY",
  "STRIPE_PRICE_PRO_YEARLY",
  "STRIPE_PRICE_TEAM_MONTHLY",
  "STRIPE_PRICE_TEAM_YEARLY",
  "BILLING_SUCCESS_URL",
  "BILLING_CANCEL_URL",
];

describe("loadConfig", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    [...Object.keys(REQUIRED_ENV), ...OPTIONAL_ENV].forEach((k) => delete process.env[k]);
    Object.assign(process.env, REQUIRED_ENV);
  });

  afterEach(() => {
    [...Object.keys(REQUIRED_ENV), ...OPTIONAL_ENV].forEach((k) => delete process.env[k]);
    Object.assign(process.env, savedEnv);
  });

  it("returns valid config when all required vars are set", () => {
    const config = loadConfig();
    expect(config.mailDomain).toBe("tgmail.example.com");
    expect(config.httpPort).toBe(3000);
  });

  it("throws when DATABASE_URL is missing", () => {
    delete process.env["DATABASE_URL"];
    expect(() => loadConfig()).toThrow();
  });

  it("throws when TELEGRAM_BOT_TOKEN is missing", () => {
    delete process.env["TELEGRAM_BOT_TOKEN"];
    expect(() => loadConfig()).toThrow();
  });

  it("uses default values for optional vars", () => {
    const config = loadConfig();
    expect(config.attachmentTtlHours).toBe(336);
    expect(config.rawEmailTtlHours).toBe(336);
    expect(config.deliveryLogRetentionDays).toBe(30);
    expect(config.storageEncryptionMode).toBe("none");
    expect(config.masterEncryptionKeyring).toEqual({});
    expect(config.maxSizeBytes).toBe(10485760);
    expect(config.logLevel).toBe("info");
    expect(config.backupArchiveEncryption).toBe("off");
    expect(config.appMode).toBe("self-hosted");
    expect(config.billingProvider).toBe("none");
    expect(config.hostedMailDomain).toBeUndefined();
    expect(config.stripePriceIds).toBeUndefined();
  });

  it("parses ATTACHMENT_TTL_HOURS as number", () => {
    process.env["ATTACHMENT_TTL_HOURS"] = "48";
    const config = loadConfig();
    expect(config.attachmentTtlHours).toBe(48);
  });

  it("throws when HTTP_PORT is not a valid port number", () => {
    process.env["HTTP_PORT"] = "99999";
    expect(() => loadConfig()).toThrow();
  });

  it("throws when HMAC_SECRET is too short", () => {
    process.env["HMAC_SECRET"] = "short";
    expect(() => loadConfig()).toThrow();
  });

  it("throws when WORKER_SECRET is too short", () => {
    process.env["WORKER_SECRET"] = "short";
    expect(() => loadConfig()).toThrow();
  });

  it("parses INITIAL_ALLOWED_USERS into array of bigints", () => {
    process.env["INITIAL_ALLOWED_USERS"] = "123456789,987654321";
    const config = loadConfig();
    expect(config.initialAllowedUsers).toEqual([123456789n, 987654321n]);
  });

  it("returns empty array when INITIAL_ALLOWED_USERS is not set", () => {
    const config = loadConfig();
    expect(config.initialAllowedUsers).toEqual([]);
  });

  it("requires a valid master key when local storage encryption is enabled", () => {
    process.env["STORAGE_ENCRYPTION_MODE"] = "local-v1";
    process.env["MASTER_ENCRYPTION_KEY"] = Buffer.alloc(32, 7).toString("base64");

    const config = loadConfig();
    expect(config.storageEncryptionMode).toBe("local-v1");
    expect(config.masterEncryptionKey).toBe(process.env["MASTER_ENCRYPTION_KEY"]);
  });

  it("parses additional read-only master keys for rotation support", () => {
    process.env["STORAGE_ENCRYPTION_MODE"] = "local-v1";
    process.env["MASTER_ENCRYPTION_KEY"] = Buffer.alloc(32, 7).toString("base64");
    process.env["MASTER_ENCRYPTION_KEYRING"] = [
      `old-v1=${Buffer.alloc(32, 3).toString("base64")}`,
      `older-v0=${Buffer.alloc(32, 4).toString("hex")}`,
    ].join(";");

    const config = loadConfig();

    expect(config.masterEncryptionKeyring).toEqual({
      "old-v1": Buffer.alloc(32, 3).toString("base64"),
      "older-v0": Buffer.alloc(32, 4).toString("hex"),
    });
  });

  it("rejects local storage encryption without a master key", () => {
    process.env["STORAGE_ENCRYPTION_MODE"] = "local-v1";
    delete process.env["MASTER_ENCRYPTION_KEY"];

    expect(() => loadConfig()).toThrow(/MASTER_ENCRYPTION_KEY is required/);
  });

  it("rejects an invalid master key value", () => {
    process.env["STORAGE_ENCRYPTION_MODE"] = "local-v1";
    process.env["MASTER_ENCRYPTION_KEY"] = "not-a-valid-key";

    expect(() => loadConfig()).toThrow(/MASTER_ENCRYPTION_KEY must decode to exactly 32 bytes/i);
  });

  it("rejects an invalid keyring entry", () => {
    process.env["STORAGE_ENCRYPTION_MODE"] = "local-v1";
    process.env["MASTER_ENCRYPTION_KEY"] = Buffer.alloc(32, 7).toString("base64");
    process.env["MASTER_ENCRYPTION_KEYRING"] = "legacy-without-separator";

    expect(() => loadConfig()).toThrow(/MASTER_ENCRYPTION_KEYRING entries must use the format/i);
  });

  it("rejects a keyring that redefines the active key id", () => {
    process.env["STORAGE_ENCRYPTION_MODE"] = "local-v1";
    process.env["MASTER_ENCRYPTION_KEY"] = Buffer.alloc(32, 7).toString("base64");
    process.env["MASTER_ENCRYPTION_KEY_ID"] = "current-v2";
    process.env["MASTER_ENCRYPTION_KEYRING"] =
      "current-v2=" + Buffer.alloc(32, 8).toString("base64");

    expect(() => loadConfig()).toThrow(/must not redefine the active key id/i);
  });

  it("rejects non-https PUBLIC_BASE_URL in production", () => {
    process.env["NODE_ENV"] = "production";
    process.env["PUBLIC_BASE_URL"] = "http://tgmail.example.com";

    expect(() => loadConfig()).toThrow(/PUBLIC_BASE_URL must use HTTPS in production/);
  });

  it("parses backup archive encryption mode", () => {
    process.env["STORAGE_ENCRYPTION_MODE"] = "local-v1";
    process.env["MASTER_ENCRYPTION_KEY"] = Buffer.alloc(32, 7).toString("base64");
    process.env["BACKUP_ARCHIVE_ENCRYPTION"] = "storage-key";

    const config = loadConfig();

    expect(config.backupArchiveEncryption).toBe("storage-key");
  });

  it("rejects backup archive encryption without local storage encryption", () => {
    process.env["BACKUP_ARCHIVE_ENCRYPTION"] = "storage-key";
    process.env["STORAGE_ENCRYPTION_MODE"] = "none";

    expect(() => loadConfig()).toThrow(/BACKUP_ARCHIVE_ENCRYPTION=storage-key requires/i);
  });

  it("parses hosted app mode with a hosted mail domain", () => {
    process.env["APP_MODE"] = "hosted";
    process.env["HOSTED_MAIL_DOMAIN"] = " inbox.example.com ";

    const config = loadConfig();

    expect(config.appMode).toBe("hosted");
    expect(config.hostedMailDomain).toBe("inbox.example.com");
    expect(config.billingProvider).toBe("none");
  });

  it("requires HOSTED_MAIL_DOMAIN in hosted mode", () => {
    process.env["APP_MODE"] = "hosted";

    expect(() => loadConfig()).toThrow(/HOSTED_MAIL_DOMAIN is required/i);
  });

  it("rejects malformed hosted mail domains", () => {
    process.env["APP_MODE"] = "hosted";
    process.env["HOSTED_MAIL_DOMAIN"] = "https://inbox.example.com";

    expect(() => loadConfig()).toThrow(/HOSTED_MAIL_DOMAIN/i);
  });

  it("rejects hosted mail domains with invalid label edges", () => {
    process.env["APP_MODE"] = "hosted";
    process.env["HOSTED_MAIL_DOMAIN"] = "foo-.example.com";

    expect(() => loadConfig()).toThrow(/HOSTED_MAIL_DOMAIN/i);

    process.env["HOSTED_MAIL_DOMAIN"] = "foo.-bar.com";

    expect(() => loadConfig()).toThrow(/HOSTED_MAIL_DOMAIN/i);
  });

  it("rejects Stripe billing outside hosted mode", () => {
    process.env["BILLING_PROVIDER"] = "stripe";

    expect(() => loadConfig()).toThrow(/BILLING_PROVIDER=stripe requires APP_MODE=hosted/i);
  });

  it("requires all Stripe billing settings when Stripe is enabled", () => {
    process.env["APP_MODE"] = "hosted";
    process.env["HOSTED_MAIL_DOMAIN"] = "inbox.example.com";
    process.env["BILLING_PROVIDER"] = "stripe";

    expect(() => loadConfig()).toThrow(/STRIPE_SECRET_KEY/);
  });

  it("rejects malformed Stripe billing settings", () => {
    process.env["APP_MODE"] = "hosted";
    process.env["HOSTED_MAIL_DOMAIN"] = "inbox.example.com";
    process.env["BILLING_PROVIDER"] = "stripe";
    process.env["STRIPE_SECRET_KEY"] = "not-a-secret-key";

    expect(() => loadConfig()).toThrow(/STRIPE_SECRET_KEY/);
  });

  it("parses Stripe billing configuration", () => {
    process.env["APP_MODE"] = "hosted";
    process.env["HOSTED_MAIL_DOMAIN"] = "inbox.example.com";
    process.env["BILLING_PROVIDER"] = "stripe";
    process.env["STRIPE_SECRET_KEY"] = " sk_test_123 ";
    process.env["STRIPE_WEBHOOK_SECRET"] = "whsec_123";
    process.env["STRIPE_PRICE_PERSONAL_MONTHLY"] = "price_personal_monthly";
    process.env["STRIPE_PRICE_PERSONAL_YEARLY"] = "price_personal_yearly";
    process.env["STRIPE_PRICE_PRO_MONTHLY"] = "price_pro_monthly";
    process.env["STRIPE_PRICE_PRO_YEARLY"] = "price_pro_yearly";
    process.env["STRIPE_PRICE_TEAM_MONTHLY"] = "price_team_monthly";
    process.env["STRIPE_PRICE_TEAM_YEARLY"] = "price_team_yearly";
    process.env["BILLING_SUCCESS_URL"] = "https://tgmail.example.com/billing/success";
    process.env["BILLING_CANCEL_URL"] = "https://tgmail.example.com/billing/cancel";

    const config = loadConfig();

    expect(config.billingProvider).toBe("stripe");
    expect(config.stripeSecretKey).toBe("sk_test_123");
    expect(config.stripeWebhookSecret).toBe("whsec_123");
    expect(config.stripePriceIds).toEqual({
      personalMonthly: "price_personal_monthly",
      personalYearly: "price_personal_yearly",
      proMonthly: "price_pro_monthly",
      proYearly: "price_pro_yearly",
      teamMonthly: "price_team_monthly",
      teamYearly: "price_team_yearly",
    });
    expect(config.billingSuccessUrl).toBe("https://tgmail.example.com/billing/success");
    expect(config.billingCancelUrl).toBe("https://tgmail.example.com/billing/cancel");
  });
});
