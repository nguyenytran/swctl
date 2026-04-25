#!/usr/bin/env bats

# Regression guard for filterResolvableIssues
# (app/src/utils/filterResolvable.ts).
#
# Policy (layered, first hit wins — see file-level docstring):
#   1. issueType filter (default onlyBug=true):
#        - issueType === 'Bug' (case-insensitive) → pass through
#        - anything else (Improvement, Story, Task, null, '') → HIDDEN
#        - disable with SWCTL_FILTER_OPTS='{"onlyBug":false}'
#   2. Active-linked-PR filter (always on):
#        - any linkedPR with state != 'closed' → HIDDEN
#        - all linkedPRs closed or none → pass through
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

teardown() {
    unset SWCTL_FILTER_OPTS
}

_probe() {
    local input="$1"
    # Default probe: onlyBug=true (matches the default behaviour).  The
    # tests covering the PR filter need the Bug filter OFF so they can
    # assert PR-only behaviour without stuffing 'Bug' into every fixture.
    run bash -c "cd '$_repo' && printf '%s' '$input' | SWCTL_FILTER_OPTS='{\"onlyBug\":false}' '$_tsx' '$_probe'"
    [ "$status" -eq 0 ]
}

_probe_onlybug() {
    local input="$1"
    run bash -c "cd '$_repo' && printf '%s' '$input' | '$_tsx' '$_probe'"
    [ "$status" -eq 0 ]
}

# Compact helper: one item, passed by number + linkedPRs JSON fragment.
# issueType is omitted (runs under SWCTL_FILTER_OPTS onlyBug=false).
_mk_items() {
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

# Helper for onlyBug tests: tag issueType explicitly.
_mk_typed() {
    local first=1
    printf '['
    local triple n type prs
    for triple in "$@"; do
        # format: "number|type|prs-json"
        n="$(printf '%s' "$triple" | cut -d'|' -f1)"
        type="$(printf '%s' "$triple" | cut -d'|' -f2)"
        prs="$(printf '%s' "$triple" | cut -d'|' -f3-)"
        if [ "$first" = "1" ]; then first=0; else printf ','; fi
        local type_json='null'
        [ -n "$type" ] && type_json="\"$type\""
        printf '{"number":%s,"title":"t","labels":[],"user":"u","branch":null,"isPR":false,"url":"","category":"assigned","issueType":%s,"linkedPRs":%s}' \
            "$n" "$type_json" "$prs"
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

# ---------------------------------------------------------------------------
# onlyBug filter (default on) — added with v0.5.x "Resolve only Bugs"
# ---------------------------------------------------------------------------

@test "onlyBug (default): issueType='Bug' → KEPT" {
    _probe_onlybug "$(_mk_typed '400|Bug|[]')"
    [ "$(printf '%s' "$output" | jq -c .keptNumbers)" = "[400]" ]
    [ "$(printf '%s' "$output" | jq .hidden)" = "0" ]
}

@test "onlyBug: issueType='bug' (lowercase) → KEPT (case-insensitive)" {
    _probe_onlybug "$(_mk_typed '401|bug|[]')"
    [ "$(printf '%s' "$output" | jq -c .keptNumbers)" = "[401]" ]
}

@test "onlyBug: issueType='BUG' (uppercase) → KEPT" {
    _probe_onlybug "$(_mk_typed '402|BUG|[]')"
    [ "$(printf '%s' "$output" | jq -c .keptNumbers)" = "[402]" ]
}

@test "onlyBug: issueType='Improvement' → HIDDEN (counted as type)" {
    _probe_onlybug "$(_mk_typed '410|Improvement|[]')"
    [ "$(printf '%s' "$output" | jq -c .keptNumbers)" = "[]" ]
    [ "$(printf '%s' "$output" | jq .hidden)" = "1" ]
    [ "$(printf '%s' "$output" | jq .hiddenByType)" = "1" ]
    [ "$(printf '%s' "$output" | jq .hiddenByLinkedPr)" = "0" ]
}

@test "onlyBug: issueType='Story' → HIDDEN" {
    _probe_onlybug "$(_mk_typed '411|Story|[]')"
    [ "$(printf '%s' "$output" | jq .hiddenByType)" = "1" ]
}

@test "onlyBug: issueType='Task' → HIDDEN" {
    _probe_onlybug "$(_mk_typed '412|Task|[]')"
    [ "$(printf '%s' "$output" | jq .hiddenByType)" = "1" ]
}

@test "onlyBug: issueType null/missing → HIDDEN (conservative — no type = not a bug)" {
    _probe_onlybug "$(_mk_typed '413||[]')"
    [ "$(printf '%s' "$output" | jq .hiddenByType)" = "1" ]
}

@test "onlyBug: mixed list — only Bugs pass, counts split by reason" {
    local input
    input="$(_mk_typed \
        '500|Bug|[]' \
        '501|Improvement|[]' \
        '502|Bug|[{"number":1,"branch":"a","title":"A","state":"open"}]' \
        '503|Story|[]' \
        '504|Bug|[]' \
        '505|Task|[{"number":1,"branch":"b","title":"B","state":"open"}]')"
    _probe_onlybug "$input"
    # Kept: 500, 504 (both Bugs with no active PR).  502 is a Bug but
    # has an active PR → hidden-by-pr.  501/503/505 hidden-by-type.
    # Note 505 is hidden by TYPE (wins over PR — first filter first).
    [ "$(printf '%s' "$output" | jq -c .keptNumbers)" = "[500,504]" ]
    [ "$(printf '%s' "$output" | jq .hiddenByType)" = "3" ]     # 501, 503, 505
    [ "$(printf '%s' "$output" | jq .hiddenByLinkedPr)" = "1" ] # 502
    [ "$(printf '%s' "$output" | jq .hidden)" = "4" ]
}

@test "onlyBug off (opts.onlyBug=false): types irrelevant, PR filter still applies" {
    local input
    input="$(_mk_typed \
        '600|Improvement|[]' \
        '601|Task|[{"number":1,"branch":"a","title":"A","state":"open"}]' \
        '602|Story|[]')"
    # _probe_onlybug runs WITHOUT SWCTL_FILTER_OPTS → uses default
    # (onlyBug=true).  _probe runs WITH onlyBug=false.
    _probe "$input"
    # With onlyBug off: 600 kept (no PR), 601 hidden (active PR),
    # 602 kept (no PR).
    [ "$(printf '%s' "$output" | jq -c .keptNumbers)" = "[600,602]" ]
    [ "$(printf '%s' "$output" | jq .hiddenByType)" = "0" ]
    [ "$(printf '%s' "$output" | jq .hiddenByLinkedPr)" = "1" ]
}
