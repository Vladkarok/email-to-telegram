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
} from "./templates.js";
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
  "adminEnabled" | "adminSecret" | "adminSessionSecret" | "adminSessionTtlMinutes"
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
      secure: "auto",
      sameSite: "strict",
      maxAge: sessionTtlMinutes * 60 * 1000,
      path: "/admin",
    },
    saveUninitialized: false,
  });

  // CSRF check must be registered before route handlers
  app.addHook("preHandler", async (req, reply) => {
    if (req.url.startsWith("/admin") && req.method === "POST" && req.url !== "/admin/login") {
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

      const detail = await buildOrganizationDetail(orgId, org);
      await reply.type("text/html").send(renderOrganizationDetailPage(csrfToken, detail));
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
