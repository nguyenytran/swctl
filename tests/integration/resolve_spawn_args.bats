#!/usr/bin/env bats

# Regression guard for buildSpawnArgs (app/server/lib/resolve.ts).
#
# The bug this prevents:  before v0.5.10 the spawn site in
# startResolveStream hard-coded `backendBinary('claude')` regardless
# of the user-selected backend.  Picking Codex in the UI logged a
# "falling back to claude" warning and then ran Claude anyway, which
# users reported as "I switched to Codex but the log says
# `[claude] Starting /shopware-resolve ...`".
#
# The regression tests here MUST assert two invariants that would
# have caught that bug directly:
#
#   1. backend='codex' → result.bin resolves via `backendBinary('codex')`
#      (== `codex` by default, SWCTL_CODEX_BIN when set).  No "claude"
#      anywhere in the result.
#   2. backend='codex' → result.args[0] is `exec` (Codex's subcommand,
#      not Claude's `-p` flag).
#
# Test 7 is the direct guard against the exact user symptom.

load integration_helper

setup() {
    _repo="$BATS_TEST_DIRNAME/../.."
    _tsx="$_repo/app/node_modules/.bin/tsx"
    _probe="$_repo/tests/integration/resolve_spawn_args_probe.ts"
    if [ ! -x "$_tsx" ]; then
        skip "tsx not installed (run: cd app && npm install)"
    fi
}

teardown() {
    :
}

