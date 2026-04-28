# Monetization Plan For `email-to-telegram`

## Summary

Use a hosted SaaS model first: keep the current self-hosted MIT project free and
useful, then charge for the hosted version where the product provides
reliability, setup-free operation, backups, billing, support, and higher limits.

The strongest positioning is not email forwarding in general. It is:

> Email aliases for Telegram alerts, teams, bots, monitoring, and operational
> messages, without running mail infrastructure.

Do not monetize by blocking the current core feature. Monetize by removing pain:
Cloudflare setup, VPS setup, bot hosting, domain routing, backups, abuse
protection, payment admin, and support.

## Current Product Read

Existing repo already supports:

- Cloudflare Email Routing inbound layer
- Cloudflare Worker preflight
- VPS parser/storage/Telegram delivery
- Telegram bot alias management
- Per-alias allow rules
- Per-alias hourly delivery cap
- Privacy mode with browser reveal link
- Attachments with expiring download links
- Raw email and attachment retention
- Optional local storage encryption
- Health checks, backups, delivery logs, deduplication

Current limitation:

- Authorization is basically "user is allowed" or "user is not allowed"
- First users are bootstrapped from `.env`
- There is no billing, tenant model, plan model, quotas, owner/org model,
  customer portal, or hosted onboarding
- Cloudflare Email Routing has a 25 MiB message size limit
- Worker Free has limited request/CPU budget, so hosted plans should assume paid
  Workers infrastructure once usage grows

## Recommended Free / Paid Split

### Always Free

Keep these free forever in the open-source self-hosted edition:

- Self-hosting the full current app
- Creating aliases
- Adding allow rules
- Forwarding accepted emails to Telegram
- DM/group/forum topic delivery
- Basic attachment forwarding/download links
- Privacy mode
- Body deduplication
- Basic retention settings
- Docker Compose deployment
- Cloudflare Worker source
- Basic health checks
- Local storage encryption
- Community support through GitHub issues/discussions

Reason: these features prove the project is real. Removing them would make the
OSS version feel crippled and reduce trust.

### Free Hosted Tier

Offer a hosted free tier for adoption:

- 1 Telegram user
- 1 Telegram chat destination
- 3 aliases
- 10 allow rules total
- 100 delivered emails/month
- 1 GB attachment/privacy-view/download egress per month
- 5 MB max processed message size
- 7-day retention
- Attachments allowed, but capped at 100 MB stored total
- Shared hosted domain, for example `alias@inbox.yourproduct.com`
- Community support only

Purpose: let users experience value in 5 minutes without a VPS or Cloudflare.

### Paid Hosted Tiers

Personal: `$5/month` or `$48/year`

- 1 user
- 10 aliases
- 1,000 delivered emails/month
- 10 GB attachment/privacy-view/download egress per month
- 1 GB attachment/raw storage
- 30-day retention
- 10 MB message limit
- Shared hosted domain
- Email support

Use case: personal alerts, GitHub notifications, home lab, uptime tools.

Pro: `$12/month` or `$120/year`

- 3 users
- 50 aliases
- 10,000 delivered emails/month
- 100 GB attachment/privacy-view/download egress per month
- 10 GB storage
- 90-day retention
- 25 MB message limit, matching Cloudflare Email Routing ceiling
- Multiple Telegram chats/topics
- Delivery history/search
- Priority email support

Use case: small teams, indie products, ops notifications, agencies.

Team: `$29/month` or `$290/year`

- 10 users
- 200 aliases
- 100,000 delivered emails/month
- 500 GB attachment/privacy-view/download egress per month
- 50 GB storage
- 180-day retention
- Custom domain support
- Audit log
- Role-based access: owner/admin/member
- Per-alias usage analytics
- SSO later, not in v1
- Priority support

Use case: companies that depend on Telegram operational workflows.

Business: `$99/month+`

- Higher limits
- Custom egress/storage ceilings by contract
- Dedicated domain/onboarding help
- Custom retention
- SLA-style response target
- Dedicated deployment option
- Compliance/data-processing paperwork if needed
- Invoice billing

Use case: customers who care less about price and more about ownership,
reliability, and support.

## Add-Ons

Keep add-ons simple:

- Extra 10 GB storage: `$5/month`
- Extra 100,000 delivered emails/month: `$10/month`
- Extra 10 team users: `$10/month`
- Done-for-you custom domain setup: one-time `$49`
- Managed private deployment: from `$199/month`
- Setup/support call: `$99/hour`

Avoid usage billing in v1 unless necessary. Fixed tiers are easier to understand
and easier to sell.

## Launch Risks And Guardrails

Hosted email infrastructure is abuse-sensitive. Free signup and shared-domain
inbound cannot launch safely without operational guardrails.

