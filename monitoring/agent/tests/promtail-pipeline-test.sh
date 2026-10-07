#!/usr/bin/env bash
# Runs the prod Promtail config (pinned image, --dry-run) against a fake
# /var/lib/docker/containers and checks that only the app container's line
# passes the pipeline, with the expected labels and the envelope timestamp.
#
#   bash monitoring/agent/tests/promtail-pipeline-test.sh
set -Eeuo pipefail

repo=$(cd "$(dirname "$0")/../../.." && pwd)
image=$(awk '/image: grafana\/promtail:/ { print $2; exit }' "$repo/monitoring/agent/docker-compose.agent.yml")
work=$(mktemp -d)
name="etg-promtail-test-$$"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# An hour in the past, so a line stamped with the read time instead of the
# envelope time fails the timestamp check below.
now=$(date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%S.%NZ)

# write_log CONTAINER_ID ATTRS_JSON MESSAGE
write_log() {
  local id=$1 attrs=$2 msg=$3 line
  mkdir -p "$work/containers/$id"
  line='{"log":"{\"level\":30,\"msg\":\"'"$msg"'\"}\n","stream":"stdout",'
  [[ -n "$attrs" ]] && line+='"attrs":'"$attrs"','
  line+='"time":"'"$now"'"}'
  printf '%s\n' "$line" >>"$work/containers/$id/$id-json.log"
}

app='{"com.docker.compose.project":"email-to-telegram","com.docker.compose.service":"app"}'
pg='{"com.docker.compose.project":"email-to-telegram","com.docker.compose.service":"postgres"}'
other='{"com.docker.compose.project":"some-other-project","com.docker.compose.service":"app"}'
agent='{"com.docker.compose.project":"etg-agent","com.docker.compose.service":"node-exporter"}'

write_log aaaa "$app" "kept-app-line"
write_log bbbb "$pg" "dropped-postgres-line"
write_log cccc "$other" "dropped-other-project-line"
write_log dddd "" "dropped-line-without-attrs"
write_log eeee "$agent" "dropped-agent-line"
# Garbage in the envelope must be dropped too.
printf 'not json at all dropped-garbage-line\n' >>"$work/containers/aaaa/aaaa-json.log"

mkdir -p "$work/tls" "$work/secrets"
# Throwaway CA: Promtail loads the client's CA file at startup.
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 \
  -subj /CN=etg-test-ca -keyout "$work/tls/ca.key" -out "$work/tls/ca.crt" 2>/dev/null
chmod 0644 "$work/tls/ca.crt"
printf 'dummy' >"$work/secrets/promtail-a"

docker run -d --name "$name" \
  -e LOKI_PUSH_ADDR=127.0.0.1:9 -e LOKI_PUSH_USER=promtail-a \
  -v "$work/containers:/var/lib/docker/containers:ro" \
  -v "$repo/monitoring/agent/promtail:/etc/promtail:ro" \
  -v "$work/tls:/etc/etg-tls:ro" \
  -v "$work/secrets:/run/etg-promtail:ro" \
  --tmpfs /positions \
  "$image" -config.file=/etc/promtail/promtail-config.yml -config.expand-env=true -dry-run >/dev/null

out=""
for _ in $(seq 1 30); do
  out=$(docker logs "$name" 2>/dev/null || true)
  [[ "$out" == *kept-app-line* ]] && break
  sleep 1
done
sleep 2
out=$(docker logs "$name" 2>/dev/null || true)

fail() {
  echo "FAIL: $*" >&2
  echo "--- promtail stdout ---" >&2
  printf '%s\n' "$out" >&2
  echo "--- promtail stderr (tail) ---" >&2
  docker logs "$name" 2>&1 >/dev/null | tail -n 20 >&2 || true
  exit 1
}

[[ "$out" == *kept-app-line* ]] || fail "the app line did not pass the pipeline"
for dropped in dropped-postgres-line dropped-other-project-line dropped-line-without-attrs \
  dropped-agent-line dropped-garbage-line; do
  [[ "$out" != *"$dropped"* ]] || fail "$dropped passed the pipeline"
done
app_line=$(printf '%s\n' "$out" | grep kept-app-line)
for label in 'env="prod"' 'compose_project="email-to-telegram"' 'service="app"' 'stream="stdout"'; do
  [[ "$app_line" == *"$label"* ]] || fail "app line lacks label $label"
done
[[ "$app_line" != *filename=* ]] || fail "filename label was not dropped"
[[ "$app_line" == *'{"level":30,"msg":"kept-app-line"}'* ]] || fail "app line is not the decoded log field"
# Dry-run prints the entry timestamp first; it must be the envelope time.
[[ "$app_line" == "${now:0:19}"* ]] || fail "app line timestamp is not the json-file time ($now)"

echo "promtail pipeline: only the app line passed"
printf '%s\n' "$app_line"
