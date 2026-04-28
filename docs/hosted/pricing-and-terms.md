# Hosted Pricing And Terms Draft

This is the public-facing draft for hosted `email-to-telegram` pricing and
commercial terms. It is an operator/product draft, not legal advice. Review the
final public version for tax, privacy, refund, and data-processing requirements
before accepting live payments.

## Positioning

Hosted `email-to-telegram` gives you email aliases that deliver operational
emails, alerts, and low-volume workflow messages to Telegram without running
mail infrastructure.

Self-hosting remains free and MIT-licensed. Paid hosted plans charge for managed
operation: hosted inbound routing, abuse controls, storage, retention, Stripe
billing, backups, and support.

## Plans

This table reflects the billing limit model in code. It is not automatically
publishable marketing copy. Before public launch, hide or qualify any capability
that does not yet have a customer-facing flow.

<!-- pricing-table:start -->

| Plan     |    Monthly |     Yearly | Users | Chats | Aliases | Allow rules | Emails/month | Egress/month | Storage | Message size | Retention | Custom domains |
| -------- | ---------: | ---------: | ----: | ----: | ------: | ----------: | -----------: | -----------: | ------: | -----------: | --------: | -------------: |
| Free     |         $0 |         $0 |     1 |     1 |       3 |          10 |          100 |         1 GB |  100 MB |         5 MB |    7 days |              0 |
| Personal |         $5 |        $48 |     1 |     3 |      10 |          50 |        1,000 |        10 GB |    1 GB |        10 MB |   30 days |              0 |
| Pro      |        $12 |       $120 |     3 |    10 |      50 |         500 |       10,000 |       100 GB |   10 GB |        25 MB |   90 days |              0 |
| Team     |        $29 |       $290 |    10 |    50 |     200 |       2,000 |      100,000 |       500 GB |   50 GB |        25 MB |  180 days |              3 |
| Business | Contact us | Contact us |   100 |   250 |   1,000 |      10,000 |    1,000,000 |     5,000 GB |  500 GB |        25 MB |  365 days |             25 |

<!-- pricing-table:end -->

All hosted plans include the shared hosted domain. The `Users` and
`Custom domains` columns are reserved plan limits until customer-facing member
invites and custom-domain verification/management are shipped. Do not advertise
multi-user collaboration or custom domains as self-serve public features before
those flows exist. Team and Business can still be offered manually when the
operator is willing to handle onboarding and support.

## Free Hosted Tier

The free hosted tier is for evaluation and small personal workflows. It may be
rate-limited, blocked, or disabled for abuse, spam, phishing, high-volume file
distribution, or shared-domain reputation risk.

There is no public free trial in v1. Users start on Free and can upgrade through
Stripe Checkout.

## Billing

- Prices are in USD.
- Personal, Pro, and Team are self-serve Stripe subscriptions.
- Business is manually priced and may use a separate agreement or invoice.
- Annual plans are billed upfront.
- Upgrades can apply after Stripe webhook delivery updates the organization.
- Downgrades and cancellations do not delete aliases or stored data
  automatically.

## Cancellation

Customers can cancel self-serve subscriptions through the Stripe Customer
Portal. When a subscription is canceled, the hosted app falls back to free
effective limits immediately after the Stripe cancellation webhook is processed.

If the workspace is over free limits after cancellation, existing aliases and
data are not deleted automatically, but inbound acceptance and management
actions can be restricted until the user deletes data/aliases or upgrades again.

## Failed Payments

For `past_due` subscriptions, paid effective limits remain only while the
current hard-coded 7-day `paid_through_at` grace window allows them. `unpaid`,
`incomplete`, and `incomplete_expired` states fall back to free effective limits
immediately.

## Refunds

Refund policy must be reviewed before public launch. Proposed v1 policy:

- Monthly subscriptions: no automatic prorated refunds after cancellation, but
  support can issue a goodwill refund for clear billing mistakes.
- Annual subscriptions: refund requests within 14 days can be considered if
  usage is low and no abuse occurred.
- Abuse, spam, phishing, or terms violations are not eligible for refunds.

Do not publish the proposed refund language until it is reviewed for your
jurisdiction and Stripe account setup.

## Taxes

Stripe is the first payment provider. You remain responsible for tax handling
unless you enable Stripe Tax or move to a Merchant of Record provider. Do not
launch live billing until the tax/accounting approach is reviewed.

## Data And Abuse

Hosted data export, erasure, abuse handling, and shared-domain reputation
controls are described in:

- [`../monetization/hosted-abuse-policy.md`](../monetization/hosted-abuse-policy.md)
- [`../monetization/stripe-test-mode-runbook.md`](../monetization/stripe-test-mode-runbook.md)

Public terms should include an abuse contact address and a privacy/data request
contact path before public signup is enabled.
