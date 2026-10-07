#!/usr/bin/env bash
# on_exit, the probe and their helpers run from traps, which shellcheck does
# not follow (SC2317).
# shellcheck disable=SC2317
# Deploy the app container on this host: pull, migrate first, replace, verify,
# and roll back to the previous image when the new one is not healthy and
# ready in time.
#
# The three app deploy jobs (Deploy on a tag push or a dispatch, Deploy
# Staging) upload this file and the release's docker-compose.yml, then, under
# the host lock (~/.etg-deploy.lock), run `docker login`, install the compose
# file as docker-compose.next.yml (the candidate) and this script, and run it:
#
#   IMAGE_TAG=v1.2.3 DEPLOY_TOOLING_COMMIT=<sha> bash deploy-app.sh </dev/null
#
# By hand, take the lock yourself; put a changed compose file at
# docker-compose.next.yml first, or the deploy uses docker-compose.yml:
#
#   flock -w 900 ~/.etg-deploy.lock env IMAGE_TAG=<tag> bash ~/email-to-telegram/deploy-app.sh </dev/null
#
# docker-compose.yml always describes the release that runs. The pull, the
# migration and the replacement use the candidate; once the new release is
# healthy and ready, the candidate is renamed to docker-compose.yml. Every
# other outcome deletes the candidate and leaves docker-compose.yml as it was,
# and the rollback uses it. Every Compose call gets the same files a plain
# `docker compose` here would read: the compose file plus the first override
# file in Compose's order (compose.override.yml, compose.override.yaml,
# docker-compose.override.yml, docker-compose.override.yaml).
#
# Stages and their time bounds: pull 600 s, migrate 300 s (starting the
# database included), replace 120 s, health 90 s; rollback 120 s plus 90 s.
# Every other Docker call gets 20 s. An availability probe requests
# http://$HOST_BIND_IP:3000/readyz every 2 s from before the migration until
# the end, and every run that gets that far prints its report.
#
# All output also goes to deploy-logs/ next to this script (mode 700; the
# newest 30 files are kept), so the report survives a lost SSH session. The
# job log gets no line of .env and no raw Compose, app or migration output:
# Compose can quote .env in a warning, so all of its output goes to a private
# file in deploy-logs/, and the job log gets exit statuses, durations, image
# IDs and container states.
#
# Exit status: 0 deployed; 1 for everything else (nothing replaced, rolled
# back, or rollback failed: the last line says which); 128+n on a signal. A
# run interrupted by a signal does not roll back.
#
# Needs Compose 2.32 or later (`run --pull never`) and GNU coreutils 8.31 or
# later (`env --ignore-signal`). Reads no secret: from .env it reads only the
# HOST_BIND_IP and COMPOSE_FILE lines.

set -euo pipefail
# Every file this script creates (logs, work files) is private to this user.
umask 077

readonly IMAGE_REPO=ghcr.io/vladkarok/email-to-telegram
readonly PREVIOUS_TAG=deploy-previous
readonly MIGRATE_CONTAINER=etg-migrate
readonly DB_SERVICE=postgres
readonly CANDIDATE=docker-compose.next.yml
readonly LOG_KEEP=30
# Stage bounds in seconds. The ETG_DEPLOY_* overrides exist for the tests.
readonly PULL_TIMEOUT=${ETG_DEPLOY_PULL_TIMEOUT:-600}
readonly MIGRATE_TIMEOUT=${ETG_DEPLOY_MIGRATE_TIMEOUT:-300}
readonly REPLACE_TIMEOUT=${ETG_DEPLOY_REPLACE_TIMEOUT:-120}
readonly HEALTH_TIMEOUT=${ETG_DEPLOY_HEALTH_TIMEOUT:-90}
# Bound for every other Docker call (ps, inspect, tag, logs, rm).
readonly CALL_TIMEOUT=${ETG_DEPLOY_CALL_TIMEOUT:-20}
# Probe and health check interval in seconds; may be fractional.
readonly POLL_INTERVAL=${ETG_DEPLOY_POLL_INTERVAL:-2}
# A stage that ignores SIGTERM at its bound gets SIGKILL this much later; a
# short call, 5 s later.
readonly KILL_AFTER=10
readonly CALL_KILL_AFTER=5

export TZ=UTC
# A lost SSH session closes stdout without a SIGHUP; the next write would
# raise SIGPIPE. Ignore it: writes fail instead, and say() tolerates that.
trap '' PIPE

