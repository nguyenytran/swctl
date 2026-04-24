#!/usr/bin/env bats

# Regression-guard tests for readInstanceBackend (app/server/lib/resolve.ts).
#
# This helper is on the critical path for every resume / ask / chat call
# from the resolve UI — it reads the instance's pinned backend from
# disk so the right CLI (claude or codex) gets spawned.  A wrong answer
# here means a fix started with Codex gets resumed with Claude (or vice
# versa), losing the session entirely.
#
# Paths covered (each = one test):
#   1. SWCTL_STATE_DIR empty → claude (safe default, no crash)
#   2. instances dir doesn't exist → claude
#   3. env file missing for issueId → claude
#   4. env file exists but has no RESOLVE_BACKEND line (pre-0.5.7
#      legacy) → claude
#   5. RESOLVE_BACKEND='claude' (shell-quoted) → claude
#   6. RESOLVE_BACKEND='codex' (shell-quoted) → codex
#   7. RESOLVE_BACKEND=codex (unquoted) → codex
#   8. RESOLVE_BACKEND='WAT' (garbage) → claude (coerceBackend fallback)

load integration_helper

setup() {
    _repo="$BATS_TEST_DIRNAME/../.."
    _tsx="$_repo/app/node_modules/.bin/tsx"
    _probe="$_repo/tests/integration/resolve_backend_read_probe.ts"
    if [ ! -x "$_tsx" ]; then
        skip "tsx not installed (run: cd app && npm install)"
    fi

    _state_dir="$(mktemp -d)"
    _instances_dir="$_state_dir/instances/trunk"
    mkdir -p "$_instances_dir"
}

teardown() {
    # set -u is inherited from `source swctl` in integration_helper —
    # guard against skipped tests where _state_dir was never assigned.
    rm -rf "${_state_dir:-}"
}

# _probe <issueId> — runs the probe with SWCTL_STATE_DIR pointed at the
# test's temp state dir.  Populates $output + $status as usual.
_probe() {
    local issue="$1"
    local input
    input="$(printf '{"issueId":"%s"}' "$issue")"
    SWCTL_STATE_DIR="$_state_dir" \
        run bash -c "cd '$_repo' && printf '%s' '$input' | '$_tsx' '$_probe'"
    [ "$status" -eq 0 ]
}

# _expect_backend <issueId> <expected>  — runs the probe and asserts.
_expect_backend() {
    local expected="$2"
    _probe "$1"
    local got
    got="$(printf '%s' "$output" | jq -r .backend)"
    [ "$got" = "$expected" ] || {
        echo "FAIL: issueId=$1 expected backend=$expected got=$got" >&2
        echo "  raw: $output" >&2
        return 1
    }
}

@test "empty SWCTL_STATE_DIR → claude (default)" {
    # Override setup's _state_dir with an empty string so the env file
    # lookup short-circuits on STATE_DIR === ''.
    local input='{"issueId":"1"}'
    SWCTL_STATE_DIR='' \
        run bash -c "cd '$_repo' && printf '%s' '$input' | '$_tsx' '$_probe'"
    [ "$status" -eq 0 ]
    got="$(printf '%s' "$output" | jq -r .backend)"
    [ "$got" = "claude" ]
}

@test "instances dir does not exist → claude" {
    rm -rf "$_state_dir/instances"
    _expect_backend "999" "claude"
}

@test "env file missing for issueId → claude" {
    # instances/trunk/ exists (setup created it) but 42.env doesn't.
    _expect_backend "42" "claude"
}

@test "env file present but no RESOLVE_BACKEND line → claude (legacy)" {
    cat > "$_instances_dir/42.env" <<'EOF'
ISSUE_ID=42
BRANCH=fix/42-something
CLAUDE_SESSION_ID=abcd-1234
EOF
    _expect_backend "42" "claude"
}

@test "RESOLVE_BACKEND='claude' → claude" {
    cat > "$_instances_dir/42.env" <<'EOF'
ISSUE_ID=42
RESOLVE_BACKEND='claude'
EOF
    _expect_backend "42" "claude"
}

@test "RESOLVE_BACKEND='codex' → codex" {
    cat > "$_instances_dir/42.env" <<'EOF'
ISSUE_ID=42
RESOLVE_BACKEND='codex'
EOF
    _expect_backend "42" "codex"
}

@test "RESOLVE_BACKEND=codex (unquoted) → codex" {
    cat > "$_instances_dir/42.env" <<'EOF'
ISSUE_ID=42
RESOLVE_BACKEND=codex
EOF
    _expect_backend "42" "codex"
}

@test "RESOLVE_BACKEND='WAT' (garbage) → claude (coerceBackend fallback)" {
    cat > "$_instances_dir/42.env" <<'EOF'
ISSUE_ID=42
RESOLVE_BACKEND='WAT'
EOF
    _expect_backend "42" "claude"
}

@test "scans all project subdirs — finds env under a non-'trunk' project" {
    # Registry may have multiple project dirs (trunk, SwagCommercial, etc.).
    # readInstanceBackend walks every project to find the issue's env.
    rm -f "$_instances_dir/42.env"
    local plugin_dir="$_state_dir/instances/SwagCommercial"
    mkdir -p "$plugin_dir"
    cat > "$plugin_dir/42.env" <<'EOF'
ISSUE_ID=42
RESOLVE_BACKEND='codex'
EOF
    _expect_backend "42" "codex"
}
