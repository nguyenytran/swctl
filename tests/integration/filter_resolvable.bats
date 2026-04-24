#!/usr/bin/env bats

# Regression guard for filterResolvableIssues
# (app/src/utils/filterResolvable.ts).
#
# Policy:
#   - Issues with NO linkedPRs → KEPT.
#   - Issues with at least one OPEN / DRAFT / MERGED linked PR → HIDDEN
#     (they're already being worked on or already fixed — resolving
#     them again would duplicate work).
#   - Issues where EVERY linked PR is CLOSED → KEPT (closed PRs =
#     abandoned attempts, the issue is still fair game).
#   - Unknown future states are treated as active (hide by default).
#
# These tests exercise every branch of that policy so a future tweak
# has to update the matrix explicitly.

load integration_helper

setup() {
    _repo="$BATS_TEST_DIRNAME/../.."
    _tsx="$_repo/app/node_modules/.bin/tsx"
    _probe="$_repo/tests/integration/filter_resolvable_probe.ts"
    if [ ! -x "$_tsx" ]; then
        skip "tsx not installed (run: cd app && npm install)"
    fi
}

teardown() { :; }

_probe() {
    local input="$1"
    run bash -c "cd '$_repo' && printf '%s' '$input' | '$_tsx' '$_probe'"
    [ "$status" -eq 0 ]
}

# Compact helper: one item, passed by number + linkedPRs JSON fragment.
# Renders the minimum GitHubItem shape the filter reads (number, linkedPRs).
_mk_items() {
    # Consumes positional "number:prs-json" pairs, prints a JSON array.
    local first=1
    printf '['
    local pair n prs
    for pair in "$@"; do
        n="${pair%%:*}"
        prs="${pair#*:}"
        if [ "$first" = "1" ]; then first=0; else printf ','; fi
        printf '{"number":%s,"title":"t","labels":[],"user":"u","branch":null,"isPR":false,"url":"","category":"assigned","linkedPRs":%s}' \
            "$n" "$prs"
    done
    printf ']'
}

# ---------------------------------------------------------------------------
# Core policy matrix
# ---------------------------------------------------------------------------

@test "no linked PRs → KEPT" {
    input="$(_mk_items '100:[]')"
    _probe "$input"
    [ "$(printf '%s' "$output" | jq -c .keptNumbers)" = "[100]" ]
    [ "$(printf '%s' "$output" | jq .hidden)" = "0" ]
}

@test "linkedPRs field absent entirely → KEPT" {
    # Some older GitHub fetches may omit the linkedPRs field; the
    # helper defaults to [] so undefined must not throw.
    input='[{"number":101,"title":"t","labels":[],"user":"u","branch":null,"isPR":false,"url":"","category":"assigned"}]'
    _probe "$input"
    [ "$(printf '%s' "$output" | jq -c .keptNumbers)" = "[101]" ]
    [ "$(printf '%s' "$output" | jq .hidden)" = "0" ]
}

@test "one OPEN linked PR → HIDDEN" {
    input="$(_mk_items '200:[{"number":1,"branch":"fix/x","title":"PR","state":"open"}]')"
    _probe "$input"
    [ "$(printf '%s' "$output" | jq -c .keptNumbers)" = "[]" ]
    [ "$(printf '%s' "$output" | jq .hidden)" = "1" ]
}

@test "one DRAFT linked PR → HIDDEN" {
    input="$(_mk_items '201:[{"number":1,"branch":"fix/x","title":"PR","state":"draft"}]')"
    _probe "$input"
    [ "$(printf '%s' "$output" | jq .hidden)" = "1" ]
}

@test "one MERGED linked PR → HIDDEN (already fixed)" {
    input="$(_mk_items '202:[{"number":1,"branch":"fix/x","title":"PR","state":"merged"}]')"
    _probe "$input"
    [ "$(printf '%s' "$output" | jq .hidden)" = "1" ]
}

@test "one CLOSED linked PR → KEPT (abandoned attempt)" {
    input="$(_mk_items '203:[{"number":1,"branch":"fix/x","title":"PR","state":"closed"}]')"
    _probe "$input"
    [ "$(printf '%s' "$output" | jq -c .keptNumbers)" = "[203]" ]
    [ "$(printf '%s' "$output" | jq .hidden)" = "0" ]
}

@test "all linked PRs closed → KEPT" {
    input="$(_mk_items '204:[{"number":1,"branch":"a","title":"A","state":"closed"},{"number":2,"branch":"b","title":"B","state":"closed"}]')"
    _probe "$input"
    [ "$(printf '%s' "$output" | jq -c .keptNumbers)" = "[204]" ]
    [ "$(printf '%s' "$output" | jq .hidden)" = "0" ]
}

@test "mix: closed + open → HIDDEN (any active PR wins)" {
    input="$(_mk_items '205:[{"number":1,"branch":"a","title":"A","state":"closed"},{"number":2,"branch":"b","title":"B","state":"open"}]')"
    _probe "$input"
    [ "$(printf '%s' "$output" | jq .hidden)" = "1" ]
}

@test "unknown state → HIDDEN (safe default)" {
    # If GitHub adds a new state like "queued", we hide rather than
    # risk duplicating work.  Users can still manually paste the URL.
    input="$(_mk_items '206:[{"number":1,"branch":"a","title":"A","state":"queued"}]')"
    _probe "$input"
    [ "$(printf '%s' "$output" | jq .hidden)" = "1" ]
}

# ---------------------------------------------------------------------------
# Multi-item + ordering
# ---------------------------------------------------------------------------

@test "mixed list preserves input order for kept items" {
    input="$(_mk_items \
        '300:[]' \
        '301:[{"number":1,"branch":"x","title":"X","state":"open"}]' \
        '302:[]' \
        '303:[{"number":2,"branch":"y","title":"Y","state":"closed"}]' \
        '304:[{"number":3,"branch":"z","title":"Z","state":"merged"}]')"
    _probe "$input"
    [ "$(printf '%s' "$output" | jq -c .keptNumbers)" = "[300,302,303]" ]
    [ "$(printf '%s' "$output" | jq .hidden)" = "2" ]
}

@test "empty input → empty output, 0 hidden" {
    _probe '[]'
    [ "$(printf '%s' "$output" | jq -c .keptNumbers)" = "[]" ]
    [ "$(printf '%s' "$output" | jq .hidden)" = "0" ]
}
