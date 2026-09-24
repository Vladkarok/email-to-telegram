#!/bin/bash
# Installs the nightly off-site backup on a Docker host. Run interactively as
# root; it prompts for secrets so they never pass through argv, shell history
# or a chat transcript.
#
#   sudo bash install.sh <environment> <restic-repository>
#
#   environment         short name used as the restic host tag, e.g. prod
#   restic-repository   e.g. s3:https://<account-id>.r2.cloudflarestorage.com/<bucket>
#
# Safe to re-run: existing credentials and the repository password are kept.
set -Eeuo pipefail
umask 077

environment=${1:?usage: install.sh <environment> <restic-repository>}
repository=${2:?usage: install.sh <environment> <restic-repository>}
here=$(cd "$(dirname "$0")" && pwd)
config_dir=/etc/etg-r2
app_container=${ETG_APP_CONTAINER:-email-to-telegram-app-1}
backup_volume=${ETG_BACKUP_VOLUME:-email-to-telegram_backups}

[[ $(id -u) -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
[[ -t 0 ]] || { echo "Run interactively (it prompts for secrets)." >&2; exit 1; }

command -v restic >/dev/null || { apt-get update -qq && apt-get install -y -qq restic; }
command -v curl >/dev/null || apt-get install -y -qq curl

backup_dir=$(docker volume inspect "$backup_volume" --format '{{.Mountpoint}}')
[[ -d "$backup_dir" ]] || { echo "Backup volume path not found: $backup_dir" >&2; exit 1; }

install -d -m 0700 "$config_dir"

cat > "$config_dir/restic.env" <<EOF
RESTIC_REPOSITORY=$repository
RESTIC_PASSWORD_FILE=$config_dir/restic-password
ETG_ENVIRONMENT=$environment
ETG_BACKUP_DIR=$backup_dir
ETG_APP_CONTAINER=$app_container
EOF
chmod 0600 "$config_dir/restic.env"

if [[ ! -s "$config_dir/credentials.env" ]]; then
    echo "R2 API token for this bucket only (Object Read & Write)."
    read -rp  "  Access Key ID: " key_id
    read -rsp "  Secret Access Key (hidden): " key_secret; echo
    read -rp  "  healthchecks.io ping URL (blank to skip): " hc_url
    [[ -n "$key_id" && -n "$key_secret" ]] || { echo "Key pair is required." >&2; exit 1; }
    {
        printf 'AWS_ACCESS_KEY_ID=%q\n' "$key_id"
        printf 'AWS_SECRET_ACCESS_KEY=%q\n' "$key_secret"
        printf 'ETG_HEALTHCHECKS_URL=%q\n' "$hc_url"
    } > "$config_dir/credentials.env"
    chmod 0600 "$config_dir/credentials.env"
    unset key_secret
fi

new_password=false
if [[ ! -s "$config_dir/restic-password" ]]; then
    head -c 48 /dev/urandom | base64 -w0 > "$config_dir/restic-password"
    chmod 0600 "$config_dir/restic-password"
    new_password=true
fi

install -m 0755 "$here/etg-r2-backup" /usr/local/sbin/etg-r2-backup
install -m 0644 "$here/etg-r2-backup.service" /etc/systemd/system/etg-r2-backup.service
install -m 0644 "$here/etg-r2-backup.timer" /etc/systemd/system/etg-r2-backup.timer

set -a
# shellcheck disable=SC1091
source "$config_dir/restic.env"
# shellcheck disable=SC1091
source "$config_dir/credentials.env"
set +a
if ! restic cat config >/dev/null 2>&1; then
    restic init
fi

systemctl daemon-reload
systemctl enable --now etg-r2-backup.timer

if $new_password; then
    echo
    echo "=================================================================="
    echo " Repository password (needed for any restore). Copy it into your"
    echo " password manager now, next to this host's .env. It is not shown"
    echo " again; it stays in $config_dir/restic-password on this host."
    echo
    echo "   $(cat "$config_dir/restic-password")"
    echo "=================================================================="
fi
echo
echo "Installed. Next run: $(systemctl show etg-r2-backup.timer -p NextElapseUSecRealtime --value)"
echo "Run once now:  systemctl start etg-r2-backup.service && journalctl -u etg-r2-backup -n 30"
