#!/usr/bin/env bats

# Regression-guard tests for slugifyIssueTitle (app/server/lib/resolve.ts).
#
# Goal: feed a GitHub issue title in, get a short hyphenated slug out
# that's safe to splice into a branch name (`<prefix>/<id>-<slug>`).
# Pure function — no I/O — so we exercise it through the tsx probe.

load integration_helper

setup() {
    _repo="$BATS_TEST_DIRNAME/../.."
    _tsx="$_repo/app/node_modules/.bin/tsx"
    _probe="$_repo/tests/integration/resolve_branch_slug_probe.ts"
    if [ ! -x "$_tsx" ]; then
        skip "tsx not installed (run: cd app && npm install)"
    fi
}

# Slugify a title; result lands in $output.
_slug() {
    local title="$1"
    output="$(printf '%s' "$title" | "$_tsx" "$_probe")"
}

# ---------------------------------------------------------------------------
# Real-world examples — these were the user-reported cases that motivated
# adding a slug at all.
# ---------------------------------------------------------------------------

@test "real issue: manufacturer language switch — produces readable 4-word slug" {
    _slug "Manufacturer module stores values in the wrong language when switching languages during the editing process"
    # Stop words ("in", "the", "when", "during") removed; first 5 survive.
    [[ "$output" =~ ^manufacturer-module-stores-values ]]
    # No trailing hyphens
    [[ ! "$output" =~ -$ ]]
    # Length cap respected
    [ "${#output}" -le 40 ]
}

@test "real issue: product stream NotFilter nullable — keeps the technical signal" {
    _slug "Product Streams: NotFilter on nullable fields excludes rows with NULL values in SQL"
    # "product-streams-notfilter-nullable-fields" or similar
    [[ "$output" =~ product ]]
    [[ "$output" =~ stream ]]
    [[ "$output" =~ notfilter ]]
    [ "${#output}" -le 40 ]
}

# ---------------------------------------------------------------------------
# Stop-word handling
# ---------------------------------------------------------------------------

@test "drops English filler stop words" {
    _slug "The quick brown fox jumps over the lazy dog"
    # "the", "over" removed; "quick", "brown", "fox", "jumps", "lazy" survive
    [[ "$output" =~ quick-brown-fox ]]
    [[ ! "$output" =~ ^the- ]]
    [[ ! "$output" =~ -the- ]]
}

@test "drops Shopware-issue noise (fix/bug/issue/error)" {
    _slug "Bug: Fix the manufacturer error issue"
    # All four noise tokens removed → leaves just "manufacturer"
    [[ "$output" = "manufacturer" ]]
}

@test "drops single-character tokens" {
    _slug "A B c manufacturer language"
    [[ ! "$output" =~ -a- ]]
    [[ ! "$output" =~ ^a- ]]
    [[ "$output" =~ manufacturer ]]
}

# ---------------------------------------------------------------------------
# Punctuation, casing, length cap
# ---------------------------------------------------------------------------

@test "lowercases everything" {
    _slug "MANUFACTURER Module Language"
    [[ "$output" =~ ^[a-z0-9-]+$ ]]
}

@test "collapses non-alphanumerics to a single hyphen" {
    _slug "[Storefront] checkout/payment_gateway: timeout (regression!)"
    [[ "$output" =~ ^[a-z0-9-]+$ ]]
    # No double-hyphens
    [[ ! "$output" =~ -- ]]
}

@test "caps total length at 40 characters" {
    _slug "Authentication-related authorization-pipeline performance regression on the long-running endpoint"
    [ "${#output}" -le 40 ]
    # Truncates on a word boundary — last char is alphanumeric, not a hyphen.
    last_char="${output: -1}"
    [[ "$last_char" =~ [a-z0-9] ]]
}

# ---------------------------------------------------------------------------
# Edge cases — caller falls back to bare `<prefix>/<id>` when slug is empty
# ---------------------------------------------------------------------------

@test "empty title → empty slug" {
    _slug ""
    [ -z "$output" ]
}

@test "title that's only stop words → empty slug" {
    _slug "the and or but a an"
    [ -z "$output" ]
}

@test "title that's only punctuation → empty slug" {
    _slug "!!!??? --- ()"
    [ -z "$output" ]
}

@test "title with non-ASCII characters: keeps the alphanumeric hits, drops the rest" {
    _slug "Übersicht für Lieferanten — Schnittstelle defekt"
    # Non-ASCII chars become spaces; "fur" is too short anyway, "ubersicht" scrubbed.
    # Either way the result must be alphanumeric+hyphen and not crash.
    [[ "$output" =~ ^[a-z0-9-]*$ ]]
}
