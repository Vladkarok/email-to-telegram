import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../../config.js";
import { getLogger } from "../../../utils/logger.js";
import { verifyAdminSecret, generateCsrfToken, requireAdmin, verifyCsrfToken } from "./auth.js";
import {
  renderLoginPage,
  renderDashboardPage,
  renderUsersPage,
  renderUserDetailPage,
  renderOrganizationDetailPage,
  renderErrorPage,
  type UserSearchResult,
  type UserDetail,
  type OrganizationDetail,
  type BillingFlash,
  type BillingFormOverrides,
} from "./templates.js";
import { adminOperatorSource, redactManualBillingForLog } from "../../../billing/audit.js";
import {
  grantManualOrganizationPlan,
  type ManualSubscriptionStatus,
} from "../../../billing/manual.js";
import type { PlanCode } from "../../../billing/plans.js";
import { getDb } from "../../../db/client.js";
import { findUserById } from "../../../db/repos/users.js";
import { findOrganizationById } from "../../../db/repos/organizations.js";
import {
  listOrganizationMembers,
  listOrganizationMembershipsForUser,
} from "../../../db/repos/organizationMembers.js";
import { countActiveAliasesByOrganization } from "../../../db/repos/aliases.js";
import { getOrganizationUsageMonth, usageMonthForDate } from "../../../db/repos/usage.js";
import { listManualBillingEventsForOrganization } from "../../../db/repos/manualBillingEvents.js";
import { users } from "../../../db/schema.js";
import { eq, ilike } from "drizzle-orm";
import cookie from "@fastify/cookie";
import session from "@fastify/session";

type AdminConfig = Pick<
  AppConfig,
  "adminEnabled" | "adminSecret" | "adminSessionSecret" | "adminSessionTtlMinutes" | "nodeEnv"
