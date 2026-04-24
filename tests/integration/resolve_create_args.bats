#!/usr/bin/env bats

# Regression-guard tests for buildCreateArgs (app/server/lib/resolve.ts).
#
# The argv shape is the CONTRACT between startResolveStream (UI/server)
# and the bash swctl CLI.  Silently adding or removing a flag here has
# historically shipped broken worktrees to users:
#
#   - v0.5.7: the inline assembly emitted `--no-provision`, leaving
#     admin + storefront broken for every resolve-created instance
#     that was opened before Claude's Step 5 ran.  The "no
#     `--no-provision`" test below guards against any reintroduction.
#
# These tests run through the tsx probe (resolve_create_args_probe.ts)
# so they exercise the actual TypeScript helper rather than a copy.
# Skip gracefully when tsx isn't installed (CI installs it via
# `cd app && npm ci` before running integration tests).

load integration_helper

setup() {
    _repo="$BATS_TEST_DIRNAME/../.."
    _tsx="$_repo/app/node_modules/.bin/tsx"
    _probe="$_repo/tests/integration/resolve_create_args_probe.ts"
    if [ ! -x "$_tsx" ]; then
        skip "tsx not installed (run: cd app && npm install)"
    fi
}

# teardown() intentionally empty — no temp state to clean (pure function).
# Kept as a no-op so future additions don't forget the `set -u`-safe guard.
teardown() {
    :
}

# Run the probe with stdin JSON; leaves the output array (or error object)
# in $output.  Sets $args_line to "arg|arg|arg" for simple bash assertions.
_probe() {
    local input="$1"
    run bash -c "cd '$_repo' && printf '%s' '$input' | '$_tsx' '$_probe'"
    [ "$status" -eq 0 ]
}

@test "create is always the first argv element" {
    _probe '{"issueId":"1234","branchPrefix":"fix","project":null,"mode":"dev"}'
    # jq to extract element 0 — more robust than pattern matching.
    first="$(printf '%s' "$output" | jq -r '.[0]')"
    [ "$first" = "create" ]
}

@test "dev mode: no --qa flag" {
    _probe '{"issueId":"1234","branchPrefix":"fix","project":null,"mode":"dev"}'
    has_qa="$(printf '%s' "$output" | jq 'any(. == "--qa")')"
    [ "$has_qa" = "false" ]
}

@test "qa mode: --qa flag is present" {
    _probe '{"issueId":"1234","branchPrefix":"fix","project":null,"mode":"qa"}'
    has_qa="$(printf '%s' "$output" | jq 'any(. == "--qa")')"
    [ "$has_qa" = "true" ]
}

@test "regression guard: --no-provision is NEVER emitted (v0.5.8 fix)" {
    # Exercise every permutation — no input should ever produce the flag.
    # The inline code deliberately doesn't add it; this test catches
    # accidental reintroductions at PR time.
    local input
    for input in \
        '{"issueId":"1","branchPrefix":"fix","project":null,"mode":"dev"}' \
        '{"issueId":"2","branchPrefix":"feat","project":null,"mode":"qa"}' \
        '{"issueId":"3","branchPrefix":"chore","project":"SwagCommercial","mode":"dev"}' \
        '{"issueId":"4","branchPrefix":"fix","project":"SwagCustomizedProducts","mode":"qa"}'; do
        _probe "$input"
        has_np="$(printf '%s' "$output" | jq 'any(. == "--no-provision")')"
        [ "$has_np" = "false" ] || {
            echo "FAIL: input=$input produced --no-provision" >&2
            echo "output: $output" >&2
            return 1
        }
    done
}

@test "project: platform (null) → no --project flag" {
    _probe '{"issueId":"1234","branchPrefix":"fix","project":null,"mode":"dev"}'
    has_project="$(printf '%s' "$output" | jq 'any(. == "--project")')"
    [ "$has_project" = "false" ]
}

@test "project: 'trunk' → no --project flag (explicit platform)" {
    # 'trunk' is the default; swctl rejects --project=trunk, so the
    # helper must omit it entirely.
    _probe '{"issueId":"1234","branchPrefix":"fix","project":"trunk","mode":"dev"}'
    has_project="$(printf '%s' "$output" | jq 'any(. == "--project")')"
    [ "$has_project" = "false" ]
}

@test "project: named plugin → --project <name> is emitted" {
    _probe '{"issueId":"1234","branchPrefix":"feat","project":"SwagCommercial","mode":"dev"}'
    # Both the flag and its value should appear, and value must follow flag.
    has_project="$(printf '%s' "$output" | jq 'any(. == "--project")')"
    has_value="$(printf '%s' "$output" | jq 'any(. == "SwagCommercial")')"
    [ "$has_project" = "true" ]
    [ "$has_value" = "true" ]
    # Flag+value pair check: index of "SwagCommercial" == index of "--project" + 1
    idx_flag="$(printf '%s' "$output" | jq 'index("--project")')"
    idx_value="$(printf '%s' "$output" | jq 'index("SwagCommercial")')"
    [ "$idx_value" = "$((idx_flag + 1))" ]
}

@test "positional tail: last two elements are <issueId> <branch>" {
    _probe '{"issueId":"9999","branchPrefix":"feat","project":"SwagCustomizedProducts","mode":"qa"}'
    # Last element is the branch, second-to-last is the issueId.
    last="$(printf '%s' "$output" | jq -r '.[-1]')"
    penultimate="$(printf '%s' "$output" | jq -r '.[-2]')"
    [ "$penultimate" = "9999" ]
    [ "$last" = "feat/9999" ]
}

@test "branch name = <prefix>/<issueId> for each prefix" {
    local p input last
    for p in fix feat chore; do
        input="{\"issueId\":\"42\",\"branchPrefix\":\"$p\",\"project\":null,\"mode\":\"dev\"}"
        _probe "$input"
        last="$(printf '%s' "$output" | jq -r '.[-1]')"
        [ "$last" = "$p/42" ] || {
            echo "FAIL: prefix=$p produced branch=$last (expected $p/42)" >&2
            return 1
        }
    done
}

@test "full argv for a platform / dev / no-project invocation" {
    _probe '{"issueId":"1234","branchPrefix":"fix","project":null,"mode":"dev"}'
    # Expected exact shape: ["create","1234","fix/1234"]
    expected='["create","1234","fix/1234"]'
    actual="$(printf '%s' "$output" | jq -c .)"
    [ "$actual" = "$expected" ]
}

@test "full argv for a plugin / qa / named-project invocation" {
    _probe '{"issueId":"5678","branchPrefix":"feat","project":"SwagCommercial","mode":"qa"}'
    # Expected: ["create","--qa","--project","SwagCommercial","5678","feat/5678"]
    expected='["create","--qa","--project","SwagCommercial","5678","feat/5678"]'
    actual="$(printf '%s' "$output" | jq -c .)"
    [ "$actual" = "$expected" ]
}
