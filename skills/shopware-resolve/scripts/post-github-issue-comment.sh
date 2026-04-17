#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  post-github-issue-comment.sh <issue_url|owner/repo#number|number> [owner/repo] [body_file|-]

Examples:
  post-github-issue-comment.sh https://github.com/shopware/shopware/issues/9642 - -
  post-github-issue-comment.sh shopware/shopware#9642 - comment.md
  printf '%s\n' "triage comment" | post-github-issue-comment.sh 9642 shopware/shopware -
EOF
}

if [[ $# -lt 1 || $# -gt 3 ]]; then
  usage >&2
  exit 1
fi

issue_ref="$1"
repo_arg="${2:-}"
body_source="${3:--}"

repo=""
issue_number=""

if [[ "$issue_ref" =~ ^https://github\.com/([^/]+/[^/]+)/issues/([0-9]+)$ ]]; then
  repo="${BASH_REMATCH[1]}"
  issue_number="${BASH_REMATCH[2]}"
elif [[ "$issue_ref" =~ ^([^/]+/[^#]+)#([0-9]+)$ ]]; then
  repo="${BASH_REMATCH[1]}"
  issue_number="${BASH_REMATCH[2]}"
elif [[ "$issue_ref" =~ ^[0-9]+$ ]]; then
  repo="$repo_arg"
  issue_number="$issue_ref"
else
  echo "Unsupported issue reference: $issue_ref" >&2
  usage >&2
  exit 1
fi

if [[ -z "$repo" || "$repo" == "-" ]]; then
  echo "Repository is required when the issue reference does not include owner/repo." >&2
  usage >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Run 'gh auth status' or re-authenticate before posting." >&2
  exit 1
fi

tmp_body=""
cleanup() {
  if [[ -n "$tmp_body" && -f "$tmp_body" ]]; then
    rm -f "$tmp_body"
  fi
}
trap cleanup EXIT

if [[ "$body_source" == "-" ]]; then
  tmp_body="$(mktemp)"
  cat >"$tmp_body"
  body_file="$tmp_body"
else
  body_file="$body_source"
fi

if [[ ! -s "$body_file" ]]; then
  echo "Comment body is empty: $body_file" >&2
  exit 1
fi

gh issue comment "$issue_number" --repo "$repo" --body-file "$body_file"
