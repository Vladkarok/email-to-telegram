export type ManualPlanCode = "free" | "personal" | "pro" | "team" | "business";
export type ManualSubscriptionStatus = "free" | "active" | "canceled";

export interface StartupOptions {
  migrateOnly: boolean;
  rewrapStorageKeys: boolean;
  backfillStorageEncryption: boolean;
  hostedExportUserId: string | null;
  hostedExportOutputPath: string | null;
  hostedDeleteUserId: string | null;
  hostedSetUserPlanTelegramUserId: string | null;
  manualPlanCode: ManualPlanCode | null;
  manualSubscriptionStatus: ManualSubscriptionStatus | null;
  manualPaidThroughAt: Date | null;
  manualPaymentReference: string | null;
  manualNote: string | null;
  manualKeepStripeLink: boolean;
  warnings: string[];
}

const NOTE_MAX_LENGTH = 1000;
const PAID_THROUGH_BACKFILL_DAYS = 7;

const VALID_PLAN_CODES: readonly ManualPlanCode[] = ["free", "personal", "pro", "team", "business"];
const VALID_STATUSES: readonly ManualSubscriptionStatus[] = ["free", "active", "canceled"];

const booleanOperationFlags = new Set([
  "--migrate-only",
  "--rewrap-storage-keys",
  "--backfill-storage-encryption",
]);

const valuedOperationFlags = new Set([
  "--hosted-export-user",
  "--hosted-delete-user",
  "--hosted-set-user-plan",
]);

const valuedAuxFlags = new Set([
  "--hosted-export-output",
  "--plan",
  "--status",
  "--paid-through",
  "--manual-payment-reference",
  "--note",
]);

const booleanAuxFlags = new Set(["--keep-stripe-link"]);

function defaultOptions(): StartupOptions {
  return {
    migrateOnly: false,
    rewrapStorageKeys: false,
    backfillStorageEncryption: false,
    hostedExportUserId: null,
    hostedExportOutputPath: null,
    hostedDeleteUserId: null,
    hostedSetUserPlanTelegramUserId: null,
    manualPlanCode: null,
    manualSubscriptionStatus: null,
    manualPaidThroughAt: null,
    manualPaymentReference: null,
    manualNote: null,
    manualKeepStripeLink: false,
    warnings: [],
  };
}

