#!/usr/bin/env bash
# Shopware 6 post-provision hook — theme refresh, cache clear,
# optional Elasticsearch enablement.
#
# Available env vars: same as provision.sh, plus:
#   SWCTL_ENABLE_ES  — "1" to write SHOPWARE_ES_* into .env.local and
#                      run `es:index` after the standard post-steps.
#                      Resolved by swctl's _decide_enable_es (auto-detected
#                      from issue labels OR forced via --enable-es).

set -euo pipefail

# Enable ES on the instance when the caller (swctl create) decided
# this is a search-related issue.  Writes the four ES env vars
# idempotently into .env.local, then runs dal:refresh:index (rebuilds
# product_search_keyword and other DAL indexes that the cloned DB
# inherited stale from trunk), es:index, and drains the async queue
# so the index is warm by the time the user opens the storefront.
#
# Why dal:refresh:index (added 2026-05-30):
# - Cloned/synced DBs carry over trunk's product_search_keyword rows.
# - Admin search (DAL) AND es:index (which reads from DAL) both see
#   stale data → /admin and /store-api/search-suggest return wrong
#   results until the user manually runs dal:refresh:index.
# - Running it before es:index ensures ES is built from fresh DAL data.
#
# Idempotent: if SHOPWARE_ES_ENABLED is already set in .env.local,
# the env-write is skipped (no duplicate stanza on `swctl refresh`).
#
# Failure mode: any individual step failing emits a `warn` but
# does NOT abort the post-provision.  The instance is still usable
# with the MySQL fallback; user can re-run the commands manually.
_swctl_enable_es_if_requested() {
    if [ "${SWCTL_ENABLE_ES:-0}" != "1" ]; then
        return 0
    fi

    local env_file="$WORKTREE_PATH/.env.local"
    if [ ! -f "$env_file" ]; then
        warn "[es] .env.local not found at $env_file — skipping ES setup."
        return 0
    fi

    if ! grep -q '^SHOPWARE_ES_ENABLED=' "$env_file"; then
        info "[es] writing SHOPWARE_ES_* into .env.local"
        # Heredoc with explicit trailing newline so the next refresh
        # doesn't smash subsequent appends into the last line.
        cat >> "$env_file" <<'EOF'

# Elasticsearch — enabled by swctl create (component/search label
# detected, or --enable-es passed).  Remove these lines to revert
# to the MySQL fallback.
SHOPWARE_ES_ENABLED=1
SHOPWARE_ES_INDEXING_ENABLED=1
SHOPWARE_ES_HOSTS=http://opensearch:9200
SHOPWARE_ES_THROW_EXCEPTION=1
EOF
    else
        info "[es] SHOPWARE_ES_ENABLED already in .env.local — leaving as-is."
    fi

    # Cache clear so the kernel picks up the new env on the next
    # console call.  Then refresh DAL indexes (DB-side, including
    # product_search_keyword) BEFORE es:index so the ES rebuild reads
    # from fresh DAL data.  Chained under one docker exec to save
    # ~3 s of PHP kernel boot each.
    run_app_command "$COMPOSE_PROJECT" \
        "$WORKFLOW_CONSOLE cache:clear && $WORKFLOW_CONSOLE dal:refresh:index --no-interaction && $WORKFLOW_CONSOLE es:index --no-interaction" \
        || warn "[es] cache:clear / dal:refresh:index / es:index failed."

    # Drain the async queue so the storefront sees freshly-indexed
    # documents immediately.  --time-limit caps the work so we don't
    # block create indefinitely on a backlog; --memory-limit is the
    # standard guard.  Allowed to fail (the index is usable even
    # partially-populated).
    run_app_command "$COMPOSE_PROJECT" \
        "$WORKFLOW_CONSOLE messenger:consume async --time-limit=60 --memory-limit=1G --limit=5000 -q" \
        2>/dev/null \
        || warn "[es] messenger:consume drain timed out / failed — index may still be filling in the background."

    # Smoke test: verify search-suggest actually returns results.  This
    # catches the "everything looked successful but search is empty"
    # class of bug (the one the 2026-05-30 dal:refresh:index addition
    # was meant to prevent) by failing LOUDLY at create time instead of
    # the user discovering it 30 min later when they open the storefront.
    _swctl_smoke_test_search
}

