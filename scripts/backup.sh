#!/bin/sh
# Nightly PostgreSQL backup
# Usage: backup.sh <backup_dir> [keep_days]
#
# Called from the app container via node-cron. DATABASE_URL is passed via the
# environment (not as a CLI argument) so the password never appears in process
# listings or shell history.
#
# Backup files: <backup_dir>/backup-YYYY-MM-DD.sql.gz
# Retention:    keep_days (default 7) — older files are deleted

set -eu

BACKUP_DIR="${1:?backup_dir required}"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL env var required}"
KEEP_DAYS="${2:-7}"

DATE=$(date -u +%Y-%m-%d)
BACKUP_FILE="${BACKUP_DIR}/backup-${DATE}.sql.gz"

mkdir -p "$BACKUP_DIR"

# Parse connection components from DATABASE_URL using Node's URL parser so that
# percent-encoded characters and special chars in passwords are handled correctly.
# PGPASSWORD is passed via environment (not argv) to keep the credential out of
# /proc/<pid>/cmdline, which is world-readable on Linux.
old_ifs=$IFS
IFS='	'
# shellcheck disable=SC2086
set -- $(node --input-type=module -e '
  const url = new URL(process.env.DATABASE_URL);
  const values = [
    url.hostname || "localhost",
    String(url.port || 5432),
    decodeURIComponent(url.pathname.replace(/^\/+/, "")),
    decodeURIComponent(url.username || ""),
    decodeURIComponent(url.password || ""),
  ];
  process.stdout.write(values.join("\t"));
')
IFS=$old_ifs

PGHOST="${1:-localhost}"
PGPORT="${2:-5432}"
PGDATABASE="${3:-}"
PGUSER="${4:-}"
PGPASSWORD="${5:-}"

export PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD

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
