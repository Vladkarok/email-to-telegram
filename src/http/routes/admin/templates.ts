import { escapeHtml, escapeHtmlAttribute } from "../../../utils/html.js";

const ADMIN_CSS = `
:root {
  color-scheme: dark;
  --bg: #0e1116;
  --panel: #151a22;
  --panel-raised: #1a2029;
  --ink: #dde3ec;
  --muted: #8a94a6;
  --line: #232b38;
  --line-soft: #1d2430;
  --accent: #58a6ff;
  --accent-btn: #2f6feb;
  --accent-btn-hover: #4079ee;
  --ok: #3fb950;
  --warn: #d29922;
  --danger: #f85149;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  -webkit-font-smoothing: antialiased;
}
main {
  max-width: 1180px;
  margin: 0 auto;
  padding: 20px 20px 64px;
}
.topnav {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 10px 4px;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--line);
}
.topnav .brand {
  font-weight: 650;
  letter-spacing: 0.01em;
  color: var(--ink);
  margin-right: 8px;
}
.topnav .brand .at { color: var(--accent); }
.topnav a { color: var(--muted); text-decoration: none; font-weight: 500; }
.topnav a:hover { color: var(--ink); }
.topnav .logout { margin-left: auto; color: var(--danger); }
.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 18px 20px;
  margin-bottom: 16px;
  overflow-x: auto;
}
h1 { font-size: 1.3rem; font-weight: 650; margin: 0 0 14px; letter-spacing: -0.01em; }
h2 {
  font-size: 0.8rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin: 4px 0 12px;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
table {
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0 2px;
  font-variant-numeric: tabular-nums;
}
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line-soft); }
th {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--muted);
  letter-spacing: 0.08em;
  border-bottom: 1px solid var(--line);
}
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: rgba(255, 255, 255, 0.025); }
.muted { color: var(--muted); }
input[type="text"], input[type="password"], input[type="date"], select, textarea {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 12px;
  font: inherit;
  color: var(--ink);
  width: 100%;
  max-width: 400px;
  background: var(--bg);
}
input:focus, select:focus, textarea:focus {
  outline: 2px solid var(--accent-btn);
  outline-offset: -1px;
  border-color: transparent;
}
input::placeholder { color: var(--muted); opacity: 0.7; }
textarea { resize: vertical; }
button, .btn {
  background: var(--accent-btn);
  color: #fff;
  border: 0;
  border-radius: 8px;
  padding: 8px 18px;
  font: inherit;
  font-weight: 550;
  cursor: pointer;
  text-decoration: none;
  display: inline-block;
  transition: background 0.12s ease;
}
button:hover, .btn:hover { background: var(--accent-btn-hover); }
.btn-danger { background: var(--danger); }
.btn-danger:hover { background: #ff6a5f; }
dl {
  margin: 0;
  display: grid;
  grid-template-columns: 150px 1fr;
  row-gap: 8px;
  align-items: baseline;
}
dt {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--muted);
  letter-spacing: 0.08em;
}
dd { margin: 0; }
.flash { padding: 10px 14px; border-radius: 8px; margin-bottom: 14px; border: 1px solid; }
.flash-success { background: rgba(63, 185, 80, 0.12); color: #56d364; border-color: rgba(63, 185, 80, 0.4); }
.flash-info { background: rgba(88, 166, 255, 0.1); color: #79b8ff; border-color: rgba(88, 166, 255, 0.4); }
.flash-error { background: rgba(248, 81, 73, 0.12); color: #ff7b72; border-color: rgba(248, 81, 73, 0.4); }
.dashboard-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(480px, 100%), 1fr));
  gap: 16px;
  align-items: start;
}
.dashboard-grid .panel { margin-bottom: 0; }
.dashboard-grid .panel > p.muted { margin: 2px 0 4px; }
th, td { white-space: nowrap; }
.compact-table th, .compact-table td { padding: 7px 8px; font-size: 0.9rem; }
.status-danger { color: var(--danger); font-weight: 600; }
.status-warn { color: var(--warn); font-weight: 600; }
.status-ok { color: var(--ok); }
`;

