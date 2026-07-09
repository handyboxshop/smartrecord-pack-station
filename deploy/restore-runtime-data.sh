#!/usr/bin/env sh
set -eu

BACKUP_FILE="${1:-}"
RUNTIME_DIR="${2:-}"
MODE="${3:-}"

if [ -z "$BACKUP_FILE" ] || [ -z "$RUNTIME_DIR" ]; then
  echo "Usage: $0 <backup_file.tar.gz> <runtime_dir> [--force]" >&2
  echo "" >&2
  echo "Safety:" >&2
  echo "  - Without --force, restore will refuse to overwrite a non-empty runtime directory." >&2
  echo "  - With --force, the existing runtime directory is moved to .pre-restore-<timestamp> first." >&2
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

if [ "$MODE" != "" ] && [ "$MODE" != "--force" ]; then
  echo "ERROR: unsupported option: $MODE" >&2
  echo "Usage: $0 <backup_file.tar.gz> <runtime_dir> [--force]" >&2
  exit 1
fi

SHA_FILE="$BACKUP_FILE.sha256"

if [ -f "$SHA_FILE" ]; then
  echo "Verifying checksum..."
  EXPECTED_SHA="$(awk 'NR==1 { print $1 }' "$SHA_FILE")"

  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL_SHA="$(sha256sum "$BACKUP_FILE" | awk '{ print $1 }')"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL_SHA="$(shasum -a 256 "$BACKUP_FILE" | awk '{ print $1 }')"
  else
    echo "ERROR: sha256 tool not found; cannot verify checksum" >&2
    exit 1
  fi

  if [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
    echo "ERROR: checksum mismatch" >&2
    echo "Expected: $EXPECTED_SHA" >&2
    echo "Actual  : $ACTUAL_SHA" >&2
    exit 1
  fi

  echo "Checksum OK"
else
  echo "WARN: checksum file not found; restore will continue without checksum verification" >&2
fi

echo "Checking archive paths..."
tar -tzf "$BACKUP_FILE" | awk '
  $0 ~ /^\// || $0 ~ /(^|\/)\.\.(\/|$)/ {
    print "ERROR: unsafe archive path: " $0 > "/dev/stderr"
    bad = 1
  }
  END { exit bad }
'

PARENT_DIR="$(dirname -- "$RUNTIME_DIR")"
STAMP="$(date +%Y%m%d-%H%M%S)"
TMP_DIR="$PARENT_DIR/.smartrecord-restore-$STAMP"

mkdir -p "$PARENT_DIR"
mkdir "$TMP_DIR"

cleanup() {
  if [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT INT TERM

echo "Extracting backup..."
tar -xzf "$BACKUP_FILE" -C "$TMP_DIR"

if [ ! -d "$TMP_DIR/config" ] && [ ! -d "$TMP_DIR/data" ] && [ ! -d "$TMP_DIR/local-nas" ]; then
  echo "ERROR: backup does not look like SmartRecord runtime data" >&2
  exit 1
fi

if [ -d "$RUNTIME_DIR" ] && [ "$(find "$RUNTIME_DIR" -mindepth 1 -maxdepth 1 | head -1)" ]; then
  if [ "$MODE" != "--force" ]; then
    echo "ERROR: runtime directory is not empty: $RUNTIME_DIR" >&2
    echo "Re-run with --force to move the existing directory aside before restore." >&2
    exit 1
  fi

  PRE_RESTORE_DIR="${RUNTIME_DIR%/}.pre-restore-$STAMP"
  echo "Moving existing runtime directory to:"
  echo "$PRE_RESTORE_DIR"
  mv "$RUNTIME_DIR" "$PRE_RESTORE_DIR"
elif [ -d "$RUNTIME_DIR" ]; then
  rmdir "$RUNTIME_DIR"
fi

mv "$TMP_DIR" "$RUNTIME_DIR"
trap - EXIT

echo "Restore completed:"
echo "$RUNTIME_DIR"
