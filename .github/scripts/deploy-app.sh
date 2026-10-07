#!/usr/bin/env bash
# Deploy the app container on this host: pull, migrate first, replace, verify,
# and roll back to the previous image when the new one is not healthy and
# ready in time.
#
# The three app deploy jobs (Deploy on a tag push or a dispatch, Deploy
# Staging) copy this file next to docker-compose.yml and run it there, under
# the host lock (~/.etg-deploy.lock) and after `docker login`:
#
#   IMAGE_TAG=v1.2.3 DEPLOY_TOOLING_COMMIT=<sha> bash deploy-app.sh </dev/null
#
# By hand, take the lock yourself:
#
#   flock -w 900 ~/.etg-deploy.lock env IMAGE_TAG=<tag> bash ~/email-to-telegram/deploy-app.sh </dev/null
#
# Stages and their time bounds: pull 600 s, migrate 300 s, replace 120 s,
# health 90 s; rollback 120 s plus 90 s. An availability probe requests
# http://$HOST_BIND_IP:3000/readyz every 2 s from before the migration until
# the end, and every run that gets that far prints its report.
#
# Exit status: 0 deployed; 1 for everything else (nothing replaced, rolled
# back, or rollback failed: the last line says which); 128+n on a signal. A
# run interrupted by a signal does not roll back.
#
# Reads no secret. From .env it reads only the HOST_BIND_IP line.

set -euo pipefail

readonly IMAGE_REPO=ghcr.io/vladkarok/email-to-telegram
readonly PREVIOUS_TAG=deploy-previous
readonly MIGRATE_CONTAINER=etg-migrate
# Stage bounds in seconds. The ETG_DEPLOY_* overrides exist for the tests.
readonly PULL_TIMEOUT=${ETG_DEPLOY_PULL_TIMEOUT:-600}
readonly MIGRATE_TIMEOUT=${ETG_DEPLOY_MIGRATE_TIMEOUT:-300}
readonly REPLACE_TIMEOUT=${ETG_DEPLOY_REPLACE_TIMEOUT:-120}
readonly HEALTH_TIMEOUT=${ETG_DEPLOY_HEALTH_TIMEOUT:-90}
# Probe and health check interval in seconds; may be fractional.
readonly POLL_INTERVAL=${ETG_DEPLOY_POLL_INTERVAL:-2}
# A stage that ignores SIGTERM at its bound gets SIGKILL this much later.
readonly KILL_AFTER=10

export TZ=UTC

say() { printf '%s\n' "$*"; }

# ------------------------------------------------------------------ helpers

