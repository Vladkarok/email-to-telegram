export type ManualPlanCode = "free" | "personal" | "pro" | "team" | "business";
export type ManualSubscriptionStatus = "free" | "active" | "canceled";
export type ManualOrganizationRole = "owner" | "admin" | "member";

export interface StartupOptions {
  migrateOnly: boolean;
  rewrapStorageKeys: boolean;
  backfillStorageEncryption: boolean;
  hostedExportOrganizationId: string | null;
  hostedExportOutputPath: string | null;
  hostedDeleteOrganizationId: string | null;
  hostedSetOrganizationPlanId: string | null;
  hostedSetUserPlanTelegramUserId: string | null;
  hostedAddOrganizationMemberId: string | null;
  manualPlanCode: ManualPlanCode | null;
  manualSubscriptionStatus: ManualSubscriptionStatus | null;
  manualPaidThroughAt: Date | null;
  manualPaymentReference: string | null;
  manualNote: string | null;
  manualTelegramUserId: string | null;
  manualOrganizationId: string | null;
  manualOrganizationRole: ManualOrganizationRole | null;
  manualKeepStripeLink: boolean;
  manualCreateNewOrganization: boolean;
  warnings: string[];
}

const NOTE_MAX_LENGTH = 1000;
const PAID_THROUGH_BACKFILL_DAYS = 7;

const VALID_PLAN_CODES: readonly ManualPlanCode[] = ["free", "personal", "pro", "team", "business"];
const VALID_STATUSES: readonly ManualSubscriptionStatus[] = ["free", "active", "canceled"];
const VALID_ROLES: readonly ManualOrganizationRole[] = ["owner", "admin", "member"];

const booleanOperationFlags = new Set([
  "--migrate-only",
  "--rewrap-storage-keys",
  "--backfill-storage-encryption",
]);

const valuedOperationFlags = new Set([
  "--hosted-export-organization",
  "--hosted-delete-organization",
  "--hosted-set-organization-plan",
  "--hosted-set-user-plan",
  "--hosted-add-organization-member",
]);

const valuedAuxFlags = new Set([
  "--hosted-export-output",
  "--plan",
  "--status",
  "--paid-through",
  "--manual-payment-reference",
  "--note",
  "--telegram-user-id",
  "--organization-id",
  "--role",
]);

const booleanAuxFlags = new Set(["--keep-stripe-link", "--create-new-organization"]);

