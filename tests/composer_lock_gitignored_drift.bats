#!/usr/bin/env bats

load test_helper

# Regression guard for `_composer_lock_drifted_from_trunk` (v0.6.21,
# 2026-05-17).
#
# Background: Shopware's composer.lock is gitignored.  Each worktree
# generates its own at create time, and over the lifetime of a feature
# branch the trunk lockfile can advance independently (someone bumps
# a dep on trunk; the existing worktree keeps its older lock).  The
# diff-based `pat_composer` regex in `count_changes` can't see this
# because the lockfile isn't tracked.
#
# Symptom (#6072 incident 2026-05-17 afternoon): branch with PHP-only
# changes gets COMPOSER_CHANGES=0 from count_changes, so
# `resolve_vendor_volume` picks the shared `vendor-base-trunk` (RO).
# `bootstrap_dependencies` then runs `_vendor_satisfies_lockfile` —
# sees the worktree lock's flysystem 3.34.0 vs vendor-base's flysystem
# 3.33.0 — tries `composer install` against the RO mount — fails with
# "Read-only file system" every retry.  STATUS=failed loop forever.
#
# Fix: hash worktree's composer.lock vs trunk's on-host composer.lock
# (the lock that vendor-base-* mirrors).  Differ → return 0.  Caller
# (`count_changes`) bumps COMPOSER_CHANGES so `resolve_vendor_volume`
# picks a per-instance writable `vendor-<issue>` volume, cloned from
# base, and composer install succeeds in-place.

setup() {
    SW_TMP="$(mktemp -d)"
    PROJECT_ROOT="$SW_TMP/trunk"
    WORKTREE_PATH="$SW_TMP/sw-6072"
    mkdir -p "$PROJECT_ROOT" "$WORKTREE_PATH"
    export SW_TMP PROJECT_ROOT WORKTREE_PATH
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# ---------------------------------------------------------------------------
# Drift: worktree's composer.lock is different from trunk's.  This is the
# #6072 case — branch generated a newer lock at create time, trunk drifted
# under it (or vice versa).  Must return 0.
# ---------------------------------------------------------------------------

@test "_composer_lock_drifted_from_trunk: lock contents differ → drift detected" {
    printf '{"_readme":["trunk lock"],"content-hash":"aaa"}\n' > "$PROJECT_ROOT/composer.lock"
    printf '{"_readme":["worktree lock"],"content-hash":"bbb"}\n' > "$WORKTREE_PATH/composer.lock"
    run _composer_lock_drifted_from_trunk
    [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# No drift: locks are byte-identical.  Don't bump COMPOSER_CHANGES — the
# shared vendor-base-* volume is correct for this worktree.
# ---------------------------------------------------------------------------

@test "_composer_lock_drifted_from_trunk: identical lock files → no drift" {
    printf '{"_readme":["same"],"content-hash":"zzz"}\n' > "$PROJECT_ROOT/composer.lock"
    cp "$PROJECT_ROOT/composer.lock" "$WORKTREE_PATH/composer.lock"
    run _composer_lock_drifted_from_trunk
    [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Worktree lock missing: brand-new create before composer install ran.
# Return 1 (no drift) — caller falls through to legacy COMPOSER_CHANGES=0
# path and the populator handles the initial vendor seed.
# ---------------------------------------------------------------------------

@test "_composer_lock_drifted_from_trunk: missing worktree lock → no drift" {
    printf '{"_readme":["trunk lock"],"content-hash":"aaa"}\n' > "$PROJECT_ROOT/composer.lock"
    # No $WORKTREE_PATH/composer.lock.
    run _composer_lock_drifted_from_trunk
    [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Trunk lock missing: project doesn't use composer (template project,
# pure-config repo, etc.) or fresh clone before composer install.
# Return 1 (no drift) — same legacy path.
# ---------------------------------------------------------------------------

@test "_composer_lock_drifted_from_trunk: missing trunk lock → no drift" {
    printf '{"_readme":["worktree lock"],"content-hash":"bbb"}\n' > "$WORKTREE_PATH/composer.lock"
    run _composer_lock_drifted_from_trunk
    [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Refresh on TRUNK itself (WORKTREE_PATH == PROJECT_ROOT): there's no
# worktree, no concept of drift.  Must not false-positive — would force
# COMPOSER_CHANGES=1 on every trunk refresh otherwise.
# ---------------------------------------------------------------------------

@test "_composer_lock_drifted_from_trunk: WORKTREE_PATH == PROJECT_ROOT → no drift" {
    printf '{"_readme":["trunk lock"],"content-hash":"aaa"}\n' > "$PROJECT_ROOT/composer.lock"
    WORKTREE_PATH="$PROJECT_ROOT"
    export WORKTREE_PATH
    run _composer_lock_drifted_from_trunk
    [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# WORKTREE_PATH unset (cmd_create path before worktree exists): must not
# false-positive.  count_changes gets called in cmd_create too — the
# helper has to stay quiet there.
# ---------------------------------------------------------------------------

@test "_composer_lock_drifted_from_trunk: WORKTREE_PATH unset → no drift" {
    printf '{"_readme":["trunk lock"],"content-hash":"aaa"}\n' > "$PROJECT_ROOT/composer.lock"
    unset WORKTREE_PATH
    run _composer_lock_drifted_from_trunk
    [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# End-to-end: count_changes bumps COMPOSER_CHANGES when lockfile drifts,
# even though the diff has zero composer-file changes.  This is the
# #6072-specific assertion — PHP-only branch + drifted lock = forced
# dedicated vendor volume routing.
# ---------------------------------------------------------------------------

@test "count_changes: drifted lock + PHP-only diff → COMPOSER_CHANGES bumped" {
    printf '{"_readme":["trunk"],"content-hash":"aaa"}\n' > "$PROJECT_ROOT/composer.lock"
    printf '{"_readme":["worktree"],"content-hash":"bbb"}\n' > "$WORKTREE_PATH/composer.lock"
    # PHP-only diff (no composer.json/composer.lock).  Without the v0.6.21
    # bump, COMPOSER_CHANGES would be 0 here — and that's the bug.
    diff_files="src/Core/Content/Product/SalesChannel/Listing/Processor/SortingListingProcessor.php"
    count_changes "$diff_files"
    [ "$COMPOSER_CHANGES" -ge 1 ]
}

# ---------------------------------------------------------------------------
# Negative end-to-end: no drift → count_changes leaves COMPOSER_CHANGES=0
# for a PHP-only diff.  Prevents accidentally always-bumping (which would
# defeat the shared-vendor-base optimization on every refresh).
# ---------------------------------------------------------------------------

@test "count_changes: identical locks + PHP-only diff → COMPOSER_CHANGES stays 0" {
    printf '{"_readme":["same"],"content-hash":"zzz"}\n' > "$PROJECT_ROOT/composer.lock"
    cp "$PROJECT_ROOT/composer.lock" "$WORKTREE_PATH/composer.lock"
    diff_files="src/Core/Content/Product/SalesChannel/Listing/Processor/SortingListingProcessor.php"
    count_changes "$diff_files"
    [ "$COMPOSER_CHANGES" -eq 0 ]
}