Required before public launch:

- Rate-limit hosted onboarding and alias creation per Telegram user and per IP
  where available through the edge
- Maintain deny/block controls for abusive senders, recipient aliases, and
  hosted shared-domain patterns
- Publish acceptable-use / abuse policy
- Establish shared-domain reputation monitoring and fast suspension workflow
- Add monthly egress ceilings per plan for attachment/privacy-view/download
  traffic

The main risk is not only free-tier generosity. The main risk is shared-domain
reputation and unbounded egress/support cost if hosted signup is easy but
abuse handling is weak.

The working hosted abuse and deliverability policy lives in
[`hosted-abuse-policy.md`](./hosted-abuse-policy.md). Treat it as the operator
runbook until public legal/policy pages are drafted.

## Payment Recommendation

Use Stripe first if you are comfortable being the merchant and handling
tax/accounting with Stripe Tax or an accountant.

Why Stripe first:

- Fastest to integrate for SaaS subscriptions
- Checkout and Customer Portal reduce custom billing UI
- Stripe Billing supports subscriptions and customer self-management
- Official current Stripe Billing pay-as-you-go pricing is `0.7%` of billing
  volume, separate from payment processing
- Stripe has no standard setup/monthly hidden fees on standard pricing

Use Lemon Squeezy or Paddle if Merchant of Record simplicity becomes more
important than direct Stripe control, especially for global B2C/B2B customers.

Tradeoff:

- Lemon Squeezy: simpler for indie digital products, Merchant of Record, but
  higher effective fees. Current public pricing shows `5% + $0.50`, plus
  possible extras such as international, PayPal, and subscription fees.
- Paddle: stronger for SaaS Merchant of Record, tax, billing support, and global
  subscriptions; better once this is clearly a SaaS business.

Recommendation:

1. Start with Stripe Checkout + Stripe Billing + Stripe Customer Portal.
2. Add Stripe webhooks for subscription status.
3. If global VAT/sales tax becomes painful, migrate new customers to Paddle or
   Lemon Squeezy before scale makes migration painful.

The test-mode billing launch checklist lives in
[`stripe-test-mode-runbook.md`](./stripe-test-mode-runbook.md). Run it before
turning on live Stripe keys.

The hosted pricing and public terms draft lives in
[`../hosted/pricing-and-terms.md`](../hosted/pricing-and-terms.md). Its pricing
table is covered by a doc test against `src/billing/plans.ts`.

## Required Product Changes

### Data Model

Add:

- `organizations`
  - `id`
  - `name`
  - `plan`
  - `billing_customer_id`
  - `billing_subscription_id`
  - `subscription_status`
  - `trial_ends_at`
  - `created_at`
  - `updated_at`
- `organization_members`
  - `organization_id`
  - `telegram_user_id`
  - `role`: `owner | admin | member`
  - `created_at`
- `inbound_domains`
  - `id`
  - `organization_id`, nullable for platform-owned shared domains
  - `domain`
  - `kind`: `shared | custom`
  - `status`: `active | pending | disabled`
  - verification/routing metadata for custom domains
- `plan_limits`
  - Can be code constants first, not necessarily DB rows
- Add `organization_id` to:
  - users or memberships
  - email aliases
  - chats
  - delivery logs if needed for faster usage queries
- Add non-null `domain_id` or equivalent domain-aware recipient key to aliases so
  `alerts@customer-a.com` and `alerts@customer-b.com` can coexist
- Add usage tracking:
  - monthly delivered emails
  - monthly rejected emails
  - current storage bytes, not only monthly stored bytes
  - alias count
  - user count

### Authorization

Replace binary `users.isAllowed` as the main hosted business rule with:

- user can access an organization if they are an active member
- user can manage aliases if role is `owner` or `admin`
- member can view or receive depending on future permissions
- initial `.env` bootstrap remains only for self-hosted/admin recovery

### Plan Enforcement

Enforce limits at these points:

- Alias creation: block when alias count exceeds plan
- Allow rule creation: block when allow-rule cap exceeds plan
- Inbound preflight: reject if subscription inactive or monthly quota exceeded
- Raw upload: reject if message size exceeds plan
- Attachment write: reject or strip attachments if storage quota exceeded
- Retention cleanup: use plan retention value
- User invite/add: block when user cap exceeded

### Hosted Onboarding

Minimum hosted onboarding flow:

1. User starts Telegram bot.
2. Bot creates a personal organization.
3. User starts on free tier by default. No public free trial is assumed in v1
   unless explicitly added later.
4. User creates first alias.
5. System gives shared-domain address immediately.
6. Later, Team users can add custom domain.
7. Custom domain wizard shows Cloudflare DNS / Email Routing instructions.

