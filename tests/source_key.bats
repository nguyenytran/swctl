#!/usr/bin/env bats

load test_helper

# Regression guard for `_compute_source_key` (v0.6.16) — the helper
# that hashes the host's lockfile so `_ensure_base_volume_populated`
# can detect when its cached vendor / node_modules volume is stale.
#
# Background (the 2026-05-15 incident on a teammate's machine): the
# shared `vendor-base-<project>` docker volume is populated once per
# machine on first need.  Trunk's composer.lock advances over time
# (e.g., when a Shopware/* PR bumps a package and merges).  Before
# v0.6.16 there was no signal to invalidate the cached volume; every
# new instance cloned the OLD vendor.  v0.6.10 added a heal step
# (composer install inside the container) — but that fails on shared
# volumes mounted read-only.  v0.6.16's content-key check refreshes
# the BASE volume itself BEFORE the container starts, so the next
# instance sees fresh vendor without needing composer install at all.
#
# The hash function uses shasum / sha256sum (whichever is available).
# Tests pin: the key changes when the source lockfile changes, and is
# stable when the lockfile is unchanged.

setup() {
    SW_TMP="$(mktemp -d)"
    export SW_TMP
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# ---------------------------------------------------------------------------
# Vendor: composer.lock at the project root (one level up from vendor/)
# ---------------------------------------------------------------------------

@test "_compute_source_key vendor: stable hash for identical composer.lock" {
    mkdir -p "$SW_TMP/proj/vendor"
    echo '{"packages":[{"name":"x/y","version":"1.0.0"}]}' > "$SW_TMP/proj/composer.lock"
    local key1 key2
    key1="$(_compute_source_key "$SW_TMP/proj/vendor" vendor)"
    key2="$(_compute_source_key "$SW_TMP/proj/vendor" vendor)"
    [ -n "$key1" ]
    [ "$key1" = "$key2" ]
}

@test "_compute_source_key vendor: hash CHANGES when composer.lock changes" {
    mkdir -p "$SW_TMP/proj/vendor"
    echo '{"packages":[{"name":"x/y","version":"1.0.0"}]}' > "$SW_TMP/proj/composer.lock"
    local key_old key_new
    key_old="$(_compute_source_key "$SW_TMP/proj/vendor" vendor)"

    # Simulate the opensearch-php 2.3.1 → 2.6.0 bump.
    echo '{"packages":[{"name":"x/y","version":"2.0.0"}]}' > "$SW_TMP/proj/composer.lock"
    key_new="$(_compute_source_key "$SW_TMP/proj/vendor" vendor)"

    [ -n "$key_old" ]
    [ -n "$key_new" ]
    [ "$key_old" != "$key_new" ]
}

@test "_compute_source_key vendor: empty output when composer.lock is missing" {
    mkdir -p "$SW_TMP/proj/vendor"
    # No composer.lock written.
    local key
    key="$(_compute_source_key "$SW_TMP/proj/vendor" vendor)"
    [ -z "$key" ]
}

# ---------------------------------------------------------------------------
# Node modules: .package-lock.json INSIDE node_modules (reflects what
# npm last installed); falls back to ../package-lock.json (source of
# truth for next install).
# ---------------------------------------------------------------------------

@test "_compute_source_key node_modules: prefers .package-lock.json inside the dir" {
    mkdir -p "$SW_TMP/app/node_modules"
    echo '{"lockfileVersion":3,"packages":{"left":{}}}' > "$SW_TMP/app/node_modules/.package-lock.json"
    # Different content in the parent — helper should pick INSIDE first.
    echo '{"lockfileVersion":3,"packages":{"right":{}}}' > "$SW_TMP/app/package-lock.json"

    local key inner_hash
    key="$(_compute_source_key "$SW_TMP/app/node_modules" node_modules)"
    inner_hash="$(shasum -a 256 "$SW_TMP/app/node_modules/.package-lock.json" | awk '{print $1}')"
    [ "$key" = "$inner_hash" ]
}

@test "_compute_source_key node_modules: falls back to parent package-lock.json" {
    mkdir -p "$SW_TMP/app/node_modules"
    # No .package-lock.json inside — only the parent's.
    echo '{"lockfileVersion":3,"packages":{"a":{}}}' > "$SW_TMP/app/package-lock.json"
    local key
    key="$(_compute_source_key "$SW_TMP/app/node_modules" node_modules)"
    [ -n "$key" ]
}

@test "_compute_source_key node_modules: empty when neither file exists" {
    mkdir -p "$SW_TMP/app/node_modules"
    local key
    key="$(_compute_source_key "$SW_TMP/app/node_modules" node_modules)"
    [ -z "$key" ]
}

# ---------------------------------------------------------------------------
# Unknown kind → empty.  Defensive against typos in caller.
# ---------------------------------------------------------------------------

@test "_compute_source_key: unknown kind returns empty" {
    mkdir -p "$SW_TMP/proj/vendor"
    echo '{"packages":[]}' > "$SW_TMP/proj/composer.lock"
    local key
    key="$(_compute_source_key "$SW_TMP/proj/vendor" notarealkind)"
    [ -z "$key" ]
}
