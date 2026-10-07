#!/usr/bin/env bash
# Runner side of the staging monitoring stack deploy: validates the inputs,
# renders the secret files and builds the upload for stack-deploy.sh.
#
#   render-payload.sh OUT_DIR
#
# Writes OUT_DIR/payload/ (uploaded to the staging VM) and OUT_DIR/stdin (piped
# to stack-deploy.sh: the push password, used only to verify the gateway).
#
# Environment:
#   LOKI_PUSH_BIND_IP                  the staging VM's 10.0.88.x address
#   HOST_TLS_CERT, HOST_TLS_KEY        PEM, server certificate for that address
#   EXPORTER_BASIC_AUTH_USER           prometheus-a | prometheus-b (default prometheus-a)
#   EXPORTER_BASIC_AUTH_PASSWORD       what Prometheus sends to the exporters
#   LOKI_PUSH_USER                     promtail-a | promtail-b (default promtail-a)
#   LOKI_PUSH_PASSWORD                 its password, accepted by the gateway
#   LOKI_PUSH_PASSWORD_SECONDARY       optional; also accepted for the other user (rotation)
#   METRICS_BEARER_TOKEN_STAGING       app /metrics token (required)
#   METRICS_BEARER_TOKEN_PROD          app /metrics token (optional)
#   HTPASSWD_VIA                       command prefix for the bcrypt container, e.g. "ssh staging"
#   ETG_CA_FILE                        default monitoring/tls/ca.crt
set -Eeuo pipefail
set +x
umask 077

here=$(cd "$(dirname "$0")" && pwd)
monitoring=$(dirname "$here")
repo=$(dirname "$monitoring")
# shellcheck source=monitoring/agent/deploy/lib.sh
. "$monitoring/agent/deploy/lib.sh"

out=${1:?usage: render-payload.sh OUT_DIR}
require_cmds openssl sha256sum rsync
[[ -n "${HTPASSWD_VIA:-}" ]] || require_cmds docker

bind_ip=${LOKI_PUSH_BIND_IP:-}
[[ "$bind_ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "LOKI_PUSH_BIND_IP must be an IPv4 address"
ca_file=${ETG_CA_FILE:-$repo/monitoring/tls/ca.crt}

exporter_user=${EXPORTER_BASIC_AUTH_USER:-prometheus-a}
check_user EXPORTER_BASIC_AUTH_USER "$exporter_user" prometheus-a prometheus-b
check_password EXPORTER_BASIC_AUTH_PASSWORD "${EXPORTER_BASIC_AUTH_PASSWORD:-}"
push_user=${LOKI_PUSH_USER:-promtail-a}
check_user LOKI_PUSH_USER "$push_user" promtail-a promtail-b
check_password LOKI_PUSH_PASSWORD "${LOKI_PUSH_PASSWORD:-}"
secondary=${LOKI_PUSH_PASSWORD_SECONDARY:-}
if [[ -n "$secondary" ]]; then
  check_password LOKI_PUSH_PASSWORD_SECONDARY "$secondary"
  [[ "$secondary" != "$LOKI_PUSH_PASSWORD" ]] ||
    die "LOKI_PUSH_PASSWORD_SECONDARY must differ from LOKI_PUSH_PASSWORD"
fi
[[ -n "${HOST_TLS_CERT:-}" ]] || die "secret HOST_TLS_CERT is not set"
[[ -n "${HOST_TLS_KEY:-}" ]] || die "secret HOST_TLS_KEY is not set"
[[ -n "${METRICS_BEARER_TOKEN_STAGING:-}" ]] ||
  die "secret METRICS_BEARER_TOKEN_STAGING is not configured at the repo level"

rm -rf "$out"
p="$out/payload"
mkdir -p "$p/tree" "$p/bearer" "$p/secrets/prometheus" "$p/secrets/loki-gateway"

# Everything under monitoring/ except the host agent, the deploy tooling and
# the env template; the host keeps its own .env and secrets.
rsync -a --exclude=/agent/ --exclude=/deploy/ --exclude=/.env --exclude=/.env.example \
  --exclude=/secrets/ --exclude=/prometheus/secrets/ "$monitoring/" "$p/tree/"
[[ -s "$p/tree/tls/ca.crt" ]] || die "monitoring/tls/ca.crt is missing (see docs/operations/monitoring.md, Certificates)"

write_secret "$p/secrets/loki-gateway/tls.crt" "$HOST_TLS_CERT"
write_secret "$p/secrets/loki-gateway/tls.key" "$HOST_TLS_KEY"
check_cert "$p/secrets/loki-gateway/tls.crt" "$p/secrets/loki-gateway/tls.key" "$ca_file" "$bind_ip"

{
  printf '%s' "$LOKI_PUSH_PASSWORD" | bcrypt_line "$push_user"
  if [[ -n "$secondary" ]]; then
    printf '%s' "$secondary" | bcrypt_line "$(other_user "$push_user")"
  fi
} >"$p/secrets/loki-gateway/htpasswd"

write_secret "$p/secrets/prometheus/exporter_username" "$exporter_user"
write_secret "$p/secrets/prometheus/exporter_password" "$EXPORTER_BASIC_AUTH_PASSWORD"

printf '%s\n' \
  "dir prometheus 65534" \
  "file prometheus/exporter_username 65534" \
  "file prometheus/exporter_password 65534" \
  "dir loki-gateway 101" \
  "file loki-gateway/tls.crt 101" \
  "file loki-gateway/tls.key 101" \
  "file loki-gateway/htpasswd 101" >"$p/secrets/manifest"

write_secret "$p/bearer/staging_token" "$METRICS_BEARER_TOKEN_STAGING"
if [[ -n "${METRICS_BEARER_TOKEN_PROD:-}" ]]; then
  write_secret "$p/bearer/prod_token" "$METRICS_BEARER_TOKEN_PROD"
else
  log "METRICS_BEARER_TOKEN_PROD is not configured; the prod token file is left as it is."
fi

cp "$here/stack-deploy.sh" "$monitoring/agent/deploy/lib.sh" "$p/"
printf '%s\n' "LOKI_PUSH_BIND_IP=$bind_ip" "LOKI_PUSH_USER=$push_user" >"$p/params"

# Services that read their config only at start; stack-deploy.sh recreates
# them when it changes. Prometheus is reloaded on every deploy instead, and
# Grafana picks up dashboard JSON by itself. The gateway re-reads htpasswd on
# every request.
dir_files() { (cd "$p" && find "$@" -type f | LC_ALL=C sort); }
{
  # shellcheck disable=SC2046 # one argument per file name, no spaces in these paths
  echo "loki $(config_hash "$p" $(dir_files tree/loki))"
  # shellcheck disable=SC2046
  echo "promtail $(config_hash "$p" $(dir_files tree/promtail))"
  # shellcheck disable=SC2046
  echo "loki-gateway $(config_hash "$p" $(dir_files tree/loki-gateway) \
    secrets/loki-gateway/tls.crt secrets/loki-gateway/tls.key)"
  # shellcheck disable=SC2046
  echo "grafana $(config_hash "$p" $(dir_files tree/grafana/provisioning/datasources) \
    tree/grafana/provisioning/dashboards/dashboards.yml)"
} >"$p/config-hashes"

printf '%s\n' "$LOKI_PUSH_PASSWORD" >"$out/stdin"
chmod -R go-rwx "$out"
log "monitoring stack payload rendered"