>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  // Prevent browsers and intermediaries from caching admin HTML
  app.addHook("onSend", async (_req, reply) => {
    const ct = reply.getHeader("content-type");
    if (typeof ct === "string" && ct.startsWith("text/html")) {
      reply.header("Cache-Control", "no-store, private, max-age=0");
      reply.header("Pragma", "no-cache");
    }
  });

  // CSRF check must be registered before route handlers.
  // Use routeOptions.url (the matched, decoded pattern) not req.url (raw, percent-encoded)
  // to avoid bypasses like POST /%61dmin/action skipping the check.
  // Login is excluded — no session exists yet, so there is no token to bind.
  app.addHook("preHandler", async (req, reply) => {
    if (req.method === "POST" && req.routeOptions.url !== "/admin/login") {
      if (!verifyCsrfToken(req)) {
        await reply.status(403).send("Invalid CSRF token");
        return;
      }
    }
  });

  // req.ip is sourced from X-Forwarded-For (trustProxy: true) which Caddy sets to the real
  // client IP. Caddy must be configured to strip/overwrite X-Forwarded-For on ingress so
  // clients cannot spoof their way around this limit.
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

      results = await Promise.all(
        rows.map(async (u) => {
          const memberships = await listOrganizationMembershipsForUser(db, u.id);
          return {
            id: u.id.toString(),
            username: u.username,
            isAllowed: u.isAllowed,
            organizationCount: memberships.length,
          };
        }),
      );
    }

    await reply.type("text/html").send(renderUsersPage(csrfToken, query, results));
  });

  app.get<{ Params: { id: string } }>(
    "/admin/users/:id",
    { preHandler: guard },
    async (req, reply) => {
      const csrfToken = req.session.admin?.csrfToken ?? "";
      const userId = req.params.id;

      if (!/^-?\d+$/.test(userId)) {
        await reply
          .status(400)
          .type("text/html")
          .send(renderErrorPage("Bad Request", "Invalid user ID."));
        return;
      }

      const db = getDb();
      const user = await findUserById(db, BigInt(userId));
      if (!user) {
        await reply.status(404).send();
        return;
      }

      const memberships = await listOrganizationMembershipsForUser(db, user.id);
      const organizations: OrganizationDetail[] = await Promise.all(
        memberships.map((m) => buildOrganizationDetail(m.organizationId)),
      );

      const detail: UserDetail = {
        id: user.id.toString(),
        username: user.username,
        isAllowed: user.isAllowed,
        createdAt: user.createdAt.toISOString(),
        organizations,
      };

      await reply.type("text/html").send(renderUserDetailPage(csrfToken, detail));
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/organizations/:id",
    { preHandler: guard },
    async (req, reply) => {
      const csrfToken = req.session.admin?.csrfToken ?? "";
      const orgId = req.params.id;

      if (!UUID_RE.test(orgId)) {
        await reply
          .status(400)
          .type("text/html")
          .send(renderErrorPage("Bad Request", "Invalid organization ID."));
        return;
      }

      const db = getDb();
      const org = await findOrganizationById(db, orgId);
      if (!org) {
        await reply.status(404).send();
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
      }

      const detail = await buildOrganizationDetail(orgId, org);
      await reply.type("text/html").send(renderOrganizationDetailPage(csrfToken, detail, flash));
    },
  );

  const VALID_PLAN_CODES: readonly string[] = ["free", "personal", "pro", "team", "business"];
  const VALID_STATUSES: readonly string[] = ["free", "active", "canceled"];

  app.post<{ Params: { id: string } }>(
    "/admin/organizations/:id/billing",
    { preHandler: guard },
    async (req, reply) => {
      const orgId = req.params.id;
      const csrfToken = req.session.admin?.csrfToken ?? "";

      if (!UUID_RE.test(orgId)) {
        await reply
          .status(400)
          .type("text/html")
          .send(renderErrorPage("Bad Request", "Invalid organization ID."));
        return;
      }

      const body = req.body as Record<string, unknown> | undefined;

      // Reject array-valued fields — repeated keys would bypass length/idempotency checks.
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
      const orgVersionRaw = getString("_org_version") ?? "";

      // Checkboxes send their form `value` attribute when checked, nothing when unchecked.
      // Parsed early so renderError can preserve the submitted checkbox state on re-render.
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
        orgVersion: orgVersionRaw,
      };

      const renderError = async (
        message: string,
        preserveCheckbox = true,
        preserveSubmitted = true,
      ): Promise<void> => {
        const detail = await buildOrganizationDetail(orgId);
        const flash: BillingFlash = { type: "error", message };
        await reply
          .type("text/html")
          .send(
            renderOrganizationDetailPage(
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
        "_org_version",
      ];
      if (allFields.some((k) => Array.isArray(body?.[k]))) {
        await renderError("Invalid request: duplicate form fields are not allowed.");
        return;
      }

      // Reject any scalar checkbox value that isn't the expected sentinel — fail closed.
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

      // _org_version is required: omitting it would bypass the concurrency guard.
      if (!orgVersionRaw) {
        await renderError("Missing page version token. Please reload and resubmit.");
        return;
      }

      const paymentReference = paymentReferenceRaw;
      const note = noteRaw || null;

      // Free plan always clears paid-through regardless of what the form submits.
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
      const result = await grantManualOrganizationPlan(db, {
        organizationId: orgId,
        planCode: planRaw as PlanCode,
        subscriptionStatus: statusRaw as ManualSubscriptionStatus,
        paidThroughAt,
        paymentReference,
        note,
        keptStripeLink,
        operatorSource: adminOperatorSource(loginSecret),
        expectedUpdatedAt: orgVersionRaw,
      });

      if (!result.ok) {
        const errorMessages: Record<string, string> = {
          organization_not_found: "Organization not found.",
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
          concurrent_update:
            "Organization billing state was updated since this page was loaded. Please reload and review before resubmitting.",
        };
        const isConcurrentUpdate = result.code === "concurrent_update";
        await renderError(
          errorMessages[result.code] ?? result.code,
          !isConcurrentUpdate,
          !isConcurrentUpdate,
        );
        return;
      }

      if (!result.idempotent) {
        logger.info(redactManualBillingForLog(result), "admin.billing.mutated");
      } else {
        logger.info({ organizationId: orgId }, "admin.billing.idempotent");
      }
      const flashParam = result.idempotent ? "idempotent" : "granted";
      await reply.redirect(`/admin/organizations/${orgId}?billing=${flashParam}`);
    },
  );
}

async function buildOrganizationDetail(
  orgId: string,
  prefetched?: NonNullable<Awaited<ReturnType<typeof findOrganizationById>>>,
): Promise<OrganizationDetail> {
  const db = getDb();
  const org = prefetched ?? (await findOrganizationById(db, orgId));
  if (!org) {
    return {
      id: orgId,
      name: "(not found)",
      planCode: "-",
      subscriptionStatus: "-",
      paidThroughAt: null,
      createdAt: "-",
      updatedAt: "-",
      hasStripeLink: false,
      aliasCount: 0,
      memberCount: 0,
      members: [],
      currentMonthUsage: null,
      latestBillingEvents: [],
    };
  }

  const members = await listOrganizationMembers(db, orgId);
  const aliasCount = await countActiveAliasesByOrganization(db, orgId);
  const currentMonth = usageMonthForDate();
  const usage = await getOrganizationUsageMonth(db, orgId, currentMonth);
  const billingEvents = await listManualBillingEventsForOrganization(db, orgId);

  const memberDetails = await Promise.all(
    members.map(async (m) => {
      const u = await findUserById(db, m.userId);
      return {
        userId: m.userId.toString(),
        role: m.role,
        username: u?.username ?? null,
      };
    }),
  );

  return {
    id: org.id,
    name: org.name,
    planCode: org.planCode,
    subscriptionStatus: org.subscriptionStatus,
    paidThroughAt: org.paidThroughAt?.toISOString() ?? null,
    createdAt: org.createdAt.toISOString(),
    updatedAt: org.updatedAt.toISOString(),
    hasStripeLink: org.stripeCustomerId != null || org.stripeSubscriptionId != null,
    aliasCount,
    memberCount: members.length,
    members: memberDetails,
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
