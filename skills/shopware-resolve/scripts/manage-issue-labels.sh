#!/usr/bin/env bash
# Manage GitHub issue labels.
#
# Usage:
#   manage-issue-labels.sh <issue_url|owner/repo#number|number> [owner/repo]
#                          --add label1,label2 [--remove label3,label4]
#
# Examples:
#   manage-issue-labels.sh https://github.com/shopware/shopware/issues/14395 \
#     --add "priority/high,domain/inventory"
#
#   manage-issue-labels.sh 14395 shopware/shopware \
#     --add "priority/high" --remove "priority/low"

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  manage-issue-labels.sh <issue_url|owner/repo#number|number> [owner/repo]
                         --add label1,label2 [--remove label3,label4]
USAGE
  exit 1
}

if [[ $# -lt 3 ]]; then
  usage
fi

ISSUE_REF="$1"
shift

# Parse issue reference
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
  if [[ $# -gt 0 && ! "$1" =~ ^-- ]]; then
    repo="$1"
    shift
  fi
fi

if [[ -z "$repo" ]]; then
  echo "Error: repository is required when issue reference is numeric." >&2
  usage
fi

if [[ -z "$issue_number" ]]; then
  echo "Error: could not parse issue number from '$ISSUE_REF'" >&2
  usage
fi

ADD_LABELS=""
REMOVE_LABELS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --add)    ADD_LABELS="$2"; shift 2 ;;
    --remove) REMOVE_LABELS="$2"; shift 2 ;;
    *)        echo "Unknown option: $1" >&2; usage ;;
  esac
done

if [[ -z "$ADD_LABELS" && -z "$REMOVE_LABELS" ]]; then
  echo "Error: at least one of --add or --remove is required" >&2
  usage
fi

# Validate gh auth
if ! gh auth status >/dev/null 2>&1; then
  echo "Error: gh is not authenticated. Run 'gh auth login' first." >&2
  exit 1
fi

echo "=== Issue Label Management ==="
echo "  repo:   $repo"
echo "  issue:  #$issue_number"
[[ -n "$ADD_LABELS" ]] && echo "  add:    $ADD_LABELS"
[[ -n "$REMOVE_LABELS" ]] && echo "  remove: $REMOVE_LABELS"
echo ""

if [[ -n "$ADD_LABELS" ]]; then
  echo "Adding labels: $ADD_LABELS"
  gh issue edit "$issue_number" --repo "$repo" --add-label "$ADD_LABELS"
fi

if [[ -n "$REMOVE_LABELS" ]]; then
  echo "Removing labels: $REMOVE_LABELS"
  gh issue edit "$issue_number" --repo "$repo" --remove-label "$REMOVE_LABELS"
fi

echo ""
echo "Done. Current labels:"
gh issue view "$issue_number" --repo "$repo" --json labels --jq '.labels[].name' 2>/dev/null || echo "(could not fetch)"