_probe() {
    local input="$1"
    run bash -c "cd '$_repo' && printf '%s' '$input' | '$_tsx' '$_probe'"
    [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Claude path — pre-existing behaviour, regression-guarded here
# ---------------------------------------------------------------------------

@test "claude: bin resolves to 'claude' by default" {
    _probe '{"backend":"claude","prompt":"p","sessionId":"u-1","worktreePath":"/tmp/w","allowedTools":"Bash Edit"}'
    bin="$(printf '%s' "$output" | jq -r .bin)"
    [ "$bin" = "claude" ]
}

@test "claude: args start with -p <prompt>" {
    _probe '{"backend":"claude","prompt":"hello","sessionId":"u-1","worktreePath":"/tmp/w","allowedTools":""}'
    first="$(printf '%s' "$output" | jq -r '.args[0]')"
    second="$(printf '%s' "$output" | jq -r '.args[1]')"
    [ "$first" = "-p" ]
    [ "$second" = "hello" ]
}

@test "claude: args include --session-id <uuid>" {
    _probe '{"backend":"claude","prompt":"p","sessionId":"my-uuid-42","worktreePath":"/tmp/w","allowedTools":""}'
    has_flag="$(printf '%s' "$output" | jq '.args | any(. == "--session-id")')"
    has_uuid="$(printf '%s' "$output" | jq '.args | any(. == "my-uuid-42")')"
    [ "$has_flag" = "true" ]
    [ "$has_uuid" = "true" ]
    # value must follow flag
    idx="$(printf '%s' "$output" | jq '.args | index("--session-id")')"
    val="$(printf '%s' "$output" | jq -r ".args[$((idx+1))]")"
    [ "$val" = "my-uuid-42" ]
}

@test "claude: args include --allowedTools passthrough" {
    _probe '{"backend":"claude","prompt":"p","sessionId":"u","worktreePath":"/tmp/w","allowedTools":"Bash Edit Write"}'
    idx="$(printf '%s' "$output" | jq '.args | index("--allowedTools")')"
    val="$(printf '%s' "$output" | jq -r ".args[$((idx+1))]")"
    [ "$val" = "Bash Edit Write" ]
}

# ---------------------------------------------------------------------------
# Codex path — the actual user-reported fix
# ---------------------------------------------------------------------------

@test "REGRESSION: backend='codex' → bin is 'codex', NOT 'claude'" {
    # Direct guard against the user-reported bug: "I switched to Codex
    # but the log shows [claude] Starting ...".  Pre-fix this returned
    # bin=claude.  The test below asserts bin=codex AND that 'claude'
    # does not appear anywhere in the spawn plan.
    _probe '{"backend":"codex","prompt":"p","sessionId":"u-ignored","worktreePath":"/tmp/w","allowedTools":""}'
    bin="$(printf '%s' "$output" | jq -r .bin)"
    [ "$bin" = "codex" ] || {
        echo "FAIL: expected bin=codex, got bin=$bin" >&2
        echo "$output" >&2
        return 1
    }
    # The entire plan (bin + args) must not mention 'claude'.
    claude_hit="$(printf '%s' "$output" | jq '. | tostring | test("claude")')"
    [ "$claude_hit" = "false" ] || {
        echo "FAIL: spawn plan contains 'claude' on a codex-backed invocation" >&2
        echo "$output" >&2
        return 1
    }
}

@test "codex: first arg is 'exec' (not '-p')" {
    _probe '{"backend":"codex","prompt":"p","sessionId":"u","worktreePath":"/tmp/w","allowedTools":""}'
    first="$(printf '%s' "$output" | jq -r '.args[0]')"
    [ "$first" = "exec" ]
}

@test "codex: args include --json (JSONL output, the stream-json equivalent)" {
    _probe '{"backend":"codex","prompt":"p","sessionId":"u","worktreePath":"/tmp/w","allowedTools":""}'
    has_json="$(printf '%s' "$output" | jq '.args | any(. == "--json")')"
    [ "$has_json" = "true" ]
}

@test "codex: args include --dangerously-bypass-approvals-and-sandbox (Alpine container is the sandbox)" {
    # We deliberately do NOT use --full-auto.  --full-auto enables Codex's
    # workspace-write bwrap sandbox, which requires unprivileged user
    # namespaces and silently breaks every file write inside Alpine
    # (bwrap: "No permissions to create a new namespace").  The swctl-ui
    # container itself is the sandbox boundary.  Regression guard for
    # the user-reported "0/8 steps emitted an END marker" failure.
    _probe '{"backend":"codex","prompt":"p","sessionId":"u","worktreePath":"/tmp/w","allowedTools":""}'
    has_bypass="$(printf '%s' "$output" | jq '.args | any(. == "--dangerously-bypass-approvals-and-sandbox")')"
    [ "$has_bypass" = "true" ]
    # And explicitly assert the broken flag is NOT present.
    has_full_auto="$(printf '%s' "$output" | jq '.args | any(. == "--full-auto")')"
    [ "$has_full_auto" = "false" ]
}

@test "codex: args include --cd <worktreePath>" {
    _probe '{"backend":"codex","prompt":"p","sessionId":"u","worktreePath":"/Users/me/work/sw-42","allowedTools":""}'
    idx="$(printf '%s' "$output" | jq '.args | index("--cd")')"
    val="$(printf '%s' "$output" | jq -r ".args[$((idx+1))]")"
    [ "$val" = "/Users/me/work/sw-42" ]
}

@test "codex: prompt is the LAST positional arg (after all flags)" {
    _probe '{"backend":"codex","prompt":"the actual task","sessionId":"u","worktreePath":"/tmp/w","allowedTools":""}'
    last="$(printf '%s' "$output" | jq -r '.args[-1]')"
    [ "$last" = "the actual task" ]
}

@test "codex: does NOT forward --session-id (Codex assigns its own)" {
    _probe '{"backend":"codex","prompt":"p","sessionId":"claude-style-uuid-not-supported","worktreePath":"/tmp/w","allowedTools":""}'
    has_flag="$(printf '%s' "$output" | jq '.args | any(. == "--session-id")')"
    has_val="$(printf '%s' "$output" | jq '.args | any(. == "claude-style-uuid-not-supported")')"
    [ "$has_flag" = "false" ]
    [ "$has_val" = "false" ]
}

@test "SWCTL_CODEX_BIN override routes through backendBinary()" {
    # When the user points .ai.codex.bin at a custom location, that
    # wins over the default 'codex'.  Covered by backendBinary()'s
    # env-first precedence — this test locks down the integration.
    local input='{"backend":"codex","prompt":"p","sessionId":"u","worktreePath":"/tmp/w","allowedTools":""}'
    SWCTL_CODEX_BIN=/opt/local/bin/codex \
        run bash -c "cd '$_repo' && printf '%s' '$input' | '$_tsx' '$_probe'"
    [ "$status" -eq 0 ]
    bin="$(printf '%s' "$output" | jq -r .bin)"
    [ "$bin" = "/opt/local/bin/codex" ]
}
