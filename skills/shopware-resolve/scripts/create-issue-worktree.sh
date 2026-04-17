#!/usr/bin/env bash
# Create an isolated worktree for a Shopware issue.
#
# Prefers swctl when available and a project is registered — this ensures
# the worktree gets a running container, database, and resolved dependencies.
# Falls back to plain git worktree if swctl is not available.
#
# Usage:
#   create-issue-worktree.sh <issue-number> <type> [slug]
#
# Arguments:
#   issue-number  GitHub issue number (required)
#   type          Branch type: fix, feat, or chore (required)
#   slug          Optional branch slug (auto-derived if omitted)
#
# Options:
#   --base <branch>     Base branch (default: trunk)
#   --repo <path>       Base repo path (default: auto-detected from cwd or /Users/ytran/Shopware/trunk)
#   --project <name>    swctl project name (auto-detected from cwd)
#   --deps <list>       Comma-separated dependency plugins for swctl (auto-read from .swctl.deps.yaml)
#   --no-swctl          Force plain git worktree (skip swctl even if available)
#
# Examples:
#   create-issue-worktree.sh 15934 fix reset-property-option-selection
#   create-issue-worktree.sh 8774 feat
#   create-issue-worktree.sh 5523 fix --project SwagCustomizedProducts --deps SwagCommercial

set -euo pipefail

BASE_BRANCH="trunk"
BASE_REPO=""
WORKTREE_ROOT="/Users/ytran/Shopware/worktrees"
SWCTL_PROJECT=""
SWCTL_DEPS=""
NO_SWCTL=0

usage() {
  echo "Usage: $0 <issue-number> <type> [slug] [--base <branch>] [--repo <path>] [--project <name>] [--deps <list>]"
  echo ""
  echo "  type: fix | feat | chore"
  exit 1
}

# Parse positional args first, then flags
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      BASE_BRANCH="$2"
      shift 2
      ;;
    --repo)
      BASE_REPO="$2"
      shift 2
      ;;
    --project)
      SWCTL_PROJECT="$2"
      shift 2
      ;;
    --deps)
      SWCTL_DEPS="$2"
      shift 2
      ;;
    --no-swctl)
      NO_SWCTL=1
      shift
      ;;
    --help|-h)
      usage
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

