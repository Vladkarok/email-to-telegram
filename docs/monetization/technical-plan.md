# Technical Development Plan: Hosted SaaS Monetization

## Summary

Build monetization as a hosted SaaS layer on top of the current self-hosted app,
without breaking the existing MIT/self-hosted deployment. The first production
goal is: Telegram user starts the hosted bot, gets an organization, uses a free
plan, can upgrade through Stripe Checkout, and inbound email is accepted/rejected
based on subscription and plan limits.

## Scope

### In Scope For Paid SaaS v1

- Hosted mode flag
- Organizations
- Organization memberships
- Plan limits
- Stripe Checkout
- Stripe Customer Portal
- Stripe webhook handling
- Free/paid subscription state
- Quota checks before expensive email processing
- Basic usage counters
- Telegram bot billing/status commands
- Tests for auth, billing webhooks, quotas, and inbound rejection

### Out Of Scope For v1

- Full web dashboard
- SSO/SAML
- Multi-custom-domain automation
- Merchant-of-Record migration
- Invoices outside Stripe
- Complex role permissions beyond `owner`, `admin`, `member`
- Per-seat billing
- Direct SMTP ingestion

## Architecture Decision

Add monetization as an optional app mode:

- `self-hosted` mode: current behavior remains available.
- `hosted` mode: users are auto-onboarded into organizations and plan limits
  apply.
- Billing code must be isolated so self-hosted users do not need Stripe env vars.

Recommended config:

```text
APP_MODE=self-hosted | hosted
BILLING_PROVIDER=none | stripe
HOSTED_MAIL_DOMAIN=inbox.example.com
STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...
STRIPE_PRICE_PERSONAL_MONTHLY=...
STRIPE_PRICE_PERSONAL_YEARLY=...
STRIPE_PRICE_PRO_MONTHLY=...
STRIPE_PRICE_PRO_YEARLY=...
STRIPE_PRICE_TEAM_MONTHLY=...
STRIPE_PRICE_TEAM_YEARLY=...
BILLING_SUCCESS_URL=https://...
BILLING_CANCEL_URL=https://...
```

Default:

- `APP_MODE=self-hosted`
- `BILLING_PROVIDER=none`

## Plan Limits

Create `src/billing/plans.ts`.

Use code constants first, not database rows.

```ts
export type PlanCode = "free" | "personal" | "pro" | "team" | "business";
export type SubscriptionStatus =
  | "free"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete";

export interface PlanLimits {
  aliases: number;
  users: number;
  chats: number;
  allowRules: number;
  deliveredEmailsMonth: number;
  egressBytesMonth: number;
  storageBytes: number;
  maxMessageBytes: number;
  retentionDays: number;
  customDomains: number;
}
```

Initial limits:

- `free`: 3 aliases, 1 user, 1 chat, 10 allow rules, 100 emails/month, 1 GB
  egress, 100 MB storage, 5 MB message size, 7 days retention, 0 custom
  domains
- `personal`: 10 aliases, 1 user, 3 chats, 50 allow rules, 1,000 emails/month,
  10 GB egress, 1 GB storage, 10 MB message size, 30 days retention, 0 custom
  domains
- `pro`: 50 aliases, 3 users, 10 chats, 500 allow rules, 10,000 emails/month,
  100 GB egress, 10 GB storage, 25 MB message size, 90 days retention, 0
  custom domains
- `team`: 200 aliases, 10 users, 50 chats, 2,000 allow rules, 100,000
  emails/month, 500 GB egress, 50 GB storage, 25 MB message size, 180 days
  retention, 3 custom domains
- `business`: handled manually, default to high limits from env/admin override
  later

Quota reset default:

- v1 uses calendar UTC months for `deliveredEmailsMonth` and `egressBytesMonth`
- if billing-period-based reset is desired later, it must be implemented
  explicitly and reflected in product UX

## Database Changes

Add migration `drizzle/0009_harsh_mordo.sql` and update `src/db/schema.ts`.

### `organizations`

Columns:

- `id uuid primary key default gen_random_uuid()`
- `name varchar(255) not null`
- `plan_code varchar(32) not null default 'free'`
- `subscription_status varchar(32) not null default 'free'`
- `stripe_customer_id varchar(255)`
- `stripe_subscription_id varchar(255)`
- `trial_ends_at timestamp with time zone`
- `current_period_start timestamp with time zone`
- `current_period_end timestamp with time zone`
- `created_at timestamp with time zone not null default now()`
- `updated_at timestamp with time zone not null default now()`

