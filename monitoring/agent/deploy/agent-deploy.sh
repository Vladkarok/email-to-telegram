#!/usr/bin/env bash
# Host side of the agent deploy. Runs on the VM as the deploy user, from the
# payload that render-payload.sh built and the workflow uploaded:
#
#   bash ~/.etg-incoming.XXXXXXXX/agent-deploy.sh ~/.etg-incoming.XXXXXXXX
#   stdin: exporter password, SCRAM verifier, push password (one per line)
#
# Order: host lock; restore a snapshot an interrupted run left behind; check
# the bind IP, the app network and a healthy Postgres (never creating either);
# pull images; snapshot the previous deployment (files, image IDs, the role's
# SCRAM verifier); arm the restore; install files, .env and secrets; reconcile
# the etg_monitor role; compose up; recreate services whose start-time inputs
# changed; verify. Any failure after the restore is armed, including an
# interruption, restores the snapshot. A run that cannot restore leaves
# ~/.etg-agent-restore-pending and the next run restores before anything else.
set -Eeuo pipefail
set +x
umask 077

payload=$(cd "${1:?usage: agent-deploy.sh PAYLOAD_DIR}" && pwd)
# shellcheck source=monitoring/agent/deploy/lib.sh
. "$payload/lib.sh"

readonly AGENT_DIR="$HOME/monitoring-agent"
readonly SNAPSHOT_DIR="$HOME/.etg-agent-snapshot"
readonly MARKER="$HOME/.etg-agent-restore-pending"
readonly RESTORE_LOG="$HOME/.etg-agent-restore.log"
readonly PROJECT=etg-agent
readonly APP_PROJECT=email-to-telegram
readonly APP_NETWORK=email-to-telegram_internal
readonly PG_SUPERUSER=emailtelegram
readonly PG_DATABASE=emailtelegram
readonly WAIT_SECONDS=120
# shellcheck disable=SC2016 # a regex, not an expansion
readonly VERIFIER_RE='^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'

# ------------------------------------------------------------------ inputs

declare -A param=()
while IFS='=' read -r key value; do
  [[ -n "$key" ]] && param[$key]=$value
