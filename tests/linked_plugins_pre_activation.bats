#!/usr/bin/env bats

load test_helper

# Coverage for PR #33: _pre_activate_linked_plugins runs plugin:refresh
# + plugin:install --activate --no-refresh for each LINKED_PLUGINS member
# BEFORE workflow hooks fire any bin/console.
#
# Why we test this:
# Without the pre-activation, multi-plugin platform creates fail at
# workflow-hook time with "non-existent service ..." because the cloned
# DB's plugin records reference filesystem paths that haven't been
# re-registered against the worktree's tree.  The bug we hit on
# instances 10833 + 2361 was a downstream symptom of this missing
# pre-activation step.
#
# Tests stub `run_app_command` so we can verify the right commands are
# called in the right order without actually starting a container.

setup() {
    SW_TMP="$(mktemp -d)"
    SW_BIN_CONSOLE="bin/console"
    export SW_TMP SW_BIN_CONSOLE

    # Stubs.  These shadow swctl's real implementations.
    run_app_command() {
        printf 'run_app_command compose=%s cmd=%s\n' "$1" "$2" >> "$SW_TMP/calls.log"
        return 0
    }
    info() { :; }
    warn() { printf 'warn: %s\n' "$*" >> "$SW_TMP/calls.log"; }
    export -f run_app_command info warn
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# ---------------------------------------------------------------------------
# No-op when LINKED_PLUGINS is empty
# ---------------------------------------------------------------------------

@test "LINKED_PLUGINS unset → no run_app_command calls (vanilla create)" {
    unset LINKED_PLUGINS
    run _pre_activate_linked_plugins "trunk-9999"
    [ "$status" -eq 0 ]
    [ ! -f "$SW_TMP/calls.log" ] || [ ! -s "$SW_TMP/calls.log" ]
}

@test "LINKED_PLUGINS empty string → no run_app_command calls" {
    LINKED_PLUGINS=""
    run _pre_activate_linked_plugins "trunk-9999"
    [ "$status" -eq 0 ]
    [ ! -f "$SW_TMP/calls.log" ] || [ ! -s "$SW_TMP/calls.log" ]
}

# ---------------------------------------------------------------------------
# Single plugin: refresh first, then activate
# ---------------------------------------------------------------------------

@test "single LINKED_PLUGINS: plugin:refresh runs FIRST, then plugin:install --activate" {
    LINKED_PLUGINS="SwagCommercial"
    export LINKED_PLUGINS

    run _pre_activate_linked_plugins "trunk-9999"
    [ "$status" -eq 0 ]

    # plugin:refresh must be the first run_app_command call (so the plugin
    # table reflects worktree filesystem paths before activate)
    local first_cmd second_cmd
    first_cmd="$(grep '^run_app_command' "$SW_TMP/calls.log" | sed -n '1p')"
    second_cmd="$(grep '^run_app_command' "$SW_TMP/calls.log" | sed -n '2p')"

    [[ "$first_cmd"  == *"plugin:refresh"* ]]
    [[ "$second_cmd" == *"plugin:install --activate --no-refresh SwagCommercial"* ]]

    # And only those two calls — no spurious extras
    [ "$(grep -c '^run_app_command' "$SW_TMP/calls.log")" = "2" ]
}

@test "single LINKED_PLUGINS: --no-refresh used to avoid redundant scan" {
    LINKED_PLUGINS="SwagCommercial"
    export LINKED_PLUGINS

    run _pre_activate_linked_plugins "trunk-9999"
    [ "$status" -eq 0 ]

    # The activate call must include --no-refresh (we already refreshed)
    grep -q -- '--no-refresh SwagCommercial' "$SW_TMP/calls.log"
}

# ---------------------------------------------------------------------------
# Multiple plugins: one refresh, then one activate per plugin in order
# ---------------------------------------------------------------------------

@test "multiple LINKED_PLUGINS: refresh once, activate each in declared order" {
    LINKED_PLUGINS="SwagCommercial,SwagCustomizedProducts,SwagFoo"
    export LINKED_PLUGINS

    run _pre_activate_linked_plugins "trunk-9999"
    [ "$status" -eq 0 ]

    local lines
    lines="$(grep '^run_app_command' "$SW_TMP/calls.log")"

    # Total = 1 refresh + 3 activates
    [ "$(echo "$lines" | wc -l | tr -d ' ')" = "4" ]

    # Order: refresh, then SwagCommercial, then SwagCustomizedProducts, then SwagFoo
    echo "$lines" | sed -n '1p' | grep -q "plugin:refresh"
    echo "$lines" | sed -n '2p' | grep -q "plugin:install --activate --no-refresh SwagCommercial"
    echo "$lines" | sed -n '3p' | grep -q "plugin:install --activate --no-refresh SwagCustomizedProducts"
    echo "$lines" | sed -n '4p' | grep -q "plugin:install --activate --no-refresh SwagFoo"
}

# ---------------------------------------------------------------------------
# Edge case: trailing/leading commas, whitespace
# ---------------------------------------------------------------------------

@test "LINKED_PLUGINS with empty entries (trailing/leading comma): skipped, no spurious calls" {
    LINKED_PLUGINS=",SwagCommercial,,SwagFoo,"
    export LINKED_PLUGINS

    run _pre_activate_linked_plugins "trunk-9999"
    [ "$status" -eq 0 ]

    # Should produce: 1 refresh + 2 valid activates (SwagCommercial, SwagFoo)
    [ "$(grep -c '^run_app_command' "$SW_TMP/calls.log")" = "3" ]
    grep -q "plugin:install --activate --no-refresh SwagCommercial" "$SW_TMP/calls.log"
    grep -q "plugin:install --activate --no-refresh SwagFoo" "$SW_TMP/calls.log"
}

# ---------------------------------------------------------------------------
# Failure-tolerance: refresh fails → warn, but continue activating each plugin.
# Activation failure → warn, but continue with the next plugin.
# ---------------------------------------------------------------------------

@test "plugin:refresh failure does not abort — activation continues" {
    LINKED_PLUGINS="SwagCommercial,SwagFoo"
    export LINKED_PLUGINS

    # Override stub: make refresh return non-zero
    run_app_command() {
        printf 'run_app_command compose=%s cmd=%s\n' "$1" "$2" >> "$SW_TMP/calls.log"
        case "$2" in
            *plugin:refresh*) return 1 ;;
            *) return 0 ;;
        esac
    }
    export -f run_app_command

    run _pre_activate_linked_plugins "trunk-9999"
    [ "$status" -eq 0 ]

    # All 3 calls (1 refresh attempt + 2 activates) must have run
    [ "$(grep -c '^run_app_command' "$SW_TMP/calls.log")" = "3" ]
    # And the refresh failure was warned about
    grep -q "warn:.*plugin:refresh failed" "$SW_TMP/calls.log"
}

