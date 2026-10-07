# shellcheck shell=bash
# Helpers shared by the monitoring deploy scripts. Sourced, never executed.
#
# Runner side: render-payload.sh (agent) and monitoring/deploy/render-payload.sh
# (staging stack) validate secrets and build the upload. Host side:
# agent-deploy.sh and monitoring/deploy/stack-deploy.sh install it under the
# host lock. Nothing here prints a secret, and no secret is passed in argv.

ETG_LOCK_FILE="$HOME/.etg-deploy.lock"
ETG_LOCK_WAIT_SECONDS=900
# Pinned images used for one-off jobs on the host.
ETG_HELPER_IMAGE=busybox:1.37
ETG_HTPASSWD_IMAGE=httpd:2.4.69-alpine

log() { printf '%s\n' "$*" >&2; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmds() {
  local cmd missing=()
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
  done
  ((${#missing[@]} == 0)) || die "required command(s) not found: ${missing[*]}"
}

# ---------------------------------------------------------------- runner side

# Passwords travel through htpasswd stdin, curl config lines and psql, so they
# are limited to a quote-free, whitespace-free alphabet.
check_password() {
  local name=$1 value=$2
  [[ -n "$value" ]] || die "secret $name is not set"
  [[ "$value" =~ ^[A-Za-z0-9._~+/=-]{24,256}$ ]] ||
    die "secret $name must be 24-256 characters of [A-Za-z0-9._~+/=-] (generate it with: openssl rand -hex 32)"
}

# check_user NAME VALUE ALLOWED... : VALUE must be one of ALLOWED.
check_user() {
  local name=$1 value=$2 allowed
  shift 2
  for allowed in "$@"; do
    [[ "$value" == "$allowed" ]] && return 0
  done
  die "$name must be one of: $* (got '$value')"
}

# other_user prometheus-a -> prometheus-b
other_user() {
  case $1 in
    *-a) printf '%s\n' "${1%-a}-b" ;;
    *-b) printf '%s\n' "${1%-b}-a" ;;
    *) die "cannot derive the second rotation user from '$1'" ;;
  esac
}

# bcrypt_line USER : reads the password on stdin, prints "USER:<bcrypt hash>".
# The hash is computed by the pinned httpd image, cost 10, on the target host
# (HTPASSWD_VIA="ssh <host>") or with the local Docker (HTPASSWD_VIA="").
bcrypt_line() {
  local user=$1 out line
  [[ "$user" =~ ^[a-z0-9-]+$ ]] || die "invalid basic-auth user name: $user"
  # shellcheck disable=SC2086 # HTPASSWD_VIA is a command prefix, split on purpose
  out=$(${HTPASSWD_VIA:-} docker run --rm -i --network none --pull missing \
    "$ETG_HTPASSWD_IMAGE" htpasswd -niB -C 10 "$user") ||
    die "htpasswd failed for user $user"
  line=$(printf '%s\n' "$out" | head -n 1)
  [[ "$line" =~ ^${user}:\$2y\$10\$[./A-Za-z0-9]{53}$ ]] ||
    die "htpasswd returned an unexpected line for user $user"
  printf '%s\n' "$line"
}

# check_cert CERT_FILE KEY_FILE CA_FILE IP : the server certificate must be
# issued by the repo CA, carry the IP as a SAN, match the key, and be valid.
check_cert() {
  local cert=$1 key=$2 ca=$3 ip=$4 cert_pub key_pub san
  [[ -s "$ca" ]] || die "CA certificate $ca is missing (see docs/operations/monitoring.md, Certificates)"
  openssl x509 -in "$cert" -noout 2>/dev/null || die "HOST_TLS_CERT is not a PEM certificate"
  openssl pkey -in "$key" -noout 2>/dev/null || die "HOST_TLS_KEY is not a PEM private key"
  openssl verify -CAfile "$ca" "$cert" >/dev/null 2>&1 ||
    die "HOST_TLS_CERT is not signed by $ca"
  san=$(openssl x509 -in "$cert" -noout -ext subjectAltName 2>/dev/null || true)
  grep -Eq "IP Address:${ip//./\\.}(,|$)" <<<"$san" ||
    die "HOST_TLS_CERT has no subjectAltName IP:$ip"
  cert_pub=$(openssl x509 -in "$cert" -noout -pubkey | openssl sha256)
  key_pub=$(openssl pkey -in "$key" -pubout | openssl sha256)
  [[ "$cert_pub" == "$key_pub" ]] || die "HOST_TLS_KEY does not match HOST_TLS_CERT"
  openssl x509 -in "$cert" -noout -checkend 0 >/dev/null || die "HOST_TLS_CERT has expired"
  if ! openssl x509 -in "$cert" -noout -checkend $((30 * 86400)) >/dev/null; then
    printf '::warning::HOST_TLS_CERT for %s expires within 30 days; renew it (docs/operations/monitoring.md)\n' "$ip"
  fi
}

# write_secret FILE VALUE : writes VALUE without a trailing newline, mode 0600.
write_secret() {
  (umask 077 && printf '%s' "$2" >"$1")
}

# config_hash BASE FILE... : one digest over the files (paths relative to
# BASE, and contents).
config_hash() {
  local base=$1
  shift
  (
    cd "$base" || exit 1
    for f in "$@"; do
      printf '%s\0' "$f"
      cat -- "$f"
      printf '\0'
    done
  ) | sha256sum | cut -c1-16
}

# ------------------------------------------------------------------ host side

# take_lock : serialises every host-mutating deploy on this host. Fails after
# 15 minutes instead of waiting forever.
take_lock() {
  exec 9>>"$ETG_LOCK_FILE"
  flock -w "$ETG_LOCK_WAIT_SECONDS" 9 ||
    die "another deploy has held $ETG_LOCK_FILE for ${ETG_LOCK_WAIT_SECONDS}s; giving up"
}

# host_has_ip IP : the address is configured on one of this host's interfaces.
host_has_ip() {
  local addrs
  addrs=$(ip -o -4 addr show | awk '{ split($4, a, "/"); print a[1] }')
  grep -qxF "$1" <<<"$addrs"
}

ensure_image() {
  docker image inspect "$1" >/dev/null 2>&1 || docker pull -q "$1" >/dev/null
}

# run_helper ARGS... : a throwaway root container without network, used for the
# few file operations that need another owner than the deploy user.
run_helper() {
  docker run --rm -i --network none --security-opt no-new-privileges \
    --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
    "$@"
}

# install_secrets SRC DST : installs the files described by SRC/manifest into
# DST. Manifest lines:
#   dir  <relative dir>  <gid>   -> DST/<dir>, owner deploy user, group <gid>, 0750
#   file <relative path> <uid>   -> owner <uid>:<uid>, 0400, written as temp + rename
# Files in a managed directory that the manifest does not list are removed.
install_secrets() {
  local src=$1 dst=$2
  [[ -s "$src/manifest" ]] || die "secret manifest missing in $src"
  mkdir -p "$dst"
  chmod 0700 "$dst"
  # shellcheck disable=SC2016 # the script runs in the helper container's sh
  run_helper -v "$src:/in:ro" -v "$dst:/out" "$ETG_HELPER_IMAGE" sh -eu -c '
    umask 077
    deploy_uid=$1
    while read -r kind path id; do
      case $kind in
        dir)
          mkdir -p "/out/$path"
          chown "$deploy_uid:$id" "/out/$path"
          chmod 0750 "/out/$path"
          ;;
        file)
          dir=$(dirname "$path"); base=$(basename "$path")
          tmp="/out/$dir/.$base.new"
          cp "/in/$path" "$tmp"
          chown "$id:$id" "$tmp"
          chmod 0400 "$tmp"
          mv -f "$tmp" "/out/$path"
          ;;
        *) echo "bad manifest line: $kind" >&2; exit 1 ;;
      esac
    done < /in/manifest
    awk "\$1 == \"dir\" { print \$2 }" /in/manifest | while read -r dir; do
      for f in "/out/$dir"/* "/out/$dir"/.[!.]*; do
        [ -e "$f" ] || continue
        rel=${f#/out/}
        awk -v p="$rel" "\$1 == \"file\" && \$2 == p { found = 1 } END { exit !found }" /in/manifest ||
          rm -rf "$f"
      done
    done
  ' install-secrets "$(id -u)"
}

# check_readable DIR UID : every file in DIR can be read by UID:UID, the user
# the consuming container runs as.
check_readable() {
  local dir=$1 uid=$2
  docker run --rm --network none --user "$uid:$uid" -v "$dir:/s:ro" "$ETG_HELPER_IMAGE" \
    sh -c 'set -e; n=0; for f in /s/*; do [ -f "$f" ] || continue; cat "$f" >/dev/null; n=$((n + 1)); done; [ "$n" -gt 0 ]' ||
    die "files in $dir are not readable as uid $uid"
}

# curl_auth USER PASSWORD CURL_ARGS... : the credential reaches curl as a
# config line on stdin, never in argv.
curl_auth() {
  local user=$1 pw=$2
  shift 2
  printf 'user = "%s:%s"\n' "$user" "$pw" | curl -K - "$@"
}

# http_status CURL_ARGS... : prints the HTTP status, 000 when no response.
http_status() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" || true
}

http_status_auth() {
  local user=$1 pw=$2
  shift 2
  curl_auth "$user" "$pw" -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" || true
}
