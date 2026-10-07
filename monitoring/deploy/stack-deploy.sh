#!/usr/bin/env bash
# Host side of the staging monitoring stack deploy. Runs on the staging VM as
# the deploy user, from the payload that render-payload.sh built:
#
#   bash ~/.etg-incoming.XXXXXXXX/stack-deploy.sh ~/.etg-incoming.XXXXXXXX
#   stdin: the push password (verification only)
#
# Under the host lock: check .env and the push bind IP, sync config into
# ~/monitoring/ (directory mounts see replaced files), write the bearer tokens
# and secrets, bring the stack up, reload Prometheus, recreate services whose
# start-time config changed, wait for health, verify the push gateway.
set -Eeuo pipefail
set +x
umask 077

payload=$(cd "${1:?usage: stack-deploy.sh PAYLOAD_DIR}" && pwd)
# shellcheck source=monitoring/agent/deploy/lib.sh
. "$payload/lib.sh"

readonly STACK_DIR="$HOME/monitoring"
readonly COMPOSE_FILE=docker-compose.monitoring.yml

declare -A param=()
while IFS='=' read -r key value; do
  [[ -n "$key" ]] && param[$key]=$value
done <"$payload/params"
expected_ip=${param[LOKI_PUSH_BIND_IP]:-}
push_user=${param[LOKI_PUSH_USER]:-}
[[ "$expected_ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "bad LOKI_PUSH_BIND_IP in params"
check_user LOKI_PUSH_USER "$push_user" promtail-a promtail-b
IFS= read -r push_password || die "push password missing on stdin"

compose() {
  (cd "$STACK_DIR" && docker compose -f "$COMPOSE_FILE" --env-file .env "$@")
}

container_id() { compose ps -aq "$1" 2>/dev/null | head -n 1; }

services=(prometheus grafana loki loki-gateway promtail)

require_cmds docker flock ip curl rsync awk sed find
take_lock
log "monitoring stack deploy on $(hostname)"
find "$HOME" -maxdepth 1 -type d -name '.etg-incoming.*' -mmin +60 ! -path "$payload" \
  -exec rm -rf {} + 2>/dev/null || true

[[ -f "$STACK_DIR/.env" ]] ||
  die "$STACK_DIR/.env is missing on the host. Create it from monitoring/.env.example (see docs/operations/monitoring.md)."
bind_ip=$(sed -n 's/^LOKI_PUSH_BIND_IP=//p' "$STACK_DIR/.env" | tail -n 1 | tr -d "\"' ")
[[ -n "$bind_ip" ]] ||
  die "LOKI_PUSH_BIND_IP is not set in $STACK_DIR/.env; add LOKI_PUSH_BIND_IP=$expected_ip (see monitoring/.env.example)"
[[ "$bind_ip" == "$expected_ip" ]] ||
  die "LOKI_PUSH_BIND_IP in $STACK_DIR/.env is $bind_ip; the staging VM's address is $expected_ip"
host_has_ip "$bind_ip" || die "this host has no address $bind_ip"

docker network inspect monitoring_scrape >/dev/null 2>&1 || docker network create monitoring_scrape
ensure_image "$ETG_HELPER_IMAGE"

mkdir -p "$STACK_DIR/prometheus/secrets" "$STACK_DIR/.state"
# Prometheus (uid 65534) reads the token files through this directory, and
# rsync never touches it (excluded below); umask 077 would make it 0700.
chmod 0755 "$STACK_DIR/prometheus/secrets"
chmod 0700 "$STACK_DIR/.state"
# --exclude keeps the operator's .env, the token files, the secrets and the
# deploy state out of --delete. Files are written as temp + rename, so the
# directory mounts in running containers see them.
rsync -a --delete --chmod=D0755,F0644 \
  --exclude=/prometheus/secrets/ --exclude=/secrets/ --exclude=/.env --exclude=/.state/ \
  "$payload/tree/" "$STACK_DIR/"

# App /metrics bearer tokens: 0644 because Prometheus runs as nobody and the
# deploy user owns the file; the directory above is the deploy user's.
for file in "$payload"/bearer/*; do
  [[ -f "$file" ]] || continue
  token=$(basename "$file")
  install -m 0644 "$file" "$STACK_DIR/prometheus/secrets/.$token.new"
  mv -f "$STACK_DIR/prometheus/secrets/.$token.new" "$STACK_DIR/prometheus/secrets/$token"
done

install_secrets "$payload/secrets" "$STACK_DIR/secrets"
rm -rf "$payload/secrets" "$payload/bearer"
check_readable "$STACK_DIR/secrets/prometheus" 65534
check_readable "$STACK_DIR/secrets/loki-gateway" 101

declare -A before=()
for svc in "${services[@]}"; do
  before[$svc]=$(container_id "$svc")
done

compose pull --quiet
compose up -d --remove-orphans

# Scrape-job edits take effect on the next scrape. A failed reload is a
# failed deploy. compose up may have just recreated Prometheus, which then
# needs a while (WAL replay) before it answers.
deadline=$((SECONDS + 180))
until compose exec -T prometheus wget -qO- http://127.0.0.1:9090/-/ready >/dev/null 2>&1; do
  ((SECONDS < deadline)) || die "Prometheus did not become ready within 180s"
  sleep 3
done
compose exec -T prometheus wget -qO- --post-data= http://127.0.0.1:9090/-/reload >/dev/null
loaded=$(compose exec -T prometheus wget -qO- http://127.0.0.1:9090/api/v1/status/config)
grep -q 'job_name: node' <<<"$loaded" || die "Prometheus did not load the node job"
log "Prometheus config reloaded"

while read -r svc hash; do
  old=$(awk -v s="$svc" '$1 == s { print $2 }' "$STACK_DIR/.state/config-hashes" 2>/dev/null || true)
  [[ "$hash" == "$old" ]] && continue
  now=$(container_id "$svc")
  if [[ -n "${before[$svc]:-}" && "${before[$svc]}" == "$now" ]]; then
    log "config of $svc changed; recreating it"
    compose up -d --no-deps --force-recreate "$svc"
  fi
done <"$payload/config-hashes"

attempts=0
while true; do
  attempts=$((attempts + 1))
  all_healthy=true
  for svc in "${services[@]}"; do
    cid=$(compose ps -q "$svc" || true)
    if [[ -z "$cid" ]]; then
      all_healthy=false
      echo "$svc: no container yet"
      continue
    fi
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid")
    echo "$svc: $health"
    if [[ "$health" == unhealthy || "$health" == exited || "$health" == dead ]]; then
      docker logs "$cid" --tail 100
      exit 1
    fi
    [[ "$health" == healthy || "$health" == running ]] || all_healthy=false
  done
  [[ "$all_healthy" == true ]] && break
  if ((attempts >= 30)); then
    echo "Timed out waiting for monitoring stack to become healthy"
    for svc in "${services[@]}"; do
      cid=$(compose ps -q "$svc" || true)
      if [[ -n "$cid" ]]; then
        echo "=== logs for $svc ==="
        docker logs "$cid" --tail 100 || true
      fi
    done
    exit 1
  fi
  sleep 5
done

# The push gateway, as the prod collector sees it.
ca="$STACK_DIR/tls/ca.crt"
push="https://$bind_ip:3101/loki/api/v1/push"
empty=(-X POST -H 'Content-Type: application/json' --data-raw '{"streams":[]}')
got=$(http_status --cacert "$ca" "${empty[@]}" "$push")
[[ "$got" == 401 ]] || die "verify: push without credentials returned HTTP $got, expected 401"
got=$(http_status_auth "$push_user" "$push_password" --cacert "$ca" "$push")
[[ "$got" == 403 ]] || die "verify: GET on the push path returned HTTP $got, expected 403"
got=$(http_status_auth "$push_user" "$push_password" --cacert "$ca" "${empty[@]}" "$push")
[[ "$got" == 204 ]] || die "verify: authenticated empty push returned HTTP $got, expected 204"
got=$(http_status "http://$bind_ip:3101/loki/api/v1/push")
[[ "$got" != 2* ]] || die "verify: plain HTTP on 3101 returned HTTP $got"
log "push gateway verified on $bind_ip:3101"

install -m 0600 "$payload/config-hashes" "$STACK_DIR/.state/config-hashes"
echo "Monitoring stack healthy at $(date)"
compose ps
