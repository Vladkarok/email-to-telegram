import { z } from "zod";
import {
  parseMasterEncryptionKey,
  parseMasterEncryptionKeyring,
  type StorageEncryptionMode,
} from "./security/encryption.js";

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
  HTTP_PORT: portSchema,
  HMAC_SECRET: secretSchema,
  WORKER_SECRET: secretSchema,
  PUBLIC_BASE_URL: z.string().url(),
  // Validated separately against HTTPS requirement in loadConfig().
  ATTACHMENT_DIR: z.string().min(1),
  RAW_EMAIL_DIR: z.string().min(1),
  ATTACHMENT_TTL_HOURS: z.coerce.number().int().positive().default(336),
  RAW_EMAIL_TTL_HOURS: z.coerce.number().int().positive().default(336),
  DELIVERY_LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  STORAGE_ENCRYPTION_MODE: z.enum(["none", "local-v1"]).default("none"),
  MASTER_ENCRYPTION_KEY: z.string().optional(),
  MASTER_ENCRYPTION_KEY_ID: z.string().default("local-env-v1"),
  MASTER_ENCRYPTION_KEYRING: z.string().optional(),
  MAX_SIZE_BYTES: z.coerce.number().int().positive().default(10485760),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "silent"]).default("info"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  // Comma-separated Telegram user IDs; validated as integers here so bad values
  // produce a clear Zod error at startup rather than a BigInt() runtime throw.
  INITIAL_ALLOWED_USERS: z
    .string()
    .optional()
    .transform((val) => {
      if (!val) return [];
      return val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    })
    .pipe(
      z.array(
        z
          .string()
          .regex(/^-?\d+$/, { message: "each entry must be an integer Telegram user ID" })
          .transform((s) => BigInt(s)),
      ),
    ),
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
  httpPort: number;
  hmacSecret: string;
  workerSecret: string;
  attachmentDir: string;
  rawEmailDir: string;
  attachmentTtlHours: number;
  rawEmailTtlHours: number;
  deliveryLogRetentionDays: number;
  storageEncryptionMode: StorageEncryptionMode;
  masterEncryptionKey: string | undefined;
  masterEncryptionKeyId: string;
  masterEncryptionKeyring: Record<string, string>;
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

  // Require HTTPS for PUBLIC_BASE_URL in production to prevent download tokens
  // being transmitted over an unencrypted connection.  URL schemes are
  // case-insensitive, so compare the parsed protocol rather than the raw string.
  if (env.NODE_ENV === "production" && new URL(env.PUBLIC_BASE_URL).protocol !== "https:") {
    throw new Error("Invalid configuration:\n  PUBLIC_BASE_URL must use HTTPS in production");
  }

  if (env.STORAGE_ENCRYPTION_MODE === "local-v1") {
    if (!env.MASTER_ENCRYPTION_KEY) {
      throw new Error(
        "Invalid configuration:\n  MASTER_ENCRYPTION_KEY is required when STORAGE_ENCRYPTION_MODE=local-v1",
      );
    }

    try {
      parseMasterEncryptionKey(env.MASTER_ENCRYPTION_KEY);
      parseMasterEncryptionKeyring(env.MASTER_ENCRYPTION_KEYRING);
    } catch (err: unknown) {
      throw new Error(`Invalid configuration:\n  ${(err as Error).message}`, { cause: err });
    }
  }

  const masterEncryptionKeyring = parseMasterEncryptionKeyring(env.MASTER_ENCRYPTION_KEYRING);

  return {
    databaseUrl: env.DATABASE_URL,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    mailDomain: env.MAIL_DOMAIN,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    httpPort: env.HTTP_PORT,
    hmacSecret: env.HMAC_SECRET,
    workerSecret: env.WORKER_SECRET,
    attachmentDir: env.ATTACHMENT_DIR,
    rawEmailDir: env.RAW_EMAIL_DIR,
    attachmentTtlHours: env.ATTACHMENT_TTL_HOURS,
    rawEmailTtlHours: env.RAW_EMAIL_TTL_HOURS,
    deliveryLogRetentionDays: env.DELIVERY_LOG_RETENTION_DAYS,
    storageEncryptionMode: env.STORAGE_ENCRYPTION_MODE,
    masterEncryptionKey: env.MASTER_ENCRYPTION_KEY,
    masterEncryptionKeyId: env.MASTER_ENCRYPTION_KEY_ID,
    masterEncryptionKeyring,
    maxSizeBytes: env.MAX_SIZE_BYTES,
    logLevel: env.LOG_LEVEL,
    nodeEnv: env.NODE_ENV,
    initialAllowedUsers: env.INITIAL_ALLOWED_USERS,
    healthchecksUrl: env.HEALTHCHECKS_URL,
    alertChatId: env.ALERT_CHAT_ID,
    backupDir: env.BACKUP_DIR,
  };
}
