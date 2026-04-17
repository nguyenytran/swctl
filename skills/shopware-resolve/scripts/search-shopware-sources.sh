#!/usr/bin/env bash
set -euo pipefail

QUERY="${1:-}"
if [[ -z "$QUERY" ]]; then
  cat <<'USAGE'
Usage:
  search-shopware-sources.sh "<query>" [owner/repo ...]

Examples:
  search-shopware-sources.sh "hideCloseoutProductsWhenOutOfStock variant"
  search-shopware-sources.sh "product configurator sold out variant" shopware/shopware shopware/commercial

Environment:
  GH_SEARCH_LIMIT    Max entries per query (default: 8)
  GH_REPO_FILTERS    Comma-separated repos (used when no repo args are passed)
  STOPLIGHT_BASE_URL Optional base URL for your Stoplight docs
USAGE
  exit 1
fi
shift || true

if ! command -v gh >/dev/null 2>&1; then
  echo "error: GitHub CLI (gh) is required." >&2
  exit 1
fi

LIMIT="${GH_SEARCH_LIMIT:-8}"
STOPLIGHT_BASE_URL="${STOPLIGHT_BASE_URL:-}"
GH_REPO_FILTERS="${GH_REPO_FILTERS:-}"

repos=()
if (( $# > 0 )); then
  repos=("$@")
elif [[ -n "$GH_REPO_FILTERS" ]]; then
  IFS=',' read -r -a repos <<< "$GH_REPO_FILTERS"
else
  repos=("shopware/shopware" "shopware/commercial")
fi

# Deduplicate repos (compatible with bash 3.x on macOS)
unique_repos=()
for repo in "${repos[@]}"; do
  repo="${repo// /}"
  [[ -z "$repo" ]] && continue
  local_dup=0
  for existing in "${unique_repos[@]+"${unique_repos[@]}"}"; do
    if [[ "$existing" == "$repo" ]]; then
      local_dup=1
      break
    fi
  done
  [[ "$local_dup" -eq 0 ]] && unique_repos+=("$repo")
done

encode_uri() {
  python3 - "$1" <<'PY'
import sys
from urllib.parse import quote
print(quote(sys.argv[1]))
PY
}

ENCODED_QUERY="$(encode_uri "$QUERY")"

echo "## External Reference Candidates"
echo "query: $QUERY"
echo
echo "### Docs links"
echo "- https://developer.shopware.com/search/?q=${ENCODED_QUERY}"
if [[ -n "$STOPLIGHT_BASE_URL" ]]; then
  echo "- ${STOPLIGHT_BASE_URL%/}/?q=${ENCODED_QUERY}"
fi

echo
echo "### GitHub results"
for repo in "${unique_repos[@]}"; do
  echo
  echo "#### repo: $repo"
  echo "issues/prs:"
  gh search issues "$QUERY repo:$repo" \
    --json number,title,url,state,updatedAt,isPullRequest \
    --limit "$LIMIT" || true

  echo
  echo "code:"
  gh search code "$QUERY repo:$repo" \
    --json path,url \
    --limit "$LIMIT" || true
done
