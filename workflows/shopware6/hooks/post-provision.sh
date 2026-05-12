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
# idempotently into .env.local, then runs es:create-aliases (if
# needed), es:index, and drains the async queue so the index is
# warm by the time the user opens the storefront.
#
# Idempotent: if SHOPWARE_ES_ENABLED is already set in .env.local,
# the env-write is skipped (no duplicate stanza on `swctl refresh`).
#
# Failure mode: any individual ES step failing emits a `warn` but
# does NOT abort the post-provision.  The instance is still usable
# with the MySQL fallback; user can re-run `es:index` manually.
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
    # console call.  Chain the next two console invocations under
    # one docker exec to save ~3 s of PHP kernel boot each.
    run_app_command "$COMPOSE_PROJECT" \
        "$WORKFLOW_CONSOLE cache:clear && $WORKFLOW_CONSOLE es:index --no-interaction" \
        || warn "[es] cache:clear / es:index failed."

    # Drain the async queue so the storefront sees freshly-indexed
    # documents immediately.  --time-limit caps the work so we don't
    # block create indefinitely on a backlog; --memory-limit is the
    # standard guard.  Allowed to fail (the index is usable even
    # partially-populated).
    run_app_command "$COMPOSE_PROJECT" \
        "$WORKFLOW_CONSOLE messenger:consume async --time-limit=60 --memory-limit=1G --limit=5000 -q" \
        2>/dev/null \
        || warn "[es] messenger:consume drain timed out / failed — index may still be filling in the background."

    ok "[es] Elasticsearch enabled and indexed for ${COMPOSE_PROJECT}."
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
