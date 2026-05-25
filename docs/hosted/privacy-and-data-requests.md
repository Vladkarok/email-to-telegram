# Hosted Privacy And Data Requests Draft

This is public-facing draft language for the hosted service. It is not legal
advice and is not a substitute for a reviewed privacy policy or DPA.

> **Status:** The hosted instance currently runs in beta with no live billing.
> Managed billing is **to be implemented**; billing-related processing
> described below is forward-looking.

## Who Runs This Service

Hosted `email-to-telegram` is operated as a personal beta project by an
individual operator (not a company). The operator is a Ukrainian citizen
currently resident in Italy. The service is offered on a best-effort basis
and is not a commercial product at this stage.

Because the operator is resident in the EU, EU data protection law (GDPR)
applies. See **International Data Transfers** below for how the EU→Ukraine
hosting situation is handled.

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
- billing identifiers from the chosen payment provider, once managed billing
  is implemented (to be implemented)
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

## Sub-processors

The following third parties receive data from hosted `email-to-telegram` in
the course of delivering the service:

- **Cloudflare, Inc.** — receives inbound email at your alias addresses via
  Cloudflare Email Routing, then forwards each message to the hosted backend
  via a Cloudflare Worker. Cloudflare also provides DNS and TLS termination
  for the hosted domain. Cloudflare may temporarily process message
  envelopes and bodies as part of routing.
- **Telegram FZ-LLC** — receives delivered message content (or, in privacy
  mode, minimal delivery notifications) for the Telegram chats you configure.
- **Healthchecks.io** — receives uptime ping signals (no message content, no
  user PII) from the hosted backend at a fixed interval.

There are no third-party error tracking, analytics, advertising, or session
recording sub-processors. Application logs and metrics are stored on
operator-controlled infrastructure (see **Data Location**) and are not
shared with external observability vendors.

## Data Location

Application processing, the Postgres database, raw email storage,
operational logs, and metrics are all hosted on operator-controlled hardware
located in Ukraine. There is no third-party cloud database or managed
backup service in the pipeline beyond the sub-processors listed above.

Cloudflare's edge presence and Telegram's delivery infrastructure are
globally distributed and operated by those vendors under their own terms.

## International Data Transfers

The operator is resident in the EU (Italy) and acts as the data controller.
The hosting infrastructure is located in Ukraine. The European Commission
has not issued a formal adequacy decision for Ukraine under GDPR Article 45.

By creating an alias and accepting these terms, you provide explicit consent
under GDPR Article 49(1)(a) to transfer your hosted account data and inbound
email content to the Ukrainian hosting location for the purpose of providing
the service. You can withdraw that consent at any time by requesting
erasure (see **Erasure** below); the service will not be deliverable after
withdrawal.

Cloudflare and Telegram transfers are governed by those vendors' published
data protection terms (Cloudflare DPA and Telegram terms of service); the
operator does not control where Cloudflare or Telegram route or store data.

## Logging

The hosted backend writes structured application logs to local files on the
operator-controlled hardware in Ukraine. Logs include request timing, error
context, abuse-control events, delivery outcomes, and Telegram chat / user
identifiers as needed for debugging. Log files are rotated and pruned on
the same retention schedule as the corresponding plan's email retention
where practical.

Logs are not shipped to any third-party log aggregation, error tracking, or
analytics service. Internal log aggregation (Prometheus / Grafana / Loki)
runs on the same operator-controlled infrastructure.

## Billing

Managed self-serve billing is **to be implemented**. When implemented, the
chosen payment provider will receive the payment and billing data needed to
process checkout, subscriptions, invoices, and the customer portal.

Do not send payment card details directly to hosted `email-to-telegram`
support. When live billing exists, use the provider-hosted checkout and portal
pages.

## Data Export

Hosted account owners can self-serve a basic export of account metadata,
aliases, allow rules, custom domains, per-row delivery metadata, delivery
attempts, attachment manifest, usage counters, storage usage, and manual
billing events by running `/export_me` in a DM with the bot. The bot replies
with a JSON file built from your live data. There is a 60-second cooldown
per user.

Raw email bodies and attachment bytes are intentionally excluded from the
self-serve export — they would frequently exceed Telegram's 50 MiB bot upload
limit. Email the operator if you need raw bytes.

Email fallback at `vladyslavkarpenko3@gmail.com` is used for cases the bot
cannot handle directly: requests for raw email bodies or attachment files,
exports too large to deliver via Telegram, requests from a Telegram account
you no longer control, or formal GDPR data-access requests.

Target handling time for the email fallback:

- acknowledge the request within 7 calendar days
- complete the export within 14 calendar days when identity and ownership are
  clear

## Erasure

Hosted account owners can self-serve deletion of hosted account records,
aliases, allow rules, custom domains, delivery logs, and stored raw email and
attachment files by running `/delete_me` in a DM with the bot. The bot shows
a preview of what will be wiped and asks for inline confirmation. On confirm,
deletion happens immediately.

Self-serve deletion is refused while a paid subscription is active — cancel
the subscription first to avoid orphaned billing state.

Email fallback at `vladyslavkarpenko3@gmail.com` is used for cases the bot
cannot handle directly: requests from a Telegram account you no longer
control, partial-file-delete failures the bot surfaces, formal GDPR erasure
requests, and any case where ownership requires manual verification.

Some records may be retained when required for security, fraud prevention,
accounting, dispute handling, legal compliance, or abuse investigation.

Target handling time for the email fallback:

- acknowledge the request within 7 calendar days
- complete erasure within 30 calendar days unless retention is legally
  required

## Ownership Verification

Before exporting or deleting workspace data, we may require proof that the
requester controls the Telegram account associated with the hosted workspace.

If ownership is unclear, export or deletion will not proceed until ownership is
verified.

## Security Contact

For privacy, data access, or erasure requests, contact
`vladyslavkarpenko3@gmail.com`.

For abuse, phishing, malware, or shared-domain reputation issues, contact
`vladyslavkarpenko3@gmail.com` (same address; mark the subject line
`ABUSE:` to help triage).
