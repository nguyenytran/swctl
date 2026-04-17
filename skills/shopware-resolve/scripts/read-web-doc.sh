#!/usr/bin/env bash
set -euo pipefail

URL="${1:-}"
LINES="${2:-${DOC_LINE_LIMIT:-220}}"

if [[ -z "$URL" ]]; then
  cat <<'USAGE'
Usage:
  read-web-doc.sh <url> [line-count|full]

Examples:
  read-web-doc.sh https://developer.shopware.com/docs/guides/plugins/plugins/storefront/add-custom-javascript.html
  read-web-doc.sh https://shopware.stoplight.io/docs/store-api full

Environment:
  DOC_LINE_LIMIT  Default max lines to output (default: 220)
USAGE
  exit 1
fi

if [[ ! "$URL" =~ ^https?:// ]]; then
  echo "error: URL must start with http:// or https://" >&2
  exit 1
fi

TARGET="${URL#http://}"
TARGET="${TARGET#https://}"
PROXY_URL="https://r.jina.ai/http://${TARGET}"

echo "## Web Document"
echo "source: $URL"
echo "proxy: $PROXY_URL"
echo

if [[ "$LINES" == "full" ]]; then
  curl -fsSL "$PROXY_URL"
  exit 0
fi

if [[ ! "$LINES" =~ ^[0-9]+$ ]]; then
  echo "error: line-count must be numeric or 'full'" >&2
  exit 1
fi

curl -fsSL "$PROXY_URL" | head -n "$LINES"