@test "plugin:install failure for one plugin does not skip subsequent plugins" {
    LINKED_PLUGINS="SwagBroken,SwagCommercial,SwagFoo"
    export LINKED_PLUGINS

    # Override stub: make SwagBroken's activate fail
    run_app_command() {
        printf 'run_app_command compose=%s cmd=%s\n' "$1" "$2" >> "$SW_TMP/calls.log"
        case "$2" in
            *plugin:install*SwagBroken*) return 1 ;;
            *) return 0 ;;
        esac
    }
    export -f run_app_command

    run _pre_activate_linked_plugins "trunk-9999"
    [ "$status" -eq 0 ]

    # All 4 calls ran (1 refresh + 3 attempts)
    [ "$(grep -c '^run_app_command' "$SW_TMP/calls.log")" = "4" ]
    # SwagBroken failure warned
    grep -q "warn:.*Failed to pre-activate 'SwagBroken'" "$SW_TMP/calls.log"
    # Subsequent plugins still attempted
    grep -q "plugin:install --activate --no-refresh SwagCommercial" "$SW_TMP/calls.log"
    grep -q "plugin:install --activate --no-refresh SwagFoo" "$SW_TMP/calls.log"
}

# ---------------------------------------------------------------------------
# IFS hygiene: the helper splits on ',' but must restore IFS on exit so it
# doesn't leak into the caller's shell state.
# ---------------------------------------------------------------------------

@test "IFS is preserved across the call (no leak from the comma-split loop)" {
    LINKED_PLUGINS="SwagFoo"
    export LINKED_PLUGINS

    local _saved_ifs="$IFS"
    _pre_activate_linked_plugins "trunk-9999"
    [ "$IFS" = "$_saved_ifs" ]
}