Indexes:

- unique nullable index on `stripe_customer_id`
- unique nullable index on `stripe_subscription_id`

### `organization_members`

Columns:

- `organization_id uuid not null references organizations(id) on delete cascade`
- `user_id bigint not null references users(id) on delete cascade`
- `role varchar(20) not null`
- `created_at timestamp with time zone not null default now()`

Constraints:

- primary key `(organization_id, user_id)`
- role check: `owner`, `admin`, `member`

### Existing Table Changes

Add to `email_addresses`:

- `organization_id uuid references organizations(id)`
- `domain_id uuid not null references inbound_domains(id)` after backfill

Replace the global unique alias constraint:

- current: unique `local_part`
- hosted target: unique `(domain_id, local_part)`
- migration safety: create a default domain row, backfill every existing alias to
  it, then make `domain_id` non-null before dropping the old global
  `local_part` unique index
- temporary transition alternative: keep the existing `local_part` unique index
  until `domain_id` is fully backfilled; do not rely on a nullable composite
  unique index because Postgres permits duplicate rows when part of the key is
  `NULL`

Add to `chats`:

- `organization_id uuid references organizations(id)`

Add to `delivery_logs`:

- `organization_id uuid references organizations(id)`
- `billable boolean not null default true`

Add to `users`:

- keep `is_allowed` for self-hosted compatibility
- do not use it as hosted authorization source

### `inbound_domains`

Add `inbound_domains` before custom-domain work becomes user-facing:

- `id uuid primary key default gen_random_uuid()`
- `organization_id uuid references organizations(id) on delete cascade`
- `domain varchar(255) not null`
- `kind varchar(20) not null`
- `status varchar(20) not null default 'active'`
- `verification_token varchar(255)`
- `verified_at timestamp with time zone`
- `created_at timestamp with time zone not null default now()`
- `updated_at timestamp with time zone not null default now()`

Constraints and indexes:

- unique `domain`
- check `kind in ('shared', 'custom')`
- check `status in ('active', 'pending', 'disabled')`
- index `(organization_id, status)`
- check shared ownership: `kind='shared'` requires `organization_id is null`
- check custom ownership: `kind='custom'` requires `organization_id is not null`

Inbound routing must resolve aliases by recipient domain plus local part, not by
local part alone. The Cloudflare Worker must pass both values to the VPS:

- `X-Local-Part`
- `X-Recipient-Domain`

Preflight must also include `recipientDomain` in its JSON body. Until custom
domains are implemented, create one platform-owned shared `inbound_domains` row
with `organization_id = null` for the hosted domain and assign all hosted aliases
to that domain. Alias ownership still comes from `email_addresses.organization_id`;
domain ownership only describes whether the domain is platform-shared or
customer-owned.

### Usage Table

Add `organization_usage_months`:

- `organization_id uuid not null references organizations(id) on delete cascade`
- `month varchar(7) not null` like `2026-04`
- `delivered_count integer not null default 0`
- `rejected_count integer not null default 0`
- `created_at timestamp with time zone not null default now()`
- `updated_at timestamp with time zone not null default now()`
- primary key `(organization_id, month)`

Use this for monthly email quotas only.

Extend this table with:

- `egress_bytes bigint not null default 0`

Do not leave attachment and privacy-view bandwidth unbounded in hosted mode.

Add `organization_storage_usage` for current storage quotas:

- `organization_id uuid primary key references organizations(id) on delete cascade`
- `raw_email_bytes bigint not null default 0`
- `attachment_bytes bigint not null default 0`
- `updated_at timestamp with time zone not null default now()`

Storage writes must increment this table in the same logical flow that persists
raw emails and attachments. Cleanup/deletion must decrement it. Add a
reconciliation job or admin command that recalculates current bytes from
`delivery_logs` and `attachments` for repair after interrupted writes.

## Repository Modules

Add:

- `src/db/repos/organizations.ts`
- `src/db/repos/organizationMembers.ts`
- `src/db/repos/usage.ts`
- `src/db/repos/inboundDomains.ts`
- `src/db/repos/storageUsage.ts`
- `src/billing/plans.ts`
- `src/billing/limits.ts`
- `src/billing/stripe.ts`
- `src/billing/webhooks.ts`
- `src/billing/customerPortal.ts`
- `src/billing/checkout.ts`
- `src/tenant/currentOrganization.ts`

Core functions:

