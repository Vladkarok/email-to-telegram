import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../../config.js";
import { getLogger } from "../../../utils/logger.js";
import { verifyAdminSecret, generateCsrfToken, requireAdmin, verifyCsrfToken } from "./auth.js";
import {
  renderLoginPage,
  renderDashboardPage,
  renderUsersPage,
  renderUserDetailPage,
  renderErrorPage,
  type UserSearchResult,
  type UserDetail,
  type BillingFlash,
  type BillingFormOverrides,
} from "./templates.js";
import { adminOperatorSource, redactManualBillingForLog } from "../../../billing/audit.js";
import { grantManualUserPlan, type ManualSubscriptionStatus } from "../../../billing/manual.js";
import type { PlanCode } from "../../../billing/plans.js";
import { getDb } from "../../../db/client.js";
import { findUserById } from "../../../db/repos/users.js";
import { countActiveAliasesByUser } from "../../../db/repos/aliases.js";
import { getUserUsageMonth, usageMonthForDate } from "../../../db/repos/usage.js";
import { listManualBillingEventsForUser } from "../../../db/repos/manualBillingEvents.js";
import { users } from "../../../db/schema.js";
import { eq, ilike } from "drizzle-orm";
import cookie from "@fastify/cookie";
import session from "@fastify/session";

type AdminConfig = Pick<
  AppConfig,
  "adminEnabled" | "adminSecret" | "adminSessionSecret" | "adminSessionTtlMinutes" | "nodeEnv"
>;

