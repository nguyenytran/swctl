#!/usr/bin/env bats

load integration_helper

# Integration tests for the resolve backend dispatch (v0.5.7).  These
# don't need Docker — they exercise the `_ai_*` helpers against stub
# binaries on disk — but the stubs must be real executables in PATH
# (not just functions), so they're part of the integration suite.
#
# Contract locked down here:
# 1. `SWCTL_CLAUDE_BIN` / `SWCTL_CODEX_BIN` can point `_ai_backend_binary`
#    at an arbitrary executable, and invoking that executable with the
#    output of `_ai_spawn_args` produces the expected arg list.
# 2. `RESOLVE_BACKEND` in an instance env file survives
#    `load_instance_metadata` and backfills to "claude" when absent.
# 3. `_ai_resolve_backend` respects --backend > env > default precedence
#    under realistic shell invocation (subshells, unset envs).

setup() {
    _it_dir="${BATS_TMPDIR}/resolve-backend-$$-${BATS_TEST_NUMBER}"
    mkdir -p "$_it_dir"
    _it_stub_out="$_it_dir/stub.out"
}

teardown() {
    rm -rf "$_it_dir"
}

# make_stub <path>  —  create a real executable that records its argv.
make_stub() {
    local path="$1"
    cat > "$path" <<SH
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$_it_stub_out"
SH
    chmod +x "$path"
}

@test "SWCTL_CLAUDE_BIN stub receives claude 'new' mode args end-to-end" {
    local stub="$_it_dir/fake-claude"
    make_stub "$stub"

    export SWCTL_CLAUDE_BIN="$stub"
    local bin
    bin="$(_ai_backend_binary claude)"
    [ "$bin" = "$stub" ]

    local args=()
    while IFS= read -r _line; do [ -n "$_line" ] && args+=("$_line"); done < <(_ai_spawn_args claude new my-session-id)
    "$bin" "${args[@]}"

    # Expect --session-id and my-session-id somewhere in the recorded argv
    grep -q -- "--session-id" "$_it_stub_out"
    grep -q "my-session-id"   "$_it_stub_out"
    grep -q -- "--output-format" "$_it_stub_out"
    grep -q "stream-json" "$_it_stub_out"
}

@test "SWCTL_CODEX_BIN stub receives codex 'new' mode args end-to-end" {
    local stub="$_it_dir/fake-codex"
    make_stub "$stub"

    export SWCTL_CODEX_BIN="$stub"
    local bin
    bin="$(_ai_backend_binary codex)"
    [ "$bin" = "$stub" ]

    local args=()
    while IFS= read -r _line; do [ -n "$_line" ] && args+=("$_line"); done < <(_ai_spawn_args codex new sess-1)
    "$bin" "${args[@]}"

    grep -q "exec"      "$_it_stub_out"
    grep -q -- "--session" "$_it_stub_out"
    grep -q "sess-1"    "$_it_stub_out"
}

@test "SWCTL_CODEX_BIN stub receives codex 'ask' mode args end-to-end" {
    local stub="$_it_dir/fake-codex"
    make_stub "$stub"

    export SWCTL_CODEX_BIN="$stub"
    local bin
    bin="$(_ai_backend_binary codex)"

    local args=()
    while IFS= read -r _line; do [ -n "$_line" ] && args+=("$_line"); done < <(_ai_spawn_args codex ask sess-1)
    "$bin" "${args[@]}"

    grep -q "exec"      "$_it_stub_out"
    grep -q -- "--message" "$_it_stub_out"
}

@test "load_instance_metadata backfills RESOLVE_BACKEND=claude when missing" {
    # Simulate a pre-0.5.7 instance env file: only CLAUDE_SESSION_ID, no
    # RESOLVE_BACKEND.  After load_instance_metadata, RESOLVE_BACKEND should
    # be "claude" (back-compat default).
    local env_file="$_it_dir/legacy.env"
    cat > "$env_file" <<EOF
ISSUE_ID='1234'
BRANCH='fix/1234-legacy'
CLAUDE_SESSION_ID='abc-legacy-session'
WORKTREE_PATH='/tmp/nowhere'
COMPOSE_PROJECT='trunk-1234'
EOF

    # Run in a subshell so the mutation doesn't leak into the next test.
    out="$(
        unset RESOLVE_BACKEND
        load_instance_metadata "$env_file" >/dev/null
        printf '%s' "${RESOLVE_BACKEND:-UNSET}"
    )"
    [ "$out" = "claude" ]
}

@test "load_instance_metadata preserves RESOLVE_BACKEND=codex" {
    local env_file="$_it_dir/codex.env"
    cat > "$env_file" <<EOF
ISSUE_ID='9999'
BRANCH='fix/9999-codex'
RESOLVE_BACKEND='codex'
CLAUDE_SESSION_ID='def-codex-session'
EOF

    out="$(
        unset RESOLVE_BACKEND
        load_instance_metadata "$env_file" >/dev/null
        printf '%s' "${RESOLVE_BACKEND:-UNSET}"
    )"
    [ "$out" = "codex" ]
}

@test "_ai_resolve_backend precedence: --backend > env > default" {
    # With env set AND explicit arg: explicit wins
    result="$(SWCTL_RESOLVE_BACKEND=claude _ai_resolve_backend codex)"
    [ "$result" = "codex" ]

    # With only env set: env wins
    result="$(SWCTL_RESOLVE_BACKEND=codex _ai_resolve_backend)"
    [ "$result" = "codex" ]

    # Neither: default claude
    unset SWCTL_RESOLVE_BACKEND
    result="$(_ai_resolve_backend)"
    [ "$result" = "claude" ]
}