```ts
getOrCreatePersonalOrganization(db, user): Promise<Organization>
getUserOrganizations(db, userId): Promise<Organization[]>
getPrimaryOrganizationForUser(db, userId): Promise<Organization>
assertOrgRole(db, orgId, userId, roles): Promise<boolean>
getEffectivePlan(org): PlanDefinition
getCurrentUsage(db, orgId, month): Promise<Usage>
getCurrentStorageUsage(db, orgId): Promise<StorageUsage>
checkAliasCreateLimit(db, orgId): Promise<LimitResult>
checkAllowRuleCreateLimit(db, orgId): Promise<LimitResult>
checkInboundLimit(db, orgId, rawSizeBytes?): Promise<LimitResult>
incrementDeliveredUsage(db, orgId, bytes): Promise<void>
incrementRejectedUsage(db, orgId, reason): Promise<void>
incrementStorageUsage(db, orgId, rawBytes, attachmentBytes): Promise<void>
decrementStorageUsage(db, orgId, rawBytes, attachmentBytes): Promise<void>
```

The old `incrementDeliveredUsage(db, orgId, bytes)` name is misleading because
monthly delivered usage and storage are separate concerns. Keep usage count and
storage accounting as separate APIs.

`LimitResult`:

```ts
type LimitResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "subscription_inactive"
        | "alias_limit"
        | "allow_rule_limit"
        | "monthly_email_limit"
        | "storage_limit"
        | "message_size_limit";
      limit?: number;
      used?: number;
    };
```

## Authorization Changes

### Self-Hosted Mode

Keep current `authMiddleware` behavior:

- upsert Telegram user
- require `users.isAllowed`
- `INITIAL_ALLOWED_USERS` continues to bootstrap operators

### Hosted Mode

Change `authMiddleware`:

- upsert Telegram user
- if no organization exists, create personal org with free plan
- add user as `owner`
- allow request to continue

Do not require `.env` user allow list in hosted mode.

Add helper:

```ts
isHostedMode(config): boolean
```

Bot command handlers should resolve an active organization before listing chats,
creating aliases, or managing billing.

## Telegram UX Changes

Add commands:

- `/billing`
- `/plan`
- `/usage`
- `/upgrade`
- `/portal`

Usage output must distinguish:

- accepted/billable emails
- delivered-to-Telegram emails
- delivery failures after acceptance
- rejected emails
- storage usage
- egress usage if enabled

### `/billing`

Shows:

- current organization
- plan
- subscription status
- current monthly usage
- alias count
- storage estimate
- buttons: Upgrade, Manage Billing

### `/upgrade`

Shows plan buttons:

- Personal monthly/yearly
- Pro monthly/yearly
- Team monthly/yearly

Each button calls backend route to create Stripe Checkout Session and returns a
URL button.

### `/portal`

Creates Stripe Billing Portal session for existing paying customers.

If no Stripe customer exists, show upgrade options instead.

### Existing Menus

Add plan/usage hints only where useful:

- chat selection footer: `Plan: Free | 2/3 aliases used`
- alias creation failure: clear upgrade prompt when alias cap is reached
- allow-rule creation failure: clear upgrade prompt when cap is reached

Avoid making every screen sales-heavy.

### Domain-Aware Alias Management

Update command parsing and repo lookups so alias management is unambiguous after
custom domains:

- Prefer full addresses in user-facing command examples:
  `/allow add alerts@example.com github.com`.
- Continue accepting local parts only when the current organization has exactly
  one matching alias across all accessible domains.
- If a local part matches multiple domains, reply with an inline selection menu
  instead of choosing arbitrarily.
- Replace `findAliasByLocalPart` command paths with domain-aware helpers:
  `findAliasByAddress`, `findAliasesByLocalPartForOrganization`, and
  `findAliasByLocalPartAndDomain`.
- Keep callback flows UUID-based where possible; existing alias-detail menus
  already avoid ambiguity because callbacks use alias IDs.
- Display full address in alias lists when an organization has more than one
  active domain.

## HTTP Routes

Add route group under `src/http/routes/billing.ts`.

Register from `src/http/routes/index.ts`.

### `POST /billing/checkout`

Input:

```json
{
  "organizationId": "uuid",
  "priceKey": "personal_monthly"
}
```

Auth:

- v1 can be Telegram deep-link token based, generated from bot callback
- route must verify signed token containing `telegramUserId`, `organizationId`,
  and expiry
- user must be org owner/admin
- route must have per-user rate limiting to avoid noisy session creation and
  Stripe abuse

