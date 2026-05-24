# Security Policy

## Supported versions

`email-to-telegram` is under active development. Security fixes target
the latest tagged release on `main`. Older releases are not back-ported
unless the vulnerability is severe and a fix is trivial.

| Version          | Supported          |
| ---------------- | ------------------ |
| Latest `v1.x`    | :white_check_mark: |
| Pre-1.0 releases | :x:                |

## Reporting a vulnerability

**Please do not file public GitHub issues for security vulnerabilities.**

Use GitHub's [Private Vulnerability Reporting][pvr] to submit a private
advisory:

[pvr]: https://github.com/Vladkarok/email-to-telegram/security/advisories/new

When reporting, please include:

- A clear description of the vulnerability and its impact.
- Steps to reproduce (or a proof-of-concept).
- The affected version or commit SHA.
- Any known mitigations or workarounds.

## What to expect

- We aim to acknowledge new reports within **7 calendar days**.
- We aim to share an initial assessment and remediation plan within
  **14 calendar days** of acknowledgement.
- We will coordinate a disclosure timeline with the reporter and credit
  the reporter in the advisory unless anonymity is requested.

## Scope

In scope:

- The application code in this repository (`src/`, `cloudflare-worker/`,
  `monitoring/`).
- The deployment manifests (`Dockerfile`, `docker-compose.yml`,
  `infra/`, `drizzle/`).
- The reference Cloudflare Worker handling inbound mail preflight.

Out of scope:

- Third-party services (Cloudflare, Telegram, hosting providers).
- Misconfigurations of a user-operated self-hosted deployment that are
  not caused by repository defaults.
- Denial-of-service via authenticated abuse of paid features (please
  report operational abuse to the hosted instance operator, not as a
  security vulnerability).

## Hardening guidance

If you self-host `email-to-telegram`, review:

- `.env.example` for the required configuration.
- The first-deployment guide in `README.md` (`INITIAL_ALLOWED_USERS`,
  `MAIL_DOMAIN`, attachment retention, optional local encryption).
- The reverse-proxy example in `docs/examples/`.

Keep your Cloudflare API token, Telegram bot token, and database
credentials in `.env` only. Never commit them to the repository.
