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

const hostedMailDomainSchema = z
  .string()
  .trim()
  .refine((value) => isValidDomainName(value), {
    message: "Must be a valid domain name without a scheme",
  })
  .optional();
const stripeSecretKeySchema = z
  .string()
  .trim()
  .regex(/^sk_(test|live)_[A-Za-z0-9_]+$/)
  .optional();
const stripeWebhookSecretSchema = z
  .string()
  .trim()
  .regex(/^whsec_[A-Za-z0-9_]+$/)
  .optional();
const stripePriceIdSchema = z
  .string()
  .trim()
  .regex(/^price_[A-Za-z0-9_]+$/)
  .optional();
const optionalTrimmedUrlSchema = z.string().trim().url().optional();

const appModeSchema = z.enum(["self-hosted", "hosted"]).default("self-hosted");
const billingProviderSchema = z.enum(["none", "stripe", "donation"]).default("none");

function isValidDomainName(value: string): boolean {
  if (value.length < 1 || value.length > 253) return false;

  const labels = value.split(".");
  if (labels.length < 2) return false;

  const tld = labels[labels.length - 1];
  if (!tld || !/^[a-zA-Z]{2,63}$/.test(tld)) return false;

  return labels.every((label) => {
    if (label.length < 1 || label.length > 63) return false;
    return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label);
  });
}

const adminSessionTtlSchema = z.coerce.number().int().min(1).max(1440).default(60);
const optionalBooleanSchema = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

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
  BACKUP_ARCHIVE_ENCRYPTION: z.enum(["off", "storage-key"]).default("off"),
  APP_MODE: appModeSchema,
  BILLING_PROVIDER: billingProviderSchema,
  HOSTED_MAIL_DOMAIN: hostedMailDomainSchema,
  STRIPE_SECRET_KEY: stripeSecretKeySchema,
  STRIPE_WEBHOOK_SECRET: stripeWebhookSecretSchema,
  STRIPE_PRICE_PERSONAL_MONTHLY: stripePriceIdSchema,
  STRIPE_PRICE_PERSONAL_YEARLY: stripePriceIdSchema,
  STRIPE_PRICE_PRO_MONTHLY: stripePriceIdSchema,
  STRIPE_PRICE_PRO_YEARLY: stripePriceIdSchema,
  STRIPE_PRICE_TEAM_MONTHLY: stripePriceIdSchema,
  STRIPE_PRICE_TEAM_YEARLY: stripePriceIdSchema,
  BILLING_SUCCESS_URL: optionalTrimmedUrlSchema,
  BILLING_CANCEL_URL: optionalTrimmedUrlSchema,
  DONATION_URL: optionalTrimmedUrlSchema,
  SUPPORT_CONTACT: z.string().trim().min(1).optional(),
  PRIVACY_POLICY_URL: optionalTrimmedUrlSchema,
  ADMIN_ENABLED: optionalBooleanSchema,
  ADMIN_SECRET: z.string().optional(),
  ADMIN_SESSION_SECRET: z.string().optional(),
  ADMIN_SESSION_TTL_MINUTES: adminSessionTtlSchema,
  METRICS_ENABLED: optionalBooleanSchema,
  METRICS_TOKEN: z.string().optional(),
  TRUST_PROXY: optionalBooleanSchema,
});

export type AppMode = z.infer<typeof appModeSchema>;
export type BillingProvider = z.infer<typeof billingProviderSchema>;

export interface StripePriceIds {
  personalMonthly: string;
  personalYearly: string;
  proMonthly: string;
  proYearly: string;
  teamMonthly: string;
  teamYearly: string;
}

export interface AppConfig {
  appMode: AppMode;
  billingProvider: BillingProvider;
  databaseUrl: string;
  telegramBotToken: string;
  mailDomain: string;
  hostedMailDomain: string | undefined;
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
  backupArchiveEncryption: "off" | "storage-key";
  stripeSecretKey: string | undefined;
  stripeWebhookSecret: string | undefined;
  stripePriceIds: StripePriceIds | undefined;
  billingSuccessUrl: string | undefined;
  billingCancelUrl: string | undefined;
  donationUrl: string | undefined;
  supportContact: string | undefined;
  privacyPolicyUrl: string | undefined;
  adminEnabled: boolean;
  adminSecret: string | undefined;
  adminSessionSecret: string | undefined;
  adminSessionTtlMinutes: number;
  metricsEnabled: boolean;
  metricsToken: string | undefined;
  trustProxy: boolean;
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
  if (env.MASTER_ENCRYPTION_KEY_ID in masterEncryptionKeyring) {
    throw new Error(
      `Invalid configuration:\n  MASTER_ENCRYPTION_KEYRING must not redefine the active key id ${env.MASTER_ENCRYPTION_KEY_ID}`,
    );
  }

  if (
    env.BACKUP_ARCHIVE_ENCRYPTION === "storage-key" &&
    env.STORAGE_ENCRYPTION_MODE !== "local-v1"
  ) {
    throw new Error(
      "Invalid configuration:\n  BACKUP_ARCHIVE_ENCRYPTION=storage-key requires STORAGE_ENCRYPTION_MODE=local-v1",
    );
  }

