# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog][kac] and this project
follows [Semantic Versioning][semver] for public releases.

[kac]: https://keepachangelog.com/en/1.1.0/
[semver]: https://semver.org/spec/v2.0.0.html

## Versioning note

Public versioning starts at `v1.0.0`. The project ran on a private
versioning track (`v1.x` through `v2.5.x`) during pre-public iteration;
those tags do not appear in the public repository's history. The
public `v1.0.0` release corresponds to the internal `v2.5.x` codebase
that has been running in production.

## [Unreleased]

### Added

- Public open-source release in preparation.
- Public-facing documentation: `SECURITY.md`, `CONTRIBUTING.md`,
  `CHANGELOG.md`, issue/PR templates, CODEOWNERS.

## [1.10.0] — 2026-10-06

Plan limits move out of the code, the free plan doubles its monthly mail, and
the inbound path stops losing or permanently bouncing mail it should not.

### Added

- **`PLAN_LIMITS`**: a JSON env var that overrides single limits of single
  plans, e.g. `PLAN_LIMITS={"free":{"deliveredEmailsMonth":300}}`. Anything
  not named keeps the code default. Unknown plans or keys and out-of-range
  values stop startup. It takes effect when the container is recreated
  (`docker compose up -d`), not on `docker compose restart`. See
  `.env.example` for keys and bounds.
- `/plan` lists the per-alias hourly cap.

### Changed

- **Free plan: 200 delivered emails a month** (was 100).
- **The per-alias hourly cap is a plan limit**, `aliasEmailsPerHour`
  (default 60 on every plan, so nothing changes by default). Self-hosters:
  the `email_addresses.max_emails_hour` column is no longer read; set
  `PLAN_LIMITS={"free":{"aliasEmailsPerHour":N}}` instead. The column stays
  until a later release.
- **Mail over the hourly cap is deferred, not bounced.** Preflight answers
  429, the Worker turns that into a temporary SMTP failure, and the sending
  server retries once the hour frees a slot. It used to be a permanent 550.
- READMEs and the hosted terms point to `/plan` for current limits instead of
  stating numbers.

### Fixed

- **Mail from a sender the alias does not allow now bounces.** When an alias
  had allow rules and the From matched none of them, the raw upload answered
  202 and dropped the message, so the sender saw success. It now answers 403
  (a 550 bounce), the same as a sender that fails authentication, which also
  stops the response from revealing which domains an alias allows.

## [1.9.0] — 2026-10-06

Every alias now looks the same, and new aliases start with rich rendering.

### Changed

- **One message frame for every alias.** Text-only emails and `plaintext`
  aliases get the same quoted From/To/Subject header, divider and paragraph
  body as HTML mail. `plaintext` still sends the email text literally.
- **`html` is the default render mode** for new aliases. Existing aliases
  keep their setting; switch with `/settings <alias> html|plaintext`.
- `/help` ends with where to report problems: the operator contact and the
  GitHub issues page.

### Removed

- The `markdown` render mode. It had no users; any alias still set to it
  renders as `html`.

## [1.8.0] — 2026-10-06

Rich messages for the mail that actually arrives: links and attachments no
longer force the plain-text layout.

### Added

- **Links in rich messages.** Emails with links, including every Gmail and
  Outlook forward, now keep native tables and headings. Links in the source
  are clickable, bare `https://` and `mailto:` text becomes a link, and
  attachment downloads appear as an "Attachments:" paragraph with the same
  one-time links as before. Verified on staging that Telegram draws no link
  preview for rich messages and never requests a linked URL before a click,
  so one-time attachment links stay unused until you open them.
- **Golden rendering tests** over real, redacted emails (a Veeam Agent
  report and its Gmail forward) and `npm run render:preview -- file.eml` to
  see exactly what Telegram would receive.

### Fixed

- A sender could stall delivery with a URL followed by tens of thousands of
  closing brackets; trimming is now linear.
- Directional-control characters are stripped from attachment filenames so
  an extension cannot be disguised.

## [1.7.0] — 2026-10-06

Rich-message polish and a dependency wave that clears every open
Dependabot alert.

### Changed

- **Tables in rich messages** are drawn with cell borders and compact
  padding, matching the source email instead of a borderless grid.
- **Message header.** From/To/Subject is now a quote block with bold
  labels, separated from the email body by a divider. Header fields are
  capped at 512 characters so a crafted subject cannot overflow the message.
- **Sender authentication.** An aligned DKIM pass now authenticates a From
  domain that publishes no DMARC record; previously a DMARC pass was
  effectively required. A DMARC lookup that fails temporarily still yields
  a temporary failure. With mailauth 7 (RFC 9989 Tree Walk), `adkim=s` is
  enforced and a subdomain with its own DMARC record no longer aligns with
  a parent-domain signature.
