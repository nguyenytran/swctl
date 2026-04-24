#!/usr/bin/env bats

load test_helper

# Regression guard for _resolve_cleanup_db_name (swctl:~153).
#
# The bug this prevents: cmd_clean's DB-drop branch only fired when the
# instance's metadata carried a non-empty DB_NAME=.  Instances created
# with --no-provision (old resolve flow, v0.5.7) were later provisioned
# via /api/stream/refresh without re-writing metadata — their DB_NAME
# stayed empty, so clean silently skipped the drop and left
# `shopware_<N>` databases orphaned on the mariadb server.
#
# These tests cover every input permutation so the fallback-to-canonical
# naming stays correct as the helper evolves.

setup() {
    # Scrub outer-shell defaults so the function genuinely exercises its
    # own defaulting logic, not whatever the test runner had set.
    unset DB_NAME SW_DB_NAME_PREFIX ISSUE_ID
}

# ---------------------------------------------------------------------------
# Happy path: explicit DB_NAME from metadata
# ---------------------------------------------------------------------------

@test "explicit DB_NAME (arg 1) wins over everything" {
    result="$(_resolve_cleanup_db_name 'shopware_1234' 'anything' 'ignored')"
    [ "$result" = "shopware_1234" ]
}

@test "explicit DB_NAME from env var is honoured when no args passed" {
    DB_NAME='shopware_42'
    result="$(_resolve_cleanup_db_name)"
    [ "$result" = "shopware_42" ]
}

# ---------------------------------------------------------------------------
# Fallback: construct from prefix + issue id when explicit is empty
# ---------------------------------------------------------------------------

@test "empty DB_NAME + prefix + issue → sanitize(prefix_issue)" {
    result="$(_resolve_cleanup_db_name '' 'shopware' '15504')"
    [ "$result" = "shopware_15504" ]
}

@test "empty DB_NAME + env-derived prefix + env-derived issue" {
    SW_DB_NAME_PREFIX='shopware'
    ISSUE_ID='15504'
    result="$(_resolve_cleanup_db_name '')"
    [ "$result" = "shopware_15504" ]
}

@test "empty DB_NAME + custom prefix → uses custom prefix" {
    result="$(_resolve_cleanup_db_name '' 'saasplatform' '777')"
    [ "$result" = "saasplatform_777" ]
}

@test "empty DB_NAME with missing prefix env defaults to 'shopware'" {
    unset SW_DB_NAME_PREFIX
    ISSUE_ID='99'
    result="$(_resolve_cleanup_db_name '')"
    [ "$result" = "shopware_99" ]
}

# ---------------------------------------------------------------------------
# Edge cases: weird inputs
# ---------------------------------------------------------------------------

@test "prefix or issue with non-alphanumerics → sanitized (mariadb identifier-safe)" {
    result="$(_resolve_cleanup_db_name '' 'my-prefix' 'SW-1234')"
    # sanitize_db_identifier lowercases + replaces non-alphanumerics with _
    # and collapses runs: "my-prefix_sw-1234" → "my_prefix_sw_1234"
    [ "$result" = "my_prefix_sw_1234" ]
}

@test "missing both explicit and issue → non-zero exit, no output" {
    run _resolve_cleanup_db_name '' '' ''
    [ "$status" -ne 0 ]
    [ -z "$output" ]
}

@test "no args at all → reads DB_NAME / SW_DB_NAME_PREFIX / ISSUE_ID from env" {
    # The defaults in the helper use bash's `${1-default}` form which
    # only kicks in when the parameter is UNSET.  Passing zero args
    # leaves them unset, so the function reads the env fallbacks.
    # (Callers inside cmd_clean rely on this — they don't pass args.)
    DB_NAME='legacy_db_name'
    result="$(_resolve_cleanup_db_name)"
    [ "$result" = "legacy_db_name" ]
}

# ---------------------------------------------------------------------------
# Regression guard: the exact scenario from the user report
# ---------------------------------------------------------------------------

@test "regression: pre-v0.5.8 resolve instance — empty DB_NAME + only ISSUE_ID" {
    # This is how the metadata looked for orphaned instance 15039:
    # DB_NAME='' was persisted before provision_database_and_app ran.
    # The old cmd_clean branched on `[ -n "$DB_NAME" ]` and skipped
    # the drop entirely.  The fixed helper reconstructs from ISSUE_ID,
    # so the DROP DATABASE IF EXISTS will target the actual DB.
    DB_NAME=''
    SW_DB_NAME_PREFIX='shopware'
    ISSUE_ID='15039'
    result="$(_resolve_cleanup_db_name)"
    [ "$result" = "shopware_15039" ]
}
