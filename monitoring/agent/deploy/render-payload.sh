#!/usr/bin/env bash
# Runner side of the agent deploy: validates the inputs, renders the secret
# files and builds the upload for agent-deploy.sh.
#
#   render-payload.sh OUT_DIR
#
# Writes OUT_DIR/payload/ (uploaded to the host) and OUT_DIR/stdin (piped to
# agent-deploy.sh: exporter password, SCRAM verifier, push password; one per
# line, never written on the host).
#
# Environment:
#   ETG_ENV                                staging | prod
#   AGENT_BIND_IP                          the VM's 10.0.88.x address
#   HOST_TLS_CERT, HOST_TLS_KEY            PEM, server certificate for AGENT_BIND_IP
#   PG_MONITOR_PASSWORD                    etg_monitor password (this environment only)
#   EXPORTER_BASIC_AUTH_USER               prometheus-a | prometheus-b (default prometheus-a)
#   EXPORTER_BASIC_AUTH_PASSWORD           its password
#   EXPORTER_BASIC_AUTH_PASSWORD_SECONDARY optional; also accepted for the other user (rotation)
#   LOKI_PUSH_ADDR                         prod: gateway host:port
#   LOKI_PUSH_USER                         prod: promtail-a | promtail-b (default promtail-a)
#   LOKI_PUSH_PASSWORD                     prod: its password
#   HTPASSWD_VIA                           command prefix for the bcrypt container, e.g. "ssh prod"
#   ETG_CA_FILE                            default monitoring/tls/ca.crt
set -Eeuo pipefail
set +x
umask 077

here=$(cd "$(dirname "$0")" && pwd)
agent_dir=$(dirname "$here")
repo=$(cd "$agent_dir/../.." && pwd)
# shellcheck source=monitoring/agent/deploy/lib.sh
. "$here/lib.sh"

out=${1:?usage: render-payload.sh OUT_DIR}
require_cmds openssl python3 sha256sum
[[ -n "${HTPASSWD_VIA:-}" ]] || require_cmds docker