done <"$payload/params"
env_name=${param[ETG_ENV]:-}
bind_ip=${param[AGENT_BIND_IP]:-}
profile=${param[PROFILE]:-}
exporter_user=${param[EXPORTER_USER]:-}
push_addr=${param[LOKI_PUSH_ADDR]:-}
push_user=${param[LOKI_PUSH_USER]:-}
check_user ETG_ENV "$env_name" staging prod
[[ "$bind_ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "bad AGENT_BIND_IP in params"
check_user EXPORTER_USER "$exporter_user" prometheus-a prometheus-b

IFS= read -r exporter_password || die "exporter password missing on stdin"
IFS= read -r verifier || die "SCRAM verifier missing on stdin"
IFS= read -r push_password || push_password=""
[[ "$verifier" =~ $VERIFIER_RE ]] || die "the SCRAM verifier on stdin is malformed"

services=(node-exporter postgres-exporter)
if [[ "$env_name" == prod ]]; then
  [[ "$profile" == prod ]] || die "prod deploys use the prod profile"
  check_user LOKI_PUSH_USER "$push_user" promtail-a promtail-b
  [[ "$push_addr" =~ ^[0-9.]+:[0-9]+$ ]] || die "bad LOKI_PUSH_ADDR in params"
  [[ -n "$push_password" ]] || die "push password missing on stdin"
  services+=(promtail)
fi

# ----------------------------------------------------------------- helpers

compose() {
  docker compose -p "$PROJECT" -f "$AGENT_DIR/docker-compose.agent.yml" \
    --env-file "$AGENT_DIR/.env" ${profile:+--profile "$profile"} "$@"
}

# container_of PROJECT SERVICE [-a] : ID of the compose service's container.
container_of() {
  docker ps ${3:+-a} -q --no-trunc \
    --filter "label=com.docker.compose.project=$1" \
    --filter "label=com.docker.compose.service=$2" | head -n 1
}

app_container_ids() {
  docker ps -aq --no-trunc --filter "label=com.docker.compose.project=$APP_PROJECT" | sort
}

# psql_quiet : runs session-quiet.sql and then stdin as the database owner.
# stderr loses every line that mentions a SCRAM verifier.
psql_quiet() {
  local pg
  pg=$(container_of "$APP_PROJECT" postgres)
  [[ -n "$pg" ]] || {
    log "no running $APP_PROJECT postgres container"
    return 1
  }
  { cat "$payload/sql/session-quiet.sql" -; } |
    docker exec -i "$pg" psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=terse \
      -U "$PG_SUPERUSER" -d "$PG_DATABASE" 2> >(sed '/SCRAM-/d' >&2)
}

# role_state : "login|nologin <verifier|->", or nothing when the role is absent.
role_state() {
  psql_quiet <<'SQL'
SELECT CASE WHEN rolcanlogin THEN 'login' ELSE 'nologin' END || ' ' || coalesce(rolpassword, '-')
FROM pg_authid WHERE rolname = 'etg_monitor';
SQL
}

# restore_role STATE : puts the role back as role_state recorded it. A role
# that did not exist is left in place without LOGIN and without a password.
restore_role() {
  local state=$1 login old
  if [[ -z "$state" ]]; then
    psql_quiet <<'SQL'
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etg_monitor') THEN
    ALTER ROLE etg_monitor NOLOGIN PASSWORD NULL;
  END IF;
END
$$;
SQL
    return
  fi
  login=${state%% *}
  old=${state#* }
  case $login in
    login) login=LOGIN ;;
    nologin) login=NOLOGIN ;;
    *)
      log "unreadable role state in the snapshot"
      return 1
      ;;
  esac
  if [[ "$old" == "-" ]]; then
    {
      printf '\\set login %s\n' "$login"
      cat <<'SQL'
ALTER ROLE etg_monitor :login PASSWORD NULL;
SQL
    } | psql_quiet
    return
  fi
  [[ "$old" =~ $VERIFIER_RE ]] || {
    log "the snapshot's verifier is malformed"
    return 1
  }
  {
    printf '\\set login %s\n' "$login"
    printf "\\\\set verifier '%s'\n" "$old"
    cat <<'SQL'
ALTER ROLE etg_monitor :login PASSWORD :'verifier';
SQL
  } | psql_quiet
}

reconcile_role() {
  {
    printf "\\\\set verifier '%s'\n" "$verifier"
    cat "$payload/sql/reconcile-role.sql"
  } | psql_quiet
}

# clear_dir DIR : empties DIR, whatever the owners of its files.
clear_dir() {
  [[ -d "$1" ]] || return 0
  run_helper -v "$1:/d" "$ETG_HELPER_IMAGE" sh -c 'rm -rf /d/* /d/.[!.]* /d/..?*'
}

clear_snapshot() {
  clear_dir "$SNAPSHOT_DIR" && rm -rf "$SNAPSHOT_DIR"
}

take_snapshot() {
  local cid
  clear_snapshot
  mkdir -m 0700 "$SNAPSHOT_DIR"
  if [[ -f "$AGENT_DIR/docker-compose.agent.yml" ]]; then
    mkdir -m 0700 "$SNAPSHOT_DIR/files"
    run_helper -v "$AGENT_DIR:/src:ro" -v "$SNAPSHOT_DIR/files:/dst" "$ETG_HELPER_IMAGE" \
      cp -a /src/. /dst/
    : >"$SNAPSHOT_DIR/containers"
    for cid in $(docker ps -aq --no-trunc --filter "label=com.docker.compose.project=$PROJECT"); do
      docker inspect --format \
        '{{index .Config.Labels "com.docker.compose.service"}} {{.Config.Image}} {{.Image}} {{.State.Running}}' \
        "$cid" >>"$SNAPSHOT_DIR/containers"
    done
  else
    : >"$SNAPSHOT_DIR/first-deploy"
  fi
  role_state >"$SNAPSHOT_DIR/role"
  : >"$SNAPSHOT_DIR/complete"
  log "snapshot of the previous deployment taken"
}