function adminLayout(title: string, bodyHtml: string, csrfToken?: string): string {
  const csrfMeta = csrfToken
    ? `<meta name="csrf-token" content="${escapeHtmlAttribute(csrfToken)}" />`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow,noarchive" />
    ${csrfMeta}
    <title>${escapeHtml(title)} - Admin</title>
    <style>${ADMIN_CSS}</style>
  </head>
  <body>
    <main>
      <nav class="topnav">
        <span class="brand">email<span class="at">→</span>telegram <span class="muted">admin</span></span>
        <a href="/admin">Dashboard</a>
        <a href="/admin/users">Users</a>
        <a href="/admin/logout" class="logout">Logout</a>
      </nav>
      ${bodyHtml}
    </main>
  </body>
</html>`;
}

export function renderLoginPage(error?: string): string {
  const errorHtml = error ? `<div class="flash flash-error">${escapeHtml(error)}</div>` : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow,noarchive" />
    <title>Admin Login</title>
    <style>${ADMIN_CSS}</style>
  </head>
  <body>
    <main>
      <div class="panel" style="max-width:400px;margin:80px auto 0;">
        <h1>Admin Login</h1>
        ${errorHtml}
        <form method="post" action="/admin/login">
          <label for="secret" style="display:block;margin-bottom:6px;">Admin Secret</label>
          <input type="password" id="secret" name="secret" required autocomplete="off" />
          <div style="margin-top:12px;">
            <button type="submit">Sign in</button>
          </div>
        </form>
      </div>
    </main>
  </body>
</html>`;
}

export function renderErrorPage(title: string, message: string): string {
  return adminLayout(
    title,
    `<div class="panel">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <p><a href="/admin">&larr; Back to dashboard</a></p>
    </div>`,
  );
}

export interface DashboardSubscriptionDeadline {
  userId: string;
  username: string | null;
  planCode: string;
  subscriptionStatus: string;
  billingEndsAt: string;
  daysUntil: number;
}

export interface DashboardBillingAttention {
  userId: string;
  username: string | null;
  planCode: string;
  subscriptionStatus: string;
  paidThroughAt: string | null;
  currentPeriodEnd: string | null;
}

export interface DashboardManualBillingEvent {
  userId: string;
  planCode: string;
  subscriptionStatus: string;
  paidThroughAt: string | null;
  operatorSource: string;
  createdAt: string;
}

export interface DashboardRecentSignup {
  userId: string;
  username: string | null;
  isAllowed: boolean;
  planCode: string;
  createdAt: string;
}

export interface DashboardData {
  subscriptionDeadlines: DashboardSubscriptionDeadline[];
  billingAttention: DashboardBillingAttention[];
  recentManualBillingEvents: DashboardManualBillingEvent[];
  recentSignups: DashboardRecentSignup[];
}

function renderUserLabel(userId: string, username: string | null): string {
  const escapedId = escapeHtml(userId);
  const escapedHrefId = escapeHtmlAttribute(userId);
  const usernameHtml = username ? ` <span class="muted">@${escapeHtml(username)}</span>` : "";
  return `<a href="/admin/users/${escapedHrefId}">${escapedId}</a>${usernameHtml}`;
}

function renderDateCell(value: string | null): string {
  return value ? escapeHtml(value.slice(0, 10)) : '<span class="muted">-</span>';
}

