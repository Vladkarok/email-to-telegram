# Hosted Observability Runbook

## Metrics

Enable Prometheus metrics with:

```bash
METRICS_ENABLED=true
METRICS_TOKEN=<random value with at least 32 characters>
```

Scrape:

```bash
curl -H "Authorization: Bearer $METRICS_TOKEN" https://mail.example.com/metrics
```

The endpoint is disabled unless `METRICS_ENABLED=true`, requires the bearer
token, and has a per-route rate limit to reduce damage from a leaked token.

Metric labels intentionally avoid organization IDs, alias IDs, Telegram IDs,
email addresses, payment references, manual notes, domains, and raw error text.
Use admin DB/UI queries for tenant drilldowns.

Core panels:

- HTTP request rate and duration by route/status class.
- Inbound preflight accepted/rejected rate by reason.
- Raw inbound accepted/rejected rate by reason.
- Telegram delivery and retry attempts by result.
- Telegram send failures by coarse error class.
- Manual plan grants by plan.
- Quota rejections by reason.
- Active organizations by stored plan.

Rollback: set `METRICS_ENABLED=false` and restart the app. No schema changes are
introduced by metrics.

## Logs

Production logs remain Pino JSON. Useful stable event names include:

- `billing.manual_grant.created`
- `billing.manual_grant.idempotent`
- `inbound.preflight.rejected`
- `inbound.raw.rejected`
- `delivery.telegram.failed`
- `admin.session.created`
- `admin.billing.mutated`

Do not add raw email content, tokens, payment references, manual notes, free-form
Telegram errors, or customer identifiers to metric labels.

## Cloudflare Worker

App-side metrics start after the Worker forwards a request to the VPS. Worker
CPU limits, uncaught Worker exceptions, or upstream timeout failures may not
appear in app metrics.

Recommended operator checks:

- Enable Cloudflare Workers Analytics Engine or Logpush if available.
- Watch Worker invocation errors, CPU-limit errors, and upstream non-2xx raw
  upload responses.
- If the current Cloudflare plan cannot export Worker logs, review the Workers
  dashboard periodically until external alerting is available.

Alert candidates:

- `/healthz` unhealthy for more than 5 minutes.
- Raw inbound 5xx rate above baseline.
- Telegram delivery failures above baseline.
- Quota rejections spike unexpectedly.
- Disk usage above 80 percent.
- Postgres unavailable.
- Cloudflare Worker errors or CPU-limit errors.