  if (env.APP_MODE === "hosted" && !env.HOSTED_MAIL_DOMAIN) {
    throw new Error(
      "Invalid configuration:\n  HOSTED_MAIL_DOMAIN is required when APP_MODE=hosted",
    );
  }

  if (env.BILLING_PROVIDER === "stripe") {
    if (env.APP_MODE !== "hosted") {
      throw new Error("Invalid configuration:\n  BILLING_PROVIDER=stripe requires APP_MODE=hosted");
    }

    const missing = [
      ["STRIPE_SECRET_KEY", env.STRIPE_SECRET_KEY],
      ["STRIPE_WEBHOOK_SECRET", env.STRIPE_WEBHOOK_SECRET],
      ["STRIPE_PRICE_PERSONAL_MONTHLY", env.STRIPE_PRICE_PERSONAL_MONTHLY],
      ["STRIPE_PRICE_PERSONAL_YEARLY", env.STRIPE_PRICE_PERSONAL_YEARLY],
      ["STRIPE_PRICE_PRO_MONTHLY", env.STRIPE_PRICE_PRO_MONTHLY],
      ["STRIPE_PRICE_PRO_YEARLY", env.STRIPE_PRICE_PRO_YEARLY],
      ["STRIPE_PRICE_TEAM_MONTHLY", env.STRIPE_PRICE_TEAM_MONTHLY],
      ["STRIPE_PRICE_TEAM_YEARLY", env.STRIPE_PRICE_TEAM_YEARLY],
      ["BILLING_SUCCESS_URL", env.BILLING_SUCCESS_URL],
      ["BILLING_CANCEL_URL", env.BILLING_CANCEL_URL],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);

    if (missing.length > 0) {
      throw new Error(
        `Invalid configuration:\n  BILLING_PROVIDER=stripe requires ${missing.join(", ")}`,
      );
    }
  }

  if (env.BILLING_PROVIDER === "donation" && !env.DONATION_URL) {
    throw new Error("Invalid configuration:\n  BILLING_PROVIDER=donation requires DONATION_URL");
  }

  if (env.ADMIN_ENABLED) {
    if (!env.ADMIN_SECRET || env.ADMIN_SECRET.length < 32) {
      throw new Error(
        "Invalid configuration:\n  ADMIN_SECRET must be at least 32 characters when ADMIN_ENABLED=true",
      );
    }
    if (env.ADMIN_SESSION_SECRET && env.ADMIN_SESSION_SECRET.length < 32) {
      throw new Error(
        "Invalid configuration:\n  ADMIN_SESSION_SECRET must be at least 32 characters when provided",
      );
    }
    if (env.NODE_ENV === "production" && new URL(env.PUBLIC_BASE_URL).protocol !== "https:") {
      throw new Error(
        "Invalid configuration:\n  ADMIN_ENABLED=true requires HTTPS PUBLIC_BASE_URL in production",
      );
    }
  }

  if (env.METRICS_ENABLED) {
    if (!env.METRICS_TOKEN || env.METRICS_TOKEN.length < 32) {
      throw new Error(
        "Invalid configuration:\n  METRICS_TOKEN must be at least 32 characters when METRICS_ENABLED=true",
      );
    }
  }

  const stripePriceIds =
    env.BILLING_PROVIDER === "stripe"
      ? {
          personalMonthly: env.STRIPE_PRICE_PERSONAL_MONTHLY!,
          personalYearly: env.STRIPE_PRICE_PERSONAL_YEARLY!,
          proMonthly: env.STRIPE_PRICE_PRO_MONTHLY!,
          proYearly: env.STRIPE_PRICE_PRO_YEARLY!,
          teamMonthly: env.STRIPE_PRICE_TEAM_MONTHLY!,
          teamYearly: env.STRIPE_PRICE_TEAM_YEARLY!,
        }
      : undefined;

  return {
    appMode: env.APP_MODE,
    billingProvider: env.BILLING_PROVIDER,
    databaseUrl: env.DATABASE_URL,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    mailDomain: env.MAIL_DOMAIN,
    hostedMailDomain: env.HOSTED_MAIL_DOMAIN,
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
    backupArchiveEncryption: env.BACKUP_ARCHIVE_ENCRYPTION,
    stripeSecretKey: env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
    stripePriceIds,
    billingSuccessUrl: env.BILLING_SUCCESS_URL,
    billingCancelUrl: env.BILLING_CANCEL_URL,
    donationUrl: env.DONATION_URL,
    supportContact: env.SUPPORT_CONTACT,
    privacyPolicyUrl: env.PRIVACY_POLICY_URL,
    adminEnabled: env.ADMIN_ENABLED,
    adminSecret: env.ADMIN_SECRET,
    adminSessionSecret: env.ADMIN_SESSION_SECRET,
    adminSessionTtlMinutes: env.ADMIN_SESSION_TTL_MINUTES,
    metricsEnabled: env.METRICS_ENABLED,
    metricsToken: env.METRICS_TOKEN,
    trustProxy: env.TRUST_PROXY,
  };
}
