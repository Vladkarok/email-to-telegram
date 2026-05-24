# Hosted Pricing And Terms Draft

This is the public-facing draft for hosted `email-to-telegram` pricing and
commercial terms. It is an operator/product draft, not legal advice. Review the
final public version for tax, privacy, refund, and data-processing requirements
before accepting live payments.

> **Status:** The hosted instance currently runs in beta with no live billing.
> Managed billing (checkout, customer portal, webhooks, refund flows, tax
> handling) is **to be implemented.** The plans table below reflects the
> planned shape; none of the paid flows are live yet.

## Positioning

Hosted `email-to-telegram` gives you email aliases that deliver operational
emails, alerts, and low-volume workflow messages to Telegram without running
mail infrastructure.

Self-hosting remains free and MIT-licensed. Paid hosted plans charge for managed
operation: hosted inbound routing, abuse controls, storage, retention, managed
billing (to be implemented), backups, and support.

## Plans

This table reflects the planned plan limit model. It is not automatically
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

There is no public free trial in v1. Users start on Free; self-serve upgrade
flow is **to be implemented**.

## Billing

- Prices are in USD.
- Self-serve subscriptions for Personal, Pro, and Team are **to be implemented**.
- Business is manually priced and may use a separate agreement or invoice.
- Hosted is currently donation-supported during beta. Paid plans are not yet
  billable.
- Annual plans (when implemented) will be billed upfront.
- Downgrades and cancellations do not delete aliases or stored data
  automatically.

## Cancellation

Self-serve cancellation is **to be implemented** as part of managed billing.
When implemented, canceling a subscription will fall back the workspace to free
effective limits.

If the workspace is over free limits after cancellation, existing aliases and
data are not deleted automatically, but inbound acceptance and management
actions can be restricted until the user deletes data/aliases or upgrades again.

## Failed Payments

Failed-payment handling is **to be implemented** as part of managed billing.
The planned shape: a short grace window keeps paid limits for unintentionally
failed payments, then falls back to free effective limits on harder failure
states.

## Refunds

Refund policy must be reviewed before public launch. Proposed v1 policy:

- Monthly subscriptions: no automatic prorated refunds after cancellation, but
  support can issue a goodwill refund for clear billing mistakes.
- Annual subscriptions: refund requests within 14 days can be considered if
  usage is low and no abuse occurred.
- Abuse, spam, phishing, or terms violations are not eligible for refunds.

Do not publish the proposed refund language until it is reviewed for your
jurisdiction and the chosen payment provider's setup.

## Taxes

Tax handling is **to be implemented** as part of managed billing. Live billing
will not launch until the tax approach is reviewed for the operator's
jurisdiction.

## Data And Abuse

Hosted data export, erasure, abuse handling, and shared-domain reputation
controls are described in:

- [`README.md`](./README.md)
- [`acceptable-use.md`](./acceptable-use.md)
- [`privacy-and-data-requests.md`](./privacy-and-data-requests.md)

Public terms should include an abuse contact address and a privacy/data request
contact path before public signup is enabled.
