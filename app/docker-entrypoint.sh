#!/usr/bin/env bash
# swctl-ui container entrypoint.  Wires up the bundled shopware-resolve
# skill and the swctl MCP server into the host-mounted ~/.claude/
# config so the containerised Claude Code picks them up without
# requiring users to install anything extra on their host.
#
# Idempotent: runs on every container start, skips any step whose
# effect is already in place, and never overwrites user-owned config.
set -euo pipefail

CLAUDE_HOME="${HOME:-/root}/.claude"
SKILL_SRC="${SWCTL_SCRIPT_DIR:-/swctl}/skills/shopware-resolve"
SKILL_DST="$CLAUDE_HOME/skills/shopware-resolve"
SETTINGS="$CLAUDE_HOME/settings.json"
# Inside the container the MCP server lives at /app/mcp/index.ts (bind-mounted
# from the swctl repo in dev, baked in via the image in production).
MCP_CMD="npx"
MCP_ARGS='["tsx","/app/mcp/index.ts"]'

log() { printf '[entrypoint] %s\n' "$*" >&2; }

# ---------- 1. Ensure ~/.claude/skills has our shopware-resolve symlink ----------

mkdir -p "$CLAUDE_HOME/skills"

if [ -d "$SKILL_SRC" ]; then
    if [ -L "$SKILL_DST" ]; then
        # Symlink already exists.  Two cases:
        #   1. Points at a valid target (the user's own dev checkout, or
        #      our bundled path already) → LEAVE IT ALONE.  Users often
        #      run against a local working copy of the skill repo; we
        #      must not quietly overwrite that.
        #   2. Dangling (target doesn't exist) → repoint to the bundled
        #      skill so Claude Code doesn't trip over a broken link.
        current="$(readlink "$SKILL_DST" 2>/dev/null || true)"
        if [ -n "$current" ] && [ ! -e "$current" ]; then
            log "repointing dangling shopware-resolve symlink ($current → $SKILL_SRC)"
            ln -sfn "$SKILL_SRC" "$SKILL_DST"
        else
            log "shopware-resolve symlink already present ($current) — keeping as-is"
        fi
    elif [ -e "$SKILL_DST" ]; then
        # Regular dir/file already there — user-installed copy, leave alone.
        log "skipping shopware-resolve symlink (user copy present at $SKILL_DST)"
    else
        log "linking shopware-resolve skill → $SKILL_SRC"
        ln -sfn "$SKILL_SRC" "$SKILL_DST"
    fi
else
    log "no bundled skill at $SKILL_SRC — skipping skill wiring"
fi

# ---------- 2. Merge swctl MCP entry into ~/.claude/settings.json ----------

# Start with an empty object if the file doesn't exist / is empty.
if [ ! -s "$SETTINGS" ]; then
    mkdir -p "$(dirname "$SETTINGS")"
    printf '{}\n' > "$SETTINGS"
fi

# Only wire up the swctl MCP entry if the user doesn't already have one
# (or theirs is missing/broken).  We check presence only — if the user
# pointed `mcpServers.swctl` at a host path or a different script, they
# did it on purpose and we respect it.
current_swctl="$(jq -c '.mcpServers.swctl // null' "$SETTINGS" 2>/dev/null || echo null)"

if [ "$current_swctl" = "null" ]; then
    log "wiring swctl MCP entry into $SETTINGS (was missing)"
    desired_swctl="$(jq -n --arg cmd "$MCP_CMD" --argjson args "$MCP_ARGS" \
        '{command: $cmd, args: $args}')"
    tmp="$(mktemp)"
    jq --argjson swctl "$desired_swctl" \
        '.mcpServers = (.mcpServers // {}) | .mcpServers.swctl = $swctl' \
        "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
else
    log "swctl MCP entry already configured — keeping user's settings.json as-is"
fi

# ---------- 3. Hand off to the real command ----------
# (Default CMD: `npx tsx server/index.ts`.)

exec "$@"
