# Historical Planning Notes

This file is intentionally no longer a full deployment or architecture guide.

It previously described several early design options that are not the current
state of the repository, including direct SMTP ingestion and older deployment
assumptions. Keeping that material around as if it were current documentation is
more confusing than useful.

Current source of truth:

- [`README.md`](./README.md) for architecture, setup, and first deployment
- [`.env.example`](./.env.example) for configuration
- [`Caddyfile`](./Caddyfile) for the bundled HTTPS reverse proxy
- [`cloudflare-worker/wrangler.toml`](./cloudflare-worker/wrangler.toml) for the Worker entry point
- [`devdocs/encryption-todo.md`](./devdocs/encryption-todo.md) for future encryption work

Current implemented state:

- Email ingestion is via Cloudflare Email Routing plus the Cloudflare Worker
- Direct SMTP ingestion is not implemented
- Docker Compose runs the app, PostgreSQL, and Caddy
- Optional tag-based releases can pull prebuilt GHCR images, but a first deploy
  can be done locally with `docker compose up -d --build`