function ensureNumericUserId(value: string, flag: string): void {
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${flag} must be a numeric Telegram user id`);
  }
}

export function parseStartupOptions(argv: readonly string[]): StartupOptions {
  const options = defaultOptions();
  const operationFlags: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (booleanOperationFlags.has(arg)) {
      operationFlags.push(arg);
      switch (arg) {
        case "--migrate-only":
          options.migrateOnly = true;
          break;
        case "--rewrap-storage-keys":
          options.rewrapStorageKeys = true;
          break;
        case "--backfill-storage-encryption":
          options.backfillStorageEncryption = true;
          break;
      }
      continue;
    }

    if (booleanAuxFlags.has(arg)) {
      switch (arg) {
        case "--keep-stripe-link":
          options.manualKeepStripeLink = true;
          break;
      }
      continue;
    }

    if (valuedOperationFlags.has(arg) || valuedAuxFlags.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for CLI argument: ${arg}`);
      }
      index += 1;

      switch (arg) {
        case "--hosted-export-user":
          if (options.hostedExportUserId) {
            throw new Error("CLI argument cannot be repeated: --hosted-export-user");
          }
          ensureNumericUserId(value, "--hosted-export-user");
          options.hostedExportUserId = value;
          operationFlags.push(arg);
          break;
        case "--hosted-export-output":
          if (options.hostedExportOutputPath) {
            throw new Error("CLI argument cannot be repeated: --hosted-export-output");
          }
          options.hostedExportOutputPath = value;
          break;
        case "--hosted-delete-user":
          if (options.hostedDeleteUserId) {
            throw new Error("CLI argument cannot be repeated: --hosted-delete-user");
          }
          ensureNumericUserId(value, "--hosted-delete-user");
          options.hostedDeleteUserId = value;
          operationFlags.push(arg);
          break;
        case "--hosted-set-user-plan":
          if (options.hostedSetUserPlanTelegramUserId) {
            throw new Error("CLI argument cannot be repeated: --hosted-set-user-plan");
          }
          ensureNumericUserId(value, "--hosted-set-user-plan");
          options.hostedSetUserPlanTelegramUserId = value;
          operationFlags.push(arg);
          break;
        case "--plan":
          if (options.manualPlanCode) {
            throw new Error("CLI argument cannot be repeated: --plan");
          }
          if (!VALID_PLAN_CODES.includes(value as ManualPlanCode)) {
            throw new Error(
              `Invalid value for --plan: ${value}. Valid plans: ${VALID_PLAN_CODES.join(", ")}`,
            );
          }
          options.manualPlanCode = value as ManualPlanCode;
          break;
        case "--status":
          if (options.manualSubscriptionStatus) {
            throw new Error("CLI argument cannot be repeated: --status");
          }
          if (!VALID_STATUSES.includes(value as ManualSubscriptionStatus)) {
            throw new Error(
              `Invalid value for --status: ${value}. Valid statuses: ${VALID_STATUSES.join(", ")}`,
            );
          }
          options.manualSubscriptionStatus = value as ManualSubscriptionStatus;
          break;
        case "--paid-through":
          if (options.manualPaidThroughAt) {
            throw new Error("CLI argument cannot be repeated: --paid-through");
          }
          options.manualPaidThroughAt = parsePaidThrough(value);
          break;
        case "--manual-payment-reference":
          if (options.manualPaymentReference) {
            throw new Error("CLI argument cannot be repeated: --manual-payment-reference");
          }
          if (value.length === 0 || value.length > 255) {
            throw new Error("--manual-payment-reference must be 1..255 characters");
          }
          options.manualPaymentReference = value;
          break;
        case "--note":
          if (options.manualNote) {
            throw new Error("CLI argument cannot be repeated: --note");
          }
          if (value.length > NOTE_MAX_LENGTH) {
            throw new Error(`--note must be ${NOTE_MAX_LENGTH} characters or fewer`);
          }
          options.manualNote = value;
          break;
      }
      continue;
    }

    throw new Error(`Unknown CLI arguments: ${arg}`);
  }

  if (operationFlags.length > 1) {
    throw new Error(
      `Choose only one startup operation flag, received: ${operationFlags.join(", ")}`,
    );
  }

  if (options.hostedExportUserId && !options.hostedExportOutputPath) {
    throw new Error("CLI argument --hosted-export-output is required with --hosted-export-user");
  }
  if (!options.hostedExportUserId && options.hostedExportOutputPath) {
    throw new Error("CLI argument --hosted-export-output requires --hosted-export-user");
  }

  const isManualPlanOperation = options.hostedSetUserPlanTelegramUserId !== null;
  const hasManualAuxFlag =
    options.manualPlanCode !== null ||
    options.manualSubscriptionStatus !== null ||
    options.manualPaidThroughAt !== null ||
    options.manualPaymentReference !== null ||
    options.manualNote !== null ||
    options.manualKeepStripeLink;

  if (hasManualAuxFlag && !isManualPlanOperation) {
    throw new Error("Manual billing arguments require --hosted-set-user-plan");
  }

  if (isManualPlanOperation) {
    if (!options.manualPlanCode) {
      throw new Error("--plan is required for manual plan operations");
    }

    if (!options.manualSubscriptionStatus) {
      options.manualSubscriptionStatus = options.manualPlanCode === "free" ? "free" : "active";
    }

    if (options.manualPlanCode === "free" && options.manualSubscriptionStatus !== "free") {
      throw new Error("--plan free must be used with --status free");
    }

    if (options.manualPlanCode === "free" && options.manualKeepStripeLink) {
      throw new Error("--keep-stripe-link is not allowed with --plan free");
    }

    if (options.manualKeepStripeLink && options.manualPlanCode !== "business") {
      throw new Error(
        "--keep-stripe-link is allowed only with --plan business (webhook overwrite protection)",
      );
    }

    const requiresPaidThrough =
      (options.manualPlanCode === "personal" ||
        options.manualPlanCode === "pro" ||
        options.manualPlanCode === "team") &&
      options.manualSubscriptionStatus === "active";
    if (requiresPaidThrough && !options.manualPaidThroughAt) {
      throw new Error(
        "--paid-through is required for paid plans (personal/pro/team). Use --plan business to grant without an expiration date.",
      );
    }

    if (options.manualPaidThroughAt) {
      const now = Date.now();
      const target = options.manualPaidThroughAt.getTime();
      if (target < now) {
        const ageMs = now - target;
        const cutoff = PAID_THROUGH_BACKFILL_DAYS * 24 * 60 * 60 * 1000;
        if (ageMs > cutoff) {
          throw new Error(
            `--paid-through must be at most ${PAID_THROUGH_BACKFILL_DAYS} days in the past`,
          );
        }
        options.warnings.push(
          `--paid-through is in the past (backfill window): ${options.manualPaidThroughAt.toISOString()}`,
        );
      }
    }
  }

  return options;
}

function parsePaidThrough(value: string): Date {
  const isoDateOnly = /^(\d{4})-(\d{2})-(\d{2})$/;
  const isoDateTime =
    /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
  const dateOnlyMatch = isoDateOnly.exec(value);
  const dateTimeMatch = isoDateTime.exec(value);
  if (!dateOnlyMatch && !dateTimeMatch) {
    throw new Error(
      `--paid-through could not be parsed as a date: ${value}. Use YYYY-MM-DD or ISO 8601.`,
    );
  }

  const [, year, month, day] = dateOnlyMatch ?? dateTimeMatch!;
  if (!isValidCalendarDate(Number(year), Number(month), Number(day))) {
    throw new Error(`--paid-through is not a valid calendar date: ${value}`);
  }

  const candidate = dateOnlyMatch ? `${value}T00:00:00.000Z` : value;
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `--paid-through could not be parsed as a date: ${value}. Use YYYY-MM-DD or ISO 8601.`,
    );
  }
  return parsed;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}
