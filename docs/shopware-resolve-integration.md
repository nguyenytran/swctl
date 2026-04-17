# Running shopware-resolve from swctl UI

The [`shopware-resolve`](https://github.com/nguyenytran/shopware-troubleshoot-skill)
skill is an 8-step workflow for triaging and fixing Shopware 6 issues. It's
normally invoked from Claude Code with `/shopware-resolve <issue>`. This
integration lets you trigger it from the swctl dashboard without opening a
terminal.

## How it works

1. You open http://swctl.orb.local → **Resolve** in the top nav
2. Paste a GitHub issue URL/number and submit
3. swctl runs `swctl create --no-provision <issue>` — a **lightweight worktree** (~5s): git worktree only, no Docker container, no DB, no Shopware install
4. The UI server spawns `claude -p "/shopware-resolve …"` inside the swctl-ui container pointed at that worktree
5. Claude Code authenticates using your existing `~/.claude/` session (no API key needed)
6. Claude runs an **analyze-first** flow:
   - Steps 1–4: verify → root cause → edit code → independent review — all in the lightweight worktree
   - **Step 5**: Claude calls the `swctl_setup` MCP tool only after the review passes. This runs the heavy provisioning (DB clone + container up + Shopware install, 1–2 min) — skipped entirely if the fix gets blocked in review or no fix is needed
   - Steps 6–8: run tests in the now-provisioned environment → prepare PR body → decision-ready summary
7. The transcript streams back to your browser via Server-Sent Events
8. swctl **stops before opening a PR**: the fix is committed locally, a PR body is left at `/tmp/pr-body.md`, but `git push` / `gh pr create` are your call

## Prerequisites

- **You are logged in to Claude Code on the host** — run `claude` once on the host and complete authentication. Auth lives in `~/.claude/`, which the swctl-ui container bind-mounts read-write to reuse the session.
- **The skill is installed as a Claude Code skill** — shopware-resolve should be at `~/.claude/skills/shopware-resolve` (usually a symlink to its source repo).
- **Claude Code binary**: the Dockerfile installs a Linux-native `@anthropic-ai/claude-code` inside the swctl-ui container, so you do **not** need to install it on the host for this integration (though installing it there too is fine — the in-container binary is the one swctl actually runs).

## Install the plugin

```bash
mkdir -p ~/.swctl/plugins
cp -r /path/to/swctl/examples/plugins/shopware-resolve ~/.swctl/plugins/
swctl ui stop && swctl ui start   # rebuild the container with HOME/PATH env
```

After the restart, hard-refresh the browser (Cmd+Shift+R) and you should see
the **🩺 Resolve** link in the top nav.

## Using it

- **From the resolve page** — paste an issue URL and hit Resolve. The transcript will stream as the skill works. When the skill hits an approval gate ("Proceed to Step 2?"), you'll see the prompt in the log — the skill pauses until Claude Code's non-interactive mode auto-accepts (or, later, until you approve it from a per-step UI).
- **From an instance row** — the "🩺 Resolve" action button on each worktree row pre-fills the form with that issue's id and navigates to the resolve page.
- **From the dashboard** — the "Recent resolve runs" widget lists the last 5 runs with ⏳/✅/❌ status.

## How the container reaches Claude Code

The swctl-ui Dockerfile is `node:20-alpine`. Your host's `claude` binary is
macOS-native (Mach-O) and cannot run in Linux — so instead the integration:

- **Installs a Linux-native `@anthropic-ai/claude-code` inside the container** (Dockerfile `RUN npm install -g …`)
- **Sets `HOME=${HOME}` inside the container** so the in-container binary finds `~/.claude/` (auth, skills, settings) on the host
- **Reuses the bind-mounted host `$HOME`** so auth and skills stay in sync with your host Claude Code

## Troubleshooting

### "Cannot run macOS (Mach-O) executable in Docker: Exec format error"

You're seeing a leftover host-PATH override running the host's macOS binary.
Rebuild the container — the Dockerfile now installs a Linux-native Claude Code:

```
swctl ui stop && swctl ui start
```

### "claude: command not found"

Rebuild the container so the Dockerfile change (which installs Claude Code) takes effect:
```
swctl ui stop && swctl ui start
```

Confirm:
```
docker exec swctl-ui which claude
# should print /usr/local/bin/claude
```

### "You need to authenticate with Claude"

Run `claude` interactively on the host once, authenticate, then retry. The
stored session at `~/.claude/` will be reused by the container.

### The skill can't find swctl MCP

The skill tries the swctl MCP server first and falls back to its bash
scripts. Inside the spawned Claude Code the MCP server config comes from
`~/.claude/settings.json` (already set up globally). If MCP is unavailable
the skill still works — it just uses `scripts/create-issue-worktree.sh`
instead.

## Endpoints (reference)

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/skill/resolve/stream?issue=<url>&project=<name>&mode=<qa\|dev>` | Spawn Claude Code, stream transcript via SSE |
| `GET`  | `/api/skill/resolve/runs` | List recent resolve runs (status + timing) |
| `POST` | `/api/skill/resolve/finish` | Finalise a run record once the SSE stream closes |

## What this doesn't do yet

- Per-step approval UI (you see the skill's gate prompts in the log but can't
  click "Approve" — Claude Code's `--permission-mode acceptEdits` auto-accepts
  file edits; other gates are pending)
- Display MCP tool calls as structured events (currently rendered as raw JSON
  from Claude Code's `stream-json` output)
- Multi-issue batching (one resolve run at a time per issue id)

All of those are tracked in the plan under "Post-MVP".
