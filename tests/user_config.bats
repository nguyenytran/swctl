#!/usr/bin/env bats

load test_helper

# Unit tests for ~/.swctl/config.json helpers and the env > config > default
# precedence in _ai_backend_binary / _ai_backend_config_dir / _ai_resolve_backend.
#
# We override SWCTL_CONFIG_FILE per-test to an isolated tmp file so tests
# never touch the developer's real config.  jq is required — the CI
# harness installs it alongside bats-core.

setup() {
    _cfg_dir="$(mktemp -d)"
    export SWCTL_CONFIG_FILE="$_cfg_dir/config.json"
    # Scrub env-var overrides so the helpers actually exercise the config path.
    unset SWCTL_CLAUDE_BIN SWCTL_CODEX_BIN
    unset CLAUDE_CONFIG_DIR CODEX_CONFIG_DIR
    unset SWCTL_RESOLVE_BACKEND
}

teardown() {
    rm -rf "$_cfg_dir"
}

# ---------------------------------------------------------------------------
# _user_config_file / _user_config_read / _user_config_write
# ---------------------------------------------------------------------------

@test "_user_config_file: defaults to ~/.swctl/config.json" {
    unset SWCTL_CONFIG_FILE
    result="$(_user_config_file)"
    [ "$result" = "$HOME/.swctl/config.json" ]
}

@test "_user_config_file: SWCTL_CONFIG_FILE override wins" {
    SWCTL_CONFIG_FILE=/tmp/alt.json
    result="$(_user_config_file)"
    [ "$result" = "/tmp/alt.json" ]
}

@test "_user_config_read: missing file → non-zero exit, no output" {
    run _user_config_read '.ai.claude.bin'
    [ "$status" -ne 0 ]
    [ -z "$output" ]
}

@test "_user_config_read: missing key → non-zero, no output" {
    printf '{}\n' > "$SWCTL_CONFIG_FILE"
    run _user_config_read '.ai.claude.bin'
    [ "$status" -ne 0 ]
    [ -z "$output" ]
}

@test "_user_config_read: present key → prints value, zero exit" {
    printf '{"ai":{"claude":{"bin":"/opt/claude"}}}\n' > "$SWCTL_CONFIG_FILE"
    result="$(_user_config_read '.ai.claude.bin')"
    [ "$result" = "/opt/claude" ]
}

@test "_user_config_write: creates file + nested path" {
    _user_config_write '.ai.claude.bin' '/opt/claude'
    [ -f "$SWCTL_CONFIG_FILE" ]
    result="$(jq -r '.ai.claude.bin' "$SWCTL_CONFIG_FILE")"
    [ "$result" = "/opt/claude" ]
}

@test "_user_config_write: preserves other keys" {
    printf '{"ai":{"codex":{"bin":"/opt/codex"}}}\n' > "$SWCTL_CONFIG_FILE"
    _user_config_write '.ai.claude.bin' '/opt/claude'
    claude="$(jq -r '.ai.claude.bin' "$SWCTL_CONFIG_FILE")"
    codex="$(jq -r '.ai.codex.bin'  "$SWCTL_CONFIG_FILE")"
    [ "$claude" = "/opt/claude" ]
    [ "$codex"  = "/opt/codex"  ]
}

@test "_user_config_delete: removes key, leaves others intact" {
    printf '{"ai":{"claude":{"bin":"/c"},"codex":{"bin":"/x"}}}\n' > "$SWCTL_CONFIG_FILE"
    _user_config_delete '.ai.claude'
    has_claude="$(jq 'has("ai") and (.ai | has("claude"))' "$SWCTL_CONFIG_FILE")"
    has_codex="$(jq -r '.ai.codex.bin' "$SWCTL_CONFIG_FILE")"
    [ "$has_claude" = "false" ]
    [ "$has_codex"  = "/x"    ]
}

# ---------------------------------------------------------------------------
# _ai_backend_binary precedence:  env > config > default
# ---------------------------------------------------------------------------

@test "_ai_backend_binary claude: default when nothing set" {
    result="$(_ai_backend_binary claude)"
    [ "$result" = "claude" ]
}

@test "_ai_backend_binary claude: config wins over default" {
    printf '{"ai":{"claude":{"bin":"/opt/claude"}}}\n' > "$SWCTL_CONFIG_FILE"
    result="$(_ai_backend_binary claude)"
    [ "$result" = "/opt/claude" ]
}

@test "_ai_backend_binary claude: env wins over config" {
    printf '{"ai":{"claude":{"bin":"/opt/claude"}}}\n' > "$SWCTL_CONFIG_FILE"
    result="$(SWCTL_CLAUDE_BIN=/env/claude _ai_backend_binary claude)"
    [ "$result" = "/env/claude" ]
}

@test "_ai_backend_binary codex: config wins over default" {
    printf '{"ai":{"codex":{"bin":"/opt/codex"}}}\n' > "$SWCTL_CONFIG_FILE"
    result="$(_ai_backend_binary codex)"
    [ "$result" = "/opt/codex" ]
}

# ---------------------------------------------------------------------------
# _ai_backend_config_dir precedence:  env > config > default
# ---------------------------------------------------------------------------

@test "_ai_backend_config_dir claude: default when nothing set" {
    result="$(_ai_backend_config_dir claude)"
    [ "$result" = "$HOME/.claude" ]
}

@test "_ai_backend_config_dir claude: config wins over default" {
    printf '{"ai":{"claude":{"configDir":"/opt/.claude"}}}\n' > "$SWCTL_CONFIG_FILE"
    result="$(_ai_backend_config_dir claude)"
    [ "$result" = "/opt/.claude" ]
}

@test "_ai_backend_config_dir claude: env wins over config" {
    printf '{"ai":{"claude":{"configDir":"/opt/.claude"}}}\n' > "$SWCTL_CONFIG_FILE"
    result="$(CLAUDE_CONFIG_DIR=/env/.claude _ai_backend_config_dir claude)"
    [ "$result" = "/env/.claude" ]
}

# ---------------------------------------------------------------------------
# _ai_resolve_backend precedence:  explicit > env > config > default
# ---------------------------------------------------------------------------

@test "_ai_resolve_backend: default claude when nothing set" {
    result="$(_ai_resolve_backend)"
    [ "$result" = "claude" ]
}

@test "_ai_resolve_backend: config default wins over built-in default" {
    printf '{"ai":{"defaultBackend":"codex"}}\n' > "$SWCTL_CONFIG_FILE"
    result="$(_ai_resolve_backend)"
    [ "$result" = "codex" ]
}

@test "_ai_resolve_backend: env wins over config default" {
    printf '{"ai":{"defaultBackend":"codex"}}\n' > "$SWCTL_CONFIG_FILE"
    result="$(SWCTL_RESOLVE_BACKEND=claude _ai_resolve_backend)"
    [ "$result" = "claude" ]
}

@test "_ai_resolve_backend: explicit --backend wins over env and config" {
    printf '{"ai":{"defaultBackend":"codex"}}\n' > "$SWCTL_CONFIG_FILE"
    result="$(SWCTL_RESOLVE_BACKEND=codex _ai_resolve_backend claude)"
    [ "$result" = "claude" ]
}
