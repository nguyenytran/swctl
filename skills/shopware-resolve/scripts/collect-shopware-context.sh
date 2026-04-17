#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(pwd)}"
PHP_MEMORY_LIMIT="${PHP_MEMORY_LIMIT:-512M}"

if [[ ! -d "$ROOT" ]]; then
  echo "error: root not found: $ROOT" >&2
  exit 1
fi

run_console() {
  php -d "memory_limit=${PHP_MEMORY_LIMIT}" bin/console "$@" --no-interaction
}

echo "== codex shopware context =="
echo "timestamp: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "root: $ROOT"
echo

echo "== runtime =="
if command -v php >/dev/null 2>&1; then
  php -v | head -n 1
else
  echo "php: not found"
fi

if command -v composer >/dev/null 2>&1; then
  composer --version | head -n 1
else
  echo "composer: not found"
fi

echo
if [[ -f "$ROOT/composer.lock" ]]; then
  echo "== shopware packages (composer.lock) =="
  rg -n '"name": "shopware/' "$ROOT/composer.lock" | head -n 25 || true
else
  echo "composer.lock: not found"
fi

echo
if [[ -f "$ROOT/bin/console" ]]; then
  echo "== console checks =="
  (
    cd "$ROOT"
    run_console --version 2>/dev/null || true
    run_console plugin:list 2>/dev/null | head -n 60 || true
    run_console app:list 2>/dev/null | head -n 60 || true
  )
else
  echo "bin/console: not found"
fi

echo
if [[ -d "$ROOT/var/log" ]]; then
  echo "== recent logs =="
  ls -lt "$ROOT/var/log" | head -n 20
else
  echo "var/log: not found"
fi