# restore : puts back the deployment recorded by take_snapshot. Output goes
# to RESTORE_LOG too, so it survives a dropped SSH session.
restore() {
  local rc=0 svc ref id _running
  : >"$RESTORE_LOG"
  [[ -f "$SNAPSHOT_DIR/complete" ]] || {
    log "no complete snapshot in $SNAPSHOT_DIR; nothing to restore from"
    return 1
  }
  {
    echo "restore started $(date -u +%FT%TZ)"
    if [[ -f "$SNAPSHOT_DIR/first-deploy" ]]; then
      echo "first deployment: taking the agent down"
      (cd / && docker compose -p "$PROJECT" down --remove-orphans) || rc=1
      { clear_dir "$AGENT_DIR" && rm -rf "$AGENT_DIR"; } || rc=1
    else
      clear_dir "$AGENT_DIR" || rc=1
      run_helper -v "$SNAPSHOT_DIR/files:/src:ro" -v "$AGENT_DIR:/dst" "$ETG_HELPER_IMAGE" \
        cp -a /src/. /dst/ || rc=1
      while read -r svc ref id _running; do
        [[ -n "$ref" ]] || continue
        echo "image for $svc: $ref"
        docker tag "$id" "$ref" 2>/dev/null || docker pull -q "$ref" || rc=1
      done <"$SNAPSHOT_DIR/containers"
    fi
    echo "restoring the etg_monitor role"
    if [[ -f "$SNAPSHOT_DIR/first-deploy" ]]; then
      # No earlier deployment: the role stays, without LOGIN and password.
      restore_role "" || rc=1
    else
      restore_role "$(cat "$SNAPSHOT_DIR/role")" || rc=1
    fi
    if [[ ! -f "$SNAPSHOT_DIR/first-deploy" ]]; then
      if grep -q ' true$' "$SNAPSHOT_DIR/containers"; then
        compose up -d --force-recreate --remove-orphans --pull never || rc=1
      else
        compose down --remove-orphans || rc=1
      fi
    fi
    echo "restore finished $(date -u +%FT%TZ), status $rc"
  } >>"$RESTORE_LOG" 2>&1
  cat "$RESTORE_LOG" >&2 || true
  return "$rc"
}

armed=0
on_exit() {
  local rc=$?
  set +e
  trap - EXIT
  trap '' HUP INT TERM PIPE
  if ((armed)) && ((rc != 0)); then
    log "agent deploy failed (exit $rc); restoring the previous deployment"
    if restore; then
      rm -f "$MARKER"
      clear_snapshot
      log "previous deployment restored"
    else
      log "RESTORE FAILED. $MARKER is kept: the next run restores from $SNAPSHOT_DIR first."
      log "See $RESTORE_LOG on the host."
    fi
  fi
  exit "$rc"
}
trap on_exit EXIT
trap 'log "failed at line $LINENO: $BASH_COMMAND"' ERR
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

wait_for_app() {
  local deadline=$((SECONDS + WAIT_SECONDS)) pg health
  while :; do
    if docker network inspect "$APP_NETWORK" >/dev/null 2>&1; then
      pg=$(container_of "$APP_PROJECT" postgres)
      if [[ -n "$pg" ]]; then
        health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$pg")
        [[ "$health" == healthy ]] && return 0
      fi
    fi
    ((SECONDS < deadline)) ||
      die "network $APP_NETWORK or a healthy $APP_PROJECT postgres did not appear within ${WAIT_SECONDS}s"
    sleep 5
  done
}

install_files() {
  local rel dst dir
  mkdir -p "$AGENT_DIR/.state"
  chmod 0755 "$AGENT_DIR"
  chmod 0700 "$AGENT_DIR/.state"
  (cd "$payload/tree" && find . -type f | sed 's|^\./||' | LC_ALL=C sort) >"$payload/files"
  while IFS= read -r rel; do
    dst="$AGENT_DIR/$rel"
    dir=$(dirname "$dst")
    mkdir -p "$dir"
    chmod 0755 "$dir"
    # Temp file + rename inside the mounted directory: a running container
    # sees the new file.
    install -m 0644 "$payload/tree/$rel" "$dst.new.$$"
    mv -f "$dst.new.$$" "$dst"
  done <"$payload/files"
  if [[ -f "$AGENT_DIR/.state/files" ]]; then
    LC_ALL=C comm -23 "$AGENT_DIR/.state/files" "$payload/files" | while IFS= read -r rel; do
      rm -f "$AGENT_DIR/$rel"
    done
  fi
  install -m 0600 "$payload/files" "$AGENT_DIR/.state/files"
  install -m 0644 "$payload/env" "$AGENT_DIR/.env.new.$$"
  mv -f "$AGENT_DIR/.env.new.$$" "$AGENT_DIR/.env"
}

