#!/bin/sh
# Lucent database restore (M3 durability). The other half of scripts/backup.sh.
#
# Usage:
#   sh scripts/restore.sh --target postgres://…/lucent_restore backups/lucent-….dump
#   sh scripts/restore.sh --target … --force --yes backups/lucent-….dump
#
# Options:
#   --target URL   database to restore INTO. Required, and deliberately has no
#                  default: see below.
#   --force        allow restoring over a database that already has Lucent
#                  tables (pg_restore --clean --if-exists drops them first).
#   --yes          skip the interactive confirmation. For scheduled DR drills;
#                  do not put this in an operator's shell history.
#
# There is no default target and LUCENT_DATABASE_URL is *ignored* on purpose.
# Every other script in this repo reads that variable, so a restore script that
# also read it would, on the one host where it is most likely to be run, default
# to overwriting production with an old snapshot. The target has to be typed.
#
# POSIX sh, same rationale as backup.sh: it runs where pg_restore lives.

set -eu

TARGET=""
FORCE=0
ASSUME_YES=0
DUMP=""

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --target=*) TARGET="${1#--target=}"; shift ;;
    --force) FORCE=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    -*) echo "restore: unknown option $1" >&2; exit 2 ;;
    *) DUMP="$1"; shift ;;
  esac
done

[ -n "$TARGET" ] || { echo "restore: --target URL is required" >&2; exit 2; }
[ -n "$DUMP" ] || { echo "restore: path to a .dump file is required" >&2; exit 2; }
[ -f "$DUMP" ] || { echo "restore: no such file: $DUMP" >&2; exit 2; }

command -v pg_restore >/dev/null 2>&1 || {
  echo "restore: pg_restore not found on PATH; install the postgresql-client package" >&2
  exit 127
}
command -v psql >/dev/null 2>&1 || {
  echo "restore: psql not found on PATH; it is needed for the pre- and post-checks" >&2
  exit 127
}

SAFE_TARGET="$(printf '%s' "$TARGET" | sed -e 's#^[a-z+]*://[^@]*@#postgres://***@#')"
DB_NAME="$(printf '%s' "$TARGET" | sed -e 's#[?].*$##' -e 's#.*/##')"

# 1. Is the archive intact? Check the recorded digest first, then make
# pg_restore parse the table of contents. Both, because they catch different
# faults: the digest catches bit rot and a truncated transfer, the TOC parse
# catches a dump that was written by a pg_dump that died mid-run.
STEM="${DUMP%.dump}"
if [ -f "$STEM.sha256" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$(dirname "$DUMP")" && sha256sum -c "$(basename "$STEM").sha256") >/dev/null || {
      echo "restore: FAILED checksum for $DUMP — do not restore this file" >&2
      exit 1
    }
    echo "[restore] checksum ok"
  fi
else
  echo "[restore] warning: no .sha256 sidecar next to $DUMP; integrity unverified"
fi
pg_restore --list "$DUMP" >/dev/null 2>&1 || {
  echo "restore: $DUMP is not a readable archive" >&2
  exit 1
}

# 2. Does the dump's schema match the code in this working tree? A dump taken at
# an older migration restores fine and then fails at runtime on the first query
# that touches a column the deployed build expects, which reads as a scatter of
# unrelated 500s rather than one clear message. Warn loudly; do not block, since
# restoring an old dump and then migrating forward is a legitimate recovery.
DUMP_SCHEMA="unknown"
[ -f "$STEM.manifest" ] && DUMP_SCHEMA="$(sed -n 's/^schema_at=//p' "$STEM.manifest")"
CODE_SCHEMA="$(ls -1 packages/server/migrations/*.sql 2>/dev/null | sed -e 's#.*/##' -e 's/_.*//' | sort | tail -1)"
echo "[restore] dump schema: ${DUMP_SCHEMA:-unknown}   working tree: ${CODE_SCHEMA:-unknown}"
if [ -n "$DUMP_SCHEMA" ] && [ "$DUMP_SCHEMA" != "unknown" ] && [ -n "$CODE_SCHEMA" ] \
   && [ "$DUMP_SCHEMA" != "$CODE_SCHEMA" ]; then
  echo "[restore] NOTE: schema differs. After restoring, run:"
  echo "[restore]   LUCENT_DATABASE_URL=<target> npm -w @lucent/server run db:migrate"
fi

# 3. Is the target safe to write? Refuse a non-empty database unless --force,
# so a mistyped target cannot quietly eat a live one.
EXISTING="$(psql "$TARGET" -qtAX -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'" 2>/dev/null || echo error)"
if [ "$EXISTING" = "error" ]; then
  echo "restore: cannot connect to $SAFE_TARGET" >&2
  exit 1
fi
if [ "$EXISTING" != "0" ] && [ "$FORCE" -ne 1 ]; then
  echo "restore: $SAFE_TARGET already has $EXISTING table(s) in public." >&2
  echo "restore: restore into a fresh database, or pass --force to DROP and replace them." >&2
  exit 1
fi

# 4. Confirm. Typing the database name is the check, not y/n: the mistake this
# guards against is having the wrong database in the URL, and someone about to
# make that mistake answers "y" to anything.
if [ "$ASSUME_YES" -ne 1 ]; then
  if [ "$EXISTING" != "0" ]; then
    echo "[restore] This will DROP the $EXISTING existing table(s) in $SAFE_TARGET and replace them."
  else
    echo "[restore] This will restore $(basename "$DUMP") into $SAFE_TARGET."
  fi
  printf '[restore] Type the database name (%s) to continue: ' "$DB_NAME"
  read -r typed
  [ "$typed" = "$DB_NAME" ] || { echo "restore: aborted" >&2; exit 1; }
fi

CLEAN=""
[ "$FORCE" -eq 1 ] && CLEAN="--clean --if-exists"

echo "[restore] restoring into $SAFE_TARGET"
# --single-transaction so a failure leaves the target as it was rather than
# half-populated; --exit-on-error so it actually stops at the first problem
# (pg_restore's default is to keep going and report a count at the end, which
# has restored many a database that nobody realised was incomplete).
# shellcheck disable=SC2086
pg_restore --dbname="$TARGET" --no-owner --no-privileges --single-transaction --exit-on-error \
  $CLEAN "$DUMP"

# 5. Prove it worked. A restore that reports success and leaves an empty
# board table has happened; count the rows that matter.
echo "[restore] verifying"
psql "$TARGET" -qtAX -c "SELECT 'migrations=' || count(*) FROM _lucent_migrations" || true
for t in users organizations boards op_log; do
  psql "$TARGET" -qtAX -c "SELECT '$t=' || count(*) FROM $t" 2>/dev/null || echo "$t=MISSING"
done

echo "[restore] done. If the schema line above differed, run db:migrate before serving traffic."