# Hit /store-api/search-suggest against the running instance and warn
# loudly when total=0.  Gracefully no-ops when prerequisites (curl, jq,
# access key, APP_URL) aren't available so it never blocks the create.
#
# Why store-api (not storefront /search): the storefront route renders
# HTML — fragile to parse, theme-dependent.  The store-api JSON has a
# stable `total` field that means exactly what it says.  Cost: we need
# the sales-channel access key from the DB.  We extract it via
# bin/console dbal:run-sql, which ships with the doctrine bundle that
# Shopware already depends on.
_swctl_smoke_test_search() {
    [ "${SWCTL_ENABLE_ES:-0}" = "1" ] || return 0

    if ! command -v curl >/dev/null 2>&1; then
        warn "[es-smoke] curl not installed on host — skipping smoke test."
        return 0
    fi
    if [ -z "${APP_URL:-}" ]; then
        warn "[es-smoke] APP_URL not set — skipping smoke test."
        return 0
    fi

    local access_key
    access_key="$(_smoke_fetch_sales_channel_access_key)"
    if [ -z "$access_key" ]; then
        warn "[es-smoke] could not extract sales-channel access key — skipping search smoke test."
        warn "[es-smoke]   (override the term via SWCTL_SEARCH_SMOKE_TERM, or test manually:"
        warn "[es-smoke]    curl -H 'sw-access-key: <KEY>' '${APP_URL}/store-api/search-suggest?search=A')"
        return 0
    fi

    # Single uppercase 'A' is a deliberately broad term — matches at least
    # one product in every Shopware demo dataset we've seen.  Override via
    # .swctl.conf if your fixtures use a different language / charset.
    local sample_term="${SWCTL_SEARCH_SMOKE_TERM:-A}"
    local total
    total="$(_smoke_search_suggest_total "$access_key" "$sample_term")"

    if [ -n "$total" ] && [ "$total" -gt 0 ] 2>/dev/null; then
        ok "[es-smoke] /store-api/search-suggest returned ${total} result(s) for '${sample_term}'."
    else
        warn "[es-smoke] /store-api/search-suggest returned 0 results for '${sample_term}' — search is likely broken."
        warn "[es-smoke]   Diagnose: curl -H 'sw-access-key: ${access_key}' '${APP_URL}/store-api/search-suggest?search=${sample_term}&limit=1'"
        warn "[es-smoke]   Likely fixes:"
        warn "[es-smoke]     1. bin/console messenger:consume async --time-limit=60   (drain remaining indexing jobs)"
        warn "[es-smoke]     2. bin/console dal:refresh:index                          (rebuild DAL search keywords)"
        warn "[es-smoke]     3. bin/console es:index                                   (rebuild ES documents)"
    fi
}

# Returns the first sales-channel access key on stdout, empty if not retrievable.
# Pulls via bin/console dbal:run-sql so we don't have to know which DB
# container alias/name the compose project uses (a moving target across
# orbstack / standalone compose / future workflow templates).
_smoke_fetch_sales_channel_access_key() {
    local raw
    raw="$(run_app_command "$COMPOSE_PROJECT" \
        "bin/console dbal:run-sql --no-interaction --no-ansi 'SELECT access_key FROM sales_channel LIMIT 1' 2>/dev/null" \
        2>/dev/null)" || return 0
    # Shopware access keys are 32 uppercase alphanumerics, typically prefixed "SW".
    # Tolerate other formats by accepting any 24+ uppercase alphanumeric token.
    printf '%s' "$raw" | grep -oE '[A-Z0-9]{24,}' | head -1
}

# Curl the suggest endpoint, return its `total` field on stdout.
# Empty string when curl fails or JSON can't be parsed.
_smoke_search_suggest_total() {
    local access_key="$1" term="$2"
    local body
    body="$(curl --max-time 15 -fsS \
        -H "sw-access-key: ${access_key}" \
        "${APP_URL}/store-api/search-suggest?search=${term}&limit=1" 2>/dev/null)" || return 0

    if command -v jq >/dev/null 2>&1; then
        printf '%s' "$body" | jq -r '.total // 0' 2>/dev/null
    else
        # Fallback: regex `"total":N` from raw JSON.  Good enough for the smoke
        # check — we just need to distinguish 0 vs >0, not exact counts.
        printf '%s' "$body" | grep -oE '"total":[0-9]+' | head -1 | grep -oE '[0-9]+'
    fi
}

# QA mode: skip theme:refresh (the synced theme is fine) but still run
# cache:clear so the DI container is fresh after plugin:refresh +
# plugin:install (and after the build.sh tail cache:clear was removed).
if [ "$SWCTL_MODE" = "qa" ]; then
    if [ "$((BACKEND_CHANGES + ADMIN_CHANGES + STOREFRONT_CHANGES + COMPOSER_CHANGES + PACKAGE_CHANGES))" -gt 0 ] \
       && [ "${DB_STATE:-}" != "fresh" ]; then
        run_app_command "$COMPOSE_PROJECT" "$WORKFLOW_CONSOLE cache:clear" \
            || warn "cache:clear failed."
    fi
    _swctl_enable_es_if_requested
    return 0 2>/dev/null || exit 0
fi

if [ "$DB_STATE" = "fresh" ]; then
    run_app_command "$COMPOSE_PROJECT" \
        "$WORKFLOW_CONSOLE theme:refresh 2>/dev/null; $WORKFLOW_CONSOLE cache:clear" \
        || warn "Post-provision commands failed."
elif [ "${STOREFRONT_CHANGES:-0}" -gt 0 ]; then
    run_app_command "$COMPOSE_PROJECT" \
        "$WORKFLOW_CONSOLE theme:refresh 2>/dev/null; $WORKFLOW_CONSOLE theme:compile --sync || echo '[WARN] theme:compile failed.'; $WORKFLOW_CONSOLE cache:clear || echo '[WARN] cache:clear failed.'" \
        || warn "Post-provision commands failed."
else
    run_app_command "$COMPOSE_PROJECT" \
        "$WORKFLOW_CONSOLE theme:refresh 2>/dev/null; $WORKFLOW_CONSOLE cache:clear" \
        || warn "Post-provision commands failed."
fi

# Always run the ES enablement step last so the index is warm before
# the user opens the storefront.  No-op when SWCTL_ENABLE_ES=0.
_swctl_enable_es_if_requested
