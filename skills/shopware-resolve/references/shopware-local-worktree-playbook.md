# Shopware Local Worktree Playbook

Use this when step 3 is approved.

## Goal

Keep the main checkout clean and perform issue work in an isolated worktree with a running environment managed by swctl.

## Default base repo

- `/Users/ytran/Shopware/trunk`

## swctl MCP tools (best option)

When the `swctl` MCP server is connected, use MCP tools directly — no shell scripts needed:

```
swctl_smart_create(issue: "5523", branch: "fix/5523-custom-product-out-of-stock", project: "SwagCustomizedProducts", deps: "SwagCommercial")
```

Key MCP tools:
- `swctl_smart_create` / `swctl_create_worktree` — Create provisioned worktree
- `swctl_exec_command(issueId, command)` — Run commands in the container
- `swctl_view_diff(issueId)` — View git diff
- `swctl_list_instances()` — Check status and domains
- `swctl_clean(issueId)` — Tear down worktree
- `swctl_refresh(issueId)` — Pull and rebuild delta
- `swctl_start_stop(issueId, action)` — Container lifecycle

## swctl CLI integration (fallback)

When the MCP server is not connected but `swctl` CLI is available, `create-issue-worktree.sh` automatically delegates to swctl. This provides:
- Isolated Docker container with PHP, Caddy, and all services
- Cloned database from trunk
- Resolved composer dependencies (including path dependencies like SwagCommercial)
- Plugin worktree nested inside the trunk worktree
- Accessible URL (e.g., `http://web.trunk-5523.orb.local`)

### Project registration

For plugin-external projects, register the project once:
```bash
swctl project add <PluginName> <plugin-path> --type plugin-external --parent trunk
```

Example:
```bash
swctl project add SwagCustomizedProducts /Users/ytran/Shopware/trunk/custom/plugins/SwagCustomizedProducts --type plugin-external --parent trunk
```

### Dependency declaration

If the trunk's `composer.lock` references other plugins as path dependencies (e.g., SwagCommercial), declare them in `.swctl.deps.yaml` at the plugin root:

```yaml
dependencies:
  - SwagCommercial
```

The script reads this file from the working copy and passes `--deps` to swctl.

### swctl worktree paths

When swctl creates a plugin-external worktree:
- Trunk worktree: `/Users/ytran/Shopware/_worktrees/sw-<issue>`
- Plugin worktree: `/Users/ytran/Shopware/_worktrees/sw-<issue>/custom/plugins/<PluginName>`
- URL: `http://web.trunk-<issue>.orb.local`

## Naming convention

Branch name: `<type>/<issue-number>-<slug>` (see `references/branch-naming-conventions.md`)

Examples:
- Branch: `fix/15934-reset-property-option-selection`
- Branch: `fix/5523-custom-product-out-of-stock`

## Automated creation

Use `scripts/create-issue-worktree.sh` to create worktree and branch in one step:

```bash
scripts/create-issue-worktree.sh 5523 fix custom-product-out-of-stock
```

The script auto-detects:
1. Whether the cwd is inside a registered swctl plugin project
2. Plugin dependencies from `.swctl.deps.yaml`
3. Falls back to plain git worktree if swctl is unavailable

### Manual override

```bash
# Force swctl with explicit project and deps
scripts/create-issue-worktree.sh 5523 fix --project SwagCustomizedProducts --deps SwagCommercial

# Force plain git worktree (skip swctl)
scripts/create-issue-worktree.sh 5523 fix --no-swctl
```

## Workflow

1. Confirm the issue number and type (fix/feat/chore)
2. Run `scripts/create-issue-worktree.sh` to create worktree and branch
3. Use the worktree as the only implementation environment
4. If swctl was used, verify the site loads at the worktree URL
5. Discard the worktree with `swctl clean <issue>` (or `git worktree remove`)

## swctl management commands

```bash
swctl status                    # List all worktrees
swctl exec <issue> '<cmd>'      # Run command in container
swctl logs <issue> [--follow]   # View container logs
swctl restart <issue>           # Restart container
swctl clean <issue>             # Remove worktree + container + DB
```

## Worked example: issue #8221 (dynamic product groups cache)

This shows the complete flow from root cause confirmation to running environment.

**1. Create worktree (swctl MCP):**
```
swctl_smart_create(
  issue: "8221",
  branch: "fix/8221-dynamic-product-groups-cache",
  project: "trunk"
)
```
Output:
- Preflight: ✅ passed
- Preview: 5 files changed, admin build skipped (PHP-only changes)
- Worktree: `/Users/ytran/Shopware/_worktrees/sw-8221`
- URL: `http://web.trunk-8221.orb.local`

**2. Verify environment:**
```
swctl_exec_command(issueId: "8221", command: "bin/console about")
swctl_list_instances()
```

**3. Set up test scenario (prod mode + Redis cache):**
```
swctl_exec_command(issueId: "8221", command: "sed -i 's/APP_ENV=dev/APP_ENV=prod/' .env.local")
swctl_exec_command(issueId: "8221", command: "echo 'SHOPWARE_HTTP_CACHE_ENABLED=1' >> .env.local")
swctl_exec_command(issueId: "8221", command: "bin/console cache:clear")
```

**4. Make code changes, then verify:**
```
swctl_view_diff(issueId: "8221")
swctl_exec_command(issueId: "8221", command: "vendor/bin/phpunit tests/unit/Core/Content/ProductStream/")
swctl_exec_command(issueId: "8221", command: "vendor/bin/phpstan analyze --memory-limit=2G")
```

**5. Cleanup:**
```
swctl_clean(issueId: "8221")
```

**Or with fallback script:**
```bash
scripts/create-issue-worktree.sh 8221 fix dynamic-product-groups-cache
# → creates worktree + branch, delegates to swctl if available
```

## Why this matters

- Avoids polluting `trunk`
- Makes review/repro easier
- Allows issue-specific environment setup
- Reduces cross-issue state contamination
- swctl provides instant running environment with database

## Decision guide

- Small PHP-only fix -> worktree + targeted tests may be enough
- Admin/storefront changes -> worktree + relevant asset build (swctl handles this)
- Migration/index-sensitive changes -> worktree + dedicated DB/reset/reindex plan

## Output expected from step 3

Always state:
- worktree path (trunk and plugin paths if swctl)
- branch name
- URL if swctl was used
- whether DB reset, cache clear, or reindex is needed
