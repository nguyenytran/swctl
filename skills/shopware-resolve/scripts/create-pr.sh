#!/usr/bin/env bash
# DEPRECATED — do not invoke.
#
# Per ground rule 6 of the shopware-resolve skill, pushing branches
# and opening PRs is done by the user via the swctl UI / dashboard,
# not by this script. This file is kept only so historical
# references don't 404; running it will exit with an error.
#
# If you ended up here because you or an automation thought you
# needed to auto-push, stop and re-read Step 7 of SKILL.md.

set -euo pipefail

echo "error: create-pr.sh is disabled by ground rule 6 of shopware-resolve." >&2
echo "       Commit locally, write the PR body to /tmp/pr-body.md via" >&2
echo "       scripts/prepare-pr.sh, and let the user open the PR from the" >&2
echo "       swctl UI / dashboard." >&2
exit 2

# --- Original implementation retained below for reference only ---
# Usage:
#   create-pr.sh <worktree-path> <issue-number> --title <title> --body-file <file>
#                 [--repo owner/repo] [--base trunk] [--labels label1,label2]
#                 [--team @shopware/team-slug] [--draft]
#
# What it did:
#   1. Validated gh auth and branch state
#   2. Pushed the branch to origin
#   3. Created a PR via gh pr create
#   4. Output the PR URL

usage() {
  cat <<'USAGE'
Usage:
  create-pr.sh <worktree-path> <issue-number> --title <title> --body-file <file>
                [--repo owner/repo] [--base trunk] [--labels label1,label2]
                [--team @shopware/team-slug] [--draft]
USAGE
  exit 1
}

if [[ $# -lt 4 ]]; then
  usage
fi

WORKTREE_PATH="$1"
ISSUE_NUMBER="$2"
shift 2

TITLE=""
BODY_FILE=""
REPO=""
BASE="trunk"
LABELS=""
TEAM=""
DRAFT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)    TITLE="$2"; shift 2 ;;
    --body-file) BODY_FILE="$2"; shift 2 ;;
    --repo)     REPO="$2"; shift 2 ;;
    --base)     BASE="$2"; shift 2 ;;
    --labels)   LABELS="$2"; shift 2 ;;
    --team)     TEAM="$2"; shift 2 ;;
    --draft)    DRAFT="--draft"; shift ;;
    *)          echo "Unknown option: $1" >&2; usage ;;
  esac
done

# Validate required args
if [[ -z "$TITLE" ]]; then
  echo "Error: --title is required" >&2
  usage
fi

if [[ -z "$BODY_FILE" || ! -f "$BODY_FILE" ]]; then
  echo "Error: --body-file is required and must exist" >&2
  usage
fi

if [[ ! -d "$WORKTREE_PATH/.git" && ! -f "$WORKTREE_PATH/.git" ]]; then
  echo "Error: $WORKTREE_PATH is not a git repository" >&2
  exit 1
fi

# Validate gh auth
if ! gh auth status >/dev/null 2>&1; then
  echo "Error: gh is not authenticated. Run 'gh auth login' first." >&2
  exit 1
fi

# Get branch name
BRANCH=$(git -C "$WORKTREE_PATH" branch --show-current)
if [[ -z "$BRANCH" ]]; then
  echo "Error: could not determine current branch in $WORKTREE_PATH" >&2
  exit 1
fi

# Detect repo from remote if not provided
if [[ -z "$REPO" ]]; then
  REMOTE_URL=$(git -C "$WORKTREE_PATH" remote get-url origin 2>/dev/null || echo "")
  if [[ "$REMOTE_URL" =~ github\.com[:/]([^/]+/[^/.]+) ]]; then
    REPO="${BASH_REMATCH[1]}"
  else
    echo "Error: could not detect repo from remote. Use --repo owner/repo" >&2
    exit 1
  fi
fi

echo "=== PR Creation ==="
echo "  repo:   $REPO"
echo "  branch: $BRANCH"
echo "  base:   $BASE"
echo "  title:  $TITLE"
echo "  issue:  #$ISSUE_NUMBER"
[[ -n "$LABELS" ]] && echo "  labels: $LABELS"
[[ -n "$TEAM" ]] && echo "  team:   $TEAM"
[[ -n "$DRAFT" ]] && echo "  mode:   draft"
echo ""

# Push branch
echo "Pushing branch '$BRANCH' to origin..."
git -C "$WORKTREE_PATH" push -u origin "$BRANCH" 2>&1
echo ""

# Build gh pr create command
PR_ARGS=(
  --repo "$REPO"
  --title "$TITLE"
  --body-file "$BODY_FILE"
  --head "$BRANCH"
  --base "$BASE"
)

if [[ -n "$LABELS" ]]; then
  PR_ARGS+=(--label "$LABELS")
fi

if [[ -n "$TEAM" ]]; then
  PR_ARGS+=(--reviewer "$TEAM")
fi

if [[ -n "$DRAFT" ]]; then
  PR_ARGS+=(--draft)
fi

# Create PR
echo "Creating PR..."
PR_URL=$(gh pr create "${PR_ARGS[@]}" 2>&1)

if [[ $? -eq 0 ]]; then
  echo ""
  echo "=== PR Created ==="
  echo "  URL: $PR_URL"
  echo ""
  echo "  Linked to issue: https://github.com/$REPO/issues/$ISSUE_NUMBER"
else
  echo "Error creating PR:" >&2
  echo "$PR_URL" >&2
  exit 1
fi
