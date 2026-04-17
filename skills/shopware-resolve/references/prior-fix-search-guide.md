# Prior Fix Search Guide

Use this reference during Step 1.2 to systematically check whether an issue has already been fixed.

## Why this matters

Many reported issues have already been fixed in a commit that uses different wording than the issue report. A keyword-only search will miss these. This guide provides a multi-layered search strategy to catch prior fixes before wasting time on root-cause analysis.

## Keyword extraction from issue reports

Extract keywords in priority order. Higher-priority keywords produce more precise results.

### Priority 1: Code identifiers

These are the most reliable search terms because fixes must touch the same code.

| Source | Example | Search with |
| --- | --- | --- |
| Class name from stack trace | `ProductConfiguratorLoader` | `git log --grep`, `gh search issues` |
| Method name from stack trace | `loadVariants` | `git log --grep`, `gh search code` |
| Full namespace path | `Shopware\Core\Content\Product\SalesChannel` | `gh search code` |
| File path from error | `src/Core/Checkout/Cart/CartService.php` | `git log -- <path>` |

### Priority 2: Error signatures

| Source | Example | Search with |
| --- | --- | --- |
| Exception class | `ProductNotFoundException` | `git log --grep`, `gh search issues` |
| Error code | `FRAMEWORK__INVALID_CRITERIA` | `git log --grep`, `gh search issues` |
| SQL state | `SQLSTATE[23000]` | `gh search issues` |
| SQL pattern | `Duplicate entry ... for key` | `gh search issues` |
| HTTP status + endpoint | `500 on /store-api/checkout/cart` | `gh search issues` |

### Priority 3: Domain keywords

| Source | Example | Search with |
| --- | --- | --- |
| Entity/table name | `product_option`, `order_line_item` | `git log --grep`, `gh search issues` |
| Subsystem name | `product stream`, `flow builder` | `gh search issues` |
| Feature keyword | `configurator sold out`, `variant visibility` | `gh search issues` |
| Admin module | `sw-product-detail`, `sw-order-list` | `gh search issues`, `gh search code` |

## Search commands

### GitHub issues and PRs

```bash
# Search across issues and PRs (default: shopware/shopware + shopware/commercial)
scripts/search-shopware-sources.sh "ProductConfiguratorLoader variant"

# Search specific repos
scripts/search-shopware-sources.sh "cart duplicate" shopware/shopware

# Direct gh search for closed issues
gh search issues "ProductConfiguratorLoader" --repo shopware/shopware --state closed --json number,title,url,state --limit 10

# Direct gh search for merged PRs
gh search prs "fix variant visibility" --repo shopware/shopware --merged --json number,title,url --limit 10
```

### Local git history

```bash
# Search commit messages
git log --oneline --all --grep="ProductConfiguratorLoader"
git log --oneline --all --grep="variant.*visibility" --regexp-ignore-case

# Search file history (shows all commits that touched a file)
git log --oneline -- src/Core/Content/Product/SalesChannel/Detail/ProductConfiguratorLoader.php

# Search file history with diff content (find commits that changed specific code)
git log --oneline -S "hideCloseoutProductsWhenOutOfStock" -- "*.php"
git log --oneline -G "isCloseout.*getAvailableStock" -- "*.php"

# Blame specific lines
git blame -L 120,140 -- src/Core/Content/Product/SalesChannel/Detail/ProductConfiguratorLoader.php
```

### Key git search flags

| Flag | What it finds | When to use |
| --- | --- | --- |
| `--grep="text"` | Commits whose message contains text | Search for issue numbers, class names, keywords in commit messages |
| `-S "text"` | Commits that add or remove text (pickaxe) | Find when a specific string was introduced or removed |
| `-G "regex"` | Commits whose diff matches regex | Find when a pattern was changed (broader than `-S`) |
| `-- path` | Commits that touch specific files | Narrow search to relevant files |
| `--all` | Search all branches, not just current | Catch fixes on release branches |
| `--since="3 months ago"` | Limit time range | Focus on recent changes |

## Evaluation checklist

When a potential prior fix is found:

1. **Which version does the fix target?**
   - Check the branch the fix was merged to
   - Check if it was backported to the reporter's version
   - `git branch --contains <commit-hash>` shows which branches include the fix

2. **Does the reporter's version include the fix?**
   - If yes: issue may be a different bug, a regression of the fix, or invalid
   - If no: the fix exists but hasn't reached the reporter yet

3. **Does the fix actually address the same symptom?**
   - Read the PR description and diff carefully
   - A fix to the same file might address a different code path
   - Compare the fix's test case with the reported reproduction steps

4. **Is the code path still the same?**
   - The fix may have been correct at the time but later refactored or overwritten
   - `git diff <fix-commit>..HEAD -- <file>` shows what changed since the fix

## Common false negatives

These patterns cause searches to miss existing fixes:

| Situation | Why search misses it | Mitigation |
| --- | --- | --- |
| Fix used different terminology | "resolved variant display" vs "fixed configurator sold out" | Search by class/file name, not just symptoms |
| Fix was part of a larger refactor | Commit message describes the refactor, not the bug | Search by file path with `git log -- path` |
| Fix was on a different branch | Fix on `6.6.x` not merged to `trunk` | Use `--all` flag in git log |
| Fix addressed a parent issue | Original issue #12345 was fixed, reporter opened #15678 | Search by class name to find the original |
| Fix was in Commercial repo | `shopware/SwagCommercial` not searched | Include Commercial repo in search |

## Output format

After completing the search, document findings:

```md
### Prior fix search results

**Keywords searched:** <list of keywords tried>
**Repositories searched:** <repos>
**Time range:** <if limited>

**Matches found:**
- [#12345](url) - <title> - <status: closed/merged> - <relevance assessment>
- commit abc1234 - <message> - <whether it addresses the same symptom>

**Conclusion:** <already fixed in version X / partial fix exists / no prior fix found / regression of #12345>
```
