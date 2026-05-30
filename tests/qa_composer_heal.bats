#!/usr/bin/env bats

# Regression guard for the QA-mode composer-heal trigger
# (workflows/shopware6/hooks/provision.sh, 2026-05-12).
#
# Background: before this fix, the provision hook's QA-mode branch
# explicitly returned BEFORE calling `_swctl_bootstrap_dependencies`,
# under the assumption "QA mode reuses trunk's vendor — no composer
# work needed."  When the branch's composer.json bumps a package
# constraint trunk's vendor doesn't satisfy (e.g. opensearch-php
# ^2.3.1 → ^2.6.0 on PR shopware/shopware#16496), the dedicated
# vendor volume is cloned from the stale shared base, never runs
# composer install, and at runtime PHP throws ClassNotFoundError on
# the new classes (GuzzleHttpClientFactory, Psr17FactoryDiscovery).
# This rendered v0.6.7's lock-drift parser dead code in the most
# important path — QA-mode creates of search-stack PRs.
#
# Fix: gate the early-return on `COMPOSER_CHANGES == 0`.  When
# `COMPOSER_CHANGES > 0`, run bootstrap_dependencies so the drift
# parser fires and `composer update <pkgs> --with-dependencies`
# heals the vendor.
#
# Decision matrix locked down here:
#
#   COMPOSER_CHANGES | bootstrap_dependencies invoked in QA mode?
#   -----------------|-------------------------------------------
#         0          | NO  (legacy fast path)
#         > 0        | YES (drift heal)
#         unset      | NO  (treated as 0 — never seen in practice,
#                          but the ${VAR:-0} default makes the
#                          contract explicit)
#
# The provision.sh hook expects to be SOURCED with several globals
# already set by the parent swctl process; we mock the bits we need.