export async function adminRoutes(app: FastifyInstance, config: AdminConfig): Promise<void> {
  if (!config.adminEnabled || !config.adminSecret) return;

  const loginSecret = config.adminSecret;
  const sessionSecret = config.adminSessionSecret ?? config.adminSecret;
  const sessionTtlMinutes = config.adminSessionTtlMinutes;
  const logger = getLogger();
  const guard = requireAdmin(sessionTtlMinutes);

  await app.register(cookie);
  await app.register(session, {
    secret: sessionSecret,
    cookie: {
      httpOnly: true,
      secure: config.nodeEnv === "production",
      sameSite: "strict",
      maxAge: sessionTtlMinutes * 60 * 1000,
      path: "/admin",
    },
    saveUninitialized: false,
  });

  app.addHook("onSend", async (_req, reply) => {
    const ct = reply.getHeader("content-type");
    if (typeof ct === "string" && ct.startsWith("text/html")) {
      reply.header("Cache-Control", "no-store, private, max-age=0");
      reply.header("Pragma", "no-cache");
    }
  });

  app.addHook("preHandler", async (req, reply) => {
    if (req.method === "POST" && req.routeOptions.url !== "/admin/login") {
      if (!verifyCsrfToken(req)) {
        await reply.status(403).send("Invalid CSRF token");
        return;
      }
    }
  });

  const loginRateLimit = { max: 5, timeWindow: "15 minutes" };

  app.get("/admin/login", async (_req, reply) => {
    await reply.type("text/html").send(renderLoginPage());
  });

  app.post("/admin/login", { config: { rateLimit: loginRateLimit } }, async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    const submitted = typeof body?.["secret"] === "string" ? body["secret"] : "";

    if (!verifyAdminSecret(submitted, loginSecret)) {
      logger.warn({ ip: req.ip }, "admin.login.failed");
      await reply.status(401).type("text/html").send(renderLoginPage("Invalid secret."));
      return;
    }

    const csrfToken = generateCsrfToken();
    req.session.admin = {
      authenticated: true,
      loginAt: Date.now(),
      csrfToken,
    };
    await req.session.save();
    logger.info({ ip: req.ip }, "admin.session.created");
    await reply.redirect("/admin");
  });

  app.get("/admin/logout", async (req, reply) => {
    await req.session.destroy();
    await reply.redirect("/admin/login");
  });

  app.get("/admin", { preHandler: guard }, async (req, reply) => {
    const csrfToken = req.session.admin?.csrfToken ?? "";
    await reply.type("text/html").send(renderDashboardPage(csrfToken));
  });

  app.get("/admin/users", { preHandler: guard }, async (req, reply) => {
    const csrfToken = req.session.admin?.csrfToken ?? "";
    const query = (req.query as Record<string, string>).q?.trim() ?? "";

    let results: UserSearchResult[] | null = null;
    if (query) {
      const db = getDb();
      const isNumeric = /^-?\d+$/.test(query);
      const rows = await db
        .select()
        .from(users)
        .where(isNumeric ? eq(users.id, BigInt(query)) : ilike(users.username, `%${query}%`))
        .limit(50);

      results = rows.map((u) => ({
        id: u.id.toString(),
        username: u.username,
        isAllowed: u.isAllowed,
        planCode: u.planCode,
      }));
    }

    await reply.type("text/html").send(renderUsersPage(csrfToken, query, results));
  });

  app.get<{ Params: { id: string } }>(
    "/admin/users/:id",
    { preHandler: guard },
    async (req, reply) => {
      const csrfToken = req.session.admin?.csrfToken ?? "";
      const userIdRaw = req.params.id;

      if (!/^-?\d+$/.test(userIdRaw)) {
        await reply
          .status(400)
          .type("text/html")
          .send(renderErrorPage("Bad Request", "Invalid user ID."));
        return;
      }

      const billingParam = (req.query as Record<string, string>).billing;
      let flash: BillingFlash | undefined;
      if (billingParam === "granted") {
        flash = { type: "success", message: "Plan updated successfully." };
      } else if (billingParam === "idempotent") {
        flash = {
          type: "idempotent",
          message: "No change: a billing event with this payment reference already exists.",
        };
      } else if (billingParam === "reconciled") {
        flash = {
          type: "success",
          message:
            "Billing state reconciled: payment reference already exists and user state was restored.",
        };
      }

      const detail = await buildUserDetail(BigInt(userIdRaw));
      if (!detail) {
        await reply.status(404).send();
        return;
      }
      await reply.type("text/html").send(renderUserDetailPage(csrfToken, detail, flash));
    },
  );

  const VALID_PLAN_CODES: readonly string[] = ["free", "personal", "pro", "team", "business"];
  const VALID_STATUSES: readonly string[] = ["free", "active", "canceled"];

  app.post<{ Params: { id: string } }>(
    "/admin/users/:id/billing",
    { preHandler: guard },
    async (req, reply) => {
      const userIdRaw = req.params.id;
      const csrfToken = req.session.admin?.csrfToken ?? "";

      if (!/^-?\d+$/.test(userIdRaw)) {
        await reply
          .status(400)
          .type("text/html")
          .send(renderErrorPage("Bad Request", "Invalid user ID."));
        return;
      }

      const userId = BigInt(userIdRaw);
      const body = req.body as Record<string, unknown> | undefined;

      const getString = (key: string): string | null => {
        const v = body?.[key];
        if (Array.isArray(v)) return null;
        return typeof v === "string" ? v.trim() : "";
      };

      const planRaw = getString("plan") ?? "";
      const statusRaw = getString("status") ?? "";
      const paidThroughRaw = getString("paid_through") ?? "";
      const paymentReferenceRaw = getString("payment_reference") ?? "";
      const noteRaw = getString("note") ?? "";
      const userVersionRaw = getString("_user_version") ?? "";

      const keepStripeLinkRaw = body?.["keep_stripe_link"];
      const confirmDowngradeRaw = body?.["_confirm_downgrade"];
      const keptStripeLink = keepStripeLinkRaw === "on";
      const confirmDowngrade = confirmDowngradeRaw === "yes";

      const submittedOverrides: BillingFormOverrides = {
        plan: planRaw,
        status: statusRaw,
        paidThrough: paidThroughRaw,
        paymentReference: paymentReferenceRaw,
        note: noteRaw,
        userVersion: userVersionRaw,
      };

      const renderError = async (
        message: string,
        preserveCheckbox = true,
        preserveSubmitted = true,
      ): Promise<void> => {
        const detail = await buildUserDetail(userId);
        if (!detail) {
          await reply.status(404).send();
          return;
        }
        const flash: BillingFlash = { type: "error", message };
        await reply
          .type("text/html")
          .send(
            renderUserDetailPage(
              csrfToken,
              detail,
              flash,
              preserveCheckbox ? keptStripeLink : undefined,
              preserveSubmitted ? submittedOverrides : undefined,
            ),
          );
      };

      const allFields = [
        "plan",
        "status",
        "paid_through",
        "payment_reference",
        "note",
        "keep_stripe_link",
        "_confirm_downgrade",
        "_user_version",
      ];
      if (allFields.some((k) => Array.isArray(body?.[k]))) {
        await renderError("Invalid request: duplicate form fields are not allowed.");
        return;
      }

      if (keepStripeLinkRaw !== undefined && keepStripeLinkRaw !== "on") {
        await renderError("Invalid request: unexpected value for keep_stripe_link.");
        return;
      }
      if (confirmDowngradeRaw !== undefined && confirmDowngradeRaw !== "yes") {
        await renderError("Invalid request: unexpected value for confirmation field.");
        return;
      }

      if (!VALID_PLAN_CODES.includes(planRaw)) {
        await renderError("Invalid plan selected.");
        return;
      }
      if (!VALID_STATUSES.includes(statusRaw)) {
        await renderError("Invalid subscription status.");
        return;
      }
      if (planRaw !== "free" && statusRaw === "free") {
        await renderError('Only the free plan can have "free" subscription status.');
        return;
      }
      if ((planRaw === "free" || statusRaw === "canceled") && !confirmDowngrade) {
        await renderError(
          "Downgrade to free or cancellation requires confirmation. Check the confirmation box and resubmit.",
        );
        return;
      }
      if (!paymentReferenceRaw) {
        await renderError("Payment reference is required.");
        return;
      }
      if (paymentReferenceRaw.length > 255) {
        await renderError("Payment reference must be 255 characters or fewer.");
        return;
      }
      if (noteRaw.length > 1000) {
        await renderError("Note must be 1000 characters or fewer.");
        return;
      }

      if (!userVersionRaw) {
        await renderError("Missing page version token. Please reload and resubmit.");
        return;
      }

      const paymentReference = paymentReferenceRaw;
      const note = noteRaw || null;

      let paidThroughAt: Date | null = null;
      if (planRaw !== "free" && paidThroughRaw) {
        const dateOnlyRe = /^(\d{4})-(\d{2})-(\d{2})$/;
        const m = dateOnlyRe.exec(paidThroughRaw);
        if (!m) {
          await renderError("Invalid paid-through date. Use YYYY-MM-DD format.");
          return;
        }
        const [, y, mo, d] = m.map(Number) as [unknown, number, number, number];
        const check = new Date(Date.UTC(y, mo - 1, d));
        if (
          check.getUTCFullYear() !== y ||
          check.getUTCMonth() !== mo - 1 ||
          check.getUTCDate() !== d
        ) {
          await renderError("Invalid paid-through date. Use YYYY-MM-DD format.");
          return;
        }
        paidThroughAt = new Date(`${paidThroughRaw}T00:00:00.000Z`);
      }

      const db = getDb();
      const result = await grantManualUserPlan(db, {
        telegramUserId: userId,
        planCode: planRaw as PlanCode,
        subscriptionStatus: statusRaw as ManualSubscriptionStatus,
        paidThroughAt,
        paymentReference,
        note,
        keptStripeLink,
        operatorSource: adminOperatorSource(loginSecret),
        expectedUpdatedAt: userVersionRaw,
      });

      if (!result.ok) {
        const errorMessages: Record<string, string> = {
          user_not_found: "User not found.",
          invalid_plan: "Invalid plan selected.",
          invalid_status: "Invalid subscription status.",
          free_status_required: 'Free plan requires "free" subscription status.',
          free_status_not_allowed_for_paid_plan:
            'Paid plans cannot use "free" subscription status.',
          paid_through_required: "Paid-through date is required for active paid plans.",
          paid_through_not_allowed: "Paid-through date must be empty when status is canceled.",
          canceled_not_allowed_for_business:
            "Business plan cannot be set to canceled. Downgrade to a lower plan instead.",
          keep_stripe_link_not_allowed: "Keep Stripe link is only allowed for the Business plan.",
          payment_reference_conflict:
            "Payment reference already used for a different user or with different billing details.",
          payment_reference_required: "Payment reference is required.",
          payment_reference_too_long: "Payment reference must be 255 characters or fewer.",
          note_too_long: "Note must be 1000 characters or fewer.",
          concurrent_update:
            "User billing state was updated since this page was loaded. Please reload and review before resubmitting.",
        };
        const isConcurrentUpdate = result.code === "concurrent_update";
        logger.warn(
          { userId: userId.toString(), failureCode: result.code },
          "admin.billing.rejected",
        );
        await renderError(
          errorMessages[result.code] ?? result.code,
          !isConcurrentUpdate,
          !isConcurrentUpdate,
        );
        return;
      }

      if (!result.idempotent) {
        logger.info(redactManualBillingForLog(result), "admin.billing.mutated");
      } else if (result.reconciled) {
        logger.info(redactManualBillingForLog(result), "admin.billing.reconciled");
      } else {
        logger.info({ userId: userId.toString() }, "admin.billing.idempotent");
      }
      const flashParam = !result.idempotent
        ? "granted"
        : result.reconciled
          ? "reconciled"
          : "idempotent";
      await reply.redirect(`/admin/users/${userId.toString()}?billing=${flashParam}`);
    },
  );
}

async function buildUserDetail(userId: bigint): Promise<UserDetail | null> {
  const db = getDb();
  const user = await findUserById(db, userId);
  if (!user) return null;

  const aliasCount = await countActiveAliasesByUser(db, userId);
  const currentMonth = usageMonthForDate();
  const usage = await getUserUsageMonth(db, userId, currentMonth);
  const billingEvents = await listManualBillingEventsForUser(db, userId);

  return {
    id: user.id.toString(),
    username: user.username,
    isAllowed: user.isAllowed,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    planCode: user.planCode,
    subscriptionStatus: user.subscriptionStatus,
    paidThroughAt: user.paidThroughAt?.toISOString() ?? null,
    hasStripeLink: user.stripeCustomerId != null || user.stripeSubscriptionId != null,
    aliasCount,
    currentMonthUsage: usage
      ? { delivered: usage.deliveredCount, rejected: usage.rejectedCount }
      : null,
    latestBillingEvents: billingEvents.slice(0, 10).map((e) => ({
      id: e.id,
      planCode: e.planCode,
      subscriptionStatus: e.subscriptionStatus,
      operatorSource: e.operatorSource,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}