service_ids() {
  local svc
  for svc in "${services[@]}"; do
    printf '%s %s\n' "$svc" "$(container_of "$PROJECT" "$svc" -a)"
  done
}

# recreate_changed IDS_BEFORE_UP : force-recreates a service whose start-time
# inputs changed when compose up kept its container.
recreate_changed() {
  local before=$1 svc hash old before_id now_id
  while read -r svc hash; do
    [[ " ${services[*]} " == *" $svc "* ]] || continue
    old=$(awk -v s="$svc" '$1 == s { print $2 }' "$AGENT_DIR/.state/config-hashes" 2>/dev/null || true)
    [[ "$hash" == "$old" ]] && continue
    before_id=$(awk -v s="$svc" '$1 == s { print $2 }' <<<"$before")
    now_id=$(container_of "$PROJECT" "$svc" -a)
    if [[ -n "$before_id" && "$before_id" == "$now_id" ]]; then
      log "inputs of $svc changed; recreating it"
      compose up -d --no-deps --force-recreate --pull never "$svc"
    fi
  done <"$payload/config-hashes"
}

retry_until() {
  local deadline=$((SECONDS + $1))
  shift
  until "$@"; do
    ((SECONDS < deadline)) || return 1
    sleep 2
  done
}

# metrics_match URL REGEX : authenticated scrape whose body matches REGEX.
metrics_match() {
  local body
  body=$(curl_auth "$exporter_user" "$exporter_password" -fsS --max-time 10 \
    --cacert "$AGENT_DIR/tls/ca.crt" "$1" 2>/dev/null) || return 1
  grep -Eq "$2" <<<"$body"
}

expect_status() {
  local want=$1 what=$2 got
  shift 2
  got=$(http_status "$@")
  [[ "$got" == "$want" ]] || die "verify: $what returned HTTP $got, expected $want"
}

expect_not_ok() {
  local what=$1 got
  shift
  got=$(http_status "$@")
  [[ "$got" != 2* ]] || die "verify: $what returned HTTP $got"
}

