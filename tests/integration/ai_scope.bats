#!/usr/bin/env bats

# Integration tests for app/server/lib/ai-scope.ts — exercise
# detectScopeWithAI end-to-end via a tsx-executed probe harness
# (tests/integration/ai_scope_probe.ts).  Every path through the
# function gets one test; the stub binary on SWCTL_CLAUDE_BIN is what
# makes the AI branch deterministic and offline.
#
# Contract locked down:
#   1. Fast-path: unambiguous heuristic + non-default prefix → no spawn.
#   2. AI success: valid JSON in stdout → method=ai.
#   3. AI malformed output → method=fallback (heuristic result).
#   4. AI timeout (>12s) → method=fallback.
#   5. AI returns unknown plugin name → schema rejected → fallback.
#   6. Binary missing (ENOENT) → fallback.
#
# The app/ directory contains the TS runtime (tsx) and ai-scope source
# so the probe can import from '../../app/server/lib/ai-scope.ts'.

load integration_helper

setup() {
    _repo="$BATS_TEST_DIRNAME/../.."
    _tsx="$_repo/app/node_modules/.bin/tsx"
    _probe="$_repo/tests/integration/ai_scope_probe.ts"
    if [ ! -x "$_tsx" ]; then
        skip "tsx not installed (run: cd app && npm install)"
    fi

    _stub_dir="$(mktemp -d)"
    _stub="$_stub_dir/fake-claude"
}

teardown() {
    # Guard against `set -u` (inherited from `source swctl` in
    # integration_helper).  When setup() `skip`s early, `_stub_dir` is
    # never assigned — referencing it unguarded would make teardown exit
    # non-zero, which bats silently swallows and prints no TAP line for
    # the test.  That's what caused CI to emit
    # "Executed 41 instead of expected 47" before this guard.
    rm -rf "${_stub_dir:-}"
}

# Helper: run the probe with stdin JSON.  Prints stdout (the decision JSON),
# captures status in $status for bats assertions.
_probe() {
    local input="$1"
    run bash -c "cd '$_repo' && printf '%s' '$input' | '$_tsx' '$_probe' 2>&1"
}

@test "fast-path: unambiguous label + feat prefix → method=heuristic, no spawn" {
    # Pre-populate a stub that would CRASH if invoked — proves no spawn.
    cat > "$_stub" <<'SH'
#!/usr/bin/env bash
echo "SHOULD NOT BE CALLED" >&2
exit 99
SH
    chmod +x "$_stub"

    input='{
        "issueTitle":"Add new commercial cart rule",
        "issueBody":"new capability",
        "labels":["extension/swag-commercial","enhancement"],
        "backend":"claude",
        "pluginNames":["SwagCommercial"]
    }'
    SWCTL_CLAUDE_BIN="$_stub" run bash -c "cd '$_repo' && printf '%s' '$input' | '$_tsx' '$_probe'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"method":"heuristic"'* ]]
    [[ "$output" == *'"project":"SwagCommercial"'* ]]
    [[ "$output" == *'"branchPrefix":"feat"'* ]]
}

@test "ai path: valid JSON from stub → method=ai, parsed project" {
    cat > "$_stub" <<'SH'
#!/usr/bin/env bash
printf '%s' '{"project":"SwagCommercial","branchPrefix":"feat","confidence":0.82,"reasoning":"body mentions commercial cart"}'
SH
    chmod +x "$_stub"

    # No extension/* label → heuristic returns null → AI is invoked.
    input='{
        "issueTitle":"Cart rule crash",
        "issueBody":"commercial cart breaks",
        "labels":["bug"],
        "backend":"claude",
        "pluginNames":["SwagCommercial","SwagPayPal"]
    }'
    SWCTL_CLAUDE_BIN="$_stub" run bash -c "cd '$_repo' && printf '%s' '$input' | '$_tsx' '$_probe'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"method":"ai"'* ]]
    [[ "$output" == *'"project":"SwagCommercial"'* ]]
    [[ "$output" == *'"confidence":0.82'* ]]
}

@test "ai fallback: malformed stdout → method=fallback, heuristic used" {
    cat > "$_stub" <<'SH'
#!/usr/bin/env bash
echo "I am a chatty AI: here is my thinking... no JSON at all"
SH
    chmod +x "$_stub"

    input='{
        "issueTitle":"Some issue",
        "issueBody":"",
        "labels":["bug"],
        "backend":"claude",
        "pluginNames":["SwagCommercial"]
    }'
    SWCTL_CLAUDE_BIN="$_stub" run bash -c "cd '$_repo' && printf '%s' '$input' | '$_tsx' '$_probe'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"method":"fallback"'* ]]
    [[ "$output" == *'"confidence":0'* ]]
    # Heuristic returned no plugin (no extension/* label) → project=null.
    [[ "$output" == *'"project":null'* ]]
}

@test "ai fallback: unknown plugin name → schema reject → method=fallback" {
    cat > "$_stub" <<'SH'
#!/usr/bin/env bash
printf '%s' '{"project":"SomeFakePlugin","branchPrefix":"fix","confidence":0.9,"reasoning":"nope"}'
SH
    chmod +x "$_stub"

    input='{
        "issueTitle":"x",
        "issueBody":"",
        "labels":["bug"],
        "backend":"claude",
        "pluginNames":["SwagCommercial"]
    }'
    SWCTL_CLAUDE_BIN="$_stub" run bash -c "cd '$_repo' && printf '%s' '$input' | '$_tsx' '$_probe'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"method":"fallback"'* ]]
}

@test "ai fallback: binary missing (ENOENT) → method=fallback" {
    # No stub — point at a guaranteed-missing path.
    input='{
        "issueTitle":"x",
        "issueBody":"",
        "labels":["extension/swag-commercial"],
        "backend":"claude",
        "pluginNames":["SwagCommercial"]
    }'
    SWCTL_CLAUDE_BIN=/nonexistent/definitely-not-a-binary \
        run bash -c "cd '$_repo' && printf '%s' '$input' | '$_tsx' '$_probe'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"method":"fallback"'* ]]
    # Heuristic should still populate plugin — extension/swag-commercial → SwagCommercial.
    [[ "$output" == *'"project":"SwagCommercial"'* ]]
}

@test "tolerates leading prose around JSON block" {
    # Some CLIs emit "Assistant: {...}" or similar preamble; the parser
    # must walk to the first balanced object.
    cat > "$_stub" <<'SH'
#!/usr/bin/env bash
cat <<EOF
Here is my analysis: the issue clearly concerns the SwagCommercial plugin.
My answer: {"project":"SwagCommercial","branchPrefix":"fix","confidence":0.65,"reasoning":"trailing prose tolerated"}
Thanks!
EOF
SH
    chmod +x "$_stub"

    input='{
        "issueTitle":"x",
        "issueBody":"",
        "labels":[],
        "backend":"claude",
        "pluginNames":["SwagCommercial"]
    }'
    SWCTL_CLAUDE_BIN="$_stub" run bash -c "cd '$_repo' && printf '%s' '$input' | '$_tsx' '$_probe'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"method":"ai"'* ]]
    [[ "$output" == *'"project":"SwagCommercial"'* ]]
}
