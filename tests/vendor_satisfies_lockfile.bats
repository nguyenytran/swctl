#!/usr/bin/env bats

load test_helper

# Regression guard for `_vendor_satisfies_lockfile` — the cheap drift
# check that lets `bootstrap_dependencies` notice when the running
# container's `vendor/composer/installed.json` is out of sync with the
# worktree's `composer.lock`.
#
# Background (the 2026-05-15 incident): swctl's shared
# `vendor-base-<project>` Docker volume is populated once per machine
# on first need.  Trunk's composer.lock advances over time (e.g., when
# a Shopware/* PR bumps a package and merges).  Without a refresh
# signal, every new instance on that machine clones the stale volume
# and runs with the OLD vendor — breaking at runtime as soon as
# someone calls a class that only exists in the new package version
# (opensearch-php 2.3.1 had no `OpenSearch\HttpClient\GuzzleHttpClientFactory`;
# 2.6.0 does).
#
# v0.6.7 caught BRANCH-vs-trunk drift via the dry-run lock-error
# parser.  v0.6.8 wired it into QA mode for branches that bump deps.
# v0.6.10's `_vendor_satisfies_lockfile` closes the TRUNK-vs-cached-
# vendor gap by comparing package versions directly — no need for
# composer to boot, ~50 ms vs ~5-10 s for `composer install --dry-run`.
#
# Tests stub `run_app_command` so we can plug in canned filesystem
# states.  Each test sets up a temp dir with `composer.lock` +
# `vendor/composer/installed.json` shapes that the helper inspects.

