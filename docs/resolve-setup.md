# Resolve workflow — setup

The swctl resolve flow uses Claude Code to automate the 8-step
`shopware-resolve` workflow (verify → root cause → implement → review
→ provision → test → prepare PR → summary). Everything it needs is
bundled with swctl — you shouldn't have to install a separate skill
repo or hand-edit `~/.claude/settings.json`.

## Prerequisites

| Requirement | Why |
|---|---|
| `brew install swctl` | the tool itself |
| [Claude Code](https://claude.com/claude-code) | runs the skill |
| You're logged into Claude Code | `claude /login` once; auth lives in `~/.claude/` |
| GitHub CLI auth | `gh auth login` — swctl stores its own token too, see below |

## Quick start

```bash
# 1. Install the bundled skill + MCP server into your host Claude Code
swctl skill install --user
swctl mcp install --user

# 2. Start the swctl UI (optional — the CLI works standalone)
swctl ui start

# 3. Resolve an issue from the CLI
swctl resolve 7659 shopware/shopware

# …or from the UI
open http://swctl.orb.local/#/resolve
```

Either path produces the same worktree layout, branch name, and commits.

## What `swctl skill install` does

Symlinks the bundled skill into your host Claude Code skills directory:

```
~/.claude/skills/shopware-resolve  →  <swctl pkgshare>/skills/shopware-resolve
```

If you already have a custom `~/.claude/skills/shopware-resolve` (not a
symlink), swctl refuses to overwrite it. Run `swctl skill uninstall`
first if you want to replace it.

Use `--repo` instead of `--user` to install into the current project's
`.claude/skills/` — handy when you want to pin the swctl-bundled skill
for teammates via git.

## What `swctl mcp install` does

Adds this entry to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "swctl": {
      "command": "npx",
      "args": ["tsx", "<swctl pkgshare>/app/mcp/index.ts"]
    }
  }
}
```

…while leaving other `mcpServers` entries alone. This lets Claude Code
call swctl MCP tools (`swctl_list_instances`, `swctl_github_issues`,
etc.) from the host terminal.

Use `--project` to write to the current repo's `.mcp.json` instead.

## What runs where

```
swctl UI Resolve page              Host terminal: `claude /shopware-resolve`
        │                                          │
        ▼                                          ▼
 swctl-ui container:                         Host Claude Code:
  - jq, gh, git, ssh, node installed          - uses ~/.claude/skills/shopware-resolve
  - claude binary (Linux)                     - uses ~/.claude/settings.json MCP config
  - entrypoint symlinks bundled               - interactive — you approve each step
    skill + swctl MCP into the                - sees your full set of MCP servers
    bind-mounted ~/.claude/
  - non-interactive: allowlist +              Same worktree state either way; resume
    effort max + structured prompt            with `swctl resolve resume <id>`.
```

## Optional: `shopware-mcp`

The skill calls `mcp__shopware-mcp__health_check` during pre-flight
validation. swctl does **not** bundle `shopware-mcp` — it's a
third-party MCP server. If you want it:

```bash
claude mcp add shopware-mcp -- npx -y @shopware/shopware-mcp
```

If `shopware-mcp` isn't installed, the skill's health check is a
no-op — the rest of the workflow still works.

## Updating the bundled skill

The snapshot version lives in `skills/shopware-resolve/` and updates
as part of swctl releases. You can see the current pin in
`skills/README.md`. If you want to run a newer skill version than
what swctl bundles:

```bash
swctl skill uninstall
git clone https://github.com/nguyenytran/shopware-troubleshoot-skill \
    ~/.claude/skills/shopware-resolve
```

swctl will stop overwriting that directory (only symlinks are managed).

## Uninstall

```bash
swctl skill uninstall        # removes the symlink, leaves your ~/.claude alone otherwise
swctl mcp uninstall          # removes only the `swctl` entry from settings.json
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `~/.claude/skills/shopware-resolve already exists as a file/dir` | You have a non-symlink there. `rm -rf ~/.claude/skills/shopware-resolve` then re-run install. |
| `'jq' is required for MCP install` | `brew install jq` |
| In-container `claude` says `command not found` | `swctl ui stop && swctl ui start` rebuilds the image with Claude Code installed. |
| PR create fails with `HTTP 401` | swctl's GitHub token expired. Re-run `swctl auth login`. The UI uses that token for all `gh` calls inside the container. |
