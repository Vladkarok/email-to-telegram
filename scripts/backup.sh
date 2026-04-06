#!/usr/bin/env bash
# Nightly PostgreSQL backup
# Usage: backup.sh <backup_dir> [keep_days]
#
# Called from the app container via node-cron. DATABASE_URL is passed via the
# environment (not as a CLI argument) so the password never appears in process
# listings or shell history.
#
# Backup files: <backup_dir>/backup-YYYY-MM-DD.sql.gz
# Retention:    keep_days (default 7) — older files are deleted

set -euo pipefail

BACKUP_DIR="${1:?backup_dir required}"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL env var required}"
KEEP_DAYS="${2:-7}"

DATE=$(date -u +%Y-%m-%d)
BACKUP_FILE="${BACKUP_DIR}/backup-${DATE}.sql.gz"

mkdir -p "$BACKUP_DIR"

# Parse connection components from DATABASE_URL using Python's URL parser so that
# percent-encoded characters and special chars in passwords are handled correctly.
# PGPASSWORD is passed via environment (not argv) to keep the credential out of
# /proc/<pid>/cmdline, which is world-readable on Linux.
_pg_vars=$(python3 - <<'PYEOF'
import os, sys, urllib.parse as up
u = up.urlparse(os.environ["DATABASE_URL"])
host = u.hostname or "localhost"
port = str(u.port or 5432)
db   = up.unquote(u.path.lstrip("/"))
user = up.unquote(u.username or "")
pw   = up.unquote(u.password or "")
# Output as NUL-delimited pairs so any character in values is safe
sys.stdout.write(f"PGHOST={host}\nPGPORT={port}\nPGDATABASE={db}\nPGUSER={user}\nPGPASSWORD={pw}\n")
PYEOF
)

# Load parsed variables into the current shell
while IFS='=' read -r key value; do
  export "$key=$value"
done <<< "$_pg_vars"

pg_dump \
  --host="$PGHOST" \
  --port="$PGPORT" \
  --username="$PGUSER" \
  --no-password \
  --format=plain \
  "$PGDATABASE" \
  | gzip -9 > "$BACKUP_FILE"

echo "Backup written: $BACKUP_FILE ($(du -sh "$BACKUP_FILE" | cut -f1))"

# Rotate: delete backups older than KEEP_DAYS
find "$BACKUP_DIR" -maxdepth 1 -name 'backup-*.sql.gz' -mtime "+${KEEP_DAYS}" -delete
echo "Retention: kept last ${KEEP_DAYS} days of backups"
