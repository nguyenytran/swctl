# swctl bundled skills

This directory vendors third-party skills that swctl's resolve flow depends
on, so a plain `brew install swctl` gives users everything they need without
having to clone additional repositories or manually wire up
`~/.claude/skills/`.

## shopware-resolve

8-step gated workflow for triaging and fixing Shopware 6 issues: verify →
root-cause → implement → independent review → flow-impact → test → prepare
PR → decision-ready summary.

- **Source**: https://github.com/nguyenytran/shopware-troubleshoot-skill
- **Snapshotted from**: `ce9eb6b` (chore: infrastructure improvements from session)
- **License**: MIT (see `shopware-resolve/LICENSE`)

## How swctl uses it

- **Inside the swctl-ui container** (Docker): `app/docker-entrypoint.sh`
  symlinks this directory into `~/.claude/skills/shopware-resolve` at
  startup, unless the user already has one there.  The containerised
  Claude Code then picks it up automatically.
- **On the host** (for `claude /shopware-resolve` in a terminal): run
  `swctl skill install --user` to symlink it into
  `~/.claude/skills/shopware-resolve` on your host.

## Re-syncing from upstream

Snapshots are intentionally manual — they rarely change and we want a
known-good version per swctl release.  To re-sync:

```bash
upstream=/path/to/shopware-troubleshoot-skill
rsync -a --delete --exclude='.git' --exclude='.DS_Store' \
    "$upstream/" skills/shopware-resolve/
# Update the SHA in this README and run the test suite
```

## Not bundled

- `shopware-mcp` — optional third-party MCP server referenced by the
  skill for `health_check`.  Out of scope; users who want it install it
  themselves via `claude mcp add`.
