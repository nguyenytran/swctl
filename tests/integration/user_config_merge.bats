#!/usr/bin/env bats

# Regression-guard tests for writeUserConfig's merge semantics
# (app/server/lib/config.ts).
#
# The bug this prevents:  saving "switch default AI backend to codex"
# from the /config UI silently set `features.resolveEnabled` back to
# false (disabling the whole resolve feature) AND dropped any
# previously-configured claude.bin / codex.configDir.  Root cause: the
# PUT handler's sanitizer emitted `{ resolveEnabled: undefined }`
# when the UI payload had no features key, and the merge spread that
# undefined over the on-disk `true`, dropping it.  JSON.stringify
# then erased the key, so the next readUserConfig saw no flag at all.
#
# These tests exercise writeUserConfig directly — any regression that
# re-introduces the "undefined overwrites current" behaviour will fail
# test #3 or #4 immediately.

load integration_helper

setup() {
    _repo="$BATS_TEST_DIRNAME/../.."
    _tsx="$_repo/app/node_modules/.bin/tsx"
    _probe="$_repo/tests/integration/user_config_merge_probe.ts"
    if [ ! -x "$_tsx" ]; then
        skip "tsx not installed (run: cd app && npm install)"
    fi

    _tmp="$(mktemp -d)"
    export SWCTL_CONFIG_FILE="$_tmp/config.json"
}

teardown() {
    # set -u safety (integration_helper sources swctl with -u enabled).
    rm -rf "${_tmp:-}"
}

_merge() {
    local input="$1"
    SWCTL_CONFIG_FILE="$SWCTL_CONFIG_FILE" \
        run bash -c "cd '$_repo' && printf '%s' '$input' | '$_tsx' '$_probe'"
    [ "$status" -eq 0 ]
}

@test "fresh write: no initial, full patch → exactly as patched" {
    _merge '{
        "initial": null,
        "patch": {
            "features": {"resolveEnabled": true},
            "ai": {"defaultBackend": "claude", "claude": {"bin": "/a"}, "codex": {"bin": "/b"}}
        }
    }'
    got="$(printf '%s' "$output" | jq -c .onDisk)"
    expected='{"features":{"resolveEnabled":true},"ai":{"defaultBackend":"claude","claude":{"bin":"/a"},"codex":{"bin":"/b"}}}'
    [ "$got" = "$expected" ]
}

@test "partial patch preserves existing siblings at the top level" {
    _merge '{
        "initial": {
            "features": {"resolveEnabled": true},
            "ai": {"defaultBackend": "claude"}
        },
        "patch": {
            "ai": {"defaultBackend": "codex"}
        }
    }'
    # features must survive untouched
    resolve_enabled="$(printf '%s' "$output" | jq -r .onDisk.features.resolveEnabled)"
    [ "$resolve_enabled" = "true" ]
    # ai.defaultBackend must flip
    backend="$(printf '%s' "$output" | jq -r .onDisk.ai.defaultBackend)"
    [ "$backend" = "codex" ]
}

@test "REGRESSION: patch with ai only does NOT disable resolve feature" {
    # The exact user-reported scenario.  Before the fix, an empty /
    # absent features key in the patch triggered a sanitizer path that
    # wrote `features: { resolveEnabled: undefined }` → JSON.stringify
    # erased it → readUserConfig saw no key → isResolveEnabled() → false.
    _merge '{
        "initial": {
            "features": {"resolveEnabled": true},
            "ai": {"defaultBackend": "claude", "claude": {"bin": "/opt/claude"}}
        },
        "patch": {
            "ai": {"defaultBackend": "codex"}
        }
    }'
    # features.resolveEnabled MUST stay true
    got="$(printf '%s' "$output" | jq -r .onDisk.features.resolveEnabled)"
    [ "$got" = "true" ] || {
        echo "FAIL: ai-only patch clobbered features.resolveEnabled" >&2
        echo "$output" >&2
        return 1
    }
    # claude.bin must also survive (same class of bug would also erase it)
    bin="$(printf '%s' "$output" | jq -r .onDisk.ai.claude.bin)"
    [ "$bin" = "/opt/claude" ]
    # and the requested change must have applied
    backend="$(printf '%s' "$output" | jq -r .onDisk.ai.defaultBackend)"
    [ "$backend" = "codex" ]
}

@test "REGRESSION: undefined-valued keys in patch do NOT overwrite current" {
    # Simulate a buggy client that sends `{features: {resolveEnabled: null}}`
    # or similar — the strip-undefined guard converts that to a no-op.
    # JSON doesn't have undefined, so we test with an absent key (which is
    # the TS-side equivalent of `undefined`).  Also cover the per-backend
    # objects: an empty `claude: {}` must not wipe existing claude.bin.
    _merge '{
        "initial": {
            "features": {"resolveEnabled": true},
            "ai": {
                "defaultBackend": "claude",
                "claude": {"bin": "/opt/claude", "configDir": "/etc/claude"},
                "codex":  {"bin": "/opt/codex"}
            }
        },
        "patch": {
            "ai": {
                "defaultBackend": "codex",
                "claude": {},
                "codex":  {}
            }
        }
    }'
    # All four original string values survive
    [ "$(printf '%s' "$output" | jq -r .onDisk.ai.claude.bin)"        = "/opt/claude" ]
    [ "$(printf '%s' "$output" | jq -r .onDisk.ai.claude.configDir)"  = "/etc/claude" ]
    [ "$(printf '%s' "$output" | jq -r .onDisk.ai.codex.bin)"         = "/opt/codex"  ]
    [ "$(printf '%s' "$output" | jq -r .onDisk.features.resolveEnabled)" = "true" ]
    # The one change we asked for applied
    [ "$(printf '%s' "$output" | jq -r .onDisk.ai.defaultBackend)"    = "codex"       ]
}

@test "explicit features toggle overrides current" {
    _merge '{
        "initial": {"features": {"resolveEnabled": true}, "ai": {}},
        "patch":   {"features": {"resolveEnabled": false}}
    }'
    [ "$(printf '%s' "$output" | jq -r .onDisk.features.resolveEnabled)" = "false" ]
}

@test "null and empty patches do nothing" {
    _merge '{
        "initial": {"features": {"resolveEnabled": true}, "ai": {"defaultBackend": "claude"}},
        "patch":   {}
    }'
    [ "$(printf '%s' "$output" | jq -r .onDisk.features.resolveEnabled)" = "true" ]
    [ "$(printf '%s' "$output" | jq -r .onDisk.ai.defaultBackend)"       = "claude" ]
}

@test "writing creates the config file when it doesn't exist yet" {
    [ ! -f "$SWCTL_CONFIG_FILE" ]
    _merge '{
        "initial": null,
        "patch":   {"ai": {"defaultBackend": "codex"}}
    }'
    [ -f "$SWCTL_CONFIG_FILE" ]
    [ "$(jq -r .ai.defaultBackend "$SWCTL_CONFIG_FILE")" = "codex" ]
}
