/**
 * Decide which GitHub issues should be offered in the Resolve page's
 * "Browse GitHub" list.
 *
 * Two filters, in order:
 *
 *  1. **Issue type = Bug** (default on).
 *     Resolve is scoped to fixing bugs.  Improvements, tasks, stories,
 *     and docs work belong in a different workflow — offering them here
 *     invites the AI to "resolve" vaguely-shaped tickets that have no
 *     clear acceptance criteria.  Disable with `filter: { onlyBug: false }`
 *     if you need the old behaviour.
 *     Matches GitHub's "issue_types" GraphQL field (values seen in the
 *     wild: Bug, Improvement, Story, Task).  Comparison is case-insensitive.
 *
 *  2. **No active linked PR**.
 *     If an issue has an OPEN, DRAFT, or MERGED pull request linked to
 *     it, clicking "Resolve" would spawn a duplicate worktree + AI
 *     session to redo work in progress or already shipped.  Closed PRs
 *     don't count (abandoned attempts = issue still fair game).
 *
 * Extracted as a pure function so the policy is unit-testable without
 * the Vue component tree.  tests/integration/filter_resolvable.bats
 * locks the matrix down.  The runtime-loaded
 * examples/plugins/shopware-resolve/index.js mirrors the same rules
 * inline — if you change them here, update the plugin too.
 */

import type { GitHubItem, LinkedPR } from '@/types'

export interface FilterOptions {
  /**
   * When true (default), only issues whose `issueType === 'Bug'` pass
   * the first filter.  Set to false to surface every type (Improvement,
   * Story, Task, …) — the manual-entry input still accepts any URL.
   */
  onlyBug?: boolean
}

export interface FilterResult {
  /** Issues that should be shown in the Resolve picker. */
  kept: GitHubItem[]
  /** How many issues were hidden because they had an active linked PR. */
  hiddenByLinkedPr: number
  /** How many issues were hidden because their issueType !== 'Bug'. */
  hiddenByType: number
  /** Total hidden (convenience).  Equals hiddenByLinkedPr + hiddenByType. */
  hidden: number
}

/**
 * A linked PR is considered "active" (and therefore a reason to hide
 * the issue) when its state is anything other than 'closed'.
 *
 * GitHub states seen in the wild: open | draft | merged | closed.
 * Treat unknown future states as active (safe default — better to hide
 * and force the user to enter the issue manually than to duplicate work).
 */
function isActive(pr: LinkedPR): boolean {
  return pr.state !== 'closed'
}

function isBug(item: GitHubItem): boolean {
  // Accept the canonical "Bug" + common capitalisation variants.  Other
  // types (Improvement / Story / Task / Feature / …) are excluded.
  return (item.issueType || '').toLowerCase() === 'bug'
}

export function filterResolvableIssues(
  items: GitHubItem[],
  opts: FilterOptions = {},
): FilterResult {
  const onlyBug = opts.onlyBug !== false  // default true
  let hiddenByType = 0
  let hiddenByLinkedPr = 0
  const kept = items.filter((item) => {
    if (onlyBug && !isBug(item)) {
      hiddenByType++
      return false
    }
    const prs = item.linkedPRs || []
    if (prs.some(isActive)) {
      hiddenByLinkedPr++
      return false
    }
    return true
  })
  return { kept, hiddenByLinkedPr, hiddenByType, hidden: hiddenByLinkedPr + hiddenByType }
}
