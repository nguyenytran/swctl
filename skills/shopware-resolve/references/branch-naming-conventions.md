# Branch Naming and Commit Conventions

## Branch prefixes

| Issue type | Branch prefix | When to use |
| --- | --- | --- |
| Bug / regression | `fix/` | Bug reports, regressions, broken behavior |
| Feature / enhancement | `feat/` | New functionality, feature requests |
| Cleanup / tooling | `chore/` | Refactoring, dependency updates, CI, docs, test-only changes |

## Branch name format (required)

```
<prefix>/<issue-number>-<slug>
```

Both the issue number AND a descriptive slug are required. The slug is what makes the branch name self-describing in the swctl UI and on GitHub — a bare `fix/4657` is hard to read at a glance, `fix/4657-variant-list-price-from-prefix` isn't.

- slug: lowercased, hyphen-separated, max ~40 chars, derived from the issue title (drop articles, keep the specific noun/verb pair that names the bug)
- Examples:
  - `fix/15934-reset-property-option-selection-after-delete`
  - `feat/8774-render-line-item-children-in-product-component`
  - `chore/16001-update-ludtwig-to-v0.13.0`
  - `fix/10922-reorder-quantity-collision`

### Do not use

- `fix/<issue-number>` — bare issue number, no slug. Hard to scan in the swctl UI and in `git branch` listings.
- `fix/<slug>` — descriptive slug, no issue number. Loses the issue link; swctl UI can't cross-reference.
- `feature/<issue-number>` — older Shopware convention. Present in some repos; do not create new branches this way.

If you encounter an existing branch using one of the "do not use" forms, leave it alone (don't rename someone else's branch) but name your new branch with the required format.

## Commit message format

```
<type>(<scope>): <message> (#PR_NUMBER)
```

- **type**: matches branch prefix (`fix`, `feat`, `chore`, `test`, `ci`, `refactor`)
- **scope**: optional, derived from `#[Package('...')]` annotation of the primary changed file
  - Example: `fix(inventory): hide empty configurator groups (#15951)`
  - Example: `fix(administration): preserve admin search term on module switch (#15952)`
  - Omit scope when changes span multiple packages or when no single package dominates
- **message**: imperative mood, lowercase start, concise description of the change
- **PR_NUMBER**: appended by GitHub on merge

## Scope derivation

1. Find the `#[Package('...')]` annotation in the primary changed file
2. Use the package value as scope: `checkout`, `inventory`, `framework`, `discovery`, etc.
3. For admin-only changes: use `administration` as scope
4. For storefront-only template/JS changes: use `storefront` as scope
5. For cross-cutting changes: omit scope

## Worktree naming

Worktrees use the issue number as directory name:
- Path: `/Users/ytran/Shopware/worktrees/<issue-number>`
- Branch: `<prefix>/<issue-number>-<slug>`

Use `scripts/create-issue-worktree.sh` to automate creation.