say() { printf '%s\n' "$*" 2>/dev/null || true; }

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

# timed_out STATUS : STATUS is what `timeout` returns when the bound ran out.
timed_out() { (($1 == 124 || $1 == 137)); }

# dk SECONDS ARGS... : docker ARGS, bounded.
dk() {
  local t=$1
  shift
  timeout -k "$CALL_KILL_AFTER" "$t" docker "$@" </dev/null
}

# -f lists for Compose: the running release's (docker-compose.yml) and the
# target's (the candidate), each with the override file; compose_files is the
# one the next Compose call uses.
current_files=()
target_files=()
compose_files=()
# Where Compose's output goes: a private file in deploy-logs/, or in the work
# directory when there is none.
COMPOSE_LOG=/dev/null

# dc SECONDS ARGS... : docker compose ARGS with compose_files and .env,
# bounded. stdout is the caller's; stderr goes to the Compose log only.
dc() {
  local t=$1
  shift
  say_compose "$COMPOSE_LOG" "$*"
  timeout -k "$CALL_KILL_AFTER" "$t" \
    docker compose "${compose_files[@]}" --env-file .env "$@" </dev/null 2>>"$COMPOSE_LOG"
}

# dc_stage FILE SECONDS ARGS... : the same for a stage, stdout included, all
# appended to FILE; a call that ignores SIGTERM at its bound gets SIGKILL
# KILL_AFTER later.
dc_stage() {
  local file=$1 t=$2
  shift 2
  say_compose "$file" "$*"
  timeout -k "$KILL_AFTER" "$t" \
    docker compose "${compose_files[@]}" --env-file .env "$@" </dev/null >>"$file" 2>&1
}

# say_compose FILE ARGS : a header line in FILE for the Compose call that
# follows.
say_compose() {
  printf '== %s docker compose %s --env-file .env %s\n' \
    "$(clock "$(now_ms)")" "${compose_files[*]}" "$2" >>"$1" 2>/dev/null || true
}

# first_id TEXT : the first line of TEXT that is a container ID. Compose
# warnings on other lines are skipped.
first_id() {
  local line
  while IFS= read -r line; do
    if [[ $line =~ ^[0-9a-f]{12,64}$ ]]; then
      printf '%s\n' "$line"
      return 0
    fi
  done <<<"$1"
  return 1
}

