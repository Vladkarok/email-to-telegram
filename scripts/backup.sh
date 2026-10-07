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
# Retention:    keep_days (default 7) — older files are deleted, including
#               temp files left behind by runs that were killed

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

# Temp files from runs killed before their EXIT trap could run (SIGKILL, OOM).
# They can hold a plaintext dump or DB credentials, and the rotation patterns
# below never match them. Sweep them before the dump, so a run that fails
# (for example on a disk those leftovers filled) still removes them. The mtime
# filter leaves the in-progress files of a concurrent run alone.
find "$BACKUP_DIR" -maxdepth 1 -type f -name '.backup-*' -mtime "+${KEEP_DAYS}" -delete
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'backup-*.tmp' -mtime "+${KEEP_DAYS}" -delete

# Parse connection components from DATABASE_URL using Node's URL parser so that
# percent-encoded characters and special chars in passwords are handled correctly.
# PGPASSWORD is passed via environment (not argv) to keep the credential out of
# /proc/<pid>/cmdline, which is world-readable on Linux.
old_ifs=$IFS
IFS='
'
TMP_CONN=
TMP_SQL=
TMP_GZ=
TMP_ENC=
TMP_META=
TMP_ARCHIVE_META=
cleanup_tmp() {
  for tmp_file in "$TMP_CONN" "$TMP_SQL" "$TMP_GZ" "$TMP_ENC" "$TMP_META" "$TMP_ARCHIVE_META"; do
    if [ -n "$tmp_file" ]; then
      rm -f "$tmp_file"
    fi
  done
}
trap cleanup_tmp EXIT
# Exit on HUP/INT/TERM so the EXIT trap cleans up and the run stops there.
# Untrapped, these signals kill the shell without running the EXIT trap; a
# trap that only cleaned up would let the run continue and commit incomplete
# metadata.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Every temp file name carries this run's PID and a token mktemp reserved in
# BACKUP_DIR, so no two runs share one, not even runs in separate containers
# that share the volume and the PID. Cleanup then only ever removes this run's
# own files. The dump and .meta keep their date-only names.
TMP_CONN=$(mktemp "${BACKUP_DIR}/.backup-conn-${DATE}-$$-XXXXXX")
RUN_ID="$$-${TMP_CONN##*-}"
TMP_SQL="${BACKUP_DIR}/.backup-${DATE}-${RUN_ID}.sql"
TMP_GZ="${PLAIN_BACKUP_FILE}.${RUN_ID}.tmp"
TMP_ENC="${ENCRYPTED_BACKUP_FILE}.${RUN_ID}.tmp"
TMP_META="${META_FILE}.${RUN_ID}.tmp"
TMP_ARCHIVE_META="${BACKUP_DIR}/.backup-${DATE}-${RUN_ID}.archive-meta"

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
if [ "$BACKUP_ARCHIVE_ENCRYPTION" = "storage-key" ]; then
  mv "$TMP_ENC" "$BACKUP_FILE"
fi

cleanup_tmp
trap - EXIT HUP INT TERM

echo "Backup written: $BACKUP_FILE ($(du -sh "$BACKUP_FILE" | cut -f1))"
echo "Backup metadata: $META_FILE"

# Rotate: delete backups older than KEEP_DAYS
find "$BACKUP_DIR" -maxdepth 1 -name 'backup-*.sql.gz' -mtime "+${KEEP_DAYS}" -delete
find "$BACKUP_DIR" -maxdepth 1 -name 'backup-*.sql.gz.etg' -mtime "+${KEEP_DAYS}" -delete
find "$BACKUP_DIR" -maxdepth 1 -name 'backup-*.meta' -mtime "+${KEEP_DAYS}" -delete
echo "Retention: kept last ${KEEP_DAYS} days of backups"
