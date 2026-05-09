# Hosted Realization Plan

This plan covers the next hosted-service slices:

- operator web administration
- user-facing UI language support
- observability, logs, and app-specific metrics
- license and source strategy

It is intentionally split into separate implementation branches so small,
reviewable PRs can land without coupling product decisions to infrastructure
changes.

## Current Position

The app already has the important primitives for a hosted beta:

- organizations, organization members, plans, and usage counters
- manual plan grants through CLI startup operations
- hosted export and deletion commands
- structured Pino logs
- health and readiness routes
- Docker deployment with Postgres

The weak operator experience today is that paid-plan administration requires
Docker CLI commands and raw Telegram IDs or organization IDs. That is fine for
one or two customers, but it will become error-prone as soon as support,
renewals, and abuse handling happen regularly.

## Branch Plan

Recommended branch order:

1. `codex/self-serve-billing-toggle`
   - Status: implemented separately.
   - Goal: Stripe UI is hidden when `BILLING_PROVIDER=none`.

2. `codex/license-source-strategy`
   - Goal: document and apply the chosen license/source model before hosted-only
     admin and observability code is implemented.

3. `codex/operator-admin-foundation`
   - Goal: authenticated internal web admin with read-only customer search and
     organization detail pages.

4. `codex/operator-audit-foundation`
   - Goal: audit event shape, operator identity/source, and redaction rules for
     admin mutations before write access exists.

5. `codex/operator-admin-manual-billing`
   - Goal: grant, renew, downgrade, and audit manual plans from the admin UI.

6. `codex/observability-foundation`
   - Goal: structured audit events, Prometheus metrics endpoint, and operator
     dashboard/runbook.

7. `codex/i18n-foundation`
   - Goal: message catalog and locale selection for English and Ukrainian, with
     Russian documented as a deferred product decision.

Each PR should include tests and a short operator note. Avoid combining admin,
i18n, observability, and license changes into one PR.

## Operator Web Administration

### Recommendation

Build a small internal admin page. Do not add a heavy admin framework yet.

The current app is Fastify + server-rendered route templates already exist for
message view pages. A narrow internal admin surface fits the existing stack and
avoids introducing React, Next.js, or a separate service before there is a clear
need.

### Authentication

Use a single operator admin secret for the first version:

- `ADMIN_ENABLED=true`
- `ADMIN_SECRET=<long random value>`
- admin routes require a signed session cookie
- login page accepts the secret and sets a short-lived secure cookie
- production requires HTTPS

This is enough for a one-operator beta. Later, replace with:

- OIDC through Google/GitHub
- Tailscale/Cloudflare Access in front of `/admin`
- per-operator audit identity

Session and cookie implementation:

- add `@fastify/cookie`
- add `@fastify/session`
- use the default in-memory session store for the single-operator beta
- enforce `ADMIN_SESSION_TTL_MINUTES` through session cookie max age and a
  server-side login timestamp check
- rotate all admin sessions by changing `ADMIN_SECRET` and restarting the app
- document that in-memory sessions are intentionally cleared on restart

Minimum browser-security requirements for the first admin PR:

- login endpoint rate limit by IP and by submitted secret fingerprint
- secure session cookie with `HttpOnly`, `Secure`, and `SameSite=Strict`
- CSRF tokens for every mutating form, stored in the admin session and submitted
  through hidden form fields
- short session TTL and explicit logout
- constant-time secret comparison
- no admin routes when `ADMIN_ENABLED` is false
- extend the existing production `PUBLIC_BASE_URL` HTTPS startup check so admin
  cannot be enabled unless the public base URL is HTTPS

Manual billing mutations additionally require a fresh confirmation step or
re-auth check before downgrade, plan grant, or renewal.

### PR 1: Admin Foundation

Branch: `codex/operator-admin-foundation`

Scope:

- add `ADMIN_ENABLED`, `ADMIN_SECRET`, and `ADMIN_SESSION_TTL_MINUTES`
- add `@fastify/cookie` and `@fastify/session`
- validate admin config in `src/config.ts` with the existing Zod env schema
- add `/admin/login`, `/admin/logout`, `/admin`
- add `/admin/users` search by Telegram ID or username
- add `/admin/organizations/:id` read-only detail page
- show plan, status, paid-through, aliases used, storage, monthly usage, and
  latest manual billing events
