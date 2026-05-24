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