setup() {
    SW_TMP="$(mktemp -d)"
    # Stub run_app_command to run the inner script in /bin/sh against
    # our $SW_TMP "container root".  The helper's command is the full
    # `[ -f composer.lock ] && [ -f vendor/.../installed.json ] && jq …`
    # script as a single string, executed in /var/www/html in production;
    # in tests we exec it in $SW_TMP with $SW_TMP as cwd.
    run_app_command() {
        # $1 = compose_project, $2 = command-as-string.  Ignore project.
        (cd "$SW_TMP" && /bin/sh -c "$2")
    }
    export -f run_app_command
    export SW_TMP
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# Helper: write composer.lock + installed.json with package versions.
# Args: pairs of "name=version".  composer.lock gets the LOCK list,
# installed.json gets the INSTALLED list.  In sync if both match.
_write_lock() {
    local arr="["
    local first=1
    for spec in "$@"; do
        local name="${spec%=*}" ver="${spec#*=}"
        [ "$first" = "0" ] && arr+=","
        arr+="{\"name\":\"$name\",\"version\":\"$ver\"}"
        first=0
    done
    arr+="]"
    mkdir -p "$SW_TMP"
    printf '{"packages":%s}\n' "$arr" > "$SW_TMP/composer.lock"
}

_write_installed() {
    local arr="["
    local first=1
    for spec in "$@"; do
        local name="${spec%=*}" ver="${spec#*=}"
        [ "$first" = "0" ] && arr+=","
        arr+="{\"name\":\"$name\",\"version\":\"$ver\"}"
        first=0
    done
    arr+="]"
    mkdir -p "$SW_TMP/vendor/composer"
    printf '{"packages":%s}\n' "$arr" > "$SW_TMP/vendor/composer/installed.json"
}

# ---------------------------------------------------------------------------
# Happy path: lockfile and installed.json have identical packages.
# Helper returns 0 → bootstrap_dependencies' "Reusing vendor" branch wins.
# ---------------------------------------------------------------------------

@test "_vendor_satisfies_lockfile: identical packages → 0 (vendor is in sync)" {
    _write_lock      "opensearch-project/opensearch-php=2.6.0" "symfony/cache=7.4.1"
    _write_installed "opensearch-project/opensearch-php=2.6.0" "symfony/cache=7.4.1"
    run _vendor_satisfies_lockfile "trunk-test"
    [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# The actual incident: lockfile bumped opensearch-php to 2.6.0 but
# the installed vendor still has 2.3.1 (stale cached volume).
# Helper MUST return 1 so the caller triggers composer install.
# ---------------------------------------------------------------------------

@test "_vendor_satisfies_lockfile: opensearch-php version mismatch (2.6.0 vs 2.3.1) → 1 (stale)" {
    _write_lock      "opensearch-project/opensearch-php=2.6.0" "symfony/cache=7.4.1"
    _write_installed "opensearch-project/opensearch-php=2.3.1" "symfony/cache=7.4.1"
    run _vendor_satisfies_lockfile "trunk-test"
    [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Package present in lock but missing from installed → 1 (stale).
# Real-world: composer.json adds a new dep that the cached vendor
# never saw.
# ---------------------------------------------------------------------------

@test "_vendor_satisfies_lockfile: package missing from installed.json → 1 (stale)" {
    _write_lock      "opensearch-project/opensearch-php=2.6.0" "symfony/cache=7.4.1"
    _write_installed "opensearch-project/opensearch-php=2.6.0"
    run _vendor_satisfies_lockfile "trunk-test"
    [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Package present in installed but missing from lock → 1 (stale).
# Real-world: composer.json removed a dep but the cached vendor still
# has the old package files.
# ---------------------------------------------------------------------------

@test "_vendor_satisfies_lockfile: extra package in installed.json → 1 (stale)" {
    _write_lock      "opensearch-project/opensearch-php=2.6.0"
    _write_installed "opensearch-project/opensearch-php=2.6.0" "removed/pkg=1.0.0"
    run _vendor_satisfies_lockfile "trunk-test"
    [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Comparison is order-independent (jq sorts by name).  Lockfile and
# installed.json don't have a guaranteed order, so the helper must
# sort before comparing.
# ---------------------------------------------------------------------------

@test "_vendor_satisfies_lockfile: order-independent comparison → 0 when contents match" {
    _write_lock      "alpha/one=1.0.0" "zulu/two=2.0.0"
    _write_installed "zulu/two=2.0.0"  "alpha/one=1.0.0"  # reversed order
    run _vendor_satisfies_lockfile "trunk-test"
    [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Defensive: missing composer.lock → 1 (be safe → bootstrap_dependencies
# will run a fresh composer install which produces the lock anyway).
# Without this check, jq would silently produce empty arrays which
# would compare equal → false positive "vendor is fine."
# ---------------------------------------------------------------------------

@test "_vendor_satisfies_lockfile: missing composer.lock → 1 (be safe)" {
    _write_installed "opensearch-project/opensearch-php=2.6.0"
    # No composer.lock written.
    run _vendor_satisfies_lockfile "trunk-test"
    [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Defensive: missing vendor/composer/installed.json → 1 (vendor is
# absent or broken; the earlier "shared volume empty" branch handles
# the bootstrap, but the helper still needs to be safe in isolation).
# ---------------------------------------------------------------------------

@test "_vendor_satisfies_lockfile: missing installed.json → 1 (be safe)" {
    _write_lock "opensearch-project/opensearch-php=2.6.0"
    # No installed.json written.
    run _vendor_satisfies_lockfile "trunk-test"
    [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Defensive: malformed installed.json → 1 (jq's stderr-suppressed
# parse returns empty, the [-n] non-empty test catches it).  Real-world
# trigger: vendor populated by a crashed cp -a, partial JSON written.
# ---------------------------------------------------------------------------

@test "_vendor_satisfies_lockfile: malformed installed.json → non-zero (be safe)" {
    _write_lock "opensearch-project/opensearch-php=2.6.0"
    mkdir -p "$SW_TMP/vendor/composer"
    printf '{ "packages": [ "BROKEN\n' > "$SW_TMP/vendor/composer/installed.json"
    run _vendor_satisfies_lockfile "trunk-test"
    # jq exits with its own code (5 for parse errors) when the JSON is
    # malformed.  set -e propagates that through the helper.  Semantics
    # for the caller are the same: any non-zero = "vendor doesn't match
    # the lockfile, run composer install."  Don't pin the exact code
    # since jq's error codes are subject to change.
    [ "$status" -ne 0 ]
}