function defaultOptions(): StartupOptions {
  return {
    migrateOnly: false,
    rewrapStorageKeys: false,
    backfillStorageEncryption: false,
    hostedExportOrganizationId: null,
    hostedExportOutputPath: null,
    hostedDeleteOrganizationId: null,
    hostedSetOrganizationPlanId: null,
    hostedSetUserPlanTelegramUserId: null,
    hostedAddOrganizationMemberId: null,
    manualPlanCode: null,
    manualSubscriptionStatus: null,
    manualPaidThroughAt: null,
    manualPaymentReference: null,
    manualNote: null,
    manualTelegramUserId: null,
    manualOrganizationId: null,
    manualOrganizationRole: null,
    manualKeepStripeLink: false,
    manualCreateNewOrganization: false,
    warnings: [],
  };
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
        case "--create-new-organization":
          options.manualCreateNewOrganization = true;
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
        case "--hosted-export-organization":
          if (options.hostedExportOrganizationId) {
            throw new Error("CLI argument cannot be repeated: --hosted-export-organization");
          }
          options.hostedExportOrganizationId = value;
          operationFlags.push(arg);
          break;
        case "--hosted-export-output":
          if (options.hostedExportOutputPath) {
            throw new Error("CLI argument cannot be repeated: --hosted-export-output");
          }
          options.hostedExportOutputPath = value;
          break;
        case "--hosted-delete-organization":
          if (options.hostedDeleteOrganizationId) {
            throw new Error("CLI argument cannot be repeated: --hosted-delete-organization");
          }
          options.hostedDeleteOrganizationId = value;
          operationFlags.push(arg);
          break;
        case "--hosted-set-organization-plan":
          if (options.hostedSetOrganizationPlanId) {
            throw new Error("CLI argument cannot be repeated: --hosted-set-organization-plan");
          }
          options.hostedSetOrganizationPlanId = value;
          operationFlags.push(arg);
          break;
        case "--hosted-set-user-plan":
          if (options.hostedSetUserPlanTelegramUserId) {
            throw new Error("CLI argument cannot be repeated: --hosted-set-user-plan");
          }
          options.hostedSetUserPlanTelegramUserId = value;
          operationFlags.push(arg);
          break;
        case "--hosted-add-organization-member":
          if (options.hostedAddOrganizationMemberId) {
            throw new Error("CLI argument cannot be repeated: --hosted-add-organization-member");
          }
          options.hostedAddOrganizationMemberId = value;
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
        case "--telegram-user-id":
          if (options.manualTelegramUserId) {
            throw new Error("CLI argument cannot be repeated: --telegram-user-id");
          }
          if (!/^-?\d+$/.test(value)) {
            throw new Error("--telegram-user-id must be a numeric Telegram user id");
          }
          options.manualTelegramUserId = value;
          break;
        case "--organization-id":
          if (options.manualOrganizationId) {
            throw new Error("CLI argument cannot be repeated: --organization-id");
          }
          options.manualOrganizationId = value;
          break;
        case "--role":
          if (options.manualOrganizationRole) {
            throw new Error("CLI argument cannot be repeated: --role");
          }
          if (!VALID_ROLES.includes(value as ManualOrganizationRole)) {
            throw new Error(
              `Invalid value for --role: ${value}. Valid roles: ${VALID_ROLES.join(", ")}`,
            );
          }
          options.manualOrganizationRole = value as ManualOrganizationRole;
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

  if (options.hostedExportOrganizationId && !options.hostedExportOutputPath) {
    throw new Error(
      "CLI argument --hosted-export-output is required with --hosted-export-organization",
    );
  }
  if (!options.hostedExportOrganizationId && options.hostedExportOutputPath) {
    throw new Error("CLI argument --hosted-export-output requires --hosted-export-organization");
  }

  // Validate --hosted-set-user-plan numeric id
  if (options.hostedSetUserPlanTelegramUserId !== null) {
    if (!/^-?\d+$/.test(options.hostedSetUserPlanTelegramUserId)) {
      throw new Error("--hosted-set-user-plan must be a numeric Telegram user id");
    }
  }

  const isManualPlanOperation =
    options.hostedSetOrganizationPlanId !== null ||
    options.hostedSetUserPlanTelegramUserId !== null;

  if (isManualPlanOperation) {
    if (!options.manualPlanCode) {
      throw new Error("--plan is required for manual plan operations");
    }

    // Default subscription status: free for free plans, active for paid plans.
    if (!options.manualSubscriptionStatus) {
      options.manualSubscriptionStatus = options.manualPlanCode === "free" ? "free" : "active";
    }

    // free plan must be paired with free status
    if (options.manualPlanCode === "free" && options.manualSubscriptionStatus !== "free") {
      throw new Error("--plan free must be used with --status free");
    }

    // free plan must not use --keep-stripe-link
    if (options.manualPlanCode === "free" && options.manualKeepStripeLink) {
      throw new Error("--keep-stripe-link is not allowed with --plan free");
    }

    // --keep-stripe-link allowed only with business
    if (options.manualKeepStripeLink && options.manualPlanCode !== "business") {
      throw new Error(
        "--keep-stripe-link is allowed only with --plan business (webhook overwrite protection)",
      );
    }

    // paid plans (personal, pro, team) require --paid-through; business is exempt
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

    // Warn if --paid-through is in the past 7-day backfill window
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

  if (options.hostedAddOrganizationMemberId !== null) {
    if (!options.manualTelegramUserId) {
      throw new Error("--telegram-user-id is required with --hosted-add-organization-member");
    }
    if (!options.manualOrganizationRole) {
      throw new Error("--role is required with --hosted-add-organization-member");
    }
  }

  return options;
}

function parsePaidThrough(value: string): Date {
  // Accept YYYY-MM-DD (treated as UTC midnight) or full ISO 8601
  const isoDateOnly = /^\d{4}-\d{2}-\d{2}$/;
  const candidate = isoDateOnly.test(value) ? `${value}T00:00:00.000Z` : value;
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `--paid-through could not be parsed as a date: ${value}. Use YYYY-MM-DD or ISO 8601.`,
    );
  }
  return parsed;
}
