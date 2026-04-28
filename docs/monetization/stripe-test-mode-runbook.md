# Stripe Test Mode Runbook

Use this before enabling live hosted billing. The goal is to prove checkout,
webhooks, quota changes, portal access, cancellation fallback, and self-hosted
isolation against Stripe test mode.

## Scope

This runbook validates the existing Stripe integration only:

- `/upgrade` creates Stripe Checkout Sessions
- `/portal` creates Stripe Customer Portal Sessions for linked customers
- `/billing/stripe/webhook` verifies signatures and processes subscription
  events idempotently
- paid limits apply after successful webhook delivery
- canceled or unpaid subscriptions fall back to free effective limits according
  to billing status rules

Do not use live Stripe keys while running this checklist.

## Prerequisites

Stripe dashboard:

- test-mode products and recurring prices for Personal monthly/yearly, Pro
  monthly/yearly, and Team monthly/yearly
- Customer Portal enabled in test mode
- local or staging webhook endpoint secret from Stripe CLI or dashboard

Application environment:

```bash
APP_MODE=hosted
BILLING_PROVIDER=stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PERSONAL_MONTHLY=price_...
STRIPE_PRICE_PERSONAL_YEARLY=price_...
STRIPE_PRICE_PRO_MONTHLY=price_...
STRIPE_PRICE_PRO_YEARLY=price_...
STRIPE_PRICE_TEAM_MONTHLY=price_...
STRIPE_PRICE_TEAM_YEARLY=price_...
BILLING_SUCCESS_URL=https://<public-base-url>/billing/success
BILLING_CANCEL_URL=https://<public-base-url>/billing/cancel
PUBLIC_BASE_URL=https://<public-base-url>
HOSTED_MAIL_DOMAIN=<hosted-mail-domain>
```

For local webhook testing, forward Stripe events to:

```bash
stripe listen --forward-to https://<public-base-url>/billing/stripe/webhook
```

Use the `whsec_...` value printed by that command as
`STRIPE_WEBHOOK_SECRET`.

## Checkout Upgrade Flow

1. Start the app in hosted mode with Stripe test keys.
2. In Telegram, run `/start` with a hosted test user.
3. Run `/plan` and confirm the organization starts on `free`.
4. Run `/usage` and confirm free limits are shown.
5. Run `/upgrade`.
6. Select a Personal or Pro monthly option.
7. Complete Checkout with Stripe test card `4242 4242 4242 4242`, any future
   expiry date, any CVC, and any postal code.
8. Confirm Stripe sends `checkout.session.completed`,
   `customer.subscription.created` or `customer.subscription.updated`, and
   `invoice.payment_succeeded`.
9. Run `/plan` and confirm the selected paid plan and active/trialing status.
10. Run `/usage` and confirm paid limits apply immediately.

Expected database state:

- `organizations.stripe_customer_id` is set
- `organizations.stripe_subscription_id` is set
- `organizations.plan_code` matches the selected Stripe price
- `organizations.subscription_status` is `active` or `trialing`
- `organizations.paid_through_at` is set after `invoice.payment_succeeded`
- `billing_webhook_events` contains one row per processed Stripe event ID

## Idempotency And Retry Flow

1. Replay the same webhook event from Stripe CLI or dashboard.
2. Confirm the webhook route returns success without duplicating side effects.
3. Confirm only one `billing_webhook_events.event_id` row exists for that event.

If a webhook write fails mid-transaction, retry the event. The transaction must
either process cleanly or leave the event unmarked so the retry can process it.

## Portal And Cancellation Flow

1. Run `/portal` from the same Telegram user.
2. Confirm the bot returns a Stripe Customer Portal link.
3. Open the portal and cancel the test subscription.
4. Confirm Stripe sends `customer.subscription.updated` or
   `customer.subscription.deleted`.
5. Run `/plan` and confirm the app reflects the canceled state.
6. Confirm effective limits fall back to free limits immediately for canceled
   subscriptions.
7. Confirm aliases and stored data are not deleted automatically.

## Failed Payment Flow

Use Stripe test payment methods that simulate failed payment behavior, or mark a
test subscription invoice unpaid from the Stripe dashboard.

Expected behavior:

- webhook processing maps Stripe status to `past_due`, `unpaid`,
  `incomplete`, or `incomplete_expired`
- paid effective limits remain for `past_due` only while the hard-coded
  7-day `paid_through_at` grace allows them
- `unpaid`, `incomplete`, and `incomplete_expired` fall back to free limits
  immediately
- inbound preflight/raw enforcement rejects over-limit traffic when the
  effective plan has fallen back to free
- `/billing` surfaces billing status, and `/usage` surfaces effective quotas
  and usage counters

## Manual Business Plan Guard

Before public launch, create one test organization with manual `business` plan
state and no linked Stripe subscription.

Verify:

- unrelated Stripe checkout or subscription webhooks do not overwrite the
  manual business plan
- if a business organization is intentionally linked to Stripe later, the
  subscription/customer IDs are explicit and traceable

## Self-Hosted Isolation Check

Run the app with:

```bash
APP_MODE=self-hosted
BILLING_PROVIDER=none
```

Confirm:

- no Stripe env vars are required
- `/billing`, `/upgrade`, `/plan`, `/usage`, and `/portal` do not expose hosted
  billing behavior
- existing self-hosted alias and delivery workflows still work

Also verify startup fails fast if `BILLING_PROVIDER=stripe` is configured
outside hosted mode.

## Launch Decision

Do not enable live billing until all checks pass in staging and the following
are reviewed:

- public pricing page matches `src/billing/plans.ts`
- refund, cancellation, annual subscription, and tax language are published
- hosted abuse policy and data request runbook are operational
- Stripe live products/prices match the test-mode plan mapping
- webhook endpoint uses the live `whsec_...` secret, not the CLI test secret
