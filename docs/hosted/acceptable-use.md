# Hosted Acceptable Use Draft

This is public-facing draft language for the hosted service. It is not legal
advice. Replace placeholders and review before publication.

> **Status:** Hosted operates in beta with no live billing yet. The abuse
> policy below applies to the current beta hosted service. Abuse and privacy
> contact: `vladyslavkarpenko3@gmail.com` (mark the subject line `ABUSE:`
> for abuse reports to help triage).

## Intended Use

Hosted `email-to-telegram` is for low-volume operational email workflows:

- application alerts and status notifications
- monitoring, uptime, CI, and deployment messages
- GitHub, SaaS, and infrastructure notifications
- small-team operational workflows delivered to Telegram chats or topics
- personal alerts that do not require running mail infrastructure

The hosted service is not a bulk email, marketing, file hosting, or general mail
hosting platform.

## Prohibited Use

You may not use the hosted service for:

- spam, phishing, impersonation, credential harvesting, malware, or deceptive
  routing
- bulk marketing, purchased-list traffic, scraped-list ingestion, or unsolicited
  mass notifications
- receiving, storing, forwarding, or redistributing unlawful, abusive, or
  non-consensual content
- evading sender/domain blocks, rate limits, shared-domain controls, or abuse
  monitoring
- high-volume attachment hosting, file sharing, hotlinking, or CDN-like traffic
- traffic that intentionally overloads Telegram, Cloudflare, the hosted app,
  or the infrastructure behind it
- workflows that create material reputation risk for the shared hosted inbound
  domain

## Shared Domain Controls

Hosted plans may use a shared inbound domain. One abusive tenant can harm
deliverability for other users, so we may block senders, recipient aliases,
recipient domains, or traffic patterns that create abuse or reputation risk.

We may temporarily restrict or disable inbound acceptance for a shared domain if
needed to protect the service and other users. We will use the narrowest
practical control for the incident.

## Free Tier Limits

The free hosted tier is for evaluation and small personal workflows. Free-tier
accounts may be rate-limited, blocked, or disabled when traffic looks abusive,
automated, or risky for shared-domain reputation.

## Enforcement

Depending on the issue, enforcement may include:

- sender, sender-domain, recipient-alias, or recipient-domain blocks
- alias pause or deletion
- temporary shared-domain disablement during an active incident
- refusal to process over-limit traffic
- account or workspace review before service is restored

The v1 system does not have a general self-serve organization suspension state.
Workspace-level abuse is handled through alias/domain blocks and shared-domain
controls.

## Reporting Abuse

Report suspected abuse, phishing, malware, spam, or shared-domain reputation
issues to `vladyslavkarpenko3@gmail.com` (mark the subject line `ABUSE:` to
help triage).

Include:

- the sender address or domain
- the recipient alias or hosted domain, if known
- message headers or timestamps, if available
- a short description of the issue

Do not send sensitive secrets, passwords, private keys, or full message content
unless support explicitly asks for it through a private channel.