promtail_ready() {
  local cid ready
  cid=$(container_of "$PROJECT" promtail)
  [[ -n "$cid" ]] || return 1
  ready=$(docker run --rm --network "container:$cid" "$ETG_HELPER_IMAGE" \
    wget -qO- http://127.0.0.1:9080/ready 2>/dev/null) || return 1
  [[ "$ready" == *Ready* ]]
}

verify() {
  local ca="$AGENT_DIR/tls/ca.crt" base="https://$bind_ip" svc cid state restarts=() i=0 got wrong
  wrong="wrong-$(date +%s%N)"

  retry_until 60 metrics_match "$base:9100/metrics" '^node_exporter_build_info' ||
    die "verify: node_exporter does not answer an authenticated scrape on $base:9100"
  retry_until 60 metrics_match "$base:9187/metrics" '^pg_up 1$' ||
    die "verify: postgres_exporter does not report pg_up 1 on $base:9187"
  if ! metrics_match "$base:9100/metrics" '^node_textfile_scrape_error 0$'; then
    log "::warning::node_exporter cannot read /var/lib/node_exporter/textfile yet (re-run infra/offsite-backup/install.sh)"
  fi

  for port in 9100 9187; do
    expect_status 401 "port $port without credentials" --cacert "$ca" "$base:$port/metrics"
    got=$(http_status_auth "$exporter_user" "$wrong" --cacert "$ca" "$base:$port/metrics")
    [[ "$got" == 401 ]] || die "verify: port $port with a wrong password returned HTTP $got"
    expect_not_ok "plain HTTP on port $port" "http://$bind_ip:$port/metrics"
  done

  if [[ "$env_name" == prod ]]; then
    retry_until 60 promtail_ready || die "verify: promtail is not ready"
    expect_status 401 "the push gateway without credentials" --cacert "$ca" \
      -X POST -H 'Content-Type: application/json' --data-raw '{"streams":[]}' \
      "https://$push_addr/loki/api/v1/push"
    got=$(curl_auth "$push_user" "$push_password" -s -o /dev/null -w '%{http_code}' --max-time 10 \
      --cacert "$ca" -X POST -H 'Content-Type: application/json' --data-raw '{"streams":[]}' \
      "https://$push_addr/loki/api/v1/push" || true)
    [[ "$got" == 204 ]] || die "verify: an authenticated empty push to https://$push_addr returned HTTP $got, expected 204"
  fi

  # Running and not restarting, twice, ten seconds apart.
  for svc in "${services[@]}"; do
    cid=$(container_of "$PROJECT" "$svc")
    [[ -n "$cid" ]] || die "verify: $svc is not running"
    restarts+=("$(docker inspect --format '{{.RestartCount}}' "$cid")")
  done
  sleep 10
  for svc in "${services[@]}"; do
    cid=$(container_of "$PROJECT" "$svc")
    [[ -n "$cid" ]] || die "verify: $svc stopped"
    state=$(docker inspect --format '{{.State.Running}} {{.RestartCount}}' "$cid")
    [[ "$state" == "true ${restarts[$i]}" ]] || die "verify: $svc is restarting"
    i=$((i + 1))
  done

  [[ "$(app_container_ids)" == "$app_ids_before" ]] ||
    die "verify: the app project's containers changed during the agent deploy"
}

remove_stale_uploads() {
  find "$HOME" -maxdepth 1 -type d -name '.etg-incoming.*' -mmin +60 ! -path "$payload" \
    -exec rm -rf {} + 2>/dev/null || true
}

# -------------------------------------------------------------------- main

require_cmds docker flock ip curl sha256sum awk sed find install comm
take_lock
log "agent deploy: $env_name, $bind_ip, profile '${profile:-none}'"
remove_stale_uploads

host_has_ip "$bind_ip" || die "this host has no address $bind_ip; refusing to bind the agent there"
grep -qxF "AGENT_BIND_IP=$bind_ip" "$payload/env" || die "the payload .env does not bind to $bind_ip"
ensure_image "$ETG_HELPER_IMAGE"
wait_for_app
app_ids_before=$(app_container_ids)

if [[ -e "$MARKER" ]]; then
  log "an earlier agent deploy was interrupted; restoring its snapshot first"
  restore || die "restore from $SNAPSHOT_DIR failed; fix the host by hand, then remove $MARKER"
  rm -f "$MARKER"
  clear_snapshot
fi

docker compose -p "$PROJECT" -f "$payload/tree/docker-compose.agent.yml" --env-file "$payload/env" \
  ${profile:+--profile "$profile"} pull --quiet

take_snapshot
date -u +%FT%TZ >"$MARKER"
armed=1 # from here on every failure restores the snapshot

install_files
install_secrets "$payload/secrets" "$AGENT_DIR/secrets"
rm -rf "$payload/secrets"
check_readable "$AGENT_DIR/secrets/exporter" 65534
check_readable "$AGENT_DIR/secrets/postgres-exporter" 65534
if [[ "$env_name" == prod ]]; then
  check_readable "$AGENT_DIR/secrets/promtail" 0
fi

reconcile_role
log "etg_monitor reconciled"

ids_before_up=$(service_ids)
compose up -d --remove-orphans --pull never
recreate_changed "$ids_before_up"
verify

install -m 0600 "$payload/config-hashes" "$AGENT_DIR/.state/config-hashes"
armed=0
rm -f "$MARKER"
clear_snapshot
log "agent deploy complete: $(compose ps --format '{{.Service}} {{.State}}' | tr '\n' ' ')"