# error_lines FILE : what of FILE may go into the public job log: from its
# JSON log lines at level 50 (error) or above, the level, the msg field and an
# error code; the last 20 of them. Nothing else: the app prints configuration
# from .env at startup, and a fatal startup error is raw text.
error_lines() {
  awk '
    /^[ \t]*[{]/ {
      if (!match($0, /"level":[0-9]+/)) next
      level = substr($0, RSTART + 8, RLENGTH - 8) + 0
      if (level < 50) next
      msg = ""
      if (match($0, /"msg":"([^"\\]|\\.)*"/)) msg = substr($0, RSTART + 7, RLENGTH - 8)
      if (length(msg) > 200) msg = substr(msg, 1, 200) "..."
      code = ""
      if (match($0, /"code":"[A-Za-z0-9_.-]+"/)) code = substr($0, RSTART + 8, RLENGTH - 9)
      line = "level " level ": " msg
      if (code != "") line = line " (code " code ")"
      kept[n % 20] = line
      n++
    }
    END {
      if (n == 0) print "(no line at level 50 or above)"
      for (i = (n > 20 ? n - 20 : 0); i < n; i++) print kept[i % 20]
    }
  ' "$1"
}

# keep_log FILE NAME : copy FILE to deploy-logs as NAME for this run and print
# where it went. The full text stays on the host.
keep_log() {
  local file=$1 name=$2
  if [[ -n $LOG_DIR ]] && cp "$file" "$LOG_DIR/$RUN_ID.$name.log" 2>/dev/null; then
    say "full output on the host: $LOG_DIR/$RUN_ID.$name.log"
  else
    say "full output not kept (no deploy-logs directory)"
  fi
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
  [[ -z $rollback_note ]] || say "rollback: $rollback_note"
  if [[ -n $rollback_healthy ]]; then
    say "time to healthy (rollback): $rollback_healthy after the rollback started"
  fi
  say "----"
}

# ----------------------------------------------------------------- replace

current_cid=""
fail_reason=""
healthy_ms=""

# replace_and_verify TAG LABEL IMAGE_ID [UP_ARGS...] : compose up with
# IMAGE_TAG=TAG, then wait until the app container runs IMAGE_ID, Docker
# reports it healthy and the probe gets 200, all within the health bound.
# Returns 1 with fail_reason set on any failure, a timed-out Docker call
# included; sets current_cid and healthy_ms.
replace_and_verify() {
  local tag=$1 label=$2 want_image=$3 start up_end rc out cid info health state restarts image
  local restart_base deadline now bound
  shift 3
  current_cid=""
  healthy_ms=""
  fail_reason=""
  start=$(now_ms)
  say "$label: docker compose ${compose_files[*]} up -d${*:+ $*} --no-build --pull never with IMAGE_TAG=$tag (at most ${REPLACE_TIMEOUT}s)"
  IMAGE_TAG=$tag dc_stage "$COMPOSE_LOG" "$REPLACE_TIMEOUT" up -d "$@" --no-build --pull never
  rc=$?
  up_end=$(now_ms)
  say "$label: compose up exited $rc after $(secs "$((up_end - start))")"
  if timed_out "$rc"; then
    fail_reason="compose up timed out after ${REPLACE_TIMEOUT}s"
    return 1
  elif ((rc != 0)); then
    fail_reason="compose up failed (exit $rc)"
    return 1
  fi

  out=$(IMAGE_TAG=$tag dc "$CALL_TIMEOUT" ps -q app)
  rc=$?
  if timed_out "$rc"; then
    fail_reason="compose ps timed out after ${CALL_TIMEOUT}s"
    return 1
  fi
  if ! cid=$(first_id "$out") || ((rc != 0)); then
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
    # Each inspect gets what is left of the health bound, at most CALL_TIMEOUT.
    now=$(now_ms)
    bound=$(((deadline - now + 999) / 1000))
    ((bound >= 1)) || bound=1
    ((bound <= CALL_TIMEOUT)) || bound=$CALL_TIMEOUT
    info=$(dk "$bound" inspect --format \
      '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.State.Status}} {{.RestartCount}} {{.Image}}' \
      "$cid" 2>"$WORK_DIR/inspect.err")
    rc=$?
    now=$(now_ms)
    if timed_out "$rc"; then
      fail_reason="docker inspect timed out after ${bound}s"
      return 1
    elif ((rc != 0)); then
      fail_reason="docker inspect failed: $(head -n 1 "$WORK_DIR/inspect.err")"
      return 1
    fi
    read -r health state restarts image <<<"$info"
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
    if [[ ${image:-} != "$want_image" ]]; then
      fail_reason="the app container runs image ${image:-unknown}, not $want_image"
      return 1
    fi
    # A healthy answer that arrives after the deadline does not count.
    if [[ $health == healthy ]] && ((now <= deadline)); then
      if [[ -z $healthy_ms ]]; then
        healthy_ms=$((now - start))
        say "$label: Docker reports healthy $(secs "$healthy_ms") after compose up started"
      fi
      if probe_up_since "$up_end"; then
        say "$label: /readyz answers 200"
        return 0
      fi
    fi
    if ((now >= deadline)); then
      fail_reason="not healthy and ready within ${HEALTH_TIMEOUT}s (Docker: $health, probe: $(probe_last))"
      return 1
    fi
    sleep "$POLL_INTERVAL"
  done
}

# Best effort and bounded: a Docker that does not answer must not hold up the
# rollback. Only error lines go to the job log; the full log stays on the host.
print_failed_logs() {
  local cid=$current_cid out rc
  if [[ -z $cid ]]; then
    out=$(dc "$CALL_TIMEOUT" ps -a -q app)
    cid=$(first_id "$out") || cid=""
  fi
  if [[ -z $cid ]]; then
    say "no app container to print logs from"
    return 0
  fi
  dk "$CALL_TIMEOUT" logs --tail 200 "$cid" >"$WORK_DIR/app.log" 2>&1
  rc=$?
  if timed_out "$rc"; then
    say "docker logs for the app container $cid did not answer within ${CALL_TIMEOUT}s; skipped"
    return 0
  fi
  say "---- app container $cid: errors in its last 200 log lines (level, msg, error code) ----"
  error_lines "$WORK_DIR/app.log"
  keep_log "$WORK_DIR/app.log" "app-${cid:0:12}"
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
    phase="done"
    return 0
  fi
  if [[ $previous_image_id == "$target_image_id" ]]; then
    final_message="deploy failed: $first_reason. The previous image is the same image ($previous_image_id): not rolled back; the host is left as is."
    phase="done"
    return 0
  fi
  # docker-compose.yml is still the one the previous release ran with.
  compose_files=("${current_files[@]}")
  rollback_note="image $previous_image_id with ${current_files[1]}"
  say "rolling back: $rollback_note ($IMAGE_REPO:$PREVIOUS_TAG)"
  if replace_and_verify "$PREVIOUS_TAG" rollback "$previous_image_id"; then
    rollback_healthy=$(secs "$healthy_ms")
    final_message="deploy failed: $first_reason. Rolled back to $previous_image_id."
  else
    [[ -z $healthy_ms ]] || rollback_healthy=$(secs "$healthy_ms")
    print_failed_logs
    final_message="rollback failed: $fail_reason. The deploy failed first: $first_reason. The host is left as is."
  fi
  phase="done"
}

# --------------------------------------------------------------- lifecycle

phase=prepare
interrupted=""
final_message=""
WORK_DIR=""
LOG_DIR=""
RUN_ID=""
tee_pid=""
migrate_result=""
deploy_healthy=""
rollback_healthy=""
rollback_note=""
replaced=0
previous_image_id=""
target_image_id=""
old_cid=""
old_state=""
old_restarts=""
# The candidate this run deploys. It is deleted at the end unless it became
# docker-compose.yml (keep_candidate).
candidate=""
keep_candidate=""

# serving : what the old app does while nothing is replaced.
serving() {
  if [[ $old_state == running ]]; then
    say "the running app keeps serving"
  else
    say "no app was running before this deploy"
  fi
}

drop_candidate() {
  [[ -n $candidate && -z $keep_candidate ]] || return 0
  if rm -f -- "$candidate"; then
    say "deleted $candidate; docker-compose.yml is unchanged"
  else
    say "WARNING: cannot delete $candidate; delete it before running this script by hand"
  fi
}

on_exit() {
  local rc=$? note
  set +e
  trap - EXIT
  trap '' HUP INT TERM PIPE
  if [[ -n $interrupted ]]; then
    # Stop the probe first: no rollback follows.
    stop_probe
    case $phase in
      prepare) final_message="interrupted by SIG$interrupted before the migration: nothing was replaced and no migration ran." ;;
      migrate)
        # Bash runs a trap once the foreground command has returned, so the
        # migration has ended or hit its bound. A container the bound left
        # behind would block the next deploy; removing it stops it.
        if dk "$CALL_TIMEOUT" rm -f "$MIGRATE_CONTAINER" >/dev/null 2>&1; then
          note="no migrate container is left"
        else
          note="removing the migrate container failed or timed out, remove it (docker rm -f $MIGRATE_CONTAINER) before the next deploy"
        fi
        final_message="interrupted by SIG$interrupted during the migration: nothing was replaced; $note; the migration outcome is unknown (it may have committed)."
        ;;
      *) final_message="interrupted by SIG$interrupted during the $phase stage: no automatic rollback. Check the app container; redeploy the previous release if needed." ;;
    esac
  elif [[ $phase == replace ]]; then
    # The probe keeps running: the rollback waits for its 200.
    fail_reason="unexpected exit (status $rc) during the replace stage"
    rollback
    rc=1
  elif [[ $phase == rollback ]]; then
    final_message="rollback failed: unexpected exit (status $rc) during the rollback. The host is left as is."
    rc=1
  fi
  stop_probe
  print_report
  drop_candidate
  [[ -z $final_message ]] || say "$final_message"
  [[ -z $WORK_DIR ]] || rm -rf "$WORK_DIR"
  if ((rc != 0 && rc < 128)); then rc=1; fi
  # Bash does not wait for a process substitution: close the pipe so tee
  # finishes the host log, and give it up to 5 s, so it never outlives the run.
  if [[ -n $tee_pid ]]; then
    exec >&- 2>&-
    for _ in {1..50}; do
      kill -0 "$tee_pid" 2>/dev/null || break
      sleep_ms 100
    done
  fi
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
[[ ! -f $CANDIDATE ]] || candidate=$CANDIDATE

