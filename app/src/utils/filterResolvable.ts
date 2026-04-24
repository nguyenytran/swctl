/**
 * Decide which GitHub issues should be offered in the Resolve page's
 * "Browse GitHub" list.
 *
 * Why this exists: if an issue already has an OPEN, DRAFT, or MERGED
 * pull request linked to it, clicking "Resolve" would spawn a second
 * worktree + second AI session to work on something either already
 * being worked on or already fixed — a guaranteed duplicate.  Those
 * issues are hidden from the list.
 *
 * CLOSED linked PRs don't count as "in progress" — they represent
 * abandoned attempts.  If every PR linked to an issue is closed, the
 * issue is still genuinely up-for-grabs and stays in the list.
 *
 * Extracted as a pure function so the policy is unit-testable without
 * the Vue component tree.  Regression guard: if someone later tweaks
 * "what counts as an active PR" here, the test in
 * tests/integration/filter_resolvable.bats locks the matrix down.
 */

import type { GitHubItem, LinkedPR } from '@/types'

export interface FilterResult {
  /** Issues that should be shown in the Resolve picker. */
  kept: GitHubItem[]
  /** How many issues were hidden.  The UI renders this as a helper note. */
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

export function filterResolvableIssues(items: GitHubItem[]): FilterResult {
  let hidden = 0
  const kept = items.filter((item) => {
    const prs = item.linkedPRs || []
    if (prs.some(isActive)) {
      hidden++
      return false
    }
    return true
  })
  return { kept, hidden }
}
