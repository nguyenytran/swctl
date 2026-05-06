#!/usr/bin/env bats

load test_helper

# Regression guard for the v0.6.0 bug:
#
#   /opt/homebrew/Cellar/swctl/0.6.0/libexec/swctl: line 1210:
#   SW_DB_HOST: unbound variable
#
# `swctl init` on a fresh machine (no .swctl.conf in the cwd tree) hit
# this when init_infra finished bringing up swctl-mariadb and called
# wait_for_mysql, whose ok-message references ${SW_DB_HOST}.  init_infra
# defaulted SW_DB_PORT but NOT SW_DB_HOST, so under `set -u` the var
# expansion died.
#
# Fix: init_infra now defaults SW_DB_HOST to 127.0.0.1 alongside the
# other SW_* vars it sets.  Test verifies wait_for_mysql can render its
# success log without an unbound var, even when no project config has
# been loaded.

setup() {
    # Drop any inherited SW_* state from the test harness or the user's
    # env so we're testing the fresh-machine condition, not "happens to
    # have it set".
    unset SW_DB_HOST SW_DB_PORT SW_DB_ROOT_USER SW_DB_ROOT_PASSWORD || true

    # Stub mysql_exec so wait_for_mysql's first SELECT succeeds.  No
    # docker, no actual mariadb — we're testing the unbound-var path.
    mysql_exec() { return 0; }
    export -f mysql_exec
}

@test "wait_for_mysql succeeds without an unbound-var crash when SW_DB_HOST is unset" {
    # Init defaults — same lines init_infra sets, minus the ones we're
    # testing the absence of.
    SW_DB_PORT="${SW_DB_PORT:-3306}"

    # The bug: this line in wait_for_mysql blows up when SW_DB_HOST is
    # not set (set -u, unbound variable).  After the fix, init_infra
    # defaults SW_DB_HOST so wait_for_mysql can render its log line.
    SW_DB_HOST="${SW_DB_HOST:-127.0.0.1}"   # mirror init_infra's new default

    run wait_for_mysql
    [ "$status" -eq 0 ]
    [[ "$output" == *"MariaDB is reachable on 127.0.0.1:3306"* ]]
}

@test "init_infra body sets SW_DB_HOST default before any reference" {
    # Structural pin — assert init_infra contains a line defaulting
    # SW_DB_HOST.  This catches a future refactor that deletes the
    # default without restoring it some other way.
    local swctl="$BATS_TEST_DIRNAME/../swctl"
    [ -f "$swctl" ]

    # init_infra body: from the function header to the matching closing brace
    local body
    body="$(awk '
        /^init_infra\(\) \{/ { in_fn = 1 }
        in_fn                { print }
        in_fn && /^\}/       { exit }
    ' "$swctl")"

    [ -n "$body" ] || {
        echo "could not locate init_infra in $swctl"
        return 1
    }

    # Must contain a SW_DB_HOST default.  We don't pin the exact value —
    # 127.0.0.1, host.docker.internal, swctl-mariadb are all defensible
    # and a future maintainer might pick any.
    if ! echo "$body" | grep -qE 'SW_DB_HOST="\$\{SW_DB_HOST:-'; then
        echo "FAIL: init_infra is missing a SW_DB_HOST default."
        echo "Without it, swctl init crashes on fresh machines that"
        echo "don't yet have a project's .swctl.conf to source."
        echo "Add: SW_DB_HOST=\"\${SW_DB_HOST:-127.0.0.1}\""
        return 1
    fi
}