# Without env --ignore-signal, env would exit before tee starts below and the
# run's output would go nowhere.
env --ignore-signal=INT true </dev/null >/dev/null 2>&1 ||
  fail "GNU coreutils 8.31 or later is required (env --ignore-signal). Nothing changed."

# A host-local copy of all output, private to this user (umask 077; the
# chmods fix a directory and files from before that); the newest LOG_KEEP
# files are kept. tee -p goes on writing the file after the job's side of the
# pipe is gone, and it ignores the signals this script traps (a Ctrl-C
# reaches the whole process group), so it ends only when the script's output
# does. (`trap ''` in the subshell does not hold for SIGINT across the exec;
# GNU env's --ignore-signal does.)
printf -v RUN_ID '%(%Y%m%dT%H%M%SZ)T-%s' -1 "$$"
if mkdir -p deploy-logs && chmod 700 deploy-logs && : >>"deploy-logs/$RUN_ID.log"; then
  LOG_DIR=$PWD/deploy-logs
  exec > >(exec env --ignore-signal=HUP,INT,TERM tee -p -a "$LOG_DIR/$RUN_ID.log") 2>&1
  tee_pid=$!
  COMPOSE_LOG=$LOG_DIR/$RUN_ID.compose.log
  : >>"$COMPOSE_LOG"
  logs=("$LOG_DIR"/*.log)
  chmod 600 -- "${logs[@]}" 2>/dev/null || say "WARNING: cannot make every file in $LOG_DIR private"
  if ((${#logs[@]} > LOG_KEEP)); then
    rm -f -- "${logs[@]:0:${#logs[@]}-LOG_KEEP}"
  fi
  say "deploy-app: full log on the host: $LOG_DIR/$RUN_ID.log"
else
  say "WARNING: cannot write $PWD/deploy-logs; this run keeps no host-local log"
fi

[[ -f .env ]] || fail "no .env next to this script ($PWD)"

IMAGE_TAG=${IMAGE_TAG:-}
[[ $IMAGE_TAG =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || fail "IMAGE_TAG is missing or not a valid tag"
[[ $IMAGE_TAG != "$PREVIOUS_TAG" ]] || fail "IMAGE_TAG=$PREVIOUS_TAG is reserved for the rollback"
export IMAGE_TAG
for value in "$PULL_TIMEOUT" "$MIGRATE_TIMEOUT" "$REPLACE_TIMEOUT" "$HEALTH_TIMEOUT" "$CALL_TIMEOUT"; do
  [[ $value =~ ^[1-9][0-9]*$ ]] || fail "stage bounds must be whole seconds"
done
[[ $POLL_INTERVAL =~ ^[0-9]+(\.[0-9]+)?$ ]] || fail "the poll interval must be a number of seconds"
POLL_MS=$(to_ms "$POLL_INTERVAL")
((POLL_MS > 0)) || fail "the poll interval must be above zero"

# The probe and Compose must use the same address. Compose prefers a value
# from the environment over .env, so export the one read from .env.
bind_ip=$(env_value HOST_BIND_IP)
[[ $bind_ip =~ ^[0-9A-Fa-f.:]+$ ]] || fail "HOST_BIND_IP in .env is missing or not an IP address"
if [[ -n ${HOST_BIND_IP+set} && $HOST_BIND_IP != "$bind_ip" ]]; then
  fail "HOST_BIND_IP in the environment differs from the one in .env; unset it or make them agree"
fi
export HOST_BIND_IP=$bind_ip
if [[ $bind_ip == *:* ]]; then
  PROBE_URL="http://[$bind_ip]:3000/readyz"
else
  PROBE_URL="http://$bind_ip:3000/readyz"
fi

# The compose files. An explicit -f list turns Compose's own discovery off,
# so the list holds what a plain `docker compose` here reads: the compose
# file and the first override file in Compose's order. Refuse what would make
# a plain call read other files.
if [[ -n ${COMPOSE_FILE:-} || -n $(env_value COMPOSE_FILE) ]]; then
  fail "COMPOSE_FILE is set in the environment or .env; this script picks the compose files itself, unset it. Nothing changed."
fi
for name in compose.yaml compose.yml docker-compose.yaml; do
  [[ ! -e $name ]] || fail "$name is next to docker-compose.yml and a plain docker compose would read it instead; remove it. Nothing changed."
done
override=()
for name in compose.override.yml compose.override.yaml docker-compose.override.yml docker-compose.override.yaml; do
  if [[ -f $name ]]; then
    override=(-f "$name")
    break
  fi
done
target_main=${candidate:-docker-compose.yml}
[[ -f $target_main ]] || fail "no docker-compose.yml or $CANDIDATE next to this script ($PWD)"
# A host that has never run the app may have no docker-compose.yml yet.
current_main=docker-compose.yml
[[ -f $current_main ]] || current_main=$target_main
current_files=(-f "$current_main" "${override[@]}")
target_files=(-f "$target_main" "${override[@]}")

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/etg-deploy.XXXXXXXX")
if [[ -n $LOG_DIR ]]; then
  say "deploy-app: Compose output goes to $COMPOSE_LOG on the host only"
else
  COMPOSE_LOG=$WORK_DIR/compose.log
  say "deploy-app: Compose output goes to the work directory only and is deleted at the end"
fi

# Compose prints the offending line of an .env it cannot parse. Both files
# must parse: the rollback uses docker-compose.yml.
compose_files=("${target_files[@]}")
dc "$CALL_TIMEOUT" config -q >>"$COMPOSE_LOG" ||
  fail "docker compose cannot read $target_main with .env (see the Compose log). Nothing changed."
if [[ $current_main != "$target_main" ]]; then
  compose_files=("${current_files[@]}")
  dc "$CALL_TIMEOUT" config -q >>"$COMPOSE_LOG" ||
    fail "docker compose cannot read docker-compose.yml, which a rollback would use, with .env (see the Compose log). Nothing changed."
fi

# 1. What runs now.
say "deploy-app: tooling commit ${DEPLOY_TOOLING_COMMIT:-unknown}, target $IMAGE_REPO:$IMAGE_TAG, compose files: ${target_files[*]}"
compose_files=("${current_files[@]}")
ps_out=$(dc "$CALL_TIMEOUT" ps -a -q app) ||
  fail "docker compose ps failed or timed out; nothing changed"
old_cid=$(first_id "$ps_out") || old_cid=""
old_image_id=""
if [[ -n $old_cid ]]; then
  old_info=$(dk "$CALL_TIMEOUT" inspect --format '{{.Config.Image}} {{.Image}} {{.State.Status}} {{.RestartCount}}' "$old_cid") ||
    fail "docker inspect of the running app container failed or timed out; nothing changed"
  read -r old_ref old_image_id old_state old_restarts <<<"$old_info"
  say "running app container $old_cid: $old_ref, image $old_image_id, state $old_state, restarts $old_restarts"
  if [[ $old_state == restarting || $old_restarts != 0 ]]; then
    say "WARNING: the app container is restarting or has restarted. If it was started outside this script with pending migrations, stop it (docker compose stop app) and deploy again."
  fi
else
  say "running app container: none"
fi

# 2. Pull. Nothing after this pulls the app image again (--pull never), and
# every container started from it must run the image ID read here. From here
# on Compose uses the target's files, until a rollback.
compose_files=("${target_files[@]}")
say "pulling $IMAGE_REPO:$IMAGE_TAG (at most ${PULL_TIMEOUT}s)"
stage_start=$(now_ms)
rc=0
dc_stage "$COMPOSE_LOG" "$PULL_TIMEOUT" pull app || rc=$?
say "pull exited $rc after $(secs "$(($(now_ms) - stage_start))")"
((rc == 0)) || fail "pull failed or timed out; nothing changed"
target_image_id=$(dk "$CALL_TIMEOUT" image inspect --format '{{.Id}}' "$IMAGE_REPO:$IMAGE_TAG") ||
  fail "docker image inspect of the pulled image failed or timed out; nothing changed"
say "target image $target_image_id"

# 3. Keep the running image under a local tag (on staging the pull has
# already moved :main, so no registry tag names it).
if [[ -n $old_image_id ]]; then
  dk "$CALL_TIMEOUT" tag "$old_image_id" "$IMAGE_REPO:$PREVIOUS_TAG" ||
    fail "docker tag of the previous image failed or timed out; nothing replaced"
  previous_image_id=$old_image_id
  say "previous image $previous_image_id tagged $PREVIOUS_TAG"
else
  say "no previous image: a failed release will not be rolled back"
fi

# 4. Availability probe, until the end of the run.
start_probe

# 5. Migrate first, while the old app (if any) keeps serving.
leftover_rc=0
dk "$CALL_TIMEOUT" container inspect "$MIGRATE_CONTAINER" >/dev/null 2>&1 || leftover_rc=$?
if ((leftover_rc == 0)); then
  fail "a container named $MIGRATE_CONTAINER is left from an earlier run; check its logs, remove it (docker rm -f $MIGRATE_CONTAINER) and deploy again. Nothing was replaced."
elif timed_out "$leftover_rc"; then
  fail "docker container inspect timed out; nothing was replaced"
fi
# The local tag must still name the pulled image: something else on this host
# may have pulled it since.
tag_id=$(dk "$CALL_TIMEOUT" image inspect --format '{{.Id}}' "$IMAGE_REPO:$IMAGE_TAG") ||
  fail "docker image inspect failed or timed out; nothing was replaced"
[[ $tag_id == "$target_image_id" ]] ||
  fail "$IMAGE_REPO:$IMAGE_TAG now names $tag_id, not the pulled $target_image_id; nothing was replaced"

set +e
stage_start=$(now_ms)
# `run --no-deps` does not start the database; `up --no-recreate` starts it
# if it is stopped and leaves a running one alone.
say "starting the database: docker compose up -d --wait --no-recreate $DB_SERVICE (within the ${MIGRATE_TIMEOUT}s migrate bound)"
dc_stage "$COMPOSE_LOG" "$MIGRATE_TIMEOUT" up -d --wait --no-recreate "$DB_SERVICE"
rc=$?
say "database: compose up exited $rc after $(secs "$(($(now_ms) - stage_start))")"
if ((rc != 0)); then
  migrate_result="not run: the database did not start"
  if timed_out "$rc"; then
    final_message="the database was not healthy within ${MIGRATE_TIMEOUT}s. Nothing was replaced; $(serving)."
  else
    final_message="the database did not start (exit $rc). Nothing was replaced; $(serving)."
  fi
  exit 1
fi
budget=$((MIGRATE_TIMEOUT - ($(now_ms) - stage_start) / 1000))
((budget >= 1)) || budget=1
phase=migrate
migrate_result="interrupted; outcome unknown"
say "migrating (at most ${budget}s); output goes to the host only"
migrate_start=$(now_ms)
dc_stage "$WORK_DIR/migrate.log" "$budget" \
  run --rm --no-deps --pull never -T --name "$MIGRATE_CONTAINER" app node dist/index.js --migrate-only
rc=$?
set -e
migrate_ms=$(($(now_ms) - migrate_start))
say "migration exited $rc after $(secs "$migrate_ms")"
if ((rc == 124 || (rc == 137 && migrate_ms >= budget * 1000))); then
  migrate_result="timed out after $(secs "$migrate_ms")"
  say "migration timed out; removing the migrate container"
  dk "$CALL_TIMEOUT" rm -f "$MIGRATE_CONTAINER" >/dev/null 2>&1 || true
  keep_log "$WORK_DIR/migrate.log" migrate
  final_message="migration outcome unknown: it may have committed. Nothing was replaced; $(serving)."
  exit 1
elif ((rc != 0)); then
  migrate_result="failed (exit $rc) after $(secs "$migrate_ms")"
  say "---- migration errors (level, msg, error code) ----"
  error_lines "$WORK_DIR/migrate.log"
  keep_log "$WORK_DIR/migrate.log" migrate
  say "----"
  final_message="migration failed (exit $rc). Nothing was replaced; $(serving)."
  exit 1
fi
migrate_result="done in $(secs "$migrate_ms")"

# 6-9. Replace. From here every failure goes to the rollback path.
phase=replace
replaced=1
trap - ERR
set +e
if replace_and_verify "$IMAGE_TAG" deploy "$target_image_id" --remove-orphans; then
  deploy_healthy=$(secs "$healthy_ms")
  phase="done"
  final_message="deployed $IMAGE_REPO:$IMAGE_TAG ($target_image_id)"
  if [[ -n $candidate ]]; then
    # Verified: the candidate now describes what runs.
    keep_candidate=1
    if ! mv -f -- "$candidate" docker-compose.yml; then
      final_message+=", but renaming $candidate to docker-compose.yml failed: rename it by hand, docker-compose.yml describes the previous release"
      exit 1
    fi
    say "$candidate renamed to docker-compose.yml"
  fi
  exit 0
fi
[[ -z $healthy_ms ]] || deploy_healthy=$(secs "$healthy_ms")
rollback
exit 1