env_name=${ETG_ENV:-}
check_user ETG_ENV "$env_name" staging prod
bind_ip=${AGENT_BIND_IP:-}
[[ "$bind_ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "AGENT_BIND_IP must be an IPv4 address"
ca_file=${ETG_CA_FILE:-$repo/monitoring/tls/ca.crt}

exporter_user=${EXPORTER_BASIC_AUTH_USER:-prometheus-a}
check_user EXPORTER_BASIC_AUTH_USER "$exporter_user" prometheus-a prometheus-b
check_password EXPORTER_BASIC_AUTH_PASSWORD "${EXPORTER_BASIC_AUTH_PASSWORD:-}"
secondary=${EXPORTER_BASIC_AUTH_PASSWORD_SECONDARY:-}
if [[ -n "$secondary" ]]; then
  check_password EXPORTER_BASIC_AUTH_PASSWORD_SECONDARY "$secondary"
  [[ "$secondary" != "$EXPORTER_BASIC_AUTH_PASSWORD" ]] ||
    die "EXPORTER_BASIC_AUTH_PASSWORD_SECONDARY must differ from EXPORTER_BASIC_AUTH_PASSWORD"
fi
check_password PG_MONITOR_PASSWORD "${PG_MONITOR_PASSWORD:-}"
[[ -n "${HOST_TLS_CERT:-}" ]] || die "secret HOST_TLS_CERT is not set"
[[ -n "${HOST_TLS_KEY:-}" ]] || die "secret HOST_TLS_KEY is not set"

push_user="" push_addr="" profile=""
if [[ "$env_name" == prod ]]; then
  profile=prod
  push_user=${LOKI_PUSH_USER:-promtail-a}
  check_user LOKI_PUSH_USER "$push_user" promtail-a promtail-b
  check_password LOKI_PUSH_PASSWORD "${LOKI_PUSH_PASSWORD:-}"
  push_addr=${LOKI_PUSH_ADDR:-}
  [[ "$push_addr" =~ ^[0-9.]+:[0-9]+$ ]] || die "LOKI_PUSH_ADDR must be host:port"
fi

rm -rf "$out"
p="$out/payload"
mkdir -p "$p/sql" "$p/tree/promtail" "$p/tree/tls" \
  "$p/secrets/exporter" "$p/secrets/postgres-exporter" "$p/secrets/promtail"

# TLS: the server certificate must chain to the repo CA and name the bind IP.
write_secret "$p/secrets/exporter/tls.crt" "$HOST_TLS_CERT"
write_secret "$p/secrets/exporter/tls.key" "$HOST_TLS_KEY"
check_cert "$p/secrets/exporter/tls.crt" "$p/secrets/exporter/tls.key" "$ca_file" "$bind_ip"

# Exporter web config: the active user, plus the other user while a rotation
# is in progress.
users=$(printf '%s' "$EXPORTER_BASIC_AUTH_PASSWORD" | bcrypt_line "$exporter_user")
if [[ -n "$secondary" ]]; then
  users+=$'\n'$(printf '%s' "$secondary" | bcrypt_line "$(other_user "$exporter_user")")
fi
while IFS= read -r line; do
  if [[ "$line" == "  # @@BASIC_AUTH_USERS@@" ]]; then
    while IFS=: read -r user hash; do
      printf '  %s: "%s"\n' "$user" "$hash"
    done <<<"$users"
  else
    printf '%s\n' "$line"
  fi
done <"$agent_dir/web-config.yml.tmpl" >"$p/secrets/exporter/web-config.yml"

write_secret "$p/secrets/postgres-exporter/password" "$PG_MONITOR_PASSWORD"
verifier=$(printf '%s' "$PG_MONITOR_PASSWORD" | python3 "$here/scram-verifier.py")

{
  echo "dir exporter 65534"
  echo "file exporter/web-config.yml 65534"
  echo "file exporter/tls.crt 65534"
  echo "file exporter/tls.key 65534"
  echo "dir postgres-exporter 65534"
  echo "file postgres-exporter/password 65534"
  if [[ "$env_name" == prod ]]; then
    echo "dir promtail 0"
    echo "file promtail/push_password 0"
  fi
} >"$p/secrets/manifest"
if [[ "$env_name" == prod ]]; then
  write_secret "$p/secrets/promtail/push_password" "$LOKI_PUSH_PASSWORD"
fi

# Files installed into ~/monitoring-agent/ (non-secret, world-readable there).
cp "$agent_dir/docker-compose.agent.yml" "$p/tree/"
cp "$agent_dir/promtail/promtail-config.yml" "$p/tree/promtail/"
cp "$ca_file" "$p/tree/tls/ca.crt"
cp "$here/agent-deploy.sh" "$here/lib.sh" "$p/"
cp "$here/sql/session-quiet.sql" "$here/sql/reconcile-role.sql" "$p/sql/"

{
  echo "# Written by the Deploy Monitoring Agent workflow; local edits are overwritten."
  echo "AGENT_BIND_IP=$bind_ip"
  if [[ "$env_name" == prod ]]; then
    echo "COMPOSE_PROFILES=prod"
    echo "LOKI_PUSH_ADDR=$push_addr"
    echo "LOKI_PUSH_USER=$push_user"
  fi
} >"$p/env"

{
  echo "ETG_ENV=$env_name"
  echo "AGENT_BIND_IP=$bind_ip"
  echo "PROFILE=$profile"
  echo "EXPORTER_USER=$exporter_user"
  echo "LOKI_PUSH_ADDR=$push_addr"
  echo "LOKI_PUSH_USER=$push_user"
} >"$p/params"

# Services that read a changed input only at start are recreated by the host
# script. The exporters re-read web-config.yml and the certificate on every
# request, so only the database password matters for postgres-exporter.
{
  echo "postgres-exporter $(config_hash "$p" secrets/postgres-exporter/password)"
  if [[ "$env_name" == prod ]]; then
    echo "promtail $(config_hash "$p" tree/promtail/promtail-config.yml tree/tls/ca.crt \
      secrets/promtail/push_password env)"
  fi
} >"$p/config-hashes"

printf '%s\n%s\n%s\n' "$EXPORTER_BASIC_AUTH_PASSWORD" "$verifier" "${LOKI_PUSH_PASSWORD:-}" >"$out/stdin"
chmod -R go-rwx "$out"
log "agent payload for $env_name rendered"