## Feature Roadmap

### v1 Paid SaaS

Build only what is needed to charge honestly:

- Tenant/org model
- Stripe Checkout
- Stripe Customer Portal
- Subscription webhook handling
- Plan limits
- Usage counters
- Hosted shared domain
- Free tier
- Admin/ops controls for hosted abuse and shared-domain reputation
- Admin command/page to inspect customer status
- Terms, privacy policy, abuse policy
- Delete-organization and basic export path for hosted users

### v1.5 Retention And Trust

Add features that justify Pro/Team:

- Delivery history/search
- Per-alias usage dashboard
- Better failed-delivery diagnostics
- Export alias/delivery data
- Team member management
- Audit log for alias and allow-rule changes

### v2 Higher-Value Features

Add features that can support Team/Business pricing:

- Web dashboard beside Telegram bot
- Multiple custom domains per org
- Domain verification automation
- Inbound webhook destinations besides Telegram
- Spam/abuse scoring
- SSO/SAML for Business
- Dedicated deployment / private cloud option
- SLA and status page

## Packaging Rules

Do not charge for privacy/security basics in a way that feels hostile.

Good paid gates:

- Higher limits
- Team collaboration
- Custom domains
- Longer retention
- Search/history
- Hosted reliability
- Priority support
- Managed/private deployments

Bad paid gates:

- Basic allow rules
- Basic privacy mode
- Basic encryption
- Basic deletion
- Basic export
- Basic abuse protection

## Usage Semantics

The product should distinguish these counters clearly in hosted billing UX:

- accepted/billable emails
- delivered to Telegram successfully
- delivery failures after acceptance
- rejected before durable processing

This matters because infrastructure cost starts when an inbound email is
accepted into durable processing, even if final Telegram delivery later fails.
Billing can remain based on accepted processing in v1, but customer-facing usage
must show delivery failures separately.

Monthly hosted quotas should reset on a documented calendar UTC month boundary
in v1 unless billing-period-based reset is implemented explicitly. Do not leave
this ambiguous.

## Pricing Rationale

Start low enough for indie adoption, but not so low that payment fees and support
destroy margins.

Suggested public prices:

- Free: `$0`
- Personal: `$5/month`
- Pro: `$12/month`
- Team: `$29/month`
- Business: `$99/month+`

Annual discounts:

- Personal: `$48/year`
- Pro: `$120/year`
- Team: `$290/year`

Do not offer a `$1/month` plan. Fixed payment fees make tiny subscriptions
inefficient, and the product handles operational communication, which should
support at least `$5/month`.

## Acceptance Criteria

The monetization implementation is ready when:

- A new Telegram user can start the hosted bot and create aliases without `.env`
  edits
- A free user is limited by aliases, email volume, storage, and retention
- A free user is also limited by egress/download volume
- A paid user can subscribe through hosted checkout
- Stripe webhook updates plan state without manual action
- A canceled/failed subscription downgrades or disables paid-only capacity
  predictably
- Inbound email is rejected before expensive processing when quota/subscription
  checks fail
- Admin can see customer, plan, usage, and delivery health
- Self-hosted deployment still works without billing enabled

## Explicit Assumptions

- Chosen business shape: hosted SaaS first
- The existing MIT self-hosted project remains free
- The first monetized audience is technical individuals and small teams using
  Telegram for operational alerts
- The hosted service can use a shared domain initially
- Custom domains are Team+ in the initial paid launch because they create
  support and setup cost
- Stripe is the first payment provider unless tax/Merchant-of-Record complexity
  becomes the main blocker
- Legal/tax setup should be checked with a professional before public launch

## Policies To Define Before Public Launch

The pricing page and hosted terms should define:

- quota reset rule: calendar month vs billing-period reset
- cancellation / downgrade / proration behavior
- refund policy
- hosted data retention and deletion SLA
- hosted export scope
- abuse response / suspension policy
- whether Team/Business can hold multiple organizations per Telegram user

## Sources Checked

- Stripe Billing pricing: <https://stripe.com/billing/pricing>
- Stripe standard pricing FAQ: <https://stripe.com/pricing>
- Lemon Squeezy pricing and fees:
  <https://www.lemonsqueezy.com/pricing> and
  <https://docs.lemonsqueezy.com/help/getting-started/fees>
- Paddle pricing / Merchant of Record positioning:
  <https://www.paddle.com/pricing>
- Cloudflare Email Routing limits:
  <https://developers.cloudflare.com/email-routing/limits/>
- Cloudflare Workers pricing/limits:
  <https://developers.cloudflare.com/workers/platform/pricing/>
