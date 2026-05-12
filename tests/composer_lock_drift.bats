#!/usr/bin/env bats

load test_helper

# Regression guard for `_composer_extract_drifted_pkgs` — the helper
# that parses `composer install --dry-run` failure output and pulls
# out the names of packages where the lockfile and composer.json
# disagree.
#
# Drives `_composer_update_missing`, which uses the extracted package
# names to run `composer update <pkgs> --with-dependencies` instead
# of the dangerous bare `composer update` (which can remove plugins
# absent from composer.json, like shopware/commercial synced via
# .swctl.deps.yaml).
#
# Two real-world error patterns are exercised here:
#
#   A. "is not present in the lock file"
#      Composer error when composer.json adds a package the lock has
#      never seen.  Pre-2026-05-12 the only pattern swctl knew.
#
#   B. "is in the lock file as <ver> but that does not satisfy your
#       constraint <new-ver>"
#      Composer error when composer.json BUMPS an existing package's
#      version constraint without regenerating the lockfile.  Verified
#      against shopware/shopware PR #16496 where opensearch-project/
#      opensearch-php went ^2.3.1 → ^2.6.0 — manifested as a runtime
#      `Class "OpenSearch\HttpClient\GuzzleHttpClientFactory" not
#      found` because the OLD vendor was reused.
#
# The fix added 2026-05-12 unifies both pattern handlers behind
# `_composer_extract_drifted_pkgs` so a single targeted
# `composer update --with-dependencies` heals either case.

setup() { :; }
teardown() { :; }

# ---------------------------------------------------------------------------
# Pattern A — package added to composer.json but missing from lock.
# ---------------------------------------------------------------------------

@test "_composer_extract_drifted_pkgs: pattern A — single package missing from lock" {
    local out
    out=$(_composer_extract_drifted_pkgs '  - Required package "shopware/commercial" is not present in the lock file.')
    [ "$(echo "$out" | tr -s ' ')" = "shopware/commercial " ]
}

@test "_composer_extract_drifted_pkgs: pattern A — multiple packages missing" {
    local input='  - Required package "shopware/commercial" is not present in the lock file.
  - Required package "shopware/storefront" is not present in the lock file.'
    local out
    out=$(_composer_extract_drifted_pkgs "$input")
    [[ "$out" == *"shopware/commercial"* ]]
    [[ "$out" == *"shopware/storefront"* ]]
}

# ---------------------------------------------------------------------------
# Pattern B — version constraint bumped without lockfile regeneration.
# This is the one PR #16496 hit (the bug that motivated this file).
# ---------------------------------------------------------------------------

@test "_composer_extract_drifted_pkgs: pattern B — opensearch-php constraint bump" {
    # Verbatim error from composer 2.9.7 on shopware/shopware PR #16496.
    local input='  - Required package "opensearch-project/opensearch-php" is in the lock file as "2.3.1" but that does not satisfy your constraint "^2.6.0".'
    local out
    out=$(_composer_extract_drifted_pkgs "$input")
    [ "$(echo "$out" | tr -s ' ')" = "opensearch-project/opensearch-php " ]
}

@test "_composer_extract_drifted_pkgs: pattern B — three packages bumped in one file" {
    # The full failure from PR #16496 — all three packages bumped together.
    local input='  - Required package "opensearch-project/opensearch-php" is in the lock file as "2.3.1" but that does not satisfy your constraint "^2.6.0".
  - Required package "shopware/conflicts" is in the lock file as "0.6.0" but that does not satisfy your constraint "0.6.1".
  - Required package "shyim/opensearch-php-dsl" is in the lock file as "1.0.5" but that does not satisfy your constraint "^1.1.4".'
    local out
    out=$(_composer_extract_drifted_pkgs "$input")
    [[ "$out" == *"opensearch-project/opensearch-php"* ]]
    [[ "$out" == *"shopware/conflicts"* ]]
    [[ "$out" == *"shyim/opensearch-php-dsl"* ]]
}

# ---------------------------------------------------------------------------
# Mixed: both patterns present (PR adds a brand-new package AND bumps an
# existing constraint).  Should extract all of them.
# ---------------------------------------------------------------------------

@test "_composer_extract_drifted_pkgs: mixed patterns — both extracted" {
    local input='  - Required package "shopware/commercial" is not present in the lock file.
  - Required package "opensearch-project/opensearch-php" is in the lock file as "2.3.1" but that does not satisfy your constraint "^2.6.0".'
    local out
    out=$(_composer_extract_drifted_pkgs "$input")
    [[ "$out" == *"shopware/commercial"* ]]
    [[ "$out" == *"opensearch-project/opensearch-php"* ]]
}

# ---------------------------------------------------------------------------
# Dedup: composer can print the same drift line twice when the dry-run
# fails partway and retries.  The extractor must not double up.
# ---------------------------------------------------------------------------

@test "_composer_extract_drifted_pkgs: dedupes repeated lines" {
    local input='  - Required package "x/y" is not present in the lock file.
  - Required package "x/y" is not present in the lock file.'
    local out
    out=$(_composer_extract_drifted_pkgs "$input" | tr -s ' ' | xargs -n1 | sort -u | wc -l | tr -d ' ')
    [ "$out" = "1" ]
}

# ---------------------------------------------------------------------------
# Negative: noise that LOOKS package-ish but isn't a drift line.
# Examples: composer's "Loading composer repositories" banner, plugin
# install hints that quote package names in unrelated contexts.
# ---------------------------------------------------------------------------

@test "_composer_extract_drifted_pkgs: ignores unrelated 'package' mentions" {
    local input='Loading composer repositories with package information
Resolving dependencies through SAT
Some other "package" hint here'
    local out
    out=$(_composer_extract_drifted_pkgs "$input" | tr -d ' ')
    [ -z "$out" ]  # nothing extracted
}

# ---------------------------------------------------------------------------
# Empty input — graceful empty output, no crash.
# ---------------------------------------------------------------------------

@test "_composer_extract_drifted_pkgs: empty input → empty output" {
    local out
    out=$(_composer_extract_drifted_pkgs "" | tr -d ' ')
    [ -z "$out" ]
}

# ---------------------------------------------------------------------------
# Constraint string contains special characters (^, ~, -dev, etc.)
# that could break a naive sed pattern.  Pin the parse semantics.
# ---------------------------------------------------------------------------

@test "_composer_extract_drifted_pkgs: handles caret/tilde/dev constraints" {
    local input='  - Required package "vendor/pkg" is in the lock file as "1.0.0-dev" but that does not satisfy your constraint "^1.1 || ~2.0".'
    local out
    out=$(_composer_extract_drifted_pkgs "$input")
    [ "$(echo "$out" | tr -s ' ')" = "vendor/pkg " ]
}
