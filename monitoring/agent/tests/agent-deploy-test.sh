#!/usr/bin/env bash
# End-to-end test of the agent deploy (render-payload.sh + agent-deploy.sh)
# against the local Docker, with a stand-in app project (Postgres with every
# statement, duration and sampling log switched on). Covers:
#
#   - first deploy, repeat deploy, app and Postgres container IDs unchanged
#   - etg_monitor reads pg_stat_database, cannot read email_addresses
#   - compose up failing right after the password change restores the old
#     verifier and the exporter keeps scraping
#   - unexpected privileges fail the run and restore: an explicit grant, a
#     table privilege or a column SELECT granted to PUBLIC, and a privilege
#     that only the membership repair switches on (checked again after it)
#   - an interrupted run (SIGKILL) is restored by the next run; a restore
#     that cannot list the snapshot's services fails and keeps the marker
#     and the snapshot
#   - rollback with compose down, then redeploy
#   - a failed first deployment takes the agent down and leaves the role
#     without LOGIN
#   - prod profile: Promtail ships the app container's lines through the TLS
#     gateway to a local Loki with env="prod"; Postgres lines (which carry
#     attrs too) and every other container's lines do not arrive
#   - a refused push that has since recovered does not fail an unchanged
#     repeat deploy (refusals are counted over the verification window)
#   - a deliberately stopped Promtail stays stopped through a failed deploy
#   - neither the Postgres server log nor the deploy output contains a
#     verifier or a password, for successful ALTER ROLEs (the deploys) and a
#     failing one run through the deploy's own psql path (pg_quiet_raw), whose
#     unfiltered stderr is checked too
#
# Command output is captured before it is matched: `cmd | grep -q` can fail
# under pipefail when grep exits before cmd has written everything.
#
# Uses the real names (projects email-to-telegram and etg-agent, network
# email-to-telegram_internal, 127.0.0.1:9100 and :9187): run it on a machine
# where those do not exist, such as a CI runner. HOME is a temp directory.
# Needs docker, openssl, python3, curl, jq, flock.
#
#   bash monitoring/agent/tests/agent-deploy-test.sh
set -Eeuo pipefail

repo=$(cd "$(dirname "$0")/../../.." && pwd)
deploy_dir="$repo/monitoring/agent/deploy"
work=$(mktemp -d)
export HOME="$work/home"
mkdir -p "$HOME"
# shellcheck source=monitoring/agent/deploy/lib.sh
. "$deploy_dir/lib.sh"
app_compose="$work/app/docker-compose.yml"
transcript="$work/transcript.log"
: >"$transcript"

for name in email-to-telegram etg-agent; do
  if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$name")" ]]; then
    echo "compose project $name already exists here; refusing to run" >&2
    exit 1
  fi
done

cleanup() {
  set +e
  docker rm -f etg-agent-test-gw etg-agent-test-loki >/dev/null 2>&1
  (cd / && docker compose -p etg-agent down -v --remove-orphans) >/dev/null 2>&1
  docker network rm etg-agent_egress etg-agent-test-loki >/dev/null 2>&1
  docker compose -f "$app_compose" down -v >/dev/null 2>&1
  docker run --rm -v "$work:/w" busybox:1.37 rm -rf /w/home /w/snap >/dev/null 2>&1
  rm -rf "$work"
}
trap cleanup EXIT

step() { printf '\n=== %s\n' "$*"; }
fail() {
  echo "FAIL: $*" >&2
  echo "--- deploy output (tail) ---" >&2
  tail -n 80 "$transcript" >&2
  exit 1
}

# ------------------------------------------------------------ stand-in app

mkdir -p "$work/app"
cat >"$app_compose" <<'YAML'
name: email-to-telegram
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: emailtelegram
      POSTGRES_USER: emailtelegram
      POSTGRES_PASSWORD: test-only
    command:
      - postgres
      - -c
      - log_statement=all
      - -c
      - log_min_duration_statement=0
      - -c
      - log_min_duration_sample=0
      - -c
      - log_statement_sample_rate=1
      - -c
      - log_transaction_sample_rate=1
      - -c
      - log_min_error_statement=error
      - -c
      - log_duration=on
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U emailtelegram"]
      interval: 2s
      timeout: 5s
      retries: 30
    networks: [internal]
    # Worst case for the allowlist: Postgres lines carry attrs too.
    logging:
      driver: json-file
      options:
        labels: com.docker.compose.project,com.docker.compose.service
  app:
    image: busybox:1.37
    command:
      - sh
      - -c
      - |
        i=0
        while :; do
          i=$$((i + 1))
          printf '{"level":30,"msg":"stand-in app line %s"}\n' "$$i"
          sleep 1
        done
    networks: [internal]
    logging:
      driver: json-file
      options:
        labels: com.docker.compose.project,com.docker.compose.service
