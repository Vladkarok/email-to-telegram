# Manual Paid Customers Technical Spec

This spec describes how to support paid hosted customers without Stripe or any
automated payment provider. It is intended for the early stage where customers
contact the operator directly, pay manually, and the operator grants a hosted
plan from a safe CLI command.

The goal is to keep the Stripe foundation available while allowing:

- one paid person to be upgraded manually
- one organization/workspace to be upgraded manually
- payment-provider-free operation with `BILLING_PROVIDER=none`
- a later migration to Stripe, Lemon Squeezy, Paddle, or another provider

## Product Decision

Manual paid access is an operator-managed hosted entitlement, not a separate
end-user billing system.

The current app model is organization-based:

- users are Telegram users
- organizations own aliases, chats, usage, storage, and billing state
- organization members connect users to organizations
- plan limits apply to organizations

Therefore, a "single paid person" should be implemented as:

1. identify the Telegram user
2. find or create that user's hosted organization
3. ensure the user is an `owner` of that organization
4. set the organization plan to `personal`, `pro`, `team`, or `business`

Do not add a second user-level subscription model. It would create confusing
rules when a user belongs to multiple organizations and would fight the existing
quota/enforcement paths.

## Initial Payment Flow

Manual flow:

1. Customer contacts the operator.
2. Operator quotes a plan and term.
3. Customer pays through a manual channel:
   - Wise invoice/payment request/bank transfer
   - PayPal invoice/payment link
   - other documented manual transfer
4. Operator records the payment outside the app.
5. Operator runs a hosted-only CLI command to grant the plan.
6. Customer uses hosted features immediately.

Do not ask customers to pay by receiving the operator's virtual card number.
Use an invoice, payment request, bank transfer details, or payment link instead.

## Supported Manual Plans

Manual activation should support all plan codes:

- `personal`
- `pro`
- `team`
- `business`

`free` should be supported only for downgrading/removing manual entitlement.

Recommended initial public offer:

- sell `personal` and `pro` manually
- keep `team` and `business` manual/approval-only until member invites and
  custom-domain self-service are implemented

## Required Operator Commands

Add hosted-only startup operations.

### Grant Plan To Existing Organization

```bash
APP_MODE=hosted npm start -- \
  --hosted-set-organization-plan <organizationId> \
  --plan pro \
  --status active \
  --paid-through 2026-05-30 \
  --manual-payment-reference wise-2026-04-001 \
  --note "Manual Wise payment for Pro monthly"
```

Behavior:

- requires `APP_MODE=hosted`
- runs migrations before mutation, like current hosted lifecycle commands
- verifies `organizationId` exists
- verifies `plan` is one of `free`, `personal`, `pro`, `team`, `business`
- verifies `status` is one of `free`, `active`, `canceled`
- when plan is paid and status is `active`, sets:
  - `organizations.plan_code`
  - `organizations.subscription_status = active`
  - `organizations.paid_through_at`
  - clears Stripe subscription/customer IDs by default
- when plan is `free`, sets:
  - `organizations.plan_code = free`
  - `organizations.subscription_status = free`
  - clears manual entitlement fields
- if an operator intentionally wants to keep Stripe links for a migration or
  reconciliation workflow, require an explicit `--keep-stripe-link` flag and
  record that choice in the manual billing event note
- writes a JSON summary to stdout
- writes operational logs to stderr
- exits non-zero if validation fails

### Grant Plan To A Single Telegram User

```bash
APP_MODE=hosted npm start -- \
  --hosted-set-user-plan <telegramUserId> \
  --plan personal \
  --status active \
  --paid-through 2026-05-30 \
  --manual-payment-reference wise-2026-04-002 \
  --note "Manual Personal monthly"
```

Behavior:

- requires `APP_MODE=hosted`
- finds owner/admin organizations for the user
- if exactly one owner/admin organization exists and `--organization-id` is not
  provided, applies the plan to that organization
- if multiple owner/admin organizations exist and `--organization-id` is not
  provided, refuses to proceed and prints the candidate organization IDs
- if `--organization-id` is provided, verifies the user is already an owner/admin
  of that organization before applying the plan
- if none exists, creates:
  - user row with `id = telegramUserId`
  - organization named `Telegram <telegramUserId>`
  - organization member row with role `owner`
  - shared inbound domain remains the default hosted domain path
- applies the same manual plan update as the organization command
- outputs both `telegramUserId` and `organizationId`

This is the command the operator should use for "add this one person to a paid
plan."

### Add Person To Existing Paid Organization

This should be separate from paid-plan activation:

```bash
APP_MODE=hosted npm start -- \
  --hosted-add-organization-member <organizationId> \
  --telegram-user-id <telegramUserId> \
  --role member
```

Behavior:

- requires `APP_MODE=hosted`
- validates role is `owner`, `admin`, or `member`
- upserts user row
- upserts organization member row
- does not change billing state

