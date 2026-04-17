#!/usr/bin/env bash
set -euo pipefail

PYTHON_BIN="${PYTHON_BIN:-python3}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${BASE:-$SCRIPT_DIR}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
VALIDATOR="${VALIDATOR:-$CODEX_HOME/skills/.system/skill-creator/scripts/quick_validate.py}"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "error: python not found or not executable: $PYTHON_BIN" >&2
  echo "hint: set PYTHON_BIN to a Python interpreter with PyYAML installed." >&2
  exit 1
fi

if [[ ! -f "$VALIDATOR" ]]; then
  echo "error: validator not found: $VALIDATOR" >&2
  exit 1
fi

if ! "$PYTHON_BIN" -c "import yaml" >/dev/null 2>&1; then
  echo "error: PyYAML is not available for $PYTHON_BIN" >&2
  echo "hint: install it with: $PYTHON_BIN -m pip install pyyaml" >&2
  exit 1
fi

targets=(
  "$BASE"
)

for dir in "${targets[@]}"; do
  echo "== validating: $dir =="
  "$PYTHON_BIN" "$VALIDATOR" "$dir"
done
