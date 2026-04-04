import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../../src/config.js";

const REQUIRED_ENV: Record<string, string> = {
  DATABASE_URL: "postgres://app:pass@localhost:5432/db",
  TELEGRAM_BOT_TOKEN: "123456:ABC",
  MAIL_DOMAIN: "tgmail.example.com",
  INGEST_MODE: "cloudflare",
  HTTP_PORT: "3000",
  HMAC_SECRET: "a".repeat(32),
  WORKER_SECRET: "b".repeat(32),
  ATTACHMENT_DIR: "/tmp/attachments",
  RAW_EMAIL_DIR: "/tmp/rawemails",
};

const OPTIONAL_ENV = [
  "ATTACHMENT_TTL_HOURS",
  "RAW_EMAIL_TTL_HOURS",
  "MAX_SIZE_BYTES",
  "LOG_LEVEL",
  "NODE_ENV",
  "INITIAL_ALLOWED_USERS",
  "SMTP_PORT",
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
    expect(config.ingestMode).toBe("cloudflare");
  });

  it("throws when DATABASE_URL is missing", () => {
    delete process.env["DATABASE_URL"];
    expect(() => loadConfig()).toThrow();
  });

  it("throws when TELEGRAM_BOT_TOKEN is missing", () => {
    delete process.env["TELEGRAM_BOT_TOKEN"];
    expect(() => loadConfig()).toThrow();
  });

  it("throws when INGEST_MODE is invalid value", () => {
    process.env["INGEST_MODE"] = "ftp";
    expect(() => loadConfig()).toThrow();
  });

  it("accepts smtp as valid INGEST_MODE", () => {
    process.env["INGEST_MODE"] = "smtp";
    const config = loadConfig();
    expect(config.ingestMode).toBe("smtp");
  });

  it("uses default values for optional vars", () => {
    const config = loadConfig();
    expect(config.attachmentTtlHours).toBe(336);
    expect(config.rawEmailTtlHours).toBe(336);
    expect(config.maxSizeBytes).toBe(10485760);
    expect(config.logLevel).toBe("info");
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
});