setup() {
    SW_TMP="$(mktemp -d)"
    HOOK="$BATS_TEST_DIRNAME/../workflows/shopware6/hooks/provision.sh"
    [ -f "$HOOK" ] || { echo "missing hook: $HOOK"; return 1; }

    # Minimum env the hook reads.
    SWCTL_MODE="qa"
    COMPOSE_PROJECT="trunk-test"
    WORKFLOW_CONSOLE="console"
    APP_URL="http://web.test.orb.local"
    DB_NAME="shopware_test"
    DB_STATE="cloned"
    MIGRATION_CHANGES=0
    ENTITY_CHANGES=0
    ADMIN_CHANGES=0
    STOREFRONT_CHANGES=0
    PACKAGE_CHANGES=0
    BACKEND_CHANGES=0
    FRONTEND_CHANGES=0
    SW_INSTALL_ARGS=""
    SW_SHARED_DB_INSTALL_ARGS=""
    SW_DB_SHARED_NAME="shopware"

    # Record every helper invocation so tests can assert exactly which
    # bootstrap steps fired.  Each stub appends a marker to $CALL_LOG.
    CALL_LOG="$SW_TMP/calls.log"
    : > "$CALL_LOG"

    _swctl_bootstrap_dependencies() { printf 'bootstrap_dependencies %s\n' "$1" >> "$CALL_LOG"; }
    _swctl_update_sales_channel_domain() { printf 'update_sales_channel %s %s\n' "$1" "$2" >> "$CALL_LOG"; }
    _swctl_ensure_install_lock() { printf 'ensure_install_lock %s\n' "$1" >> "$CALL_LOG"; }
    run_app_command() { printf 'run_app_command %s | %s\n' "$1" "$2" >> "$CALL_LOG"; }
    info() { :; }
    warn() { :; }
    ok()   { :; }
    sanitize_db_identifier() { printf '%s' "$1"; }
    mysql_db_has_tables() { return 0; }
    clone_database() { :; }
    export -f _swctl_bootstrap_dependencies _swctl_update_sales_channel_domain \
              _swctl_ensure_install_lock run_app_command info warn ok \
              sanitize_db_identifier mysql_db_has_tables clone_database

    export SW_TMP HOOK SWCTL_MODE COMPOSE_PROJECT WORKFLOW_CONSOLE APP_URL \
           DB_NAME DB_STATE MIGRATION_CHANGES ENTITY_CHANGES ADMIN_CHANGES \
           STOREFRONT_CHANGES PACKAGE_CHANGES BACKEND_CHANGES FRONTEND_CHANGES \
           SW_INSTALL_ARGS SW_SHARED_DB_INSTALL_ARGS SW_DB_SHARED_NAME CALL_LOG
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# ---------------------------------------------------------------------------
# COMPOSER_CHANGES > 0 → bootstrap_dependencies MUST run.
# This is the search-stack PR scenario (#16496, #15629).
# ---------------------------------------------------------------------------

@test "QA mode + COMPOSER_CHANGES > 0 → bootstrap_dependencies fires" {
    COMPOSER_CHANGES=48   # the actual count from #15629 create
    export COMPOSER_CHANGES
    bash "$HOOK"
    grep -q '^bootstrap_dependencies trunk-test$' "$CALL_LOG"
}

# Multiple non-trivial counts — same expectation.
@test "QA mode + COMPOSER_CHANGES = 1 → bootstrap_dependencies fires" {
    COMPOSER_CHANGES=1
    export COMPOSER_CHANGES
    bash "$HOOK"
    grep -q '^bootstrap_dependencies trunk-test$' "$CALL_LOG"
}

# ---------------------------------------------------------------------------
# v0.6.10 change: bootstrap_dependencies now runs UNCONDITIONALLY in
# QA mode, not only when COMPOSER_CHANGES > 0.  Reason: a teammate's
# `vendor-base-<project>` Docker volume can be stale even when the
# branch matches trunk (e.g., volume populated 3 weeks ago, trunk's
# opensearch-php bumped 2 weeks ago, branch synced today — diff is
# zero, but the cached vendor still has the old package).  The
# `_vendor_satisfies_lockfile` jq check inside bootstrap_dependencies
# is ~50 ms — cheap enough to run every time.
# ---------------------------------------------------------------------------

@test "QA mode + COMPOSER_CHANGES = 0 → bootstrap_dependencies STILL fires (v0.6.10 stale-vendor guard)" {
    COMPOSER_CHANGES=0
    export COMPOSER_CHANGES
    bash "$HOOK"
    grep -q '^bootstrap_dependencies trunk-test$' "$CALL_LOG"
}

# ---------------------------------------------------------------------------
# COMPOSER_CHANGES unset (legacy callers) — bootstrap still runs.
# The hook no longer needs the ${VAR:-0} guard for this var, but
# leaving the test guards against a regression where some path forgot
# to export COMPOSER_CHANGES at all.
# ---------------------------------------------------------------------------

@test "QA mode + COMPOSER_CHANGES unset → bootstrap_dependencies still fires (no crash)" {
    unset COMPOSER_CHANGES
    bash "$HOOK"
    grep -q '^bootstrap_dependencies trunk-test$' "$CALL_LOG"
}

# ---------------------------------------------------------------------------
# Dev mode: bootstrap_dependencies ALWAYS runs (unchanged behaviour).
# This existed before the fix; pin it so a future refactor of the
# QA-mode block can't accidentally regress the dev-mode contract.
# ---------------------------------------------------------------------------

@test "Dev mode → bootstrap_dependencies fires regardless of COMPOSER_CHANGES" {
    SWCTL_MODE="dev"
    COMPOSER_CHANGES=0
    export SWCTL_MODE COMPOSER_CHANGES
    bash "$HOOK"
    grep -q '^bootstrap_dependencies trunk-test$' "$CALL_LOG"
}

# ---------------------------------------------------------------------------
# QA-mode flow ordering: composer heal runs BEFORE migrations.  The
# migration command needs the dedicated vendor to be installed first
# (database:migrate-destructive depends on entity classes), so the
# order matters — assert it explicitly.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# v0.6.11 regression guard: when bootstrap_dependencies fails (e.g., a
# transient docker exec error under parallel load), the rest of the
# provision flow — most critically `_swctl_ensure_install_lock` — MUST
# still run.  Before this guard, `set -euo pipefail` would propagate the
# bootstrap error and kill the hook; the instance ended up with a fully-
# cloned DB but no install.lock, so the storefront redirected to
# /installer forever (#15504/#6345 incident on 2026-05-15).
# ---------------------------------------------------------------------------

@test "QA mode: bootstrap_dependencies failure does NOT prevent ensure_install_lock" {
    COMPOSER_CHANGES=0
    export COMPOSER_CHANGES
    # Make bootstrap intentionally fail to simulate the parallel-load
    # docker-exec-timeout case we observed.
    _swctl_bootstrap_dependencies() {
        printf 'bootstrap_dependencies %s [FAILED]\n' "$1" >> "$CALL_LOG"
        return 1
    }
    export -f _swctl_bootstrap_dependencies

    bash "$HOOK"

    # Bootstrap ran and failed — recorded for visibility.
    grep -q '^bootstrap_dependencies trunk-test \[FAILED\]$' "$CALL_LOG"

    # But the post-bootstrap steps still ran.  Without the `|| warn`
    # guards added in v0.6.11+v0.6.12, these would be absent and the
    # storefront would be stuck at /installer.
    grep -q '^update_sales_channel trunk-test' "$CALL_LOG"
    grep -q '^ensure_install_lock trunk-test$' "$CALL_LOG"
    # And the final cache:clear fired
    grep -q 'cache:clear' "$CALL_LOG"
}

# ---------------------------------------------------------------------------
# v0.6.12 regression guard: install.lock MUST be written FIRST in QA mode,
# before bootstrap_dependencies / migrations / update_sales_channel_domain.
# Reason: those later steps can fail under parallel-batch docker contention.
# install.lock has no upstream dependency — the QA-mode DB is clone-from-
# installed, so writing the file marker as the first act guarantees the
# storefront NEVER ends up redirecting to /installer just because a later
# step fell over.  Original incident: #15504/#6345/#5393/#6304 all
# provisioned with fully-cloned DBs but no install.lock because a
# downstream step's failure propagated through `set -euo pipefail`.
# ---------------------------------------------------------------------------

@test "QA-mode flow: ensure_install_lock runs BEFORE bootstrap_dependencies" {
    COMPOSER_CHANGES=0
    export COMPOSER_CHANGES
    bash "$HOOK"

    local lock_line boot_line
    lock_line=$(grep -n '^ensure_install_lock trunk-test$'  "$CALL_LOG" | head -1 | cut -d: -f1)
    boot_line=$(grep -n '^bootstrap_dependencies trunk-test$' "$CALL_LOG" | head -1 | cut -d: -f1)
    [ -n "$lock_line" ]
    [ -n "$boot_line" ]
    [ "$lock_line" -lt "$boot_line" ]
}

# ---------------------------------------------------------------------------
# v0.6.12 regression guard: ALL downstream QA-mode steps are best-effort.
# Specifically tests that `update_sales_channel_domain` failure doesn't
# bypass subsequent cache:clear.  Before v0.6.12, sales-channel-domain
# was unguarded — its failure (e.g., container DB connection blip)
# would set -e the script before cache:clear could run.
# ---------------------------------------------------------------------------

@test "QA mode: update_sales_channel_domain failure does NOT prevent cache:clear" {
    COMPOSER_CHANGES=0
    export COMPOSER_CHANGES
    _swctl_update_sales_channel_domain() {
        printf 'update_sales_channel %s %s [FAILED]\n' "$1" "$2" >> "$CALL_LOG"
        return 1
    }
    export -f _swctl_update_sales_channel_domain

    bash "$HOOK"

    grep -q '\[FAILED\]' "$CALL_LOG"            # the failure was recorded
    grep -q 'cache:clear' "$CALL_LOG"           # cache:clear still ran
}

@test "QA-mode flow: bootstrap_dependencies runs BEFORE migrations" {
    COMPOSER_CHANGES=5
    MIGRATION_CHANGES=2
    export COMPOSER_CHANGES MIGRATION_CHANGES
    bash "$HOOK"

    local boot_line migrate_line
    boot_line=$(grep -n '^bootstrap_dependencies'           "$CALL_LOG" | head -1 | cut -d: -f1)
    migrate_line=$(grep -n 'database:migrate'               "$CALL_LOG" | head -1 | cut -d: -f1)
    [ -n "$boot_line" ]
    [ -n "$migrate_line" ]
    [ "$boot_line" -lt "$migrate_line" ]
}
