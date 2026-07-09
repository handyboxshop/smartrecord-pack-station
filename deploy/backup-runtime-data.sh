#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
RUNTIME_DIR="${1:-"$SCRIPT_DIR/smartrecord-data"}"
BACKUP_DIR="${2:-"$SCRIPT_DIR/smartrecord-backups"}"

if [ ! -d "$RUNTIME_DIR" ]; then
  echo "ERROR: runtime directory not found: $RUNTIME_DIR" >&2
  echo "Usage: $0 [runtime_dir] [backup_dir]" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_NAME="smartrecord-runtime-$STAMP.tar.gz"
TMP_FILE="$BACKUP_DIR/.$BACKUP_NAME.tmp"
BACKUP_FILE="$BACKUP_DIR/$BACKUP_NAME"
SHA_FILE="$BACKUP_FILE.sha256"

echo "Backing up SmartRecord runtime data..."
echo "Runtime: $RUNTIME_DIR"
echo "Backup : $BACKUP_FILE"

tar -czf "$TMP_FILE" -C "$RUNTIME_DIR" .
mv "$TMP_FILE" "$BACKUP_FILE"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$BACKUP_FILE" > "$SHA_FILE"
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$BACKUP_FILE" > "$SHA_FILE"
else
  echo "WARN: sha256 tool not found; skipped checksum" >&2
fi

echo "Backup completed:"
echo "$BACKUP_FILE"

if [ -f "$SHA_FILE" ]; then
  echo "Checksum:"
  cat "$SHA_FILE"
fi