now_ms() {
  local us=${EPOCHREALTIME//[!0-9]/}
  printf '%s\n' "$((us / 1000))"
}

# to_ms SECONDS : "2" -> 2000, "0.25" -> 250.
to_ms() {
  local s=$1 int frac=000
  int=${s%%.*}
  if [[ $s == *.* ]]; then
    frac=${s#*.}000
    frac=${frac:0:3}
  fi
  printf '%s\n' "$((10#$int * 1000 + 10#$frac))"
}

sleep_ms() {
  local ms=$1
  ((ms > 0)) || return 0
  sleep "$((ms / 1000)).$(printf '%03d' "$((ms % 1000))")"
}

# secs MS : "4.4 s"
secs() {
  printf '%d.%d s' "$(($1 / 1000))" "$((($1 % 1000) / 100))"
}

# clock MS : "12:00:05"
clock() {
  printf '%(%H:%M:%S)T' "$(($1 / 1000))"
}

# env_value KEY : the value of KEY in ./.env. The file is not sourced and no
# other line of it is printed. Handles `export `, quotes, a trailing comment
# after an unquoted value and CRLF line ends; the last assignment wins.
env_value() {
  awk -v key="$1" -v sq="'" -v dq='"' '
    {
      sub(/\r$/, "")
      line = $0
      sub(/^[ \t]*/, "", line)
      sub(/^export[ \t]+/, "", line)
      eq = index(line, "=")
      if (eq == 0) next
      name = substr(line, 1, eq - 1)
      sub(/[ \t]+$/, "", name)
      if (name != key) next
      value = substr(line, eq + 1)
      sub(/^[ \t]+/, "", value)
      q = substr(value, 1, 1)
      if (q == sq || q == dq) {
        value = substr(value, 2)
        end = index(value, q)
        if (end > 0) value = substr(value, 1, end - 1)
      } else {
        sub(/[ \t]+#.*$/, "", value)
        sub(/[ \t]+$/, "", value)
      }
      found = value
    }
    END { print found }
  ' .env
}

compose() {
  docker compose --env-file .env "$@"
}

# ------------------------------------------------------------ availability

PROBE_PID=""
PROBE_LOG=""
PROBE_URL=""

# Runs in the background: one GET /readyz per interval, 1-s timeout, one
# "<epoch ms> <status>" line per sample (000 = no answer). It stops on
# SIGTERM, taking its curl or sleep with it, and on its own once this
# script's process is gone.
probe_loop() {
  set +e
  local child="" t now next code
  trap '[[ -n $child ]] && kill "$child" 2>/dev/null && wait "$child" 2>/dev/null; exit 0' TERM
  trap '' HUP INT
  while kill -0 "$MAIN_PID" 2>/dev/null; do
    t=$(now_ms)
    curl -s -o /dev/null -w '%{http_code}' --max-time 1 "$PROBE_URL" >"$WORK_DIR/probe.out" 2>/dev/null </dev/null &
    child=$!
    wait "$child"
    child=""
    code=$(<"$WORK_DIR/probe.out")
    [[ $code =~ ^[0-9]{3}$ ]] || code=000
    printf '%s %s\n' "$t" "$code" >>"$PROBE_LOG"
    now=$(now_ms)
    next=$((t + POLL_MS))
    if ((now < next)); then
      sleep_ms "$((next - now))" &
      child=$!
      wait "$child"
      child=""
    fi
  done
}

start_probe() {
  PROBE_LOG=$WORK_DIR/probe.log
  : >"$PROBE_LOG"
  probe_loop &
  PROBE_PID=$!
  say "availability probe: GET $PROBE_URL every ${POLL_INTERVAL}s, 1-s timeout"
}

stop_probe() {
  [[ -n $PROBE_PID ]] || return 0
  kill -TERM "$PROBE_PID" 2>/dev/null
  wait "$PROBE_PID" 2>/dev/null
  PROBE_PID=""
}

# probe_up_since MS : the latest sample was taken at or after MS and got 200.
probe_up_since() {
  local since=$1 last ts code
  [[ -s $PROBE_LOG ]] || return 1
  last=$(tail -n 1 "$PROBE_LOG")
  read -r ts code <<<"$last"
  [[ ${ts:-} =~ ^[0-9]+$ && ${code:-} == 200 ]] && ((ts >= since))
}

probe_last() {
  local last
  last=$(tail -n 1 "$PROBE_LOG" 2>/dev/null)
  if [[ -n $last ]]; then say "${last#* }"; else say "no sample"; fi
}

print_report() {
  [[ -n $PROBE_LOG && -f $PROBE_LOG ]] || return 0
  local ts code down_start="" last_ts="" total=0 count=0 samples=0 saw429=0 len
  say "---- availability report (host-local, $PROBE_URL, ${POLL_INTERVAL}-s resolution, UTC) ----"
  while read -r ts code; do
    [[ ${ts:-} =~ ^[0-9]+$ && ${code:-} =~ ^[0-9]{3}$ ]] || continue
    samples=$((samples + 1))
    [[ $code != 429 ]] || saw429=1
    if [[ $code != 200 ]]; then
      [[ -n $down_start ]] || down_start=$ts
    elif [[ -n $down_start ]]; then
      len=$((ts - down_start))
      say "down $(clock "$down_start") -> $(clock "$ts") ($(secs "$len"))"
      total=$((total + len))
      count=$((count + 1))
      down_start=""
    fi
    last_ts=$ts
  done <"$PROBE_LOG"
  if [[ -n $down_start ]]; then
    len=$((last_ts - down_start))
    say "down $(clock "$down_start") -> not recovered (at least $(secs "$len") when the probe stopped)"
    total=$((total + len))
    count=$((count + 1))
  fi
  if ((samples == 0)); then
    say "no probe samples"
  elif ((count == 0)); then
    say "never down ($samples samples)"
  else
    say "total down: $(secs "$total") in $count interval(s), $samples samples"
  fi
  if ((saw429)); then
    say "unreliable: /readyz answered 429, so another client shares this address's rate limit"
  fi
  say "migration: ${migrate_result:-not run}"
  if [[ -n $deploy_healthy ]]; then
    say "time to healthy: $deploy_healthy after replacement started"
  elif ((replaced)); then
    say "time to healthy: never healthy"
  else
    say "replacement: not started"
  fi
  if [[ -n $rollback_healthy ]]; then
    say "time to healthy (rollback): $rollback_healthy after the rollback started"
  fi
  say "----"
}

# ----------------------------------------------------------------- replace

current_cid=""
fail_reason=""
healthy_ms=""

# replace_and_verify TAG LABEL [UP_ARGS...] : compose up with IMAGE_TAG=TAG,
# then wait until Docker reports healthy and the probe gets 200. Returns 1
# with fail_reason set on any failure; sets current_cid and healthy_ms.
replace_and_verify() {
  local tag=$1 label=$2 start up_end rc out cid info health state restarts restart_base deadline now
  shift 2
  current_cid=""
  healthy_ms=""
  fail_reason=""
  start=$(now_ms)
  say "$label: docker compose up -d${*:+ $*} --no-build with IMAGE_TAG=$tag (at most ${REPLACE_TIMEOUT}s)"
  IMAGE_TAG=$tag timeout -k "$KILL_AFTER" "$REPLACE_TIMEOUT" \
    docker compose --env-file .env up -d "$@" --no-build </dev/null
  rc=$?
  up_end=$(now_ms)
  if ((rc == 124 || rc == 137)); then
    fail_reason="compose up timed out after ${REPLACE_TIMEOUT}s"
    return 1
  elif ((rc != 0)); then
    fail_reason="compose up failed (exit $rc)"
    return 1
  fi
  say "$label: compose up finished in $(secs "$((up_end - start))")"

  out=$(IMAGE_TAG=$tag compose ps -q app 2>&1)
  rc=$?
  cid=${out%%$'\n'*}
  if ((rc != 0)) || [[ ! $cid =~ ^[0-9a-f]{12,64}$ ]]; then
    fail_reason="no app container ID after compose up"
    return 1
  fi
  current_cid=$cid
  # Compose may keep the running container when nothing changed; its earlier
  # restarts are not this deploy's.
  restart_base=0
  if [[ $cid == "$old_cid" && $old_restarts =~ ^[0-9]+$ ]]; then
    restart_base=$old_restarts
  fi

  deadline=$((up_end + HEALTH_TIMEOUT * 1000))
  while :; do
    if ! info=$(docker inspect --format \
      '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.State.Status}} {{.RestartCount}}' \
      "$cid" 2>&1); then
      fail_reason="docker inspect failed: ${info%%$'\n'*}"
      return 1
    fi
    read -r health state restarts <<<"$info"
    case ${state:-} in
      exited | dead | restarting)
        fail_reason="the app container is $state"
        return 1
        ;;
    esac
    if [[ ${health:-} == unhealthy ]]; then
      fail_reason="Docker reports the app container unhealthy"
      return 1
    fi
    if [[ ! ${restarts:-} =~ ^[0-9]+$ ]]; then
      fail_reason="unexpected docker inspect output: $info"
      return 1
    fi
    if ((restarts > restart_base)); then
      fail_reason="the app container restarted ($restarts)"
      return 1
    fi
    if [[ $health == healthy ]]; then
      if [[ -z $healthy_ms ]]; then
        now=$(now_ms)
        healthy_ms=$((now - start))
        say "$label: Docker reports healthy $(secs "$healthy_ms") after compose up started"
      fi
      if probe_up_since "$up_end"; then
        say "$label: /readyz answers 200"
        return 0
      fi
    fi
    now=$(now_ms)
    if ((now >= deadline)); then
      fail_reason="not healthy and ready within ${HEALTH_TIMEOUT}s (Docker: $health, probe: $(probe_last))"
      return 1
    fi
    sleep "$POLL_INTERVAL"
  done
}

print_failed_logs() {
  local cid=$current_cid out
  if [[ -z $cid ]]; then
    out=$(compose ps -a -q app 2>/dev/null)
    cid=${out%%$'\n'*}
  fi
  if [[ -z $cid ]]; then
    say "no app container to print logs from"
    return 0
  fi
  say "---- last 200 log lines of the app container $cid ----"
  docker logs --tail 200 "$cid" 2>&1 || say "(docker logs failed)"
  say "----"
}

# Called once the new release has failed. Sets final_message; the caller
# exits 1.
rollback() {
  local first_reason=$fail_reason
  phase=rollback
  say "deploy failed: $first_reason"
  print_failed_logs
  if [[ -z $previous_image_id ]]; then
    final_message="deploy failed: $first_reason. No previous image (first deploy): not rolled back; the host is left as is."
    phase=done
    return 0
  fi
  if [[ $previous_image_id == "$target_image_id" ]]; then
    final_message="deploy failed: $first_reason. The previous image is the same image ($previous_image_id): not rolled back; the host is left as is."
    phase=done
    return 0
  fi
  say "rolling back to $previous_image_id ($IMAGE_REPO:$PREVIOUS_TAG)"
  if replace_and_verify "$PREVIOUS_TAG" rollback; then
    rollback_healthy=$(secs "$healthy_ms")
    final_message="deploy failed: $first_reason. Rolled back to $previous_image_id."
  else
    [[ -z $healthy_ms ]] || rollback_healthy=$(secs "$healthy_ms")
    print_failed_logs
    final_message="rollback failed: $fail_reason. The deploy failed first: $first_reason. The host is left as is."
  fi
  phase=done
}

# --------------------------------------------------------------- lifecycle

phase=prepare
interrupted=""
final_message=""
WORK_DIR=""
migrate_result=""
deploy_healthy=""
rollback_healthy=""
replaced=0
previous_image_id=""
target_image_id=""
old_cid=""
old_restarts=""

on_exit() {
  local rc=$?
  set +e
  trap - EXIT
  trap '' HUP INT TERM
  # First, before any output: the job's SSH session may be gone.
  stop_probe
  if [[ -n $interrupted ]]; then
    final_message="interrupted by SIG$interrupted during the $phase stage: no automatic rollback. Check the app container; redeploy the previous release if needed."
  elif [[ $phase == replace ]]; then
    fail_reason="unexpected exit (status $rc) during the replace stage"
    rollback
    rc=1
  elif [[ $phase == rollback ]]; then
    final_message="rollback failed: unexpected exit (status $rc) during the rollback. The host is left as is."
    rc=1
  fi
  print_report
  [[ -z $final_message ]] || say "$final_message"
  [[ -z $WORK_DIR ]] || rm -rf "$WORK_DIR"
  if ((rc != 0 && rc < 128)); then rc=1; fi
  exit "$rc"
}

fail() {
  final_message="ERROR: $*"
  exit 1
}

trap on_exit EXIT
trap 'interrupted=HUP; exit 129' HUP
trap 'interrupted=INT; exit 130' INT
trap 'interrupted=TERM; exit 143' TERM
trap 'say "failed at line $LINENO: $BASH_COMMAND"' ERR

# -------------------------------------------------------------------- main

((BASH_VERSINFO[0] >= 5)) || fail "bash 5 or newer is required"
MAIN_PID=$$
cd "$(dirname "${BASH_SOURCE[0]}")" || fail "cannot enter the script's directory"
[[ -f docker-compose.yml ]] || fail "no docker-compose.yml next to this script ($PWD)"
[[ -f .env ]] || fail "no .env next to this script ($PWD)"

IMAGE_TAG=${IMAGE_TAG:-}
[[ $IMAGE_TAG =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || fail "IMAGE_TAG is missing or not a valid tag"
[[ $IMAGE_TAG != "$PREVIOUS_TAG" ]] || fail "IMAGE_TAG=$PREVIOUS_TAG is reserved for the rollback"
export IMAGE_TAG
for value in "$PULL_TIMEOUT" "$MIGRATE_TIMEOUT" "$REPLACE_TIMEOUT" "$HEALTH_TIMEOUT"; do
  [[ $value =~ ^[1-9][0-9]*$ ]] || fail "stage bounds must be whole seconds"
done
[[ $POLL_INTERVAL =~ ^[0-9]+(\.[0-9]+)?$ ]] || fail "the poll interval must be a number of seconds"
POLL_MS=$(to_ms "$POLL_INTERVAL")
((POLL_MS > 0)) || fail "the poll interval must be above zero"

bind_ip=$(env_value HOST_BIND_IP)
[[ $bind_ip =~ ^[0-9A-Fa-f.:]+$ ]] || fail "HOST_BIND_IP in .env is missing or not an IP address"
if [[ $bind_ip == *:* ]]; then
  PROBE_URL="http://[$bind_ip]:3000/readyz"
else
  PROBE_URL="http://$bind_ip:3000/readyz"
fi

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/etg-deploy.XXXXXXXX")

# 1. What runs now.
say "deploy-app: tooling commit ${DEPLOY_TOOLING_COMMIT:-unknown}, target $IMAGE_REPO:$IMAGE_TAG"
ps_out=$(compose ps -a -q app)
old_cid=${ps_out%%$'\n'*}
old_image_id=""
if [[ -n $old_cid ]]; then
  old_info=$(docker inspect --format '{{.Config.Image}} {{.Image}} {{.State.Status}} {{.RestartCount}}' "$old_cid")
  read -r old_ref old_image_id old_state old_restarts <<<"$old_info"
  say "running app container $old_cid: $old_ref, image $old_image_id, state $old_state, restarts $old_restarts"
  if [[ $old_state == restarting || $old_restarts != 0 ]]; then
    say "WARNING: the app container is restarting or has restarted. If it was started outside this script with pending migrations, stop it (docker compose stop app) and deploy again."
  fi
else
  say "running app container: none"
fi

# 2. Pull.
say "pulling $IMAGE_REPO:$IMAGE_TAG (at most ${PULL_TIMEOUT}s)"
timeout -k "$KILL_AFTER" "$PULL_TIMEOUT" docker compose --env-file .env pull app </dev/null ||
  fail "pull failed or timed out; nothing changed"
target_image_id=$(docker image inspect --format '{{.Id}}' "$IMAGE_REPO:$IMAGE_TAG")
say "target image $target_image_id"

# 3. Keep the running image under a local tag (on staging the pull has
# already moved :main, so no registry tag names it).
if [[ -n $old_image_id ]]; then
  docker tag "$old_image_id" "$IMAGE_REPO:$PREVIOUS_TAG"
  previous_image_id=$old_image_id
  say "previous image $previous_image_id tagged $PREVIOUS_TAG"
else
  say "no previous image: a failed release will not be rolled back"
fi

# 4. Availability probe, until the end of the run.
start_probe

# 5. Migrate first; the running app keeps serving.
if docker container inspect "$MIGRATE_CONTAINER" >/dev/null 2>&1; then
  fail "a container named $MIGRATE_CONTAINER is left from an earlier run; check its logs, remove it (docker rm -f $MIGRATE_CONTAINER) and deploy again. Nothing was replaced."
fi
phase=migrate
say "migrating (at most ${MIGRATE_TIMEOUT}s)"
migrate_start=$(now_ms)
set +e
timeout -k "$KILL_AFTER" "$MIGRATE_TIMEOUT" \
  docker compose --env-file .env run --rm --no-deps -T --name "$MIGRATE_CONTAINER" \
  app node dist/index.js --migrate-only </dev/null
rc=$?
set -e
migrate_ms=$(($(now_ms) - migrate_start))
if ((rc == 124 || (rc == 137 && migrate_ms >= MIGRATE_TIMEOUT * 1000))); then
  migrate_result="timed out after $(secs "$migrate_ms")"
  say "migration timed out; removing the migrate container"
  docker rm -f "$MIGRATE_CONTAINER" >/dev/null 2>&1 || true
  final_message="migration outcome unknown: it may have committed. Nothing was replaced; the running app keeps serving."
  exit 1
elif ((rc != 0)); then
  migrate_result="failed (exit $rc) after $(secs "$migrate_ms")"
  final_message="migration failed (exit $rc). Nothing was replaced; the running app keeps serving."
  exit 1
fi
migrate_result="done in $(secs "$migrate_ms")"
say "migration done in $(secs "$migrate_ms")"

# 6-9. Replace. From here every failure goes to the rollback path.
phase=replace
replaced=1
trap - ERR
set +e
if replace_and_verify "$IMAGE_TAG" deploy --remove-orphans; then
  deploy_healthy=$(secs "$healthy_ms")
  phase=done
  final_message="deployed $IMAGE_REPO:$IMAGE_TAG ($target_image_id)"
  exit 0
fi
[[ -z $healthy_ms ]] || deploy_healthy=$(secs "$healthy_ms")
rollback
exit 1
