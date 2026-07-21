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
