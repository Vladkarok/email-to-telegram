#!/bin/sh
# Nightly PostgreSQL backup
# Usage: backup.sh <backup_dir> [keep_days]
#
# Called from the app container via node-cron. DATABASE_URL is passed via the
# environment (not as a CLI argument) so the password never appears in process
# listings or shell history.
#
# Backup files: <backup_dir>/backup-YYYY-MM-DD.sql.gz
# Metadata:      <backup_dir>/backup-YYYY-MM-DD.meta
# Retention:    keep_days (default 7) — older files are deleted

set -eu
umask 077

BACKUP_DIR="${1:?backup_dir required}"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL env var required}"
KEEP_DAYS="${2:-7}"
STORAGE_ENCRYPTION_MODE="${STORAGE_ENCRYPTION_MODE:-none}"
MASTER_ENCRYPTION_KEY="${MASTER_ENCRYPTION_KEY:-}"
MASTER_ENCRYPTION_KEY_ID="${MASTER_ENCRYPTION_KEY_ID:-local-env-v1}"
MASTER_ENCRYPTION_KEYRING="${MASTER_ENCRYPTION_KEYRING:-}"
ATTACHMENT_DIR="${ATTACHMENT_DIR:-}"
RAW_EMAIL_DIR="${RAW_EMAIL_DIR:-}"
BACKUP_ARCHIVE_ENCRYPTION="${BACKUP_ARCHIVE_ENCRYPTION:-off}"

DATE=$(date -u +%Y-%m-%d)
PLAIN_BACKUP_FILE="${BACKUP_DIR}/backup-${DATE}.sql.gz"
ENCRYPTED_BACKUP_FILE="${PLAIN_BACKUP_FILE}.etg"
BACKUP_FILE="$PLAIN_BACKUP_FILE"
META_FILE="${BACKUP_DIR}/backup-${DATE}.meta"

mkdir -p "$BACKUP_DIR"

# Parse connection components from DATABASE_URL using Node's URL parser so that
# percent-encoded characters and special chars in passwords are handled correctly.
# PGPASSWORD is passed via environment (not argv) to keep the credential out of
# /proc/<pid>/cmdline, which is world-readable on Linux.
old_ifs=$IFS
IFS='
'
TMP_CONN="${BACKUP_DIR}/.backup-conn-${DATE}-$$.txt"
TMP_SQL="${BACKUP_DIR}/.backup-${DATE}-$$.sql"
TMP_GZ="${PLAIN_BACKUP_FILE}.tmp"
TMP_ENC="${ENCRYPTED_BACKUP_FILE}.tmp"
TMP_META="${META_FILE}.tmp"
TMP_ARCHIVE_META="${BACKUP_DIR}/.backup-${DATE}-$$.archive-meta"
cleanup_tmp() {
  rm -f "$TMP_SQL" "$TMP_GZ" "$TMP_ENC" "$TMP_CONN" "$TMP_META" "$TMP_ARCHIVE_META"
}
trap cleanup_tmp EXIT INT TERM

if [ "$STORAGE_ENCRYPTION_MODE" = "local-v1" ] && [ -z "$MASTER_ENCRYPTION_KEY" ]; then
  echo "backup.sh: MASTER_ENCRYPTION_KEY is required when STORAGE_ENCRYPTION_MODE=local-v1" >&2
  exit 1
fi

case "$BACKUP_ARCHIVE_ENCRYPTION" in
  off|storage-key) ;;
  *)
    echo "backup.sh: BACKUP_ARCHIVE_ENCRYPTION must be off or storage-key" >&2
    exit 1
    ;;
esac

if [ "$BACKUP_ARCHIVE_ENCRYPTION" = "storage-key" ] && [ "$STORAGE_ENCRYPTION_MODE" != "local-v1" ]; then
  echo "backup.sh: BACKUP_ARCHIVE_ENCRYPTION=storage-key requires STORAGE_ENCRYPTION_MODE=local-v1" >&2
  exit 1
fi

node --input-type=module -e '
  const url = new URL(process.env.DATABASE_URL);
  const values = [
    url.hostname || "localhost",
    String(url.port || 5432),
    decodeURIComponent(url.pathname.replace(/^\/+/, "")),
    decodeURIComponent(url.username || ""),
    decodeURIComponent(url.password || ""),
  ];
  process.stdout.write(`${values.join("\n")}\n`);
' > "$TMP_CONN"
IFS=$old_ifs

{
  IFS= read -r PGHOST
  IFS= read -r PGPORT
  IFS= read -r PGDATABASE
  IFS= read -r PGUSER
  IFS= read -r PGPASSWORD
} < "$TMP_CONN"

export PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD
pg_dump \
  --host="$PGHOST" \
  --port="$PGPORT" \
  --username="$PGUSER" \
  --no-password \
  --format=plain \
  "$PGDATABASE" > "$TMP_SQL"

gzip -9 < "$TMP_SQL" > "$TMP_GZ"

if [ "$BACKUP_ARCHIVE_ENCRYPTION" = "storage-key" ]; then
  BACKUP_FILE="$ENCRYPTED_BACKUP_FILE"
  node "$(dirname "$0")/../dist/backupArchiveCli.js" \
    encrypt \
    "$TMP_GZ" \
    "$TMP_ENC" \
    "backup-archive:$(basename "$BACKUP_FILE")" > "$TMP_ARCHIVE_META"
  mv "$TMP_ENC" "$BACKUP_FILE"
  rm -f "$TMP_GZ"
else
  mv "$TMP_GZ" "$BACKUP_FILE"
fi

{
  echo "created_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "backup_file=$(basename "$BACKUP_FILE")"
  echo "backup_scope=database_only"
  echo "storage_encryption_mode=$STORAGE_ENCRYPTION_MODE"
  echo "master_encryption_key_id=$MASTER_ENCRYPTION_KEY_ID"
  echo "backup_archive_encryption=$BACKUP_ARCHIVE_ENCRYPTION"
  echo "attachment_dir=$ATTACHMENT_DIR"
  echo "raw_email_dir=$RAW_EMAIL_DIR"
  echo "requires_matching_master_key=$([ "$STORAGE_ENCRYPTION_MODE" = "local-v1" ] && echo yes || echo no)"
  echo "note=This backup contains only the PostgreSQL dump. Attachment/raw mail files are stored separately."
  echo "restore_warning=Keep the attachment/raw mail files alongside this dump. If storage encryption is enabled, keep the matching MASTER_ENCRYPTION_KEY. Reuse the ATTACHMENT_DIR/RAW_EMAIL_DIR paths recorded here when restoring old files."
  if [ -f "$TMP_ARCHIVE_META" ]; then
    cat "$TMP_ARCHIVE_META"
  fi
} > "$TMP_META"
mv "$TMP_META" "$META_FILE"

rm -f "$TMP_SQL" "$TMP_CONN"
trap - EXIT INT TERM

echo "Backup written: $BACKUP_FILE ($(du -sh "$BACKUP_FILE" | cut -f1))"
echo "Backup metadata: $META_FILE"

# Rotate: delete backups older than KEEP_DAYS
find "$BACKUP_DIR" -maxdepth 1 -name 'backup-*.sql.gz' -mtime "+${KEEP_DAYS}" -delete
find "$BACKUP_DIR" -maxdepth 1 -name 'backup-*.sql.gz.etg' -mtime "+${KEEP_DAYS}" -delete
find "$BACKUP_DIR" -maxdepth 1 -name 'backup-*.meta' -mtime "+${KEEP_DAYS}" -delete
echo "Retention: kept last ${KEEP_DAYS} days of backups"
