#!/usr/bin/env bats

load test_helper

# Regression guard for `_decide_enable_es` — the helper that decides
# whether `swctl create` should auto-enable Elasticsearch for the
# new instance (writing SHOPWARE_ES_* into .env.local and running
# es:index in post-provision).
#
# Decision precedence locked down here:
#   1. SWCTL_ENABLE_ES_OVERRIDE="1" → on  (--enable-es)
#   2. SWCTL_ENABLE_ES_OVERRIDE="0" → off (--no-enable-es)
#   3. Auto-detect via gh issue labels — on iff any of
#        component/search, component/elasticsearch, domain/search
#      is present (case-insensitive).
#   4. Otherwise → off.
#
# Tests stub `gh` so we don't talk to real GitHub.  Each test
# controls the simulated `gh api ... --jq` output by writing a
# response file the stub reads.

setup() {
    SW_TMP="$(mktemp -d)"
    export SW_TMP
    # Reset any caller-side env so each test starts from a known state.
    unset SWCTL_ENABLE_ES_OVERRIDE SWCTL_GITHUB_ORG SWCTL_GITHUB_REPO
    unset SWCTL_LABEL_FETCH_REPO
    ISSUE_ID="9999"
    export ISSUE_ID

    # Stub `gh` that prints whatever's in $SW_TMP/gh-labels.out and
    # returns exit code from $SW_TMP/gh-rc (default 0).  We
    # path-shadow so `command -v gh` still succeeds.
    cat > "$SW_TMP/gh" <<'SH'
#!/usr/bin/env bash
rc=0
[ -r "$SW_TMP/gh-rc" ] && rc=$(cat "$SW_TMP/gh-rc")
[ -r "$SW_TMP/gh-labels.out" ] && cat "$SW_TMP/gh-labels.out"
exit "$rc"
SH
    chmod +x "$SW_TMP/gh"
    PATH="$SW_TMP:$PATH"
    export PATH
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# Helper: write what the stubbed `gh` should output for a labels call.
_stub_labels() {
    printf '%s\n' "$@" > "$SW_TMP/gh-labels.out"
}

# ---------------------------------------------------------------------------
# Precedence #1: --enable-es always wins, even with no labels.
# ---------------------------------------------------------------------------

@test "_decide_enable_es: SWCTL_ENABLE_ES_OVERRIDE=1 → on (forced)" {
    SWCTL_ENABLE_ES_OVERRIDE=1
    run _decide_enable_es
    [ "$status" -eq 0 ]
    [[ "$output" == *"forced on via --enable-es"* ]]
}

# ---------------------------------------------------------------------------
# Precedence #2: --no-enable-es always wins, even on a search issue.
# ---------------------------------------------------------------------------

@test "_decide_enable_es: SWCTL_ENABLE_ES_OVERRIDE=0 → off (forced)" {
    SWCTL_ENABLE_ES_OVERRIDE=0
    _stub_labels "component/search"    # would auto-enable, but override wins
    run _decide_enable_es
    [ "$status" -eq 1 ]
    [[ "$output" == *"forced off via --no-enable-es"* ]]
}

# ---------------------------------------------------------------------------
# Precedence #3: auto-detect from labels — happy paths.
# ---------------------------------------------------------------------------

@test "_decide_enable_es: enables on component/search label" {
    _stub_labels "domain/inventory" "component/search" "priority/low"
    run _decide_enable_es
    [ "$status" -eq 0 ]
    [[ "$output" == *"matched ES-related label"* ]]
}

@test "_decide_enable_es: enables on component/elasticsearch label" {
    _stub_labels "component/elasticsearch"
    run _decide_enable_es
    [ "$status" -eq 0 ]
    [[ "$output" == *"matched ES-related label"* ]]
}

@test "_decide_enable_es: enables on domain/search label" {
    _stub_labels "domain/search"
    run _decide_enable_es
    [ "$status" -eq 0 ]
}

@test "_decide_enable_es: case-insensitive label match" {
    _stub_labels "Component/Search"
    run _decide_enable_es
    [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Auto-detect: negative cases — no ES label = off.
# ---------------------------------------------------------------------------

@test "_decide_enable_es: stays off when no ES-related label" {
    _stub_labels "domain/inventory" "priority/low" "component/admin"
    run _decide_enable_es
    [ "$status" -eq 1 ]
    [[ "$output" == *"no ES-related label"* ]]
}

# Substring match in another label should NOT trigger.  Without an
# anchored regex, `component/search-bar` (hypothetical) would mistakenly
# enable ES.  We anchor to ^/$ in the helper; this test pins that.
@test "_decide_enable_es: substring-only match in unrelated label does not enable" {
    _stub_labels "component/search-suggestion-thing"
    run _decide_enable_es
    [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Graceful degradation: gh missing / failed → no crash, default off.
# ---------------------------------------------------------------------------

@test "_decide_enable_es: gh failure → off with explanation, no crash" {
    echo "1" > "$SW_TMP/gh-rc"       # gh stub returns 1
    : > "$SW_TMP/gh-labels.out"       # empty output
    run _decide_enable_es
    [ "$status" -eq 1 ]
    [[ "$output" == *"no labels fetched"* ]] \
        || [[ "$output" == *"off"* ]]
}

@test "_decide_enable_es: missing ISSUE_ID → off without invoking gh" {
    unset ISSUE_ID
    _stub_labels "component/search"  # ignored — ISSUE_ID gate kicks in first
    run _decide_enable_es
    [ "$status" -eq 1 ]
    [[ "$output" == *"auto-detect skipped"* ]]
}

# Hostile env: the loop must not be tricked by a label name containing
# our search regex as a substring inside a different field.
@test "_decide_enable_es: label name is read line-by-line, not as one blob" {
    _stub_labels "component/search OR component/admin"  # single label, weird name
    run _decide_enable_es
    [ "$status" -eq 1 ]
}