if [[ ${#POSITIONAL[@]} -lt 2 ]]; then
  usage
fi

ISSUE_NUMBER="${POSITIONAL[0]}"
BRANCH_TYPE="${POSITIONAL[1]}"
SLUG="${POSITIONAL[2]:-}"

# Validate type
case "$BRANCH_TYPE" in
  fix|feat|chore) ;;
  *)
    echo "Error: type must be fix, feat, or chore (got: $BRANCH_TYPE)"
    exit 1
    ;;
esac

# Validate issue number is numeric
if ! [[ "$ISSUE_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "Error: issue-number must be numeric (got: $ISSUE_NUMBER)"
  exit 1
fi

# Build branch name
if [[ -n "$SLUG" ]]; then
  BRANCH_NAME="${BRANCH_TYPE}/${ISSUE_NUMBER}-${SLUG}"
else
  BRANCH_NAME="${BRANCH_TYPE}/${ISSUE_NUMBER}"
fi

# --- Auto-detect context from cwd ---

# Detect if we're inside a plugin directory.
# Sets: PLUGIN_NAME, BASE_REPO, SWCTL_PROJECT, SWCTL_DEPS (all global).
detect_plugin_context() {
  local cwd="${PWD}"

  # Check if cwd is under custom/plugins/<PluginName>
  if [[ "$cwd" =~ /custom/plugins/([^/]+) ]]; then
    PLUGIN_NAME="${BASH_REMATCH[1]}"
    local plugin_path="${cwd%%/custom/plugins/${PLUGIN_NAME}*}/custom/plugins/${PLUGIN_NAME}"
    local trunk_path="${cwd%%/custom/plugins/${PLUGIN_NAME}*}"

    # Auto-detect repo path
    if [[ -z "$BASE_REPO" ]]; then
      BASE_REPO="$trunk_path"
    fi

    # Auto-detect swctl project name
    if [[ -z "$SWCTL_PROJECT" ]] && command -v swctl &>/dev/null; then
      local registered
      registered=$(swctl project list 2>/dev/null | grep -w "$PLUGIN_NAME" | awk '{print $1}') || true
      if [[ -n "$registered" ]]; then
        SWCTL_PROJECT="$registered"
      fi
    fi

    # Auto-detect deps from .swctl.deps.yaml in the plugin working copy
    if [[ -z "$SWCTL_DEPS" ]] && [[ -f "$plugin_path/.swctl.deps.yaml" ]]; then
      SWCTL_DEPS=$(python3 -c "
import yaml, sys
with open(sys.argv[1]) as f:
    data = yaml.safe_load(f) or {}
deps = data.get('dependencies', [])
print(','.join(deps))
" "$plugin_path/.swctl.deps.yaml" 2>/dev/null) || true
    fi

    return 0
  fi

  return 1
}

PLUGIN_NAME=""
detect_plugin_context || true

# Fallback repo path
if [[ -z "$BASE_REPO" ]]; then
  BASE_REPO="/Users/ytran/Shopware/trunk"
fi

# --- swctl path ---

try_swctl() {
  if [[ "$NO_SWCTL" -eq 1 ]]; then
    return 1
  fi

  if ! command -v swctl &>/dev/null; then
    return 1
  fi

  # Check if instance already exists
  local existing_status
  existing_status=$(swctl status 2>/dev/null | grep -w "$ISSUE_NUMBER" || true)
  if [[ -n "$existing_status" ]]; then
    echo "swctl instance already exists for issue $ISSUE_NUMBER:"
    echo "  $existing_status"
    echo ""

    # Extract worktree path from metadata
    local meta_file
    meta_file=$(find ~/.local/state/swctl/instances -name "${ISSUE_NUMBER}.env" 2>/dev/null | head -1)
    if [[ -n "$meta_file" ]]; then
      local wt_path
      wt_path=$(grep '^WORKTREE_PATH=' "$meta_file" | cut -d= -f2)
      echo "Reusing existing swctl worktree."
      echo "  path:   $wt_path"
      # If it's a plugin worktree, show the plugin path too
      local plugin_wt_path
      plugin_wt_path=$(grep '^PLUGIN_WORKTREE_PATHS=' "$meta_file" | cut -d= -f2)
      if [[ -n "$plugin_wt_path" ]]; then
        echo "  plugin: $plugin_wt_path"
      fi
    fi
    return 0
  fi

  # Build swctl create command
  local swctl_args=()

  if [[ -n "$SWCTL_PROJECT" ]]; then
    swctl_args+=(--project "$SWCTL_PROJECT")
  fi

  if [[ -n "$SWCTL_DEPS" ]]; then
    swctl_args+=(--deps "$SWCTL_DEPS")
  fi

  # For plugin-external projects, swctl needs the plugin's base branch (e.g., main)
  # to check out from origin. The fix branch is created by swctl internally as swctl/<issue>.
  # For platform projects, pass the branch name directly.
  if [[ -n "$SWCTL_PROJECT" ]]; then
    # Detect the plugin's default branch
    local plugin_default_branch="main"
    if [[ -n "$PLUGIN_NAME" ]]; then
      local plugin_repo="${BASE_REPO}/custom/plugins/${PLUGIN_NAME}"
      plugin_default_branch=$(git -C "$plugin_repo" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@') || plugin_default_branch="main"
    fi
    swctl_args+=("$ISSUE_NUMBER" "$plugin_default_branch")
  else
    swctl_args+=("$ISSUE_NUMBER" "$BRANCH_NAME")
  fi

  echo "Creating worktree via swctl..."
  echo "  command: swctl create ${swctl_args[*]}"
  echo ""

  if swctl create "${swctl_args[@]}"; then
    echo ""

    # Extract paths from metadata
    local meta_file
    meta_file=$(find ~/.local/state/swctl/instances -name "${ISSUE_NUMBER}.env" 2>/dev/null | head -1)
    if [[ -n "$meta_file" ]]; then
      local wt_path plugin_wt_path domain
      wt_path=$(grep '^WORKTREE_PATH=' "$meta_file" | cut -d= -f2)
      plugin_wt_path=$(grep '^PLUGIN_WORKTREE_PATHS=' "$meta_file" | cut -d= -f2)
      domain=$(grep '^DOMAIN=' "$meta_file" | cut -d= -f2)

      echo ""
      echo "swctl worktree ready:"
      echo "  path:   $wt_path"
      if [[ -n "$plugin_wt_path" ]]; then
        echo "  plugin: $plugin_wt_path"
      fi
      echo "  branch: $BRANCH_NAME"
      echo "  url:    http://$domain"
    fi
    return 0
  else
    echo ""
    echo "swctl create failed. Falling back to plain git worktree."
    return 1
  fi
}

# --- Plain git worktree fallback ---

create_git_worktree() {
  local worktree_path="${WORKTREE_ROOT}/${ISSUE_NUMBER}"

  # Check if worktree already exists
  if [[ -d "$worktree_path" ]]; then
    local existing_branch
    existing_branch=$(git -C "$worktree_path" branch --show-current 2>/dev/null || echo "unknown")
    echo "Worktree already exists at: $worktree_path"
    echo "  branch: $existing_branch"
    echo ""
    echo "Reusing existing worktree."
    return 0
  fi

  mkdir -p "$WORKTREE_ROOT"

  echo "Fetching latest $BASE_BRANCH..."
  git -C "$BASE_REPO" fetch origin "$BASE_BRANCH" --quiet 2>/dev/null || true

  echo "Creating worktree..."
  git -C "$BASE_REPO" worktree add -b "$BRANCH_NAME" "$worktree_path" "origin/${BASE_BRANCH}" 2>/dev/null || \
    git -C "$BASE_REPO" worktree add -b "$BRANCH_NAME" "$worktree_path" "$BASE_BRANCH"

  echo ""
  echo "Worktree created:"
  echo "  path:   $worktree_path"
  echo "  branch: $BRANCH_NAME"
  echo "  base:   $BASE_BRANCH"
  echo ""
  echo "Note: This is a plain git worktree without a running environment."
  echo "      Use 'swctl create --project <name> $ISSUE_NUMBER $BRANCH_NAME' to add Docker environment."
}

# --- Main ---

if try_swctl; then
  exit 0
fi

create_git_worktree