- add route-level tests for auth and read-only pages
- widen HTTP route config types to include admin settings
- register admin routes only when enabled
- redact payment references and notes by default; reveal them only behind an
  explicit operator action if truly needed
- log admin page access without logging payment references, notes, or tokens

Non-goals:

- no billing mutations
- no data deletion
- no abuse block edits
- no multi-operator roles

### PR 2: Audit Foundation

Branch: `codex/operator-audit-foundation`

Scope:

- define operator audit event fields before admin mutations exist
- use the existing `manual_billing_events.operator_source` column explicitly
  instead of relying on its database default
- update `src/billing/manual.ts` inputs and `buildEventInput()` so manual
  billing callers can pass `operatorSource`
- represent operator source as at least `cli` or `admin`
- store a safe operator identifier:
  - `cli` for current CLI operations
  - `admin:<stable hash or configured operator id>` for first web admin
- define redaction rules for payment references, manual notes, tokens, raw
  email content, and customer identifiers
- preserve and reuse the existing `redactManualBillingForLog()` pattern for CLI
  logs, and add equivalent redaction for admin logs/audit views
- add tests proving audit events do not expose sensitive content
- update manual billing service input so both CLI and admin can pass operator
  source/identity

This PR should land before admin write access. Billing changes are entitlement
changes, so auditability and redaction should be designed before the form that
performs them.

### PR 3: Admin Manual Billing

Branch: `codex/operator-admin-manual-billing`

Scope:

- add forms for:
  - grant paid plan
  - renew paid-through date
  - downgrade to free
  - add private operator note
- call the same `src/billing/manual.ts` service used by the CLI
- show idempotency conflicts clearly when a payment reference already exists
- require confirmation for downgrade
- write manual billing events exactly as CLI does
- write audit events with `operatorSource=admin`
- add tests for success, validation failure, duplicate payment reference, and
  forbidden access
- add CSRF token tests for all mutating forms

Key design rule:

Admin UI must not duplicate business logic. It should validate form shape, then
delegate to existing manual billing service functions.

### Later Admin Slices

Do these only after billing administration is proven useful:

- abuse blocklist management
- hosted export trigger and download handoff
- hosted deletion request workflow
- organization member management
- custom domain review/activation

## UI Language Support

### Recommendation

Add real i18n before translating every string.

Start with a typed message catalog and locale resolver. Do not scatter
`if language === ...` branches inside handlers.

Initial locales:

- `en`
- `uk`

Deferred locale:

- `ru`

Russian should be a deliberate product/support decision, not automatic v1
scope. Track it in the catalog structure, but do not translate or expose it
until support capacity and audience policy are clear.

Default:

- use Telegram `ctx.from.language_code` on first contact when supported
- store user locale in `users.locale`
- allow `/language` to change it
- fall back to English

### PR: i18n Foundation

Branch: `codex/i18n-foundation`

Scope:

- add `locale` column to `users`
- add a Drizzle migration with nullable `users.locale`; existing users fall
  back to Telegram `language_code` or English until they choose a language
- add `src/i18n/locales/en.ts` and `uk.ts`
- add typed translation keys and interpolation helper
- add locale middleware or helper that resolves current user locale
- add `/language` command with inline keyboard
- migrate high-traffic bot text first:
  - `/start`
  - `/help`
  - `/newemail`
  - `/listemail`
  - `/plan`
  - `/usage`
  - `/billing`
  - billing/manual-billing messages
- add tests for fallback and language switching

Non-goals:

- translating every internal error/log message
- admin UI localization
- user-generated content translation

Translation quality:

- Ukrainian should be first-class, not machine-looking fallback text.
- Russian can be supported if you are comfortable serving that audience and
  handling support in that language.
- If support capacity is limited, launch `en` + `uk` first and keep `ru` behind
  an explicit product decision.

## Observability

### Recommendation

Keep logs structured, add Prometheus metrics, and add app-specific counters.

Do not start with a large observability platform. Docker logs + Prometheus
metrics + a runbook is enough for the current deployment. Grafana/Prometheus can
be added on the VPS when needed.

### PR: Observability Foundation

Branch: `codex/observability-foundation`

Scope:

- add `METRICS_ENABLED=true`
- add `METRICS_TOKEN=<long random value>`
- add `prom-client`
- expose `/metrics` in Prometheus text format
- protect `/metrics` with bearer token unless bound to private network only
- add process/runtime metrics:
  - process uptime
  - memory RSS/heap
  - Node event loop lag if practical