networks:
  internal:
    driver: bridge
YAML
step "starting the stand-in app"
docker compose -f "$app_compose" up -d --wait --quiet-pull
pg=$(docker compose -f "$app_compose" ps -q postgres)
docker exec -i "$pg" psql -q -U emailtelegram -d emailtelegram <<'SQL'
-- The app's only extension; the role checks must pass with it installed.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE email_addresses (id serial PRIMARY KEY, address text NOT NULL);
INSERT INTO email_addresses (address) VALUES ('someone@example.com');
SQL
app_ids() { docker ps -aq --no-trunc --filter label=com.docker.compose.project=email-to-telegram | sort; }
app_ids_initial=$(app_ids)

# ---------------------------------------------------------- certificates

tls="$work/tls"
mkdir -p "$tls"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 60 \
  -subj /CN=etg-test-ca -addext basicConstraints=critical,CA:TRUE \
  -addext keyUsage=critical,keyCertSign,cRLSign \
  -keyout "$tls/ca.key" -out "$tls/ca.crt" 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj /CN=127.0.0.1 \
  -keyout "$tls/host.key" -out "$tls/host.csr" 2>/dev/null
printf 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' >"$tls/ext"
openssl x509 -req -in "$tls/host.csr" -CA "$tls/ca.crt" -CAkey "$tls/ca.key" -CAcreateserial \
  -days 60 -extfile "$tls/ext" -out "$tls/host.crt" 2>/dev/null

# ------------------------------------------------------------- helpers

secret() { openssl rand -hex 24; }
exporter_pw=$(secret)
pg_pw1=$(secret)
pg_pw3=$(secret)
all_secrets=("$exporter_pw" "$pg_pw1" "$pg_pw3")

render() { # PG_PASSWORD OUT
  ETG_ENV=staging AGENT_BIND_IP=127.0.0.1 ETG_CA_FILE="$tls/ca.crt" HTPASSWD_VIA="" \
    HOST_TLS_CERT="$(cat "$tls/host.crt")" HOST_TLS_KEY="$(cat "$tls/host.key")" \
    PG_MONITOR_PASSWORD="$1" EXPORTER_BASIC_AUTH_PASSWORD="$exporter_pw" \
    bash "$deploy_dir/render-payload.sh" "$2" 2>>"$transcript"
}

render_prod() { # PG_PASSWORD OUT
  ETG_ENV=prod AGENT_BIND_IP=127.0.0.1 ETG_CA_FILE="$tls/ca.crt" HTPASSWD_VIA="" \
    HOST_TLS_CERT="$(cat "$tls/host.crt")" HOST_TLS_KEY="$(cat "$tls/host.key")" \
    PG_MONITOR_PASSWORD="$1" EXPORTER_BASIC_AUTH_PASSWORD="$exporter_pw" \
    LOKI_PUSH_ADDR="$gw_ip:3101" LOKI_PUSH_PASSWORD="$push_pw" \
    bash "$deploy_dir/render-payload.sh" "$2" 2>>"$transcript"
}

# deploy OUT : runs the host script like the workflow does; returns its status.
# The run's output is in OUT/out.log and appended to the transcript.
deploy() {
  local rc=0
  bash "$1/payload/agent-deploy.sh" "$1/payload" <"$1/stdin" >"$1/out.log" 2>&1 || rc=$?
  cat "$1/out.log" >>"$transcript"
  return "$rc"
}

# has FILE TEXT : FILE contains TEXT.
has() { grep -qF -- "$2" "$1"; }

verifier_now() {
  docker exec "$pg" psql -X -A -t -U emailtelegram -d emailtelegram \
    -c "SELECT coalesce(rolpassword, '-') FROM pg_authid WHERE rolname = 'etg_monitor'"
}
can_login() {
  docker exec "$pg" psql -X -A -t -U emailtelegram -d emailtelegram \
    -c "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'etg_monitor'"
}