- **Node 24.** The Docker image and CI run on Node 24. The supported
  minimum for self-hosters is Node 22.19.
- **Releases.** The release workflow refuses a new tag whose commit does
  not carry the matching `package.json` version. Redeploys of existing tags
  are unaffected.

### Security

- mailauth 4.13 → 7.1 (nodemailer 10.0.14, undici 8.11.2): closes
  GHSA-prgh-xp8r-p3m5, GHSA-g57g-f23g-4646, GHSA-6vj9-mwq6-2f5v,
  GHSA-8vvx-rff5-p5rq and the undici 7.x advisory set.
- fastify 5.12.1 → 5.12.5: GHSA-p68q-wchp-6fh7 (authentication bypass via
  malformed URLs), GHSA-667r-xxjv-c9mm, GHSA-hwr6-493r-vm6h,
  GHSA-9q9j-q6p8-xq58, GHSA-4mh8-r7rc-xpvc.
- fast-uri, fast-copy, brace-expansion and wrangler bumps for the remaining
  alerts.

## [1.6.3] — 2026-09-22

Healthchecks.io fail signal on sustained probe failures; clearer quota
notices and plan commands in donation mode.

## [1.6.2] — 2026-09-12

Uptime alert debounce and log redaction; dependency advisories in the
Cloudflare Worker closed.

## [1.6.1] — 2026-08-15

Telegram rich email rendering: structured HTML emails are delivered as
rich messages with headings, lists and native tables, with a classic text
fallback.

## [1.6.0] — 2026-07-21

Alias chat mobility: aliases are no longer tied for life to the chat they
were created in.

### Added

- **Move an alias to another chat.** From the alias menu, tap
  **📦 Move to another chat** and pick any group, channel, or your own
  private chat with the bot that you administer. The alias address never
  changes — only where its mail arrives. Permissions on both the source and
  the destination are re-checked at the moment you confirm.
- **Forum topics.** Deliver an alias into a specific forum topic: open that
  topic, run `/listemail` there, and tap **📌 Deliver in this topic**. A
  **📤 Deliver in General** button sends it back to the General topic at any
  time.
- **Orphan recovery.** If the bot is removed from a group, that group's
  aliases no longer disappear from every menu. Their creator can now move or
  delete them from a private chat with the bot, freeing the alias name for
  reuse.
- **Close button** on the chat, alias-list, and alias-detail menus, so a
  menu can be dismissed instead of lingering in the conversation.
- A durable, append-only audit record of every move and migration, wired
  into the existing data-export and account-deletion flows.

### Changed

- Each delivery attempt now resolves its destination with a single fresh
  read, so an email's text and its attachments always arrive together in
  the same chat, even if the alias is moved mid-delivery.

### Fixed

- **Group → supergroup upgrades are now invisible.** When Telegram upgrades
  a group to a supergroup (which changes the chat's internal id), aliases
  follow the chat automatically and mail keeps arriving. Previously such
  upgrades silently broke delivery.
- An alias whose chat has become permanently unreachable can no longer get
  stuck in a state where it cannot be managed or removed.

### Notes

- New database migration `0009` adds the move-audit table and an
  alias routing-version column. It applies automatically on startup and is
  inert on the previous release, so rollback is a normal image rollback.
- Changelog entries for `1.1.0`–`1.5.0` are not yet itemized here; those
  releases are tagged in git history.

## [1.0.0] — Initial public release

Planned scope for the first public-tagged release:

### Features

- Cloudflare Email Routing inbound layer.
- Cloudflare Worker preflight that validates aliases and streams raw
  MIME to the VPS.
- VPS application that parses mail, stores raw `.eml` files and
  attachments, and delivers to Telegram chats, groups, or forum topics.
- Telegram bot for alias management:
  `/start`, `/newemail`, `/listemail`, `/deleteemail`, `/pauseemail`,
  `/resumeemail`, `/settings`, `/allow add|remove|list`, `/language`,
  `/help`.
- Per-alias allow rules (`email` or `domain` precision).
- Per-alias hourly delivery cap.
- Privacy mode with browser reveal link.
- Attachments with expiring download links.
- Optional local storage encryption for raw email and attachments.
- Health checks, backups, structured Pino logs, deduplication.
- Self-hosted Prometheus + Grafana + Loki monitoring stack
  (`monitoring/`) with bearer-token-authenticated `/metrics`.
- i18n foundation: English and Ukrainian bot messages, `/language`
  selection.
- Hosted-mode flag with planned managed billing (to be implemented).

### Documentation

- Full first-deployment guide in `README.md` (Cloudflare zone, DNS,
  Worker, VPS, Telegram bot, Docker Compose).
- Standalone first-deploy example under `docs/examples/`.
- Operations runbook for the monitoring stack under `docs/operations/`.
- Hosted-service draft policies (acceptable use, pricing direction,
  privacy and data requests) under `docs/hosted/`.