Output:

```json
{ "url": "https://checkout.stripe.com/..." }
```

### `POST /billing/portal`

Input:

```json
{
  "organizationId": "uuid"
}
```

Same auth as checkout.

Output:

```json
{ "url": "https://billing.stripe.com/..." }
```

### `POST /billing/stripe/webhook`

Requirements:

- use raw body
- verify Stripe signature
- handle idempotently
- return 2xx after successful processing

Handle events:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_succeeded`
- `invoice.payment_failed`

Map Stripe price IDs to plan codes through config.

Add explicit tests for:

- out-of-order webhook delivery
- duplicate webhook delivery
- Stripe price ID not mapped to a known plan
- `incomplete_expired` and `past_due` handling
- manual `business` plan orgs not being overwritten accidentally by unrelated
  Stripe events

## Billing State Rules

Subscription state mapping:

- `free`: internal app-only state, never written directly from Stripe event type
  mapping
- `trialing` or `active`: paid limits apply
- `past_due`: paid limits remain only for an explicitly defined grace policy;
  avoid relying only on `current_period_end` without tests
- `canceled`, `unpaid`, `incomplete`, `incomplete_expired`: free limits apply
- missing subscription: free limits apply
- `business`: manual admin-only plan; Stripe webhook must not overwrite unless
  subscription is linked

Follow-up recommendation:

- if Stripe grace handling becomes hard to reason about, add explicit
  `paid_through_at` semantics derived from successful billing events rather than
  inferring grace only from `current_period_end`

Downgrade behavior:

- Do not delete aliases or data automatically.
- Existing aliases over the free limit become paused logically for inbound
  delivery.
- Management UI should say: plan is over limit, delete aliases or upgrade.
- Inbound preflight rejects over-limit aliases before raw upload.

Hosted rejection behavior must be documented clearly:

- paused/over-limit hosted aliases should produce generic permanent rejection
  behavior at the worker boundary in v1
- internal logs and UI may show exact reason, but SMTP-side behavior should not
  leak account state

## Inbound Email Enforcement

### Preflight Route

Update `src/http/routes/preflight.ts`.

Preflight sequence:

1. Resolve alias by `(recipientDomain, localPart)`, falling back to configured
   `MAIL_DOMAIN` only in self-hosted mode.
2. Reject inactive/deleted alias as today.
3. Resolve `alias.organizationId`.
4. Load organization and plan.
5. Check subscription active enough.
6. Check monthly delivered email quota.
7. Check per-alias hourly cap as today.
8. Check allow rule as today.
9. Return `{ accept: false }` if any check fails.

Rejected reasons should be logged internally, but Cloudflare should still
receive generic reject response to avoid leaking account state.

### Raw Route

Update `src/http/routes/raw.ts`.

Before writing raw email:

1. Set Fastify global/raw route body limits to the maximum allowed hosted plan
   size, currently 25 MiB, so the handler can inspect alias and plan before
   rejecting lower-tier users.
2. Keep self-hosted deployments on `MAX_SIZE_BYTES` unless `APP_MODE=hosted`.
3. Resolve alias by `(recipientDomain, localPart)`.
4. Resolve organization and plan.
5. Check raw body byte length against plan `maxMessageBytes`.
6. Check current storage quota from `organization_storage_usage`.
7. Reject with `413` for message size over limit.
8. Reject with `402` or `403` for inactive subscription/storage quota.

This requires changing `src/http/server.ts` or route registration so hosted mode
uses a body limit equal to the largest plan-supported inbound message. If the
Fastify parser rejects at 10 MiB before route logic runs, Pro/Team 25 MiB limits
will not work.

Old local-part-only behavior:

1. Self-hosted mode may continue resolving by `localPart` while there is only
   one configured `MAIL_DOMAIN`.
2. Self-hosted mode skips organization and plan checks when billing is disabled.
3. Any hosted/custom-domain path must use recipient domain.

Important: Cloudflare Worker currently treats only `413` as permanent raw upload
failure. Update Worker logic so `402` and `403` are also permanent rejects with
generic SMTP rejection.

### Pipeline

Update `queueInboundEmail` and delivery log creation:

- pass `organizationId`
- pass `recipientDomain` / `domainId`
- store `organizationId` on delivery log
- increment usage only after a delivery is accepted into durable processing
- increment current storage usage after raw email and attachments are persisted
- for failed Telegram delivery, still count as delivered/processed email because
  infrastructure was used

Because this is customer-sensitive, `/usage` must surface delivery failures
separately from accepted/billable emails.

## Storage And Retention

Current cleanup uses global retention config. Hosted mode needs plan-aware
retention.

v1 approach:

- Keep global raw/attachment cleanup as an upper bound.
- Add plan-aware deletion by joining `delivery_logs.organization_id` to
  organization plan.
- Delete raw email and attachments older than effective plan retention.
- Decrement `organization_storage_usage` when files/rows are removed.
- Free plan: 7 days.
- Paid plans: 30/90/180 days.

Add tests around free vs paid retention cleanup and storage usage decrementing.

Hosted v1 must also include:

- delete-organization path that removes hosted aliases, memberships, raw emails,
  attachments, and organization-linked usage data
- basic export path for organization metadata, aliases, and delivery-log summary
- hosted-only operator CLI commands for export and deletion:
  `--hosted-export-organization <organizationId> --hosted-export-output <path>`
  and `--hosted-delete-organization <organizationId>`
- documented erasure SLA and operator runbook for hosted users

## Stripe Integration Details

Use official Stripe SDK.

Add dependency:

```bash
npm install stripe
```

Do not initialize Stripe unless `BILLING_PROVIDER=stripe`.

`src/billing/stripe.ts` exports:

```ts
getStripeClient(config): Stripe
createCheckoutSession(input): Promise<string>
createPortalSession(input): Promise<string>
constructWebhookEvent(rawBody, signature): Stripe.Event
```

Checkout metadata:

```json
{
  "organizationId": "uuid",
  "planCode": "pro",
  "billingInterval": "monthly"
}
```

Stripe customer metadata:

```json
{
  "organizationId": "uuid"
}
```

Subscription metadata should also include `organizationId`.

## Security Requirements

- Stripe webhook route must verify signature against `STRIPE_WEBHOOK_SECRET`.
- Checkout/portal route tokens must be HMAC-signed and short-lived.
- Never trust `organizationId` from the client without checking user membership.
- Never expose Stripe secret keys in bot messages or logs.
- Log webhook event IDs and ignore duplicate processed events.
- Hosted onboarding and alias creation must be rate-limited and abuse-monitored.
- Shared hosted domain must have sender/domain block controls and operational
  suspension workflow.
- Add `billing_webhook_events` table:
  - `event_id varchar(255) primary key`
  - `event_type varchar(255) not null`
  - `processed_at timestamp with time zone not null default now()`

## Abuse And Deliverability Requirements

Before public hosted launch:

- define acceptable-use / abuse policy
- add Telegram-user and edge-level throttles for hosted onboarding
- add per-alias / per-domain deny controls for abuse response
- define shared-domain reputation monitoring and emergency disable flow
- decide whether free hosted signup needs extra proof-of-human friction at the
  edge layer

Shared-domain reputation is a launch-blocking operational risk, not a later
polish item.

The operational baseline is captured in
[`hosted-abuse-policy.md`](./hosted-abuse-policy.md). Keep it updated when abuse
controls, retention behavior, or billing cancellation policy changes.

## Migration Strategy

1. Add nullable `organization_id` to existing tables.
2. Create a default organization for existing self-hosted data only when running
   an explicit backfill command.
3. For hosted fresh deploys, all new aliases/chats get `organization_id`.
4. After hosted mode is stable, consider making `organization_id` non-null for
   hosted-only deployments.
5. Do not force self-hosted users to migrate immediately.

Add CLI flag:

```bash
--backfill-default-organization
```

Backfill behavior:

- Create organization named `Default`
- Add all `isAllowed=true` users as owners/admins
- Create a default `inbound_domains` row from `MAIL_DOMAIN`
- Attach existing aliases/chats/logs to default org
- Backfill every existing alias with the default `domain_id`
- Only after backfill, make `email_addresses.domain_id` non-null and replace the
  old `local_part` unique index with `unique(domain_id, local_part)`

## Testing Plan

### Unit Tests

Add tests for:

- plan limit constants
- hosted auth auto-creates org
- self-hosted auth still requires `isAllowed`
- alias creation rejects over alias cap
- allow-rule creation rejects over rule cap
- preflight rejects inactive subscription
- preflight rejects monthly quota exceeded
- raw route rejects message over plan size
- Stripe webhook maps subscription status correctly
- duplicate Stripe webhook event is ignored
- checkout route requires owner/admin membership
- portal route requires existing Stripe customer
- business/manual plan webhook precedence is preserved
- egress limit enforcement is correct if enabled in v1

### Integration Tests

Add tests for:

- free hosted user starts bot, creates first alias
- free hosted user cannot create fourth alias
- paid webhook upgrades organization to Pro
- Pro limits apply immediately after webhook
- canceled subscription falls back to free limits without deleting aliases
- over-limit alias is rejected at preflight
- out-of-order Stripe webhook delivery converges to correct org state

### Early E2E Slice

Do not wait until the end of the monetization rollout to add end-to-end tests.
Add a small hosted-ingestion E2E harness immediately after inbound quota and
storage enforcement are in place.

Initial E2E scope:

- boot app in hosted mode against test Postgres
- exercise Cloudflare worker preflight -> raw upload -> VPS ingest path
- stub Telegram send at the API boundary
- assert final HTTP responses, DB usage counters, and delivery-log state
- cover one accepted hosted message and one permanently rejected hosted message

Reasoning:

- quota and storage work changes cross worker, HTTP, DB, and async pipeline code
- unit and integration tests catch local regressions, but not contract drift
  between worker and VPS
- adding this harness before later Stripe/domain work reduces the chance of
  building new features on top of a broken hosted-ingestion path

### Manual Acceptance

Run:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Manual Stripe test mode flow:

1. Start app in hosted mode.
2. Start Telegram bot as new user.
3. Verify org is created.
4. Run `/billing`.
5. Start checkout.
6. Pay with Stripe test card.
7. Confirm webhook updates org to paid plan.
8. Create aliases up to paid limit.
9. Cancel subscription in Stripe.
10. Confirm limits fall back after webhook.

## File-Level Implementation Order

1. Save docs:
   - `docs/monetization/business-plan.md`
   - `docs/monetization/technical-plan.md`
2. Config:
   - update `src/config.ts`
   - add billing env parsing
   - add tests in `tests/unit/config/config.test.ts`
3. Schema and migrations:
   - update `src/db/schema.ts`
   - add migration `drizzle/0009_harsh_mordo.sql`
   - add repo modules
4. Plans and limits:
   - add `src/billing/plans.ts`
   - add `src/billing/limits.ts`
   - add unit tests
5. Hosted auth:
   - update `src/telegram/middleware/auth.ts`
   - add tenant resolution helpers
   - preserve self-hosted behavior
6. Alias/chat ownership:
   - update alias and chat create/list repos to carry `organizationId`
   - update commands/menus to use current org
7. Inbound enforcement:
   - update `preflight.ts`
   - update `raw.ts`
   - update Cloudflare Worker permanent reject handling
   - update pipeline delivery log writes
8. Early hosted-ingestion E2E:
   - add one accepted hosted ingest path
   - add one permanently rejected hosted ingest path
   - wire into CI as a targeted test step if runtime stays reasonable
9. Stripe:
   - install `stripe`
   - add billing routes
   - add webhook processing
   - add idempotency table/repo
10. Telegram billing UX:

- add `/billing`, `/plan`, `/usage`, `/upgrade`, `/portal`
- add minimal menu buttons

11. Cleanup/retention + data lifecycle:

- add plan-aware retention logic
- test free vs paid cleanup
- add delete-org and basic export path
- add hosted-only operator commands and runbook for export/erasure requests

12. Final verification:

- full test/typecheck/lint/build
- manual Stripe test mode walkthrough

## Rollout Plan

### Stage 1: Internal Hosted Mode

- Deploy with `APP_MODE=hosted`
- Billing disabled or Stripe test mode
- Only your own Telegram account
- Confirm onboarding, aliases, preflight, raw delivery

### Stage 2: Private Beta

- Stripe test mode first, then live mode
- 5-10 trusted users
- Free + Personal + Pro only
- Collect support issues before Team plan

### Stage 3: Public Launch

- Enable live Stripe
- Publish pricing page
- Keep GitHub repo self-hosted instructions intact
- Add hosted setup docs
- Add abuse policy, terms, privacy policy

## Explicit Defaults

- Hosted SaaS is the first monetization path.
- Stripe is the first billing provider.
- Self-hosted remains free and MIT.
- Free hosted users are auto-created on `/start`.
- Billing is organization-based, not per-alias or per-seat in v1.
- Over-limit data is not deleted automatically.
- Inbound rejection happens as early as possible, preferably at preflight.
- Custom domains are planned for Team in the initial paid launch unless
  verification automation is implemented earlier.