This should be implemented after or alongside manual plan activation if manual
Team/Business onboarding is needed.

## Schema Changes

The current `organizations` table can already represent manual paid state by
using:

- `plan_code`
- `subscription_status`
- `paid_through_at`

However, manual operation needs auditability. Add a small table:

```sql
create table manual_billing_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  telegram_user_id bigint,
  plan_code varchar(32) not null,
  subscription_status varchar(32) not null,
  paid_through_at timestamp with time zone,
  payment_reference varchar(255),
  note varchar(1000),
  kept_stripe_link boolean not null default false,
  operator_source varchar(64) not null default 'cli',
  created_at timestamp with time zone not null default now()
);

create index idx_manual_billing_events_org_created
  on manual_billing_events(organization_id, created_at desc);
```

Reason:

- operators need to know why an org is paid
- manual payments need a reference
- later migration to Stripe/MoR needs a clear history
- support/debugging should not rely on shell history

Do not store sensitive payment data. Store only external references such as
invoice ID, Wise transfer reference, PayPal transaction ID, or a short note.
Limit `note` to operational context, not payment secrets or private support
transcripts.

## Repository/API Additions

Add:

- `src/db/repos/manualBillingEvents.ts`
  - `createManualBillingEvent(db, data)`
  - `listManualBillingEventsForOrganization(db, organizationId)`
- `src/billing/manual.ts`
  - `grantManualOrganizationPlan(db, input)`
  - `grantManualUserPlan(db, input)`
  - `addManualOrganizationMember(db, input)`
- `src/startup/hostedManualBilling.ts`
  - hosted-mode guard
  - CLI result formatting
  - exit-code helpers

Implementation should reuse:

- `updateOrganizationBillingState`
- `findOrganizationById`
- `createOrganization`
- `addOrganizationMember`
- existing user repo upsert helper
- existing plan definitions and plan-code validation

## CLI Parsing

Extend `StartupOptions` with:

```ts
hostedSetOrganizationPlanId: string | null;
hostedSetUserPlanTelegramUserId: string | null;
hostedAddOrganizationMemberId: string | null;
manualPlanCode: PlanCode | null;
manualSubscriptionStatus: "free" | "active" | "canceled" | null;
manualPaidThrough: string | null;
manualPaymentReference: string | null;
manualNote: string | null;
manualTelegramUserId: string | null;
manualOrganizationRole: "owner" | "admin" | "member" | null;
manualKeepStripeLink: boolean;
```

Only one startup operation may run at a time. The operation flags are:

- `--hosted-set-organization-plan`
- `--hosted-set-user-plan`
- `--hosted-add-organization-member`

Validation rules:

- paid plans require `--status active` or default to `active`
- paid plans require `--paid-through` unless `--plan business`
- `--paid-through` must parse to a valid future UTC date
- `--plan free` must use `--status free`
- `--hosted-set-user-plan` may accept `--organization-id` to disambiguate an
  existing owner/admin organization
- manual grants clear Stripe links unless `--keep-stripe-link` is supplied
- `--manual-payment-reference` should be optional but recommended
- member command requires `--telegram-user-id` and `--role`
- all manual commands require hosted mode before DB mutation

## Effective Limits Behavior

Manual active paid plans should use the existing limits logic:

- `subscription_status = active` gives paid plan limits
- `plan_code = business` gives business limits regardless of status
- `plan_code = free` gives free limits

Expiry behavior needs one explicit decision.

Recommended v1 behavior:

- manual paid plans do not auto-expire in the first implementation
- `paid_through_at` is informational and displayed/exported
- operator manually downgrades unpaid customers to `free`

Reason: automatic expiry needs scheduled enforcement, customer messaging, and
grace policy. Manual billing is intentionally low volume.

Recommended v1.1:

- add a daily manual billing expiry job
- when `paid_through_at < now`, set `subscription_status = canceled`
- effective plan falls back to free
- emit an operator log/report

## Telegram UX

Existing `/billing`, `/plan`, and `/usage` can remain mostly unchanged.

Add later, not required for v1:

- show "Manual billing" when `stripe_customer_id` is null but plan is paid
- show `paid_through_at` in `/billing`
- show latest manual payment reference only to owner/admin users if the operator
  decides it is safe to expose

Required for v1:

- `/portal` must detect `BILLING_PROVIDER=none` or a paid org without
  `stripe_customer_id`
- it must respond with a manual-billing support message instead of throwing a
  generic error or trying to open Stripe
- the message should tell the user to contact support for renewal, cancellation,
  or invoice questions

## Webhook Safety

Manual paid organizations must not be accidentally overwritten by unrelated
Stripe events.

Existing protection:

- business plan has explicit webhook overwrite protection
- Stripe events resolve organizations by Stripe customer/subscription IDs or
  metadata

Required v1 behavior:

- manual grants clear `stripe_customer_id` and `stripe_subscription_id` by
  default
