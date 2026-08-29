#!/bin/sh
# Lucent database backup (M3 durability).
#
# Takes a consistent, restorable snapshot of the Postgres database that holds
# every board, op log, session and usage row, verifies the archive is readable,
# records which migration the schema was at, and prunes old copies.
#
# Usage:
#   sh scripts/backup.sh                     # uses $LUCENT_DATABASE_URL
#   sh scripts/backup.sh postgres://…/lucent # explicit target
#
# Environment:
#   LUCENT_DATABASE_URL   source database (required unless passed as $1)
#   LUCENT_BACKUP_DIR     output directory (default ./backups)
#   LUCENT_BACKUP_KEEP    how many dumps to keep (default 14, 0 = keep all)
#
# POSIX sh on purpose: this runs on the deploy host or in a container next to
# the database, where `pg_dump` lives — not on a developer's Windows box. The
# repo's cross-platform entry points are the .mjs launchers; this is not one of
# them, and it is deliberately not wired into package.json so nobody discovers
# that on a machine without pg_dump.
#
# Why custom format (-Fc) rather than plain SQL: it restores selectively
# (pg_restore -t / -n), compresses, and — the reason that matters here — it can
# be *validated* without a database, because `pg_restore --list` has to parse
# the whole table of contents. A truncated plain-SQL dump looks like a smaller
# but perfectly valid file; the failure only surfaces during the restore, which
# is the one moment you cannot afford to discover it.

set -eu

DB_URL="${1:-${LUCENT_DATABASE_URL:-}}"
if [ -z "$DB_URL" ]; then
  echo "backup: LUCENT_DATABASE_URL is required (or pass the URL as \$1)" >&2
  exit 2
fi

BACKUP_DIR="${LUCENT_BACKUP_DIR:-./backups}"
KEEP="${LUCENT_BACKUP_KEEP:-14}"

command -v pg_dump >/dev/null 2>&1 || {
  echo "backup: pg_dump not found on PATH; install the postgresql-client package" >&2
  exit 127
}
command -v pg_restore >/dev/null 2>&1 || {
  echo "backup: pg_restore not found on PATH; it is needed to verify the archive" >&2
  exit 127
}

# Dumps contain every user's board content. Create them unreadable to anyone
# else on the host, and set this before the first file is written rather than
# chmod-ing afterwards — a window where the file is world-readable is a leak
# even if it lasts a millisecond.
umask 077
mkdir -p "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="$BACKUP_DIR/lucent-$STAMP"
DUMP="$BASE.dump"

# Never print the URL: it carries the password. Show host/database only.
SAFE_TARGET="$(printf '%s' "$DB_URL" | sed -e 's#^[a-z+]*://[^@]*@#postgres://***@#')"
echo "[backup] dumping $SAFE_TARGET -> $DUMP"

# --no-owner / --no-privileges so the archive restores into a database owned by
# a different role, which is what a restore into a fresh instance or a staging
# environment always is.
pg_dump --format=custom --compress=9 --no-owner --no-privileges --file="$DUMP" "$DB_URL"

# Validate before anyone trusts it. An unreadable table of contents here means
# the dump is worthless, and it is better to fail this script than to prune a
# good older backup in favour of a broken new one.
if ! pg_restore --list "$DUMP" >/dev/null 2>&1; then
  echo "[backup] FAILED: $DUMP is not a readable archive; leaving it for inspection" >&2
  exit 1
fi

# Record the schema version the dump matches. `restore.sh` compares this against
# the code being deployed, because restoring a dump taken at migration 0007 onto
# a build that expects 0010 fails at runtime with arbitrary SQL errors rather
# than one clear refusal. psql is optional — the dump is still valid without it,
# so an absent psql downgrades the manifest instead of failing the backup.
SCHEMA_AT="unknown"
if command -v psql >/dev/null 2>&1; then
  SCHEMA_AT="$(psql "$DB_URL" -qtAX -c \
    'SELECT COALESCE(MAX(id), 0::text) FROM _lucent_migrations' 2>/dev/null || echo unknown)"
  [ -n "$SCHEMA_AT" ] || SCHEMA_AT="unknown"
fi

BYTES="$(wc -c < "$DUMP" | tr -d ' ')"
{
  echo "created_at=$STAMP"
  echo "schema_at=$SCHEMA_AT"
  echo "bytes=$BYTES"
  echo "pg_dump=$(pg_dump --version | head -1)"
  echo "format=custom"
} > "$BASE.manifest"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$BACKUP_DIR" && sha256sum "$(basename "$DUMP")" > "$(basename "$BASE").sha256")
elif command -v shasum >/dev/null 2>&1; then
  (cd "$BACKUP_DIR" && shasum -a 256 "$(basename "$DUMP")" > "$(basename "$BASE").sha256")
fi

echo "[backup] ok: $DUMP ($BYTES bytes, schema $SCHEMA_AT)"

# Retention. Sorted by name, which is chronological because the stamp is
# ISO-8601 UTC; deleting the oldest .dump takes its sidecars with it.
if [ "$KEEP" -gt 0 ] 2>/dev/null; then
  COUNT="$(ls -1 "$BACKUP_DIR"/lucent-*.dump 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$COUNT" -gt "$KEEP" ]; then
    DROP=$((COUNT - KEEP))
    ls -1 "$BACKUP_DIR"/lucent-*.dump | sort | head -n "$DROP" | while read -r old; do
      stem="${old%.dump}"
      echo "[backup] pruning $(basename "$old")"
      rm -f "$stem.dump" "$stem.manifest" "$stem.sha256"
    done
  fi
fi