pg_up() {
  local body
  body=$(printf 'user = "prometheus-a:%s"\n' "$exporter_pw" |
    curl -K - -fsS --max-time 10 --cacert "$tls/ca.crt" https://127.0.0.1:9187/metrics 2>/dev/null) || return 1
  grep -qx 'pg_up 1' <<<"$body"
}

# as_monitor PASSWORD SQL : runs SQL as etg_monitor over TCP (password auth).
as_monitor() {
  printf '%s\n' "$2" | docker exec -i -e PGPASSWORD="$1" "$pg" \
    psql -X -A -t -v ON_ERROR_STOP=1 -h 127.0.0.1 -U etg_monitor -d emailtelegram 2>&1
}

# ---------------------------------------------------------------- tests

step "1. first deploy"
render "$pg_pw1" "$work/r1"
deploy "$work/r1" || fail "first deploy failed (see transcript)"
pg_up || fail "pg_up is not 1 after the first deploy"
# The series the Operations dashboard's Host & database row queries.
scrape() {
  printf 'user = "prometheus-a:%s"\n' "$exporter_pw" |
    curl -K - -fsS --max-time 10 --cacert "$tls/ca.crt" "https://127.0.0.1:$1/metrics"
}
node_metrics=$(scrape 9100)
pg_metrics=$(scrape 9187)
for re in '^node_filesystem_avail_bytes\{[^}]*mountpoint="/"[,}]' '^node_filesystem_size_bytes\{[^}]*mountpoint="/"[,}]' \
  '^node_memory_MemAvailable_bytes ' '^node_load1 ' '^node_memory_SwapTotal_bytes ' '^node_memory_SwapFree_bytes '; do
  grep -Eq "$re" <<<"$node_metrics" || fail "node_exporter exposes no series matching $re"
done
for re in '^pg_up 1$' '^pg_stat_database_numbackends\{[^}]*datname="emailtelegram"' \
  '^pg_database_size_bytes\{[^}]*datname="emailtelegram"'; do
  grep -Eq "$re" <<<"$pg_metrics" || fail "postgres_exporter exposes no series matching $re"
done
v1=$(verifier_now)
[[ "$v1" == SCRAM-SHA-256* ]] || fail "no SCRAM verifier stored"
allowed=$(as_monitor "$pg_pw1" "SELECT count(*) > 0 FROM pg_stat_database;" || true)
[[ "$allowed" == t ]] || fail "etg_monitor cannot read pg_stat_database: $allowed"
denied=$(as_monitor "$pg_pw1" "SELECT count(*) FROM email_addresses;" || true)
grep -q 'permission denied for table email_addresses' <<<"$denied" ||
  fail "etg_monitor can read email_addresses: $denied"
agent_ids=$(docker ps -q --no-trunc --filter label=com.docker.compose.project=etg-agent | sort)

step "2. repeat deploy"
render "$pg_pw1" "$work/r2"
deploy "$work/r2" || fail "repeat deploy failed"
pg_up || fail "pg_up is not 1 after the repeat deploy"
v2=$(verifier_now)
[[ "$v2" != "$v1" ]] || fail "the verifier was not re-set (expected a new salt)"
[[ "$(docker ps -q --no-trunc --filter label=com.docker.compose.project=etg-agent | sort)" == "$agent_ids" ]] ||
  fail "an unchanged repeat deploy recreated agent containers"

step "3. compose up fails right after the password change"
render "$pg_pw3" "$work/r3"
sed -i 's/cpus: 0.25/cpus: 999/' "$work/r3/payload/tree/docker-compose.agent.yml"
if deploy "$work/r3"; then fail "deploy with a broken compose file succeeded"; fi
has "$work/r3/out.log" 'previous deployment restored' || fail "no restore after the failed compose up"
[[ "$(verifier_now)" == "$v2" ]] || fail "the old verifier was not restored"
[[ ! -e "$HOME/.etg-agent-restore-pending" ]] || fail "marker left after a successful restore"
pg_up || fail "the exporter does not scrape after the restore"
grep -q 'cpus: 0.25' "$HOME/monitoring-agent/docker-compose.agent.yml" || fail "the old compose file was not restored"

step "4. unexpected privileges fail the run, before and after the repairs"
as_owner() { docker exec "$pg" psql -q -v ON_ERROR_STOP=1 -U emailtelegram -d emailtelegram -c "$1"; }
reject_case=0
# reject DESCRIPTION EXPECTED_MESSAGE SETUP_SQL CLEANUP_SQL
reject() {
  reject_case=$((reject_case + 1))
  local out="$work/r4-$reject_case"
  as_owner "$3"
  render "$pg_pw1" "$out"
  if deploy "$out"; then fail "deploy succeeded with $1"; fi
  has "$out/out.log" "$2" || fail "$1 was not reported as: $2"
  has "$out/out.log" 'previous deployment restored' || fail "no restore after $1"
  [[ "$(verifier_now)" == "$v2" ]] || fail "verifier changed by the failed run ($1)"
  pg_up || fail "the exporter does not scrape after the failure ($1)"
  as_owner "$4"
  echo "rejected: $1"
}
reject "an explicit grant to etg_monitor" \
  'etg_monitor has unexpected privileges: grant on email_addresses' \
  'GRANT SELECT ON email_addresses TO etg_monitor' \
  'REVOKE SELECT ON email_addresses FROM etg_monitor'
reject "DELETE granted to PUBLIC" \
  'etg_monitor has unexpected privileges: DELETE on email_addresses' \
  'GRANT DELETE ON email_addresses TO PUBLIC' \
  'REVOKE DELETE ON email_addresses FROM PUBLIC'
reject "a column SELECT granted to PUBLIC" \
  'etg_monitor has unexpected privileges: column SELECT on email_addresses' \
  'GRANT SELECT (address) ON email_addresses TO PUBLIC' \
  'REVOKE SELECT (address) ON email_addresses FROM PUBLIC'
reject "a privilege only the membership repair switches on" \
  'etg_monitor has unexpected privileges after the repairs: SELECT on email_addresses' \
  'REVOKE pg_monitor FROM etg_monitor; GRANT pg_monitor TO etg_monitor WITH INHERIT FALSE; GRANT SELECT ON email_addresses TO pg_monitor' \
  'REVOKE SELECT ON email_addresses FROM pg_monitor; REVOKE pg_monitor FROM etg_monitor; GRANT pg_monitor TO etg_monitor'
render "$pg_pw1" "$work/r4-ok"
deploy "$work/r4-ok" || fail "deploy after removing the extra privileges failed"
v2=$(verifier_now)

step "5. interrupted run (SIGKILL), restored by the next run"
render "$pg_pw3" "$work/r5"
bash "$work/r5/payload/agent-deploy.sh" "$work/r5/payload" <"$work/r5/stdin" >>"$transcript" 2>&1 &
deploy_pid=$!
for _ in $(seq 1 600); do
  [[ -e "$HOME/.etg-agent-restore-pending" ]] && break
  sleep 0.1
done
[[ -e "$HOME/.etg-agent-restore-pending" ]] || fail "the marker never appeared"
sleep 1
kill -9 "$deploy_pid"
wait "$deploy_pid" 2>/dev/null || true
[[ -e "$HOME/.etg-agent-restore-pending" ]] || fail "SIGKILL did not leave the marker"
# A restore that cannot list the snapshot's services must fail and keep the
# marker and the snapshot, not report success with nothing restored.
snap_compose="$HOME/.etg-agent-snapshot/files/docker-compose.agent.yml"
cp "$snap_compose" "$work/snapshot-compose.good"
printf 'services: [broken\n' >>"$snap_compose"
render "$pg_pw3" "$work/r6a"
if deploy "$work/r6a"; then fail "a run whose restore cannot list the services succeeded"; fi
has "$work/r6a/out.log" 'cannot list the services of the restored compose file' ||
  fail "the failed service listing was not reported"
has "$work/r6a/out.log" 'failed; fix the host by hand' || fail "the failed restore did not stop the run"
[[ -e "$HOME/.etg-agent-restore-pending" ]] || fail "a failed restore removed the marker"
[[ -f "$HOME/.etg-agent-snapshot/complete" ]] || fail "a failed restore removed the snapshot"
cp "$work/snapshot-compose.good" "$snap_compose"
render "$pg_pw3" "$work/r6"
deploy "$work/r6" || fail "the run after the interruption failed"
has "$work/r6/out.log" 'an earlier agent deploy was interrupted' || fail "the next run did not restore first"
[[ ! -e "$HOME/.etg-agent-restore-pending" ]] || fail "marker left after the recovery run"
pg_up || fail "pg_up is not 1 after the recovery run"
v6=$(verifier_now)
one=$(as_monitor "$pg_pw3" "SELECT 1;" || true)
[[ "$one" == 1 ]] || fail "the new password does not log in: $one"

step "6. rollback (compose down) and redeploy"
docker compose -p etg-agent -f "$HOME/monitoring-agent/docker-compose.agent.yml" \
  --env-file "$HOME/monitoring-agent/.env" --profile prod down
[[ -z "$(docker ps -q --filter label=com.docker.compose.project=etg-agent)" ]] || fail "rollback left containers"
render "$pg_pw3" "$work/r7"
deploy "$work/r7" || fail "redeploy after rollback failed"
pg_up || fail "pg_up is not 1 after the redeploy"

[[ "$(app_ids)" == "$app_ids_initial" ]] || fail "app or Postgres container IDs changed"

step "7. failed first deployment"
(cd / && docker compose -p etg-agent down)
docker run --rm -v "$HOME:/h" busybox:1.37 rm -rf /h/monitoring-agent
docker exec "$pg" psql -q -U emailtelegram -d emailtelegram -c 'DROP ROLE etg_monitor'
render "$pg_pw1" "$work/r8"
sed -i 's/cpus: 0.25/cpus: 999/' "$work/r8/payload/tree/docker-compose.agent.yml"
if deploy "$work/r8"; then fail "a broken first deploy succeeded"; fi
[[ -z "$(docker ps -aq --filter label=com.docker.compose.project=etg-agent)" ]] || fail "the agent is not down"
[[ ! -e "$HOME/monitoring-agent" ]] || fail "the agent directory was left behind"
[[ "$(can_login)" == f ]] || fail "etg_monitor kept LOGIN after a failed first deployment"
[[ "$(verifier_now)" == "-" ]] || fail "etg_monitor kept a password after a failed first deployment"

step "8. prod profile: only the app's lines reach Loki, through the gateway"
# A local Loki behind the gateway (repo config, pinned images, compose
# container options). The gateway sits on the agent's egress network with a
# fixed address, the stand-in for 10.0.88.3:3101.
mon_compose="$repo/monitoring/docker-compose.monitoring.yml"
gw_ip=10.213.47.10
push_pw=$(secret)
all_secrets+=("$push_pw")
docker network create --subnet 10.213.47.0/24 \
  --label com.docker.compose.project=etg-agent --label com.docker.compose.network=egress \
  etg-agent_egress >/dev/null
docker network create etg-agent-test-loki >/dev/null
docker run -d --name etg-agent-test-loki --network etg-agent-test-loki --network-alias loki \
  --tmpfs /loki:uid=10001,gid=10001 -v "$repo/monitoring/loki:/etc/loki:ro" \
  "$(awk '/image: grafana\/loki:/ { print $2; exit }' "$mon_compose")" \
  -config.file=/etc/loki/loki-config.yml >/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$gw_ip" \
  -keyout "$tls/gw.key" -out "$tls/gw.csr" 2>/dev/null
printf 'subjectAltName=IP:%s\nextendedKeyUsage=serverAuth\n' "$gw_ip" >"$tls/gw.ext"
openssl x509 -req -in "$tls/gw.csr" -CA "$tls/ca.crt" -CAkey "$tls/ca.key" -CAcreateserial \
  -days 60 -extfile "$tls/gw.ext" -out "$tls/gw.crt" 2>/dev/null
mkdir -p "$work/gw-in/loki-gateway"
cp "$tls/gw.crt" "$work/gw-in/loki-gateway/tls.crt"
cp "$tls/gw.key" "$work/gw-in/loki-gateway/tls.key"
printf '%s' "$push_pw" | HTPASSWD_VIA="" bcrypt_line promtail-a >"$work/gw-in/loki-gateway/htpasswd"
printf '%s\n' "dir loki-gateway 101" "file loki-gateway/tls.crt 101" \
  "file loki-gateway/tls.key 101" "file loki-gateway/htpasswd 101" >"$work/gw-in/manifest"
install_secrets "$work/gw-in" "$HOME/gw-secrets"
docker create --name etg-agent-test-gw --network etg-agent-test-loki \
  --user 101:101 --read-only --tmpfs /tmp:size=8m,mode=1777 --cap-drop ALL \
  --security-opt no-new-privileges --memory 32m --cpus 0.25 --pids-limit 32 \
  -v "$repo/monitoring/loki-gateway:/etc/loki-gateway:ro" \
  -v "$HOME/gw-secrets/loki-gateway:/etc/loki-gateway-secrets:ro" \
  --entrypoint nginx "$(awk '/image: nginx:/ { print $2; exit }' "$mon_compose")" \
  -c /etc/loki-gateway/nginx.conf -g 'daemon off;' >/dev/null
docker network connect --ip "$gw_ip" etg-agent_egress etg-agent-test-gw
docker start etg-agent-test-gw >/dev/null
for _ in $(seq 1 60); do
  ready=$(docker exec etg-agent-test-loki wget -qO- http://127.0.0.1:3100/ready 2>/dev/null || true)
  [[ "$ready" == *ready* ]] && break
  sleep 2
done

render_prod "$pg_pw1" "$work/r9"
deploy "$work/r9" || fail "prod-profile deploy failed"
[[ -n "$(docker ps -q --filter label=com.docker.compose.project=etg-agent --filter label=com.docker.compose.service=promtail)" ]] ||
  fail "promtail is not running"
loki_query() { # LOGQL : instant query, prints the summed value
  docker exec etg-agent-test-loki wget -qO- \
    "http://127.0.0.1:3100/loki/api/v1/query?query=$(jq -rn --arg q "$1" '$q|@uri')" |
    jq -r '[.data.result[].value[1] | tonumber] | add // 0'
}
app_lines=0
for _ in $(seq 1 30); do
  app_lines=$(loki_query 'sum(count_over_time({env="prod", compose_project="email-to-telegram", service="app"}[1h]))')
  [[ "$app_lines" -gt 0 ]] && break
  sleep 2
done
[[ "$app_lines" -gt 0 ]] || fail "no prod app line reached Loki"
series=$(docker exec etg-agent-test-loki wget -qO- \
  "http://127.0.0.1:3100/loki/api/v1/series?match%5B%5D=$(jq -rn --arg q '{env="prod"}' '$q|@uri')")
others=$(jq -r '[.data[] | select(.service != "app" or .compose_project != "email-to-telegram")] | length' <<<"$series")
[[ "$others" == 0 ]] || fail "streams other than the app container reached Loki: $series"
labels=$(jq -c '[.data[] | keys] | add | unique' <<<"$series")
[[ "$labels" == '["compose_project","env","service","stream"]' ]] || fail "unexpected label set: $labels"
echo "prod app lines in Loki: $app_lines; streams: $(jq -c '[.data[]]' <<<"$series")"

step "8a. an earlier, recovered refusal does not fail the next deploy"
# Give the gateway another password until Promtail has a refused push on its
# lifetime counter, put the right one back, then deploy again unchanged.
gateway_password() { # PASSWORD : the gateway accepts promtail-a with PASSWORD
  printf '%s' "$1" | HTPASSWD_VIA="" bcrypt_line promtail-a >"$work/gw-in/loki-gateway/htpasswd"
  install_secrets "$work/gw-in" "$HOME/gw-secrets"
}
promtail_id() {
  docker ps -q --no-trunc --filter label=com.docker.compose.project=etg-agent \
    --filter label=com.docker.compose.service=promtail
}
promtail_rejections() {
  local m
  m=$(docker run --rm --network "container:$(promtail_id)" busybox:1.37 \
    wget -qO- http://127.0.0.1:9080/metrics 2>/dev/null) || m=""
  awk '/^promtail_request_duration_seconds_count\{.*status_code="4[0-9][0-9]"/ { n += $2 }
       END { printf "%d\n", n }' <<<"$m"
}
gateway_password "$(secret)"
for _ in $(seq 1 30); do
  (($(promtail_rejections) > 0)) && break
  sleep 2
done
(($(promtail_rejections) > 0)) || fail "promtail recorded no refused push against a wrong gateway password"
gateway_password "$push_pw"
promtail_before=$(promtail_id)
echo "promtail has $(promtail_rejections) refused push(es) on its counter; redeploying unchanged"
render_prod "$pg_pw1" "$work/r9b"
deploy "$work/r9b" || fail "a repeat deploy failed on an earlier, recovered refusal"
[[ "$(promtail_id)" == "$promtail_before" ]] || fail "the repeat deploy recreated promtail (counter not carried over)"
(($(promtail_rejections) > 0)) || fail "the refused push is no longer on the counter"

step "8b. a stopped Promtail stays stopped through a failed deploy"
agent_compose=(docker compose -p etg-agent -f "$HOME/monitoring-agent/docker-compose.agent.yml"
  --env-file "$HOME/monitoring-agent/.env")
"${agent_compose[@]}" stop promtail
render_prod "$pg_pw1" "$work/r10"
sed -i 's/cpus: 0.25/cpus: 999/' "$work/r10/payload/tree/docker-compose.agent.yml"
if deploy "$work/r10"; then fail "deploy with a broken compose file succeeded"; fi
has "$work/r10/out.log" 'previous deployment restored' || fail "no restore"
promtail_id=$(docker ps -aq --filter label=com.docker.compose.project=etg-agent --filter label=com.docker.compose.service=promtail)
[[ -n "$promtail_id" ]] || fail "the restore removed the stopped promtail"
[[ "$(docker inspect --format '{{.State.Running}}' "$promtail_id")" == false ]] || fail "the restore started promtail"
for svc in node-exporter postgres-exporter; do
  [[ -n "$(docker ps -q --filter label=com.docker.compose.project=etg-agent --filter "label=com.docker.compose.service=$svc")" ]] ||
    fail "$svc is not running after the restore"
done
pg_up || fail "pg_up is not 1 after the restore"

step "9. failing ALTER ROLE through the deploy's psql path, unfiltered stderr"
# pg_quiet_raw is what the deploy's pg_quiet runs, minus the stderr filter:
# the same preamble and psql flags. Its stderr must not hold the verifier
# without any filtering.
v_fail=$(printf '%s' "$(secret)" | python3 "$deploy_dir/scram-verifier.py")
rc=0
raw_err=$({
  printf "\\\\set verifier '%s'\n" "$v_fail"
  echo "ALTER ROLE etg_monitor_does_not_exist PASSWORD :'verifier';"
} | pg_quiet_raw "$pg" emailtelegram emailtelegram 2>&1 >/dev/null) || rc=$?
((rc != 0)) || fail "the ALTER ROLE for a missing role succeeded"
printf '%s\n' "$raw_err" >>"$transcript"
[[ "$raw_err" == *"does not exist"* ]] || fail "the ALTER ROLE did not fail as expected: $raw_err"
[[ "$raw_err" != *"$v_fail"* && "$raw_err" != *'SCRAM-SHA-256$'* ]] ||
  fail "psql's unfiltered stderr contains the verifier"

step "10. no verifier or password in the server log or the deploy output"
server_log=$(docker logs "$pg" 2>&1)
grep -q 'duration:' <<<"$server_log" || fail "server duration logging is not on"
grep -q 'statement: CREATE TABLE email_addresses' <<<"$server_log" || fail "server statement logging is not on"
for value in "$v1" "$v2" "$v6" "$v_fail" "${all_secrets[@]}"; do
  [[ -n "$value" ]] || continue
  grep -qF -- "$value" <<<"$server_log" && fail "a secret value reached the Postgres server log"
  grep -qF -- "$value" "$transcript" && fail "a secret value reached the deploy output"
done
grep -Eq 'SCRAM-SHA-256[$][0-9]+:' <<<"$server_log" && fail "a SCRAM verifier reached the Postgres server log"
grep -Eq 'SCRAM-SHA-256[$][0-9]+:' "$transcript" && fail "a SCRAM verifier reached the deploy output"

step "11. control: without the quiet preamble the server would log it"
v_ctrl=$(printf '%s' "$(secret)" | python3 "$deploy_dir/scram-verifier.py")
{
  printf "\\\\set verifier '%s'\n" "$v_ctrl"
  echo "ALTER ROLE etg_monitor_does_not_exist PASSWORD :'verifier';"
} | docker exec -i "$pg" psql -X -q -U emailtelegram -d emailtelegram >/dev/null 2>&1 || true
server_log=$(docker logs "$pg" 2>&1)
[[ "$server_log" == *"$v_ctrl"* ]] || fail "control: the unprotected verifier was not logged"

echo
echo "agent deploy test: all checks passed"