- keeping Stripe links requires explicit `--keep-stripe-link`
- if `--keep-stripe-link` is used, webhook overwrite risk must be visible in the
  JSON output and audit record
- do not claim webhook safety for non-business manual plans while Stripe links
  remain attached

Add tests for:

- manual `personal`/`pro` org without Stripe IDs is not changed by unrelated
  webhook events
- manual grants clear stale Stripe links by default
- `--keep-stripe-link` preserves Stripe links and records the risk explicitly
- if a manual org later migrates to Stripe intentionally, checkout/webhook
  behavior is explicit and tested

## Manual Payment Records

Manual billing event fields:

- `organizationId`
- `telegramUserId` when the command was user-targeted
- `planCode`
- `subscriptionStatus`
- `paidThroughAt`
- `paymentReference`
- `note`
- `keptStripeLink`
- `createdAt`

Examples of safe `paymentReference`:

- `wise-2026-04-001`
- `paypal-invoice-INV2-ABCD`
- `bank-transfer-2026-04-30`

Do not store:

- card numbers
- bank account numbers beyond what is already in external invoice systems
- customer documents
- private chat transcripts

## Export, Erasure, And Privacy Scope

Manual billing events are hosted customer data. They are payment-adjacent even
when they do not contain sensitive payment details.

Implementation must update:

- `exportHostedOrganizationData` to include manual billing event summaries
- `deleteHostedOrganization` to delete manual billing events through
  organization cascade
- `docs/hosted/privacy-and-data-requests.md` to mention manual payment
  references and operator billing notes
- hosted export/erasure tests to cover manual billing records

Export shape should include:

```ts
manualBillingEvents: Array<{
  id: string;
  telegramUserId: string | null;
  planCode: string;
  subscriptionStatus: string;
  paidThroughAt: string | null;
  paymentReference: string | null;
  note: string | null;
  keptStripeLink: boolean;
  createdAt: string;
}>;
```

Do not include raw payment instrument details because they must never be stored.

## Tests

Unit tests:

- CLI parser accepts manual organization plan command
- CLI parser accepts manual user plan command
- CLI parser accepts add-member command
- parser rejects multiple operation flags
- parser rejects paid plan without valid paid-through date
- parser rejects `--plan free --status active`
- manual organization grant updates plan/status/paidThrough and records event
- missing organization returns non-zero/no mutation
- manual user grant creates user/org/member when needed
- manual user grant reuses a single unambiguous owner/admin org when present
- manual user grant refuses when multiple owner/admin orgs exist without
  explicit `--organization-id`
- add-member upserts user and membership without billing mutation
- manual billing events do not store sensitive fields
- hosted organization export includes manual billing event summaries

Integration-style tests:

- manual paid org receives paid limits immediately
- manual downgrade to free falls back to free limits without deleting aliases
- Stripe webhook does not overwrite unlinked manual org
- `/portal` behavior for manual paid org is documented or improved

## Security And Operational Requirements

- Commands must be hosted-only.
- Commands must not start bot polling or HTTP server.
- Logs must go to stderr for operator commands.
- JSON result must go to stdout.
- No command should accept arbitrary SQL-like values.
- Plan/status/role must be enum-validated before DB writes.
- Payment references and notes should be length-limited.
- The command output should include enough detail to paste into a private
  support log.

Example successful output:

```json
{
  "updated": true,
  "organizationId": "org-uuid",
  "telegramUserId": "123456789",
  "planCode": "pro",
  "subscriptionStatus": "active",
  "paidThroughAt": "2026-05-30T00:00:00.000Z",
  "manualBillingEventId": "event-uuid"
}
```

## Documentation Updates

Update:

- `docs/hosted/pricing-and-terms.md`
  - add "manual billing during beta" language
- `docs/hosted/launch-checklist.md`
  - add manual billing command checklist
- `docs/monetization/technical-plan.md`
  - add manual paid customer slice before final live Stripe rollout
- `docs/monetization/stripe-test-mode-runbook.md`
  - clarify Stripe can remain disabled while manual billing is used

## Rollout Plan

1. Add schema/repo for manual billing events.
2. Add pure manual billing service functions and tests.
3. Add CLI parsing for manual billing commands.
4. Wire commands into startup, hosted-only and one-shot.
5. Add docs and runbook examples.
6. Run full validation.
7. Review/merge.
8. Use manual billing for early customers while legal/payment setup is pending.

## Open Decisions

- Should manual paid plans auto-expire in v1 or remain operator-managed?
  Recommended: operator-managed in v1.
- Should `/portal` get a manual-billing-specific message in the first PR?
  Recommended: yes if small; otherwise document current behavior.
- Should manual `team`/`business` be allowed before member invites/custom domain
  self-service?
  Recommended: allow only as operator-managed/manual onboarding.
- Should payment references be required?
  Recommended: optional in code, required in operator runbook.
