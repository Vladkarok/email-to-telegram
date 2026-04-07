# Historical Planning Notes

This file is intentionally no longer a full deployment or architecture guide.

It previously described several early design options that are not the current
state of the repository, including direct SMTP ingestion and older deployment
assumptions. Keeping that material around as if it were current documentation is
more confusing than useful.

Current source of truth:

- [`README.md`](./README.md) for architecture, setup, and first deployment
- [`.env.example`](./.env.example) for configuration
- [`docker-compose.yml`](./docker-compose.yml) for the repository's current VPS-specific compose layout
- [`docs/examples/docker-compose.standalone.yml`](./docs/examples/docker-compose.standalone.yml) for a clean first-install compose example
- [`docs/examples/Caddyfile`](./docs/examples/Caddyfile) for the matching standalone HTTPS proxy example
- [`cloudflare-worker/wrangler.toml`](./cloudflare-worker/wrangler.toml) for the Worker entry point
- [`devdocs/encryption-todo.md`](./devdocs/encryption-todo.md) for future encryption work

Current implemented state:

- Email ingestion is via Cloudflare Email Routing plus the Cloudflare Worker
- Direct SMTP ingestion is not implemented
- The checked-in Docker Compose file reflects an existing VPS deployment that joins an external proxy network
- A clean first deployment can be done from source with the standalone example under `docs/examples/`
- Optional tag-based releases can pull prebuilt GHCR images for this repository's current VPS layout
