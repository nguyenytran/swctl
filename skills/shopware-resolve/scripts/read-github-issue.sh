#!/usr/bin/env bash
set -euo pipefail

COMMENT_LIMIT="${GH_COMMENT_LIMIT:-6}"
ISSUE_REF=""
REPO_OVERRIDE=""
OUTPUT_FORMAT="markdown"

usage() {
  cat <<'USAGE'
Usage:
  read-github-issue.sh <issue_url|owner/repo#number|number> [owner/repo] [--output markdown|json]

Examples:
  read-github-issue.sh https://github.com/shopware/shopware/issues/1234
  read-github-issue.sh shopware/shopware#1234
  read-github-issue.sh 1234 shopware/shopware

Environment:
  GH_COMMENT_LIMIT  Number of latest comments to include (default: 6)
USAGE
}

while (( $# > 0 )); do
  case "$1" in
    --output)
      OUTPUT_FORMAT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$ISSUE_REF" ]]; then
        ISSUE_REF="$1"
      elif [[ -z "$REPO_OVERRIDE" ]]; then
        REPO_OVERRIDE="$1"
      else
        echo "error: unexpected argument: $1" >&2
        usage
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "$ISSUE_REF" ]]; then
  usage
  exit 1
fi

if [[ "$OUTPUT_FORMAT" != "markdown" && "$OUTPUT_FORMAT" != "json" ]]; then
  echo "error: --output must be markdown or json" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "error: GitHub CLI (gh) is required." >&2
  exit 1
fi

repo=""
issue_number=""

if [[ "$ISSUE_REF" =~ ^https?://github\.com/([^/]+)/([^/]+)/issues/([0-9]+) ]]; then
  repo="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
  issue_number="${BASH_REMATCH[3]}"
elif [[ "$ISSUE_REF" =~ ^([^/]+/[^#]+)#([0-9]+)$ ]]; then
  repo="${BASH_REMATCH[1]}"
  issue_number="${BASH_REMATCH[2]}"
elif [[ "$ISSUE_REF" =~ ^[0-9]+$ ]]; then
  issue_number="$ISSUE_REF"
  repo="$REPO_OVERRIDE"
else
  echo "error: unsupported issue reference: $ISSUE_REF" >&2
  usage
  exit 1
fi

if [[ -z "$repo" ]]; then
  echo "error: repository is required when issue reference is numeric." >&2
  usage
  exit 1
fi

payload="$(gh issue view "$issue_number" \
  --repo "$repo" \
  --json number,title,state,url,createdAt,updatedAt,author,labels,assignees,body,comments \
  --jq "{
    issue: {
      number,
      title,
      state,
      url,
      createdAt,
      updatedAt,
      author: (.author.login // \"\"),
      labels: [(.labels // [])[] | .name],
      assignees: [(.assignees // [])[] | .login],
      body
    },
    comments: (
      .comments
      | (if length > ${COMMENT_LIMIT} then .[-${COMMENT_LIMIT}:] else . end)
      | map({
          author: (.author.login // \"\"),
          createdAt,
          body
        })
    )
  }")"

if [[ "$OUTPUT_FORMAT" == "json" ]]; then
  jq -n \
    --arg repo "$repo" \
    --argjson payload "$payload" \
    '{
      repo: $repo,
      issue: $payload.issue,
      comments: $payload.comments
    }'
  exit 0
fi

echo "## GitHub Issue Context"
echo "repo: $repo"
echo "issue: #$issue_number"
echo

echo "### Issue payload"
jq '.issue' <<< "$payload"

echo
echo "### Recent comments (up to $COMMENT_LIMIT)"
jq '.comments' <<< "$payload"
