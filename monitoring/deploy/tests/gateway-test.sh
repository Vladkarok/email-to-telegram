#!/usr/bin/env bash
# Tests the Loki push gateway (monitoring/loki-gateway/nginx.conf) in its
# pinned image, with the container options of docker-compose.monitoring.yml,
# in front of a real Loki (pinned image, repo config). Throwaway CA and
# certificate; secrets installed the way the deploy installs them.
#
#   bash monitoring/deploy/tests/gateway-test.sh
#
# Checks: nginx -t; 401 without or with wrong credentials; 403 for other
# methods and paths even with valid credentials; plain HTTP rejected; an
# authenticated push accepted; a chunked authenticated push larger than the
# 1 MiB body buffer accepted with no temp file written; 413 above 4 MiB; the
# pushed lines queryable in Loki.
set -Eeuo pipefail

repo=$(cd "$(dirname "$0")/../../.." && pwd)
# shellcheck source=monitoring/agent/deploy/lib.sh
. "$repo/monitoring/agent/deploy/lib.sh"
compose_file="$repo/monitoring/docker-compose.monitoring.yml"
nginx_image=$(awk '/image: nginx:/ { print $2; exit }' "$compose_file")
loki_image=$(awk '/image: grafana\/loki:/ { print $2; exit }' "$compose_file")
port=13101
id=$$
net="etg-gwtest-$id"
loki="etg-gwtest-loki-$id"
gw="etg-gwtest-gw-$id"
work=$(mktemp -d)

cleanup() {
  set +e
  docker rm -f "$gw" "$loki" >/dev/null 2>&1
  docker network rm "$net" >/dev/null 2>&1
  docker run --rm -v "$work:/w" "$ETG_HELPER_IMAGE" rm -rf /w/secrets >/dev/null 2>&1
  rm -rf "$work"
}
trap cleanup EXIT
fail() {
  echo "FAIL: $*" >&2
  docker logs --tail 30 "$gw" >&2 2>&1 || true
  exit 1
}

# Throwaway CA and a server certificate for 127.0.0.1.
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 60 \
  -subj /CN=etg-test-ca -addext basicConstraints=critical,CA:TRUE \
  -addext keyUsage=critical,keyCertSign,cRLSign \
  -keyout "$work/ca.key" -out "$work/ca.crt" 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj /CN=127.0.0.1 \
  -keyout "$work/host.key" -out "$work/host.csr" 2>/dev/null
printf 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' >"$work/ext"
openssl x509 -req -in "$work/host.csr" -CA "$work/ca.crt" -CAkey "$work/ca.key" -CAcreateserial \
  -days 60 -extfile "$work/ext" -out "$work/host.crt" 2>/dev/null

user=promtail-a
password=$(openssl rand -hex 24)
mkdir -p "$work/in/loki-gateway"
cp "$work/host.crt" "$work/in/loki-gateway/tls.crt"
cp "$work/host.key" "$work/in/loki-gateway/tls.key"
printf '%s' "$password" | HTPASSWD_VIA="" bcrypt_line "$user" >"$work/in/loki-gateway/htpasswd"
printf '%s\n' "dir loki-gateway 101" "file loki-gateway/tls.crt 101" \
  "file loki-gateway/tls.key 101" "file loki-gateway/htpasswd 101" >"$work/in/manifest"
install_secrets "$work/in" "$work/secrets"
check_readable "$work/secrets/loki-gateway" 101

# shellcheck disable=SC2054 # the commas belong to the --tmpfs option
gateway_opts=(
  --user 101:101 --read-only --tmpfs /tmp:size=8m,mode=1777
  --cap-drop ALL --security-opt no-new-privileges
  --memory 32m --cpus 0.25 --pids-limit 32
  -v "$repo/monitoring/loki-gateway:/etc/loki-gateway:ro"
  -v "$work/secrets/loki-gateway:/etc/loki-gateway-secrets:ro"
  --entrypoint nginx
)

echo "nginx -t ($nginx_image)"
docker run --rm --network none "${gateway_opts[@]}" "$nginx_image" -t -c /etc/loki-gateway/nginx.conf

docker network create "$net" >/dev/null
docker run -d --name "$loki" --network "$net" --network-alias loki \
  --tmpfs /loki:uid=10001,gid=10001 -v "$repo/monitoring/loki:/etc/loki:ro" \
  "$loki_image" -config.file=/etc/loki/loki-config.yml >/dev/null
