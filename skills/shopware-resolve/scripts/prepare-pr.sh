#!/usr/bin/env bash
# Generate commit message and PR body from a Shopware issue worktree.
#
# Usage:
#   prepare-pr.sh <worktree-path> <issue-number> [--type <fix|feat|chore>]
#
# Output:
#   Prints a suggested commit message and PR body to stdout.

set -euo pipefail

usage() {
  echo "Usage: $0 <worktree-path> <issue-number> [--type <fix|feat|chore>]"
  exit 1
}

if [[ $# -lt 2 ]]; then
  usage
fi

WORKTREE_PATH="$1"
ISSUE_NUMBER="$2"
BRANCH_TYPE="fix"
OUTPUT_FILE=""

shift 2
while [[ $# -gt 0 ]]; do
  case "$1" in
    --type)
      BRANCH_TYPE="$2"
      shift 2
      ;;
    --output)
      OUTPUT_FILE="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

# Validate type
case "$BRANCH_TYPE" in
  fix|feat|chore|test|ci|refactor) ;;
  *)
    echo "Warning: unexpected type '$BRANCH_TYPE', using as-is"
    ;;
esac

# Get changed files
CHANGED_FILES=$(git -C "$WORKTREE_PATH" diff --name-only trunk 2>/dev/null || \
                git -C "$WORKTREE_PATH" diff --name-only HEAD~1 2>/dev/null || echo "")

if [[ -z "$CHANGED_FILES" ]]; then
  echo "Error: no changed files detected in $WORKTREE_PATH"
  exit 1
fi

# Try to detect scope from Package annotation of primary changed file
SCOPE=""
FIRST_PHP=$(echo "$CHANGED_FILES" | grep '\.php$' | head -1)
if [[ -n "$FIRST_PHP" && -f "$WORKTREE_PATH/$FIRST_PHP" ]]; then
  PACKAGE=$(grep -oP "#\[Package\('\K[^']+" "$WORKTREE_PATH/$FIRST_PHP" 2>/dev/null | head -1 || echo "")
  if [[ -n "$PACKAGE" ]]; then
    SCOPE="$PACKAGE"
  fi
fi

# Check if changes are admin-only or storefront-only
if echo "$CHANGED_FILES" | grep -q "src/Administration" && ! echo "$CHANGED_FILES" | grep -qv "src/Administration"; then
  [[ -z "$SCOPE" ]] && SCOPE="administration"
fi
if echo "$CHANGED_FILES" | grep -q "src/Storefront" && ! echo "$CHANGED_FILES" | grep -qv "src/Storefront"; then
  [[ -z "$SCOPE" ]] && SCOPE="storefront"
fi

# Count changes
FILE_COUNT=$(echo "$CHANGED_FILES" | wc -l | tr -d ' ')
INSERTIONS=$(git -C "$WORKTREE_PATH" diff --stat trunk 2>/dev/null | tail -1 | grep -oP '\d+ insertion' | grep -oP '\d+' || echo "0")
DELETIONS=$(git -C "$WORKTREE_PATH" diff --stat trunk 2>/dev/null | tail -1 | grep -oP '\d+ deletion' | grep -oP '\d+' || echo "0")

# Build commit message template
echo "═══════════════════════════════════════"
echo "SUGGESTED COMMIT MESSAGE"
echo "═══════════════════════════════════════"
echo ""
if [[ -n "$SCOPE" ]]; then
  echo "${BRANCH_TYPE}(${SCOPE}): <description> (#${ISSUE_NUMBER})"
else
  echo "${BRANCH_TYPE}: <description> (#${ISSUE_NUMBER})"
fi
echo ""
echo "Replace <description> with a concise imperative summary."
echo ""

# Build PR body -- write to file if --output is set, otherwise stdout
PR_OUTPUT="/dev/stdout"
if [[ -n "$OUTPUT_FILE" ]]; then
  PR_OUTPUT="$OUTPUT_FILE"
  echo "PR body written to: $OUTPUT_FILE"
  echo ""
else
  echo "═══════════════════════════════════════"
  echo "SUGGESTED PR BODY"
  echo "═══════════════════════════════════════"
  echo ""
fi

cat <<EOF > "$PR_OUTPUT"
## Summary

Fixes #${ISSUE_NUMBER}

- <what was broken>
- <what the fix does>
- <why this approach>

## Changes

- ${FILE_COUNT} file(s) changed (+${INSERTIONS}/-${DELETIONS})

### Changed files
EOF

echo "$CHANGED_FILES" | head -20 | while IFS= read -r f; do
  echo "- \`$f\`"
done >> "$PR_OUTPUT"
if [[ "$FILE_COUNT" -gt 20 ]]; then
  echo "- ... and $((FILE_COUNT - 20)) more" >> "$PR_OUTPUT"
fi

cat <<EOF >> "$PR_OUTPUT"

## Environment needs

- [ ] Admin build needed
- [ ] Storefront build needed
- [ ] DB reset / migration
- [ ] Cache clear / DAL reindex

## Test plan

- [ ] Unit tests pass (\`composer phpunit:verify -- <test-path>\`)
- [ ] Static analysis clean (\`composer phpstan\`)
- [ ] Code style clean (\`composer cs-fix\`)
- [ ] Manual verification of the fix
- [ ] Flow Builder impact assessed (if applicable)

## Review

- [ ] Independent review agent verdict: <PASS|CONCERNS|BLOCK>
- [ ] Flow Builder impact: <none|low|medium|high>
EOF
