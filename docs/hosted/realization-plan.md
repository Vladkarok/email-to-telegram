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

2. `codex/operator-admin-foundation`
   - Goal: authenticated internal web admin with read-only customer search and
     organization detail pages.

3. `codex/operator-admin-manual-billing`
   - Goal: grant, renew, downgrade, and audit manual plans from the admin UI.

4. `codex/i18n-foundation`
   - Goal: message catalog and locale selection for English, Ukrainian, and
     Russian.

5. `codex/observability-foundation`
   - Goal: structured audit events, Prometheus metrics endpoint, and operator
     dashboard/runbook.

6. `codex/license-source-strategy`
   - Goal: document and apply the chosen license/source model.

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

### PR 1: Admin Foundation

Branch: `codex/operator-admin-foundation`

Scope:

- add `ADMIN_ENABLED`, `ADMIN_SECRET`, and `ADMIN_SESSION_TTL_MINUTES`
- add `/admin/login`, `/admin/logout`, `/admin`
- add `/admin/users` search by Telegram ID or username
- add `/admin/organizations/:id` read-only detail page
- show plan, status, paid-through, aliases used, storage, monthly usage, and
  latest manual billing events
- add route-level tests for auth and read-only pages

Non-goals:

- no billing mutations
- no data deletion
- no abuse block edits
- no multi-operator roles

### PR 2: Admin Manual Billing

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
- add tests for success, validation failure, duplicate payment reference, and
  forbidden access

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
- `ru`

Default:

- use Telegram `ctx.from.language_code` on first contact when supported
- store user locale in `users.locale`
- allow `/language` to change it
- fall back to English

### PR: i18n Foundation

Branch: `codex/i18n-foundation`

Scope:

- add `locale` column to `users`
- add `src/i18n/locales/en.ts`, `uk.ts`, `ru.ts`
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

Logs:

- keep Pino JSON in production
- add stable event names for billing, inbound rejection, delivery failure, and
  admin mutations
- include organization ID and alias ID where useful
- never log raw email content, tokens, payment references, or manual notes

Suggested dashboard panels:

- bot health and HTTP readiness
- inbound accepted/rejected rate
- Telegram delivery success/failure
- quota rejections
- manual billing actions
- storage usage trend
- top noisy aliases/organizations by rejected mail

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

For this project, the cleanest strategy is:

- keep the self-hosted core open source under MIT
- keep hosted operations, billing/admin automation, and deployment-specific
  secrets/config private if needed
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

Decision gate before changing license:

- is the repo already public under MIT?
- do you need outside contributions?
- do you care more about adoption or preventing competitors?
- are hosted-only features separable from the core?
- are you prepared to enforce a restrictive license?

## Suggested Execution Order

1. Merge self-serve billing toggle.
2. Build admin read-only foundation.
3. Build admin manual billing mutations.
4. Add observability foundation before public traffic increases.
5. Add i18n foundation once the main bot flows stabilize.
6. Finalize source strategy before pushing larger public-launch marketing.

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
