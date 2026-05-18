# Hosted Privacy And Data Requests Draft

This is public-facing draft language for the hosted service. It is not legal
advice and is not a substitute for a reviewed privacy policy or DPA.

## What The Hosted Service Processes

Hosted `email-to-telegram` receives inbound email for aliases you create and
delivers accepted messages to Telegram.

Depending on your settings and message content, the hosted service may process:

- Telegram user IDs, chat IDs, and forum topic IDs needed for delivery
- alias local parts, hosted recipient domains, and allow-rule settings
- email metadata such as sender, recipient, subject, received time, message
  size, delivery status, and attachment metadata
- raw email files while retention settings require them
- attachments and attachment download links while retention settings require
  them
- privacy-view links and one-time view/download state
- billing identifiers from Stripe, such as customer and subscription IDs
- manual payment references and operator billing notes when a hosted plan is
  granted outside automated billing
- operational logs, abuse blocks, rate-limit records, and usage counters

## Retention

Plan retention controls how long raw email and attachment data are kept for
hosted delivery, retry, privacy-view, and download workflows. Current plan
retention is documented in [`pricing-and-terms.md`](./pricing-and-terms.md).

Operational logs, billing records, abuse records, and backup copies may be kept
longer when needed for security, accounting, fraud prevention, legal compliance,
or service reliability.

## Telegram Delivery

When an email is delivered to Telegram, Telegram receives the message content
needed for that delivery. If privacy mode is enabled, Telegram receives a
minimal alert and a browser view link instead of the full email body.

Telegram is a separate service with its own terms and privacy practices.

## Stripe Billing

Hosted billing uses Stripe for self-serve subscriptions. Stripe receives the
payment and billing data needed to process checkout, subscriptions, invoices,
and the customer portal.

Do not send payment card details directly to hosted `email-to-telegram`
support. Use Stripe-hosted checkout and portal pages.

## Data Export

Hosted account owners can request a basic export of account metadata, aliases,
usage, storage counters, and delivery-log summaries.

Target handling time:

- acknowledge the request within 7 calendar days
- complete the export within 14 calendar days when identity and ownership are
  clear

Export requests should be sent to `<privacy@example.com>`.

## Erasure

Hosted account owners can request deletion of hosted account records and stored
raw email/attachment files known to delivery logs.

Target handling time:

- acknowledge the request within 7 calendar days
- complete erasure within 30 calendar days unless retention is legally required

Some records may be retained when required for security, fraud prevention,
accounting, dispute handling, legal compliance, or abuse investigation.

Erasure requests should be sent to `<privacy@example.com>`.

## Ownership Verification

Before exporting or deleting workspace data, we may require proof that the
requester controls the Telegram account associated with the hosted workspace.

If ownership is unclear, export or deletion will not proceed until ownership is
verified.

## Security Contact

For privacy, data access, or erasure requests, contact
`<privacy@example.com>`.

For abuse, phishing, malware, or shared-domain reputation issues, contact
`<abuse@example.com>`.
