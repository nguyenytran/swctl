#!/usr/bin/env bats

# Regression guard for the redesigned multi-select AI backend schema:
#
#   ai.enabledBackends: KnownBackend[]   ← multi-select (must be non-empty)
#   ai.defaultBackend:  KnownBackend     ← single-select (must be in enabled)
#
# Both are validated at PUT-time by validateAiConfig, and both have
# read-time fallbacks via resolveEnabledBackends / resolveDefaultBackend
# that apply the back-compat default (older configs without
# enabledBackends still work).
#
# The behaviours these tests lock down:
#
#   1. resolveEnabledBackends:
#      - empty / missing → ['claude']  (back-compat)
#      - includes only unknown values → ['claude'] (defensive recovery)
#      - explicit list → preserved with dedupe + filter to known
#
#   2. resolveDefaultBackend:
#      - explicit + in enabled → use it
#      - explicit but disabled → first enabled (forgive instead of throw)
#      - missing → first enabled
#
#   3. validateAiConfig:
#      - empty enabledBackends array → error
#      - unknown backend in enabledBackends → error
#      - defaultBackend not in incoming enabledBackends → error
#      - defaultBackend not in CURRENT enabledBackends (when next omits
#        the list) → error (cross-PUT consistency)
#      - all-good combo → null

load integration_helper

setup() {
    _repo="$BATS_TEST_DIRNAME/../.."
    _tsx="$_repo/app/node_modules/.bin/tsx"
    _probe="$_repo/tests/integration/user_config_backends_probe.ts"
    if [ ! -x "$_tsx" ]; then
        skip "tsx not installed (run: cd app && npm install)"
    fi
}

teardown() { :; }

