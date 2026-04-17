#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-var/log}"
LIMIT="${2:-400}"

if [[ ! -e "$TARGET" ]]; then
  echo "error: target not found: $TARGET" >&2
  exit 1
fi

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

rg -n -i 'critical|error|exception|sqlstate|deadlock|cannot autowire|class .* not found|message handling failed' "$TARGET" > "$TMP_FILE" || true

echo "== matching lines (first ${LIMIT}) =="
head -n "$LIMIT" "$TMP_FILE" || true

echo
echo "== top recurring signatures =="
# Normalize volatile values so repeated failures collapse into comparable signatures.
sed -E 's/[0-9a-f]{12,}/<id>/g; s/:[0-9]+/:<line>/g; s@[[:space:]]+in /[^ ]+@ in <path>@g' "$TMP_FILE" \
  | sed -E 's/^[^:]+:[0-9]+://g' \
  | awk '{$1=$1; print}' \
  | sort \
  | uniq -c \
  | sort -nr \
  | head -n 30
