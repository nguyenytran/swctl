#!/usr/bin/env bash
# Analyze git diff for potential Flow Builder impact.
#
# Usage:
#   analyze-flow-impact.sh [worktree-path] [--base <branch>]
#
# Arguments:
#   worktree-path   Path to worktree or repo (default: current directory)
#
# Options:
#   --base <branch>   Comparison branch (default: trunk)
#
# Output:
#   Structured flow impact assessment with risk level.

set -euo pipefail

REPO_PATH="${1:-.}"
BASE_BRANCH="trunk"

# Parse flags
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      BASE_BRANCH="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

# Get changed files
CHANGED_FILES=$(git -C "$REPO_PATH" diff --name-only "$BASE_BRANCH" 2>/dev/null || \
                git -C "$REPO_PATH" diff --name-only HEAD~1 2>/dev/null || echo "")

if [[ -z "$CHANGED_FILES" ]]; then
  echo "## Flow Builder Impact"
  echo ""
  echo "- events affected: none detected"
  echo "- actions affected: none detected"
  echo "- rules affected: none detected"
  echo "- entity/DAL impact: none detected"
  echo "- state machine impact: none detected"
  echo "- risk level: none"
  echo "- recommended flow validation: no validation needed"
  echo ""
  echo "No changed files detected."
  exit 0
fi

# Initialize tracking
EVENTS_AFFECTED=()
ACTIONS_AFFECTED=()
RULES_AFFECTED=()
ENTITY_IMPACT=()
STATE_MACHINE_IMPACT=()
RISK="none"

# Check each category
while IFS= read -r file; do
  [[ -z "$file" ]] && continue

  # Direct flow code
  if [[ "$file" == *"src/Core/Content/Flow/"* ]]; then
    if [[ "$file" == *"/Action/"* ]]; then
      ACTIONS_AFFECTED+=("$(basename "$file" .php)")
      RISK="high"
    elif [[ "$file" == *"/Rule/"* ]]; then
      RULES_AFFECTED+=("$(basename "$file" .php)")
      [[ "$RISK" != "high" ]] && RISK="medium"
    elif [[ "$file" == *"FlowDispatcher"* || "$file" == *"FlowExecutor"* || "$file" == *"FlowLoader"* ]]; then
      ACTIONS_AFFECTED+=("flow-core: $(basename "$file" .php)")
      RISK="high"
    elif [[ "$file" == *"/Storer/"* ]]; then
      EVENTS_AFFECTED+=("storer: $(basename "$file" .php)")
      [[ "$RISK" != "high" ]] && RISK="medium"
    elif [[ "$file" == *"/Aware/"* ]]; then
      EVENTS_AFFECTED+=("aware: $(basename "$file" .php)")
      [[ "$RISK" != "high" ]] && RISK="medium"
    else
      EVENTS_AFFECTED+=("flow: $(basename "$file" .php)")
      [[ "$RISK" == "none" ]] && RISK="low"
    fi
  fi

  # Framework rules
  if [[ "$file" == *"src/Core/Framework/Rule/"* ]]; then
    RULES_AFFECTED+=("framework-rule: $(basename "$file" .php)")
    [[ "$RISK" == "none" ]] && RISK="low"
  fi

  # State machine
  if [[ "$file" == *"StateMachine"* ]]; then
    STATE_MACHINE_IMPACT+=("$(basename "$file" .php)")
    [[ "$RISK" != "high" ]] && RISK="medium"
  fi

  # Entity definitions that flow actions depend on
  if [[ "$file" == *"OrderDefinition"* || "$file" == *"OrderEntity"* || \
        "$file" == *"CustomerDefinition"* || "$file" == *"CustomerEntity"* || \
        "$file" == *"OrderTransactionDefinition"* || "$file" == *"OrderDeliveryDefinition"* ]]; then
    ENTITY_IMPACT+=("$(basename "$file" .php)")
    [[ "$RISK" == "none" ]] && RISK="low"
  fi

  # Mail template system
  if [[ "$file" == *"MailTemplate"* || "$file" == *"SendMail"* ]]; then
    ACTIONS_AFFECTED+=("mail: $(basename "$file" .php)")
    [[ "$RISK" == "none" ]] && RISK="low"
  fi

  # Document generation
  if [[ "$file" == *"DocumentGenerat"* || "$file" == *"DocumentRender"* ]]; then
    ACTIONS_AFFECTED+=("document: $(basename "$file" .php)")
    [[ "$RISK" == "none" ]] && RISK="low"
  fi

  # Check for FlowEventAware implementations in changed files
  if [[ -f "$REPO_PATH/$file" ]]; then
    if grep -q "FlowEventAware" "$REPO_PATH/$file" 2>/dev/null; then
      EVENTS_AFFECTED+=("event-aware: $(basename "$file" .php)")
      [[ "$RISK" != "high" ]] && RISK="medium"
    fi
  fi

done <<< "$CHANGED_FILES"

# Format output
format_list() {
  local -n arr=$1
  if [[ ${#arr[@]} -eq 0 ]]; then
    echo "none detected"
  else
    local IFS=", "
    echo "${arr[*]}"
  fi
}

# Determine validation recommendation
VALIDATION="standard regression suite"
if [[ "$RISK" == "high" ]]; then
  VALIDATION="test all active flows touching affected actions; verify flow execution order and buffered execution"
elif [[ "$RISK" == "medium" ]]; then
  VALIDATION="test flows using affected rules or entity data; verify cached flow payloads"
elif [[ "$RISK" == "low" ]]; then
  VALIDATION="spot-check flows in affected area"
fi

echo "## Flow Builder Impact"
echo ""
echo "- events affected: $(format_list EVENTS_AFFECTED)"
echo "- actions affected: $(format_list ACTIONS_AFFECTED)"
echo "- rules affected: $(format_list RULES_AFFECTED)"
echo "- entity/DAL impact: $(format_list ENTITY_IMPACT)"
echo "- state machine impact: $(format_list STATE_MACHINE_IMPACT)"
echo "- risk level: $RISK"
echo "- recommended flow validation: $VALIDATION"

# Show changed files for context
echo ""
echo "### Changed files analyzed"
echo ""
echo "$CHANGED_FILES" | head -30 | while IFS= read -r f; do
  echo "- \`$f\`"
done

TOTAL=$(echo "$CHANGED_FILES" | wc -l | tr -d ' ')
if [[ "$TOTAL" -gt 30 ]]; then
  echo "- ... and $((TOTAL - 30)) more files"
fi