- add HTTP metrics:
  - request count by route/status
  - request duration histogram by route
- add email pipeline metrics:
  - inbound preflight accepted/rejected by reason
  - raw inbound accepted/rejected by reason
  - delivery attempts by result
  - retry attempts by result
  - Telegram send failures by error class
- add billing/usage metrics:
  - manual plan grants count by plan
  - quota rejections by reason
  - active organizations by plan
- add tests for `/metrics` auth and basic metric output
- widen HTTP route config types to include metrics settings
- keep tenant identifiers out of Prometheus labels

Logs:

- keep Pino JSON in production
- add stable dot-separated event names:
  - `billing.manual_grant.created`
  - `billing.manual_grant.idempotent`
  - `inbound.preflight.rejected`
  - `inbound.raw.rejected`
  - `delivery.telegram.failed`
  - `admin.session.created`
  - `admin.billing.mutated`
- include organization ID and alias ID where useful
- never log raw email content, tokens, payment references, or manual notes

Metric label policy:

- labels may include route, status class, result, plan, and rejection reason
- labels must not include organization ID, alias ID, Telegram user ID, email
  address, domain, payment reference, or free-form error text
- tenant drilldowns belong in admin-only DB/UI queries, not metric labels

Suggested dashboard panels:

- bot health and HTTP readiness
- inbound accepted/rejected rate
- Telegram delivery success/failure
- quota rejections
- manual billing actions
- storage usage trend
- admin-only noisy alias/organization drilldown by rejected mail, outside
  Prometheus labels

Alert candidates:

- bot unhealthy for more than 5 minutes
- raw inbound 5xx rate above threshold
- Telegram delivery failures above threshold
- disk usage above 80 percent
- Postgres unavailable
- Cloudflare Worker failures or CPU-limit errors

## License And Source Strategy

### Current State

The repository currently uses MIT.

MIT is good for adoption and self-hosting. It is permissive: people can copy,
modify, sell, or host competing versions as long as they keep the copyright and
license notice. If the repository has already been public under MIT, old copies
remain available under MIT even if you change future versions.

### Recommendation

For this project, decide the source boundary before implementing hosted-only
admin and observability branches. The cleanest default strategy is:

- keep the self-hosted core open source under MIT
- keep hosted-only operations, billing/admin automation, and deployment-specific
  config private if needed, or consciously keep them in the public repo if the
  hosted business is based on service quality rather than code exclusivity
- sell managed hosting, support, uptime, backups, deliverability, abuse
  handling, and convenience

This fits the product: users can self-host, but many will pay to avoid running
mail routing, Telegram bot infrastructure, backups, and abuse controls.

### Avoid For Now

Avoid switching to a restrictive source-available license unless you are sure
you need it. It adds friction, creates trust questions, and does not by itself
create a business.

Avoid AGPL unless you intentionally want network-service copyleft. It can
protect against hosted competitors, but it also discourages some users and
companies from adopting or contributing.

### PR: License/Source Strategy

Branch: `codex/license-source-strategy`

Scope:

- add `docs/project/source-strategy.md`
- document what is open source vs hosted-private
- document contribution expectations
- document commercial hosted offering boundaries
- add a short README section pointing to the source strategy
- decide whether admin and observability code lives in this public repo before
  those implementation PRs are opened

Decision gate before changing license:

- is the repo already public under MIT?
- do you need outside contributions?
- do you care more about adoption or preventing competitors?
- are hosted-only features separable from the core?
- are you prepared to enforce a restrictive license?

## Suggested Execution Order

1. Merge self-serve billing toggle.
2. Merge license/source strategy and decide the hosted-only code boundary.
3. Build admin read-only foundation.
4. Build audit foundation.
5. Build admin manual billing mutations.
6. Add observability foundation before public traffic increases.
7. Add i18n foundation once the main bot flows stabilize.

The reason admin comes before i18n is operational: manual billing and support
will be painful immediately. Language support matters, but it is safer after
the text surface is stable.

## Review Requirements

Every feature PR should be reviewed for:

- auth bypasses
- accidental raw email/token/payment-reference exposure
- hosted vs self-hosted behavior
- tests around disabled feature/config states
- operator rollback path

Admin and observability PRs should receive stricter review because they expose
internal service data.
