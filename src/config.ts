import { z } from "zod";

const portSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535, { message: "Port must be between 1 and 65535" });

const secretSchema = z.string().min(16, {
  message: "Secret must be at least 16 characters",
});

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  MAIL_DOMAIN: z.string().min(1),
  INGEST_MODE: z.enum(["cloudflare", "smtp"]),
  HTTP_PORT: portSchema,
  HMAC_SECRET: secretSchema,
  WORKER_SECRET: secretSchema,
  PUBLIC_BASE_URL: z.string().url(),
  ATTACHMENT_DIR: z.string().min(1),
  RAW_EMAIL_DIR: z.string().min(1),
  SMTP_PORT: portSchema.optional(),
  ATTACHMENT_TTL_HOURS: z.coerce.number().int().positive().default(336),
  RAW_EMAIL_TTL_HOURS: z.coerce.number().int().positive().default(336),
  MAX_SIZE_BYTES: z.coerce.number().int().positive().default(10485760),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "silent"]).default("info"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  INITIAL_ALLOWED_USERS: z.string().optional(),
  /** Optional: URL to ping on each healthy cycle (e.g. https://hc-ping.com/<uuid>) */
  HEALTHCHECKS_URL: z.string().url().optional(),
  /** Optional: Telegram chat ID to send critical alerts to */
  ALERT_CHAT_ID: z.coerce.bigint().optional(),
  /** Directory to store nightly DB backups (optional — skips backup if unset) */
  BACKUP_DIR: z.string().optional(),
});

export interface AppConfig {
  databaseUrl: string;
  telegramBotToken: string;
  mailDomain: string;
  publicBaseUrl: string;
  ingestMode: "cloudflare" | "smtp";
  httpPort: number;
  hmacSecret: string;
  workerSecret: string;
  attachmentDir: string;
  rawEmailDir: string;
  smtpPort: number | undefined;
  attachmentTtlHours: number;
  rawEmailTtlHours: number;
  maxSizeBytes: number;
  logLevel: string;
  nodeEnv: string;
  initialAllowedUsers: bigint[];
  healthchecksUrl: string | undefined;
  alertChatId: bigint | undefined;
  backupDir: string | undefined;
}

export function loadConfig(): AppConfig {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const errors = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${errors}`);
  }

  const env = result.data;

  const initialAllowedUsers =
    env.INITIAL_ALLOWED_USERS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => BigInt(s)) ?? [];

  return {
    databaseUrl: env.DATABASE_URL,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    mailDomain: env.MAIL_DOMAIN,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    ingestMode: env.INGEST_MODE,
    httpPort: env.HTTP_PORT,
    hmacSecret: env.HMAC_SECRET,
    workerSecret: env.WORKER_SECRET,
    attachmentDir: env.ATTACHMENT_DIR,
    rawEmailDir: env.RAW_EMAIL_DIR,
    smtpPort: env.SMTP_PORT,
    attachmentTtlHours: env.ATTACHMENT_TTL_HOURS,
    rawEmailTtlHours: env.RAW_EMAIL_TTL_HOURS,
    maxSizeBytes: env.MAX_SIZE_BYTES,
    logLevel: env.LOG_LEVEL,
    nodeEnv: env.NODE_ENV,
    initialAllowedUsers,
    healthchecksUrl: env.HEALTHCHECKS_URL,
    alertChatId: env.ALERT_CHAT_ID,
    backupDir: env.BACKUP_DIR,
  };
}
