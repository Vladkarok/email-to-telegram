# Hosted Abuse, Deliverability, And Data Policy

This document is the hosted-SaaS launch checklist for abuse handling,
shared-domain reputation, and hosted-user data requests. It is operational
guidance, not legal advice. Public terms, privacy, tax, and DPA language should
still be reviewed before a public launch.

## Acceptable Use

Hosted email-to-Telegram is for personal alerts, operational notifications,
transactional messages, and low-volume team workflows.

Do not use the hosted service for:

- spam, phishing, credential harvesting, malware, or deceptive forwarding
- bulk marketing, scraped-list ingestion, or purchased-list ingestion
- evading sender/domain blocks, reputation controls, or rate limits
- receiving or redistributing unlawful, abusive, or non-consensual content
- high-volume attachment hosting, file sharing, CDN-like traffic, or hotlinking
- workflows that intentionally overload Telegram, Cloudflare, Stripe, or the VPS

Self-hosted deployments remain MIT-licensed. Hosted controls apply to the
managed SaaS because one abusive tenant can affect the shared domain, support
load, and infrastructure cost for everyone.

## Enforcement Ladder

Use the narrowest control that contains the risk.

1. Sender block: add `sender_email` or `sender_domain` to
   `hosted_inbound_blocks`.
2. Alias block: add `local_part` to `hosted_inbound_blocks`.
3. Shared-domain block: add `recipient_domain` to `hosted_inbound_blocks`.
4. Alias suspension: pause or delete abusive aliases.
5. Emergency shared-domain suspension: set the shared `inbound_domains` row to
   `disabled`.

There is no full organization suspension state in v1. Do not document or sell
workspace suspension until the schema and enforcement paths support it. For
workspace-level abuse in v1, disable all abusive aliases and add blocklist rows
for the relevant local parts, senders, or recipient domain.

Blocks must be logged with a reason that is specific enough for later support
review, for example `phishing report`, `spam trap hit`, `egress abuse`, or
`shared-domain emergency`.

## Shared-Domain Reputation Runbook

Monitor at least daily during beta, and more often after public launch:

- Cloudflare Email Routing rejects, spikes, or delivery anomalies
- sudden preflight rejection spikes by sender domain, alias, or recipient domain
- attachment/privacy-view egress spikes
- Telegram delivery failures by organization and alias
- user reports of missing mail from major senders
- abuse complaints sent to the hosted contact address

Emergency response:

1. Disable new public onboarding if signup abuse is active.
2. Add sender/domain/local-part blocks for the active abuse source.
3. If the shared domain reputation is at risk, disable the shared
   `inbound_domains` row. Hosted routing rejects disabled domains before raw
   persistence.
4. Keep existing raw files and logs unless an erasure request or retention job
   applies.
5. Write an incident note with time, scope, controls applied, and rollback
   condition.
6. Re-enable only after the abuse source is blocked and normal rejection/error
   rates are observed.

## Data Export And Erasure

Hosted users can request:

- basic export of organization metadata, aliases, usage, storage counters, and
  delivery-log summaries
- organization deletion/erasure for hosted data owned by the workspace

Operational SLA target:

- acknowledge export or erasure request within 7 calendar days
- complete export within 14 calendar days when identity/ownership is clear
- complete erasure within 30 calendar days unless retention is legally required

Current implementation notes:

- `exportHostedOrganizationData` provides the basic export primitive.
- `deleteHostedOrganization` removes hosted organization records and stored raw
  email files known to delivery logs.
- Normal retention cleanup continues to remove raw email and attachment data
  according to effective plan limits.

Operator instructions still need to be written before public launch. They must
cover:

- how to identify the requester and verify owner/admin access to the
  organization
- how to find the target `organizationId`
- how to invoke export/delete primitives from the production environment
- where to store the export while preparing delivery to the requester
- how to record request receipt, completion time, and any retained-data
  exception

Do not delete another tenant's data while resolving a single organization
request. If ownership is ambiguous, do not proceed until the requestor proves
workspace ownership.

## Billing And Cancellation Policy

v1 hosted billing uses fixed Stripe subscriptions, not metered usage billing.

- Upgrades can apply immediately when Stripe webhook state is received.
- Failed or canceled subscriptions fall back to the effective free limits
  without deleting aliases automatically.
- Past-due paid limits use `paid_through_at` grace, derived from successful
  Stripe subscription invoice service periods.
- Over-limit aliases or data are not deleted automatically; inbound acceptance
  and management actions are restricted until the user deletes data/aliases or
  upgrades.
- Refunds, proration overrides, annual cancellation terms, and tax treatment are
  policy decisions to define before public paid launch. Stripe defaults should
  not be treated as public terms without review.

## Public Launch Gate

Do not launch public hosted signup until all of these are true:

- hosted onboarding and alias creation throttles are enabled
- shared-domain block controls are available to the operator
- shared-domain emergency disable has been tested
- egress ceilings are enforced for attachment and privacy-view downloads
- export and delete primitives have operator instructions
- a public acceptable-use/abuse contact is published
- privacy/terms/refund/cancellation language has been reviewed