function renderSubscriptionDeadlines(rows: DashboardSubscriptionDeadline[]): string {
  if (rows.length === 0) {
    return '<p class="muted">No paid subscriptions expiring in the next 30 days.</p>';
  }

  const body = rows
    .map((row) => {
      const urgencyClass = row.daysUntil <= 7 ? "status-danger" : "status-warn";
      return `<tr>
        <td>${renderUserLabel(row.userId, row.username)}</td>
        <td>${escapeHtml(row.planCode)}</td>
        <td>${renderDateCell(row.billingEndsAt)}</td>
        <td class="${urgencyClass}">${row.daysUntil}d</td>
      </tr>`;
    })
    .join("");

  return `<table class="compact-table"><thead><tr><th>User</th><th>Plan</th><th>Ends</th><th>Due</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderBillingAttention(rows: DashboardBillingAttention[]): string {
  if (rows.length === 0) {
    return '<p class="muted">No billing exceptions need attention.</p>';
  }

  const body = rows
    .map(
      (row) => `<tr>
        <td>${renderUserLabel(row.userId, row.username)}</td>
        <td>${escapeHtml(row.planCode)}</td>
        <td class="status-danger">${escapeHtml(row.subscriptionStatus)}</td>
        <td>${renderDateCell(row.paidThroughAt ?? row.currentPeriodEnd)}</td>
      </tr>`,
    )
    .join("");

  return `<table class="compact-table"><thead><tr><th>User</th><th>Plan</th><th>Status</th><th>Ended</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderRecentManualBillingEvents(rows: DashboardManualBillingEvent[]): string {
  if (rows.length === 0) {
    return '<p class="muted">No manual billing events yet.</p>';
  }

  const body = rows
    .map(
      (row) => `<tr>
        <td>${renderDateCell(row.createdAt)}</td>
        <td><a href="/admin/users/${escapeHtmlAttribute(row.userId)}">${escapeHtml(row.userId)}</a></td>
        <td>${escapeHtml(row.planCode)}</td>
        <td>${escapeHtml(row.subscriptionStatus)}</td>
        <td>${escapeHtml(row.operatorSource)}</td>
      </tr>`,
    )
    .join("");

  return `<table class="compact-table"><thead><tr><th>Date</th><th>User</th><th>Plan</th><th>Status</th><th>Source</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderRecentSignups(rows: DashboardRecentSignup[]): string {
  if (rows.length === 0) {
    return '<p class="muted">No signups yet.</p>';
  }

  const body = rows
    .map(
      (row) => `<tr>
        <td>${renderUserLabel(row.userId, row.username)}</td>
        <td>${row.isAllowed ? "Yes" : "No"}</td>
        <td>${escapeHtml(row.planCode)}</td>
        <td>${renderDateCell(row.createdAt)}</td>
      </tr>`,
    )
    .join("");

  return `<table class="compact-table"><thead><tr><th>User</th><th>Allowed</th><th>Plan</th><th>Created</th></tr></thead><tbody>${body}</tbody></table>`;
}

export function renderDashboardPage(csrfToken: string, data: DashboardData): string {
  return adminLayout(
    "Dashboard",
    `<div class="panel">
      <h1>Admin Dashboard</h1>
      <form method="get" action="/admin/users" style="margin-bottom:10px;">
        <input type="text" name="q" placeholder="Telegram ID or username" autocomplete="off" />
        <button type="submit" style="margin-left:8px;">Search</button>
      </form>
      <p class="muted">Renewals, billing audit, and support context.</p>
    </div>
    <div class="dashboard-grid">
      <div class="panel">
        <h2>Renewals Due</h2>
        ${renderSubscriptionDeadlines(data.subscriptionDeadlines)}
      </div>
      <div class="panel">
        <h2>Billing Attention</h2>
        ${renderBillingAttention(data.billingAttention)}
      </div>
      <div class="panel">
        <h2>Recent Manual Billing</h2>
        ${renderRecentManualBillingEvents(data.recentManualBillingEvents)}
      </div>
      <div class="panel">
        <h2>Recent Signups</h2>
        ${renderRecentSignups(data.recentSignups)}
      </div>
    </div>`,
    csrfToken,
  );
}

export interface UserSearchResult {
  id: string;
  username: string | null;
  isAllowed: boolean;
  planCode: string;
  createdAt: string;
}

export function renderUsersPage(
  csrfToken: string,
  query: string,
  results: UserSearchResult[] | null,
): string {
  let resultsHtml = "";
  const isSearch = query.length > 0;
  if (results !== null) {
    if (results.length === 0) {
      resultsHtml = `<p class="muted">${isSearch ? "No users found." : "No users yet."}</p>`;
    } else {
      const rows = results
        .map(
          (u) =>
            `<tr>
              <td><a href="/admin/users/${escapeHtmlAttribute(u.id)}">${escapeHtml(u.id)}</a></td>
              <td>${u.username ? escapeHtml(u.username) : '<span class="muted">-</span>'}</td>
              <td>${u.isAllowed ? "Yes" : "No"}</td>
              <td>${escapeHtml(u.planCode)}</td>
              <td>${renderDateCell(u.createdAt)}</td>
            </tr>`,
        )
        .join("");
      resultsHtml = `<h2>${isSearch ? "Search Results" : "Recent Users"}</h2><table><thead><tr><th>Telegram ID</th><th>Username</th><th>Allowed</th><th>Plan</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table>`;
    }
  }

  return adminLayout(
    "Users",
    `<div class="panel">
      <h1>User Search</h1>
      <form method="get" action="/admin/users" style="margin-bottom:16px;">
        <input type="text" name="q" value="${escapeHtmlAttribute(query)}" placeholder="Telegram ID or username" />
        <button type="submit" style="margin-left:8px;">Search</button>
      </form>
      ${isSearch ? '<p><a href="/admin/users">Show recent users</a></p>' : ""}
      ${resultsHtml}
    </div>`,
    csrfToken,
  );
}

export interface BillingFlash {
  type: "success" | "error" | "idempotent";
  message: string;
}

export interface UserDetail {
  id: string;
  username: string | null;
  isAllowed: boolean;
  createdAt: string;
  updatedAt: string;
  planCode: string;
  subscriptionStatus: string;
  paidThroughAt: string | null;
  hasStripeLink: boolean;
  aliasCount: number;
  currentMonthUsage: { delivered: number; rejected: number } | null;
  latestBillingEvents: Array<{
    id: string;
    planCode: string;
    subscriptionStatus: string;
    operatorSource: string;
    createdAt: string;
  }>;
}

const PLAN_CODES = ["free", "personal", "pro", "team", "business"] as const;
const SUBSCRIPTION_STATUSES = ["free", "active", "canceled"] as const;

export interface BillingFormOverrides {
  plan: string;
  status: string;
  paidThrough: string;
  paymentReference: string;
  note: string;
  userVersion: string;
}

function renderBillingForm(
  csrfToken: string,
  user: UserDetail,
  flash?: BillingFlash,
  submittedKeptStripeLink?: boolean,
  submittedValues?: BillingFormOverrides,
): string {
  const flashHtml = flash
    ? `<div class="flash flash-${flash.type === "success" ? "success" : flash.type === "idempotent" ? "info" : "error"}">${escapeHtml(flash.message)}</div>`
    : "";

  const activePlan = submittedValues?.plan ?? user.planCode;
  const planOptions = PLAN_CODES.map(
    (p) => `<option value="${p}"${activePlan === p ? " selected" : ""}>${p}</option>`,
  ).join("");

  const activeStatus = submittedValues?.status ?? user.subscriptionStatus;
  const statusIsManual = (SUBSCRIPTION_STATUSES as readonly string[]).includes(
    user.subscriptionStatus,
  );
  const currentStatusOption =
    statusIsManual || submittedValues
      ? ""
      : `<option value="${escapeHtmlAttribute(user.subscriptionStatus)}" selected disabled>(current: ${escapeHtml(user.subscriptionStatus)} — read-only)</option>`;
  const statusOptions =
    currentStatusOption +
    SUBSCRIPTION_STATUSES.map(
      (s) => `<option value="${s}"${activeStatus === s ? " selected" : ""}>${s}</option>`,
    ).join("");

  const paidThroughValue = escapeHtmlAttribute(
    submittedValues?.paidThrough ?? (user.paidThroughAt ? user.paidThroughAt.slice(0, 10) : ""),
  );

  const paymentReferenceValue = escapeHtmlAttribute(submittedValues?.paymentReference ?? "");
  const noteValue = escapeHtml(submittedValues?.note ?? "");

  const keepStripeLinkChecked =
    submittedKeptStripeLink ?? (user.hasStripeLink && activePlan === "business");
  const stripeLinkStatus = user.hasStripeLink
    ? `<span class="status-ok">linked</span>`
    : `<span class="muted">none</span>`;

  return `<div class="panel">
    <h2>Grant / Update Plan</h2>
    ${flashHtml}
    <form method="post" action="/admin/users/${escapeHtmlAttribute(user.id)}/billing">
      <input type="hidden" name="_csrf" value="${escapeHtmlAttribute(csrfToken)}" />
      <input type="hidden" name="_user_version" value="${escapeHtmlAttribute(submittedValues?.userVersion ?? user.updatedAt)}" />
      <div style="margin-bottom:12px;">
        <label for="bf-plan" style="display:block;margin-bottom:4px;" class="muted">Plan</label>
        <select id="bf-plan" name="plan">${planOptions}</select>
      </div>
      <div style="margin-bottom:12px;">
        <label for="bf-status" style="display:block;margin-bottom:4px;" class="muted">Status</label>
        <select id="bf-status" name="status">${statusOptions}</select>
      </div>
      <div style="margin-bottom:12px;">
        <label for="bf-paid-through" style="display:block;margin-bottom:4px;" class="muted">Paid Through</label>
        <input type="date" id="bf-paid-through" name="paid_through" value="${paidThroughValue}" />
      </div>
      <div style="margin-bottom:12px;">
        <label for="bf-ref" style="display:block;margin-bottom:4px;" class="muted">Payment Reference <span style="color:var(--danger)">*</span></label>
        <input type="text" id="bf-ref" name="payment_reference" placeholder="wise-2026-…" maxlength="255" required value="${paymentReferenceValue}" />
      </div>
      <div style="margin-bottom:12px;">
        <label for="bf-note" style="display:block;margin-bottom:4px;" class="muted">Note</label>
        <textarea id="bf-note" name="note" rows="2" maxlength="1000">${noteValue}</textarea>
      </div>
      <div style="margin-bottom:8px;">
        <label><input type="checkbox" name="keep_stripe_link"${keepStripeLinkChecked ? " checked" : ""} /> Keep Stripe link (business plan only) — current: ${stripeLinkStatus}</label>
      </div>
      <div style="margin-bottom:16px;">
        <label><input type="checkbox" name="_confirm_downgrade" value="yes" /> Confirm downgrade to free plan or cancellation</label>
      </div>
      <button type="submit">Apply</button>
    </form>
  </div>`;
}

export function renderUserDetailPage(
  csrfToken: string,
  user: UserDetail,
  flash?: BillingFlash,
  submittedKeptStripeLink?: boolean,
  submittedValues?: BillingFormOverrides,
): string {
  const billingHtml = user.latestBillingEvents
    .map(
      (e) =>
        `<tr>
          <td>${escapeHtml(e.createdAt)}</td>
          <td>${escapeHtml(e.planCode)}</td>
          <td>${escapeHtml(e.subscriptionStatus)}</td>
          <td>${escapeHtml(e.operatorSource)}</td>
        </tr>`,
    )
    .join("");

  return adminLayout(
    `User ${user.id}`,
    `<div class="panel">
      <h1>User ${escapeHtml(user.id)}</h1>
      <dl>
        <dt>Username</dt><dd>${user.username ? escapeHtml(user.username) : '<span class="muted">-</span>'}</dd>
        <dt>Allowed</dt><dd>${user.isAllowed ? "Yes" : "No"}</dd>
        <dt>Plan</dt><dd>${escapeHtml(user.planCode)}</dd>
        <dt>Status</dt><dd>${escapeHtml(user.subscriptionStatus)}</dd>
        <dt>Paid Through</dt><dd>${user.paidThroughAt ? escapeHtml(user.paidThroughAt) : '<span class="muted">-</span>'}</dd>
        <dt>Created</dt><dd>${escapeHtml(user.createdAt)}</dd>
        <dt>Stripe Link</dt><dd>${user.hasStripeLink ? "linked" : '<span class="muted">none</span>'}</dd>
        <dt>Aliases</dt><dd>${user.aliasCount}</dd>
        ${
          user.currentMonthUsage
            ? `<dt>This Month</dt><dd>${user.currentMonthUsage.delivered} delivered, ${user.currentMonthUsage.rejected} rejected</dd>`
            : ""
        }
      </dl>
    </div>
    <div class="panel">
      <h2>Manual Billing Events</h2>
      ${
        billingHtml
          ? `<table><thead><tr><th>Date</th><th>Plan</th><th>Status</th><th>Source</th></tr></thead><tbody>${billingHtml}</tbody></table>`
          : '<p class="muted">No billing events.</p>'
      }
    </div>
    ${renderBillingForm(csrfToken, user, flash, submittedKeptStripeLink, submittedValues)}`,
    csrfToken,
  );
}