# Command output is captured before matching: `cmd | grep -q` can fail under
# pipefail when grep exits before cmd has written everything.
loki_ready() {
  local out
  out=$(docker exec "$loki" wget -qO- http://127.0.0.1:3100/ready 2>/dev/null) || return 1
  [[ "$out" == *ready* ]]
}
for _ in $(seq 1 60); do
  loki_ready && break
  sleep 2
done
loki_ready || fail "loki not ready"

docker run -d --name "$gw" --network "$net" -p "127.0.0.1:$port:3101" "${gateway_opts[@]}" \
  "$nginx_image" -c /etc/loki-gateway/nginx.conf -g 'daemon off;' >/dev/null
for _ in $(seq 1 30); do
  health=$(docker exec "$gw" wget -qO- http://127.0.0.1:8080/healthz 2>/dev/null || true)
  [[ "$health" == *ok* ]] && break
  sleep 1
done

url="https://127.0.0.1:$port"
push="$url/loki/api/v1/push"
ca=(--cacert "$work/ca.crt")
json=(-H 'Content-Type: application/json')

check() { # WANT DESCRIPTION GOT
  [[ "$3" == "$1" ]] || fail "$2: HTTP $3, expected $1"
  echo "ok  $1  $2"
}

check 401 "POST without credentials" "$(http_status "${ca[@]}" -X POST "${json[@]}" --data-raw '{"streams":[]}' "$push")"
check 401 "POST with a wrong password" \
  "$(http_status_auth "$user" "wrong-$password" "${ca[@]}" -X POST "${json[@]}" --data-raw '{"streams":[]}' "$push")"
for method in GET PUT DELETE PATCH; do
  check 403 "$method on the push path with valid credentials" \
    "$(http_status_auth "$user" "$password" "${ca[@]}" -X "$method" "$push")"
done
check 403 "HEAD on the push path with valid credentials" "$(http_status_auth "$user" "$password" "${ca[@]}" -I "$push")"
for path in / /ready /metrics /loki/api/v1/query /loki/api/v1/delete /loki/api/v1/push/; do
  check 403 "GET $path with valid credentials" "$(http_status_auth "$user" "$password" "${ca[@]}" "$url$path")"
done
got=$(http_status "http://127.0.0.1:$port/loki/api/v1/push")
[[ "$got" != 2* ]] || fail "plain HTTP returned $got"
echo "ok  $got  plain HTTP rejected"
check 204 "authenticated empty push" \
  "$(http_status_auth "$user" "$password" "${ca[@]}" -X POST "${json[@]}" --data-raw '{"streams":[]}' "$push")"

# A push larger than client_body_buffer_size (1 MiB), sent chunked.
python3 - "$work/big.json" 2500000 <<'PY'
import json, sys, time
path, target = sys.argv[1], int(sys.argv[2])
now = time.time_ns()
values, size, i = [], 0, 0
while size < target:
    line = f"gateway-test line {i:07d} " + "x" * 200
    values.append([str(now + i), line])
    size += len(line) + 40
    i += 1
json.dump({"streams": [{"stream": {"env": "gateway-test", "service": "app"}, "values": values}]},
          open(path, "w"))
PY
size=$(stat -c %s "$work/big.json")
check 204 "chunked push of $size bytes" \
  "$(http_status_auth "$user" "$password" "${ca[@]}" -X POST "${json[@]}" -H 'Transfer-Encoding: chunked' \
    --data-binary @"$work/big.json" "$push")"
temp_files=$(docker exec "$gw" find /tmp -type f ! -name nginx.pid)
[[ -z "$temp_files" ]] || fail "request body written to disk: $temp_files"
# nginx deletes a body temp file when the request ends, but warns when it
# writes one ("a client request body is buffered to a temporary file").
gw_log=$(docker logs "$gw" 2>&1)
if [[ "$gw_log" == *"buffered to a temporary file"* ]]; then
  fail "the request body was buffered to a temporary file"
fi
echo "ok  no temp files under /tmp and no buffering warning after the chunked push"

head -c 5000000 /dev/zero | tr '\0' 'x' >"$work/huge.json"
check 413 "push above client_max_body_size" \
  "$(http_status_auth "$user" "$password" "${ca[@]}" -X POST "${json[@]}" --data-binary @"$work/huge.json" "$push")"

sleep 2
count=$(docker exec "$loki" wget -qO- \
  'http://127.0.0.1:3100/loki/api/v1/query?query=sum(count_over_time(%7Benv%3D%22gateway-test%22%7D%5B1h%5D))' |
  python3 -c 'import json,sys; r=json.load(sys.stdin)["data"]["result"]; print(r[0]["value"][1] if r else 0)')
[[ "$count" -gt 1000 ]] || fail "loki holds $count pushed lines"
echo "ok  loki holds $count pushed lines"
echo
echo "gateway test: all checks passed"
