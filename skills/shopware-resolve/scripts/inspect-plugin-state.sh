#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(pwd)}"
PHP_MEMORY_LIMIT="${PHP_MEMORY_LIMIT:-512M}"

if [[ ! -d "$ROOT" ]]; then
  echo "error: root not found: $ROOT" >&2
  exit 1
fi

if [[ ! -f "$ROOT/bin/console" ]]; then
  echo "error: bin/console not found under: $ROOT" >&2
  exit 1
fi

run_console() {
  php -d "memory_limit=${PHP_MEMORY_LIMIT}" bin/console "$@" --no-interaction
}

echo "== plugin and app lifecycle snapshot =="
echo "timestamp: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "root: $ROOT"
echo

cd "$ROOT"

echo "== plugin:list =="
run_console plugin:list || true

echo
echo "== app:list =="
run_console app:list || true

echo
echo "== migration status hint =="
run_console database:migrate --all --dry-run 2>/dev/null || echo "dry-run not supported; inspect migrations manually"

echo
echo "== index refresh hint =="
run_console dal:refresh:index --help >/dev/null 2>&1 && echo "index command available: dal:refresh:index" || echo "index command unavailable"
