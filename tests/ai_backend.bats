#!/usr/bin/env bats

load test_helper

# AI-backend dispatch helpers (swctl:_ai_*).  Keep the Claude vs Codex
# choice out of the spawn sites in cmd_resolve / resolve.ts so adding
# a new backend is a case-statement edit, not a spawn-site rewrite.
#
# Regression guard for v0.5.7 (Codex CLI backend MVP): the shape
# (backend × mode × flag list) is the stable contract every caller
# depends on.  These tests lock it down.

setup() {
    # Hermetic: point the config reader at an empty tmp file so a
    # dev's ~/.swctl/config.json (may have `ai.defaultBackend = codex`
    # from manual experiments) doesn't leak into tests that assert the
    # built-in "claude" default.
    _cfg_dir="$(mktemp -d)"
    export SWCTL_CONFIG_FILE="$_cfg_dir/config.json"
    unset SWCTL_CLAUDE_BIN SWCTL_CODEX_BIN CLAUDE_CONFIG_DIR CODEX_CONFIG_DIR
    unset SWCTL_RESOLVE_BACKEND
}

teardown() {
    rm -rf "${_cfg_dir:-}"
}

# ---------------------------------------------------------------------------
# _ai_backend_binary
# ---------------------------------------------------------------------------

@test "_ai_backend_binary: claude → 'claude' by default" {
    result="$(_ai_backend_binary claude)"
    [ "$result" = "claude" ]
}

@test "_ai_backend_binary: codex → 'codex' by default" {
    result="$(_ai_backend_binary codex)"
    [ "$result" = "codex" ]
}

@test "_ai_backend_binary: SWCTL_CLAUDE_BIN override is honoured" {
    result="$(SWCTL_CLAUDE_BIN=/opt/custom/claude _ai_backend_binary claude)"
    [ "$result" = "/opt/custom/claude" ]
}

@test "_ai_backend_binary: SWCTL_CODEX_BIN override is honoured" {
    result="$(SWCTL_CODEX_BIN=/opt/custom/codex _ai_backend_binary codex)"
    [ "$result" = "/opt/custom/codex" ]
}

@test "_ai_backend_binary: unknown backend → non-zero exit" {
    run _ai_backend_binary gpt4
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# _ai_backend_config_dir
# ---------------------------------------------------------------------------

@test "_ai_backend_config_dir: claude → ~/.claude by default" {
    result="$(_ai_backend_config_dir claude)"
    [ "$result" = "$HOME/.claude" ]
}

@test "_ai_backend_config_dir: codex → ~/.codex by default" {
    result="$(_ai_backend_config_dir codex)"
    [ "$result" = "$HOME/.codex" ]
}

@test "_ai_backend_config_dir: CLAUDE_CONFIG_DIR override" {
    result="$(CLAUDE_CONFIG_DIR=/tmp/alt-claude _ai_backend_config_dir claude)"
    [ "$result" = "/tmp/alt-claude" ]
}

@test "_ai_backend_config_dir: CODEX_CONFIG_DIR override" {
    result="$(CODEX_CONFIG_DIR=/tmp/alt-codex _ai_backend_config_dir codex)"
    [ "$result" = "/tmp/alt-codex" ]
}

# ---------------------------------------------------------------------------
# _ai_resolve_backend  (precedence: --backend > env > default)
# ---------------------------------------------------------------------------

@test "_ai_resolve_backend: no input → claude default" {
    unset SWCTL_RESOLVE_BACKEND
    result="$(_ai_resolve_backend)"
    [ "$result" = "claude" ]
}

@test "_ai_resolve_backend: explicit --backend wins over env" {
    result="$(SWCTL_RESOLVE_BACKEND=claude _ai_resolve_backend codex)"
    [ "$result" = "codex" ]
}

@test "_ai_resolve_backend: env picks up when no --backend" {
    result="$(SWCTL_RESOLVE_BACKEND=codex _ai_resolve_backend)"
    [ "$result" = "codex" ]
}

@test "_ai_resolve_backend: lowercases mixed-case input" {
    result="$(_ai_resolve_backend "CODEX")"
    [ "$result" = "codex" ]
    result="$(SWCTL_RESOLVE_BACKEND=Claude _ai_resolve_backend)"
    [ "$result" = "claude" ]
}

@test "_ai_resolve_backend: rejects unknown backend" {
    run _ai_resolve_backend "gpt-4"
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# _ai_spawn_args — shape contract per backend × mode
# ---------------------------------------------------------------------------

@test "_ai_spawn_args claude new: includes --session-id + stream-json" {
    out="$(_ai_spawn_args claude new my-session-id)"
    [[ "$out" == *"--session-id"* ]]
    [[ "$out" == *"my-session-id"* ]]
    [[ "$out" == *"--output-format"* ]]
    [[ "$out" == *"stream-json"* ]]
}

@test "_ai_spawn_args claude resume: includes --resume <id>" {
    out="$(_ai_spawn_args claude resume abc-123)"
    [[ "$out" == *"--resume"* ]]
    [[ "$out" == *"abc-123"* ]]
}

@test "_ai_spawn_args claude ask: includes --resume + -p" {
    out="$(_ai_spawn_args claude ask xyz-456)"
    [[ "$out" == *"--resume"* ]]
    [[ "$out" == *"xyz-456"* ]]
    [[ "$out" == *"-p"* ]]
}

@test "_ai_spawn_args codex new: uses 'exec' subcommand" {
    out="$(_ai_spawn_args codex new sess-1)"
    [[ "$out" == *"exec"* ]]
    [[ "$out" == *"--session"* ]]
    [[ "$out" == *"sess-1"* ]]
}

@test "_ai_spawn_args codex resume: exec + --resume" {
    out="$(_ai_spawn_args codex resume sess-1)"
    [[ "$out" == *"exec"* ]]
    [[ "$out" == *"--resume"* ]]
}

@test "_ai_spawn_args codex ask: exec + --message" {
    out="$(_ai_spawn_args codex ask sess-1)"
    [[ "$out" == *"exec"* ]]
    [[ "$out" == *"--message"* ]]
}

@test "_ai_spawn_args: newline-separated so callers can readarray safely" {
    # Critical contract: args with embedded spaces must not be word-split
    # by the caller.  The helper emits one arg per line; callers use
    # `readarray -t`.
    out="$(_ai_spawn_args claude new test-id)"
    # Every line should be exactly one arg — no spaces within a line.
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        [[ "$line" != *" "* ]]
    done <<< "$out"
}

@test "_ai_spawn_args: unknown backend → non-zero" {
    run _ai_spawn_args gpt4 new sess
    [ "$status" -ne 0 ]
}

@test "_ai_spawn_args: unknown mode → non-zero" {
    run _ai_spawn_args claude chat sess
    [ "$status" -ne 0 ]
}
