# Monitoring stack

Self-hosted Prometheus + Grafana + Loki + Promtail for email-to-telegram, on
the staging VM next to the staging app, plus a small host agent on each VM.
Two services of the stack are published to the host, each on a private
address only: Grafana (VPN) and the Loki push gateway (TLS + basic auth, for
the prod log collector).

## Services

- **Prometheus** (`prom/prometheus:v2.55.1`) — scrapes the app `/metrics`
  endpoint using a bearer token, and the host agents' node_exporter (job
  `node`) and postgres_exporter (job `postgres`) on both VMs over TLS with
  basic auth. 90-day TSDB retention.
- **Grafana** (`grafana/grafana-oss:11.3.0`) — UI on
  `${MONITORING_BIND_IP}:3001`. Provisioned datasources and dashboards.
- **Loki** (`grafana/loki:2.9.10`) — single-binary, filesystem storage,
  7-day retention via compactor.
- **loki-gateway** (`nginx:1.30.5-alpine`) — `${LOKI_PUSH_BIND_IP}:3101`.
  Accepts only an authenticated `POST /loki/api/v1/push` and streams it to
  Loki; every other path and method gets 403.
- **Promtail** (`grafana/promtail:2.9.10`) — Docker SD; ships the staging app
  container's logs only, with labels `service`, `compose_project`,
  `container_name`, `container_id`, `stream`, `env`.

## Host agent

`agent/` is a separate compose project (`etg-agent`) installed at
`~/monitoring-agent/` on each VM by the `Deploy Monitoring Agent` workflow:

- **node_exporter** (`prom/node-exporter:v1.12.1`) on `10.0.88.x:9100`, with
  the textfile collector for the off-site backup freshness metric.
- **postgres_exporter** (`prometheuscommunity/postgres-exporter:v0.20.1`) on
  `10.0.88.x:9187`, logged in as the read-only `etg_monitor` role.
- **Promtail** (prod only, profile `prod`) — reads the json-file logs
  read-only, keeps the app container's lines and pushes them to the gateway.

Deploy tooling lives in `agent/deploy/` (agent) and `deploy/` (this stack).
Tests that run in CI: `agent/tests/` and `deploy/tests/`.

## Dashboards

Provisioned from `grafana/provisioning/dashboards/json/`:

- **Email to Telegram – Operations** (`e2t-app`) — mail flow from preflight
  to Telegram: inbound, delivery, latency, backlog, HTTP, logs, host and
  database.
- **Email to Telegram – Product** (`e2t-product`) — activation funnel, users,
  aliases, daily volume, quota rejections.
- **Email to Telegram – Runtime** (`e2t-runtime`) — Node.js process health.

Panel guide: `docs/operations/monitoring.md#dashboards`.

## Networking

Two networks:

- `monitoring_internal` (bridge, this compose only) — grafana, prometheus,
  loki, promtail, loki-gateway.
- `monitoring_scrape` (external, shared) — created once on the host with
  `docker network create monitoring_scrape`. The app compose joins this same
  network so Prometheus can resolve `app:3000`.

The agents and the gateway listen on the private `10.0.88.0/24` subnet.

## Secrets

`./prometheus/secrets/staging_token` and `prod_token` are mounted read-only
into Prometheus and referenced via `bearer_token_file`. The deploy writes
those files from `METRICS_BEARER_TOKEN_STAGING` / `METRICS_BEARER_TOKEN_PROD`.

`./secrets/prometheus/` (exporter username and password) and
`./secrets/loki-gateway/` (TLS key and certificate, htpasswd) come from the
GitHub environment `staging`, owned by the UID of the container that reads
them, mode 0400. `tls/ca.crt` is the private CA's public certificate. Never
commit secret files.

Grafana admin credentials and the bind IPs come from `./.env` (see
`.env.example`). Compose fails fast if `MONITORING_BIND_IP`,
`LOKI_PUSH_BIND_IP` or `GRAFANA_ADMIN_PASSWORD` are unset.

## Adding a scrape target

Edit `prometheus/prometheus.yml`, add a new job (mirror the staging job),
then reload with `curl -X POST http://prometheus:9090/-/reload` from inside
the `monitoring_internal` network or restart the container. The prod job
(`10.0.88.2:3000` over the VPN) is enabled.

## Retention

- Prometheus: 90 days TSDB (`--storage.tsdb.retention.time=90d`).
- Loki: 7 days (`retention_period: 168h`).

See `docs/operations/monitoring.md` for the full operator runbook:
certificates, GitHub environments, credential rotation, rollback and
erasure requests.
