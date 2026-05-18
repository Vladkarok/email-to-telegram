import { escapeHtml, escapeHtmlAttribute } from "../../../utils/html.js";

const ADMIN_CSS = `
:root {
  color-scheme: light;
  --bg: #f4f1ea;
  --panel: #fffdf8;
  --ink: #171514;
  --muted: #6b645c;
  --line: #d9d0c4;
  --accent: #8b5e34;
  --danger: #b53d3d;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
main {
  max-width: 920px;
  margin: 0 auto;
  padding: 24px 18px 56px;
}
.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 16px;
}
h1 { font-size: 1.5rem; margin: 0 0 16px; }
h2 { font-size: 1.15rem; margin: 20px 0 10px; }
a { color: var(--accent); }
nav { margin-bottom: 20px; }
nav a { margin-right: 16px; }
table { width: 100%; border-collapse: collapse; margin: 10px 0; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
th { font-size: 0.82rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.06em; }
.muted { color: var(--muted); }
input[type="text"], input[type="password"], select, textarea {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px 12px;
  font: inherit;
  width: 100%;
  max-width: 400px;
  background: var(--panel);
}
textarea { resize: vertical; }
.flash-success { background: #e6f4ea; color: #1a5c2a; border: 1px solid #a8d5b3; }
.flash-info { background: #e8f0fe; color: #1a3a6b; border: 1px solid #a8c4f5; }
button, .btn {
  background: var(--accent);
  color: #fff;
  border: 0;
  border-radius: 6px;
  padding: 8px 16px;
  font: inherit;
  cursor: pointer;
  text-decoration: none;
  display: inline-block;
}
button:hover, .btn:hover { opacity: 0.9; }
.btn-danger { background: var(--danger); }
dl { margin: 0; }
dt { font-size: 0.82rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.06em; margin-top: 12px; }
dt:first-child { margin-top: 0; }
dd { margin: 2px 0 0; }
.flash { padding: 10px 14px; border-radius: 6px; margin-bottom: 14px; }
.flash-error { background: #fde8e8; color: var(--danger); border: 1px solid #f5c6c6; }
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
      <nav>
        <a href="/admin">Dashboard</a>
        <a href="/admin/users">Users</a>
        <a href="/admin/logout" style="float:right;color:var(--danger);">Logout</a>
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

export function renderDashboardPage(csrfToken: string): string {
  return adminLayout(
    "Dashboard",
    `<div class="panel">
      <h1>Admin Dashboard</h1>
      <p class="muted">Operator administration panel.</p>
      <p><a href="/admin/users">Search users &rarr;</a></p>
    </div>`,
    csrfToken,
  );
}

export interface UserSearchResult {
  id: string;
  username: string | null;
  isAllowed: boolean;
  planCode: string;
}

export function renderUsersPage(
  csrfToken: string,
  query: string,
  results: UserSearchResult[] | null,
): string {
  let resultsHtml = "";
  if (results !== null) {
    if (results.length === 0) {
      resultsHtml = `<p class="muted">No users found.</p>`;
    } else {
      const rows = results
        .map(
          (u) =>
            `<tr>
              <td><a href="/admin/users/${escapeHtmlAttribute(u.id)}">${escapeHtml(u.id)}</a></td>
              <td>${u.username ? escapeHtml(u.username) : '<span class="muted">-</span>'}</td>
              <td>${u.isAllowed ? "Yes" : "No"}</td>
              <td>${escapeHtml(u.planCode)}</td>
            </tr>`,
        )
        .join("");
      resultsHtml = `<table><thead><tr><th>Telegram ID</th><th>Username</th><th>Allowed</th><th>Plan</th></tr></thead><tbody>${rows}</tbody></table>`;
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
    ? `<span style="color:#1a5c2a;">linked</span>`
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
        <label for="bf-paid-through" style="display:block;margin-bottom:4px;" class="muted">Paid Through (YYYY-MM-DD)</label>
        <input type="text" id="bf-paid-through" name="paid_through" placeholder="2026-12-31" value="${paidThroughValue}" maxlength="10" />
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