# Pipe a JSON request to the probe; assert exit 0 and capture .result.
_probe() {
    local input="$1"
    run bash -c "cd '$_repo' && printf '%s' '$input' | '$_tsx' '$_probe'"
    [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# resolveEnabledBackends
# ---------------------------------------------------------------------------

@test "resolveEnabledBackends: missing list → ['claude']" {
    _probe '{"fn":"resolveEnabledBackends","args":[{"features":{},"ai":{}}]}'
    [ "$(printf '%s' "$output" | jq -c .result)" = '["claude"]' ]
}

@test "resolveEnabledBackends: empty list → ['claude']" {
    _probe '{"fn":"resolveEnabledBackends","args":[{"features":{},"ai":{"enabledBackends":[]}}]}'
    [ "$(printf '%s' "$output" | jq -c .result)" = '["claude"]' ]
}

@test "resolveEnabledBackends: explicit ['claude','codex'] preserved" {
    _probe '{"fn":"resolveEnabledBackends","args":[{"features":{},"ai":{"enabledBackends":["claude","codex"]}}]}'
    [ "$(printf '%s' "$output" | jq -c .result)" = '["claude","codex"]' ]
}

@test "resolveEnabledBackends: only-codex preserved" {
    _probe '{"fn":"resolveEnabledBackends","args":[{"features":{},"ai":{"enabledBackends":["codex"]}}]}'
    [ "$(printf '%s' "$output" | jq -c .result)" = '["codex"]' ]
}

@test "resolveEnabledBackends: dedupes" {
    _probe '{"fn":"resolveEnabledBackends","args":[{"features":{},"ai":{"enabledBackends":["claude","claude","codex","claude"]}}]}'
    [ "$(printf '%s' "$output" | jq -c .result)" = '["claude","codex"]' ]
}

@test "resolveEnabledBackends: filters unknown values" {
    _probe '{"fn":"resolveEnabledBackends","args":[{"features":{},"ai":{"enabledBackends":["claude","gpt-4","codex","gemini"]}}]}'
    [ "$(printf '%s' "$output" | jq -c .result)" = '["claude","codex"]' ]
}

@test "resolveEnabledBackends: only-unknown → ['claude'] (defensive)" {
    _probe '{"fn":"resolveEnabledBackends","args":[{"features":{},"ai":{"enabledBackends":["gpt-4","gemini"]}}]}'
    [ "$(printf '%s' "$output" | jq -c .result)" = '["claude"]' ]
}

# ---------------------------------------------------------------------------
# resolveDefaultBackend
# ---------------------------------------------------------------------------

@test "resolveDefaultBackend: explicit + in enabled → use it" {
    _probe '{"fn":"resolveDefaultBackend","args":[{"features":{},"ai":{"defaultBackend":"codex","enabledBackends":["claude","codex"]}}]}'
    [ "$(printf '%s' "$output" | jq -r .result)" = 'codex' ]
}

@test "resolveDefaultBackend: explicit but DISABLED → first enabled (forgive)" {
    # User had codex as default, then unticked codex but didn't pick a
    # new default.  Don't 500 — just shift to the first enabled.
    _probe '{"fn":"resolveDefaultBackend","args":[{"features":{},"ai":{"defaultBackend":"codex","enabledBackends":["claude"]}}]}'
    [ "$(printf '%s' "$output" | jq -r .result)" = 'claude' ]
}

@test "resolveDefaultBackend: missing → first enabled" {
    _probe '{"fn":"resolveDefaultBackend","args":[{"features":{},"ai":{"enabledBackends":["codex","claude"]}}]}'
    [ "$(printf '%s' "$output" | jq -r .result)" = 'codex' ]
}

@test "resolveDefaultBackend: nothing set → claude (back-compat)" {
    _probe '{"fn":"resolveDefaultBackend","args":[{"features":{},"ai":{}}]}'
    [ "$(printf '%s' "$output" | jq -r .result)" = 'claude' ]
}

# ---------------------------------------------------------------------------
# validateAiConfig
# ---------------------------------------------------------------------------

@test "validateAiConfig: empty incoming + any current → null (no validation needed)" {
    _probe '{"fn":"validateAiConfig","args":[{},{"features":{},"ai":{}}]}'
    [ "$(printf '%s' "$output" | jq .result)" = 'null' ]
}

@test "validateAiConfig: empty enabledBackends array → error" {
    _probe '{"fn":"validateAiConfig","args":[{"ai":{"enabledBackends":[]}},{"features":{},"ai":{}}]}'
    out="$(printf '%s' "$output" | jq -r .result)"
    [[ "$out" == *"non-empty"* ]]
}

@test "validateAiConfig: unknown backend in enabledBackends → error" {
    _probe '{"fn":"validateAiConfig","args":[{"ai":{"enabledBackends":["claude","gpt-4"]}},{"features":{},"ai":{}}]}'
    out="$(printf '%s' "$output" | jq -r .result)"
    [[ "$out" == *"unknown backend"* ]]
    [[ "$out" == *"gpt-4"* ]]
}

@test "validateAiConfig: defaultBackend not in incoming enabledBackends → error" {
    _probe '{"fn":"validateAiConfig","args":[{"ai":{"defaultBackend":"codex","enabledBackends":["claude"]}},{"features":{},"ai":{}}]}'
    out="$(printf '%s' "$output" | jq -r .result)"
    [[ "$out" == *"defaultBackend"* ]]
    [[ "$out" == *"must be one of enabledBackends"* ]]
}

@test "validateAiConfig: defaultBackend not in CURRENT list (no incoming list) → error" {
    # User PUTs only defaultBackend = codex.  Current on-disk list is
    # ['claude'] (no codex enabled).  Server must reject without
    # silently dropping codex — the user thinks they switched but they
    # didn't enable it first.
    _probe '{"fn":"validateAiConfig","args":[{"ai":{"defaultBackend":"codex"}},{"features":{},"ai":{"enabledBackends":["claude"]}}]}'
    out="$(printf '%s' "$output" | jq -r .result)"
    [[ "$out" == *"must be one of enabledBackends"* ]]
}

@test "validateAiConfig: all-good combo → null" {
    _probe '{"fn":"validateAiConfig","args":[{"ai":{"defaultBackend":"codex","enabledBackends":["claude","codex"]}},{"features":{},"ai":{}}]}'
    [ "$(printf '%s' "$output" | jq .result)" = 'null' ]
}

@test "validateAiConfig: changing only defaultBackend within currently-enabled list → null" {
    # Current has both enabled; user just flips default codex → claude.
    _probe '{"fn":"validateAiConfig","args":[{"ai":{"defaultBackend":"claude"}},{"features":{},"ai":{"enabledBackends":["claude","codex"]}}]}'
    [ "$(printf '%s' "$output" | jq .result)" = 'null' ]
}

@test "validateAiConfig: unknown defaultBackend → error" {
    _probe '{"fn":"validateAiConfig","args":[{"ai":{"defaultBackend":"gpt-4"}},{"features":{},"ai":{"enabledBackends":["claude"]}}]}'
    out="$(printf '%s' "$output" | jq -r .result)"
    [[ "$out" == *"not a known backend"* ]]
}
