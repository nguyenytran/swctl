#!/usr/bin/env bash
# Shopware 6 frontend build hook — conditional admin + storefront builds.
#
# Available env vars: same as provision.sh, plus:
#   FORCE_PLUGIN_BUILD — "1" if plugin has admin/storefront extensions

set -euo pipefail

local compose_project="$COMPOSE_PROJECT"
local force_plugin_build="${FORCE_PLUGIN_BUILD:-0}"

# QA mode: skip full builds but still register bundles + assets.
# Chain the two console calls under one docker exec to skip an extra
# PHP kernel boot.
if [ "$SWCTL_MODE" = "qa" ] && [ "$force_plugin_build" -ne 1 ]; then
    info "QA mode: skipping frontend builds (using synced assets)."
    run_app_command "$compose_project" \
        "$WORKFLOW_CONSOLE bundle:dump && $WORKFLOW_CONSOLE assets:install" \
        2>/dev/null || true
    return 0 2>/dev/null || exit 0
fi

# Install missing deps when worktree's package.json diverged from trunk
_swctl_install_admin_deps_if_needed "$compose_project"

local needs_admin_build=0
local needs_storefront_build=0

if [ "${ADMIN_CHANGES:-0}" -gt 0 ]; then
    needs_admin_build=1
fi
if [ "${STOREFRONT_CHANGES:-0}" -gt 0 ]; then
    needs_storefront_build=1
fi

if [ "$needs_admin_build" -eq 1 ] || [ "$needs_storefront_build" -eq 1 ]; then
    if [ "$needs_admin_build" -eq 1 ] && [ "$needs_storefront_build" -eq 1 ]; then
        info "Admin + Storefront changes detected. Building with parallel npm."
        # Chain the 3 prep console calls under one docker exec — they are
        # independent of each other but each pays ~3 s of PHP kernel boot
        # when invoked separately.  `admin:generate-entity-schema-types` is
        # allowed to fail (node-side feature, not always available).
        run_app_command "$compose_project" \
            "$WORKFLOW_CONSOLE bundle:dump && \
             $WORKFLOW_CONSOLE feature:dump && \
             ($WORKFLOW_CONSOLE admin:generate-entity-schema-types 2>/dev/null || true)" \
            || warn "bundle:dump / feature:dump failed."
        run_app_command "$compose_project" 'set -e
ADMIN_DIR=src/Administration/Resources/app/administration
STOREFRONT_DIR=src/Storefront/Resources/app/storefront
export PROJECT_ROOT="$PWD"

( cd "$ADMIN_DIR" && export PATH="$PWD/node_modules/.bin:$PATH" && npm run build ) &
ADMIN_PID=$!

( cd "$STOREFRONT_DIR" && export PATH="$PWD/node_modules/.bin:$PATH" && npm run production ) &
STOREFRONT_PID=$!

ADMIN_OK=0; STOREFRONT_OK=0
wait $ADMIN_PID || ADMIN_OK=1
wait $STOREFRONT_PID || STOREFRONT_OK=1

cd "$STOREFRONT_DIR" && node copy-to-vendor.js
cd "$PROJECT_ROOT"

[ $STOREFRONT_OK -eq 0 ] || echo "[WARN] Storefront npm build failed."
# Admin failure is fatal — returning a non-zero exit code that run_app_command
# will propagate.  Storefront failures stay warn (theme:refresh can recover).
if [ $ADMIN_OK -ne 0 ]; then
    echo "[ERR] Admin npm build failed — aborting create (the instance would have a broken admin UI)."
    exit 2
fi
exit 0
' || {
    _build_rc=$?
    if [ "$_build_rc" -eq 2 ]; then
        # Admin build failed.  Decide whether this is fatal:
        # - Vanilla create with no dep plugins (LINKED_PLUGINS empty) → fatal.
        #   The user's primary work touched admin code and the rebuild
        #   couldn't produce fresh bundles, so shipping would mean a stale
        #   admin UI.  Abort and let the user re-run after fixing.
        # - Plugin-external or platform-with-deps create (LINKED_PLUGINS set)
        #   → warn-but-continue.  The most common cause is that one of the
        #   nested plugins (typically a SwagCommercial sub-app) lacks a
        #   local node_modules with its own `vite` install; trying to build
        #   it from source aborts the whole admin build.  swctl's create
        #   already synced the parent plugin's prebuilt dist into the
        #   worktree (see sync_plugin_gitignored_artifacts), so the admin
        #   UI is functional with the fallback assets.  We surface a clear
        #   warning + a remedy path instead of failing the create.
        if [ -n "${LINKED_PLUGINS:-}" ]; then
            warn "Admin npm build failed (likely a nested plugin build), but synced prebuilt dist is present — continuing."
            warn "If the admin UI looks stale, rebuild in the worktree:"
            warn "  swctl exec ${ISSUE_ID:-<issue>} 'composer build:js:admin'"
        else
            # Admin build failed: propagate up to cmd_create so it aborts the
            # create with STATUS=failed instead of shipping a broken admin.
            # `return` rather than `exit` because this hook is SOURCED by
            # run_workflow_hook; `exit` would kill the whole swctl process.
            err "Admin npm build failed — aborting create."
            return 2 2>/dev/null || exit 2
        fi
    fi
    warn "Parallel JS build had errors."
}
        # Chain theme:compile + assets:install under one docker exec.
        run_app_command "$compose_project" \
            "($WORKFLOW_CONSOLE theme:compile --sync 2>/dev/null || true) && \
             $WORKFLOW_CONSOLE assets:install" \
            || warn "theme:compile / assets:install failed."
    elif [ "$needs_admin_build" -eq 1 ]; then
        info "Admin changes detected. Running bundle:dump + composer build:js:admin."
        run_app_command "$compose_project" "$WORKFLOW_CONSOLE bundle:dump" || warn "bundle:dump failed."
        run_app_command "$compose_project" "composer build:js:admin" || warn "Admin JS build failed."
    else
        info "Storefront changes detected. Running bundle:dump + composer build:js:storefront."
        run_app_command "$compose_project" "$WORKFLOW_CONSOLE bundle:dump" || warn "bundle:dump failed."
        run_app_command "$compose_project" "composer build:js:storefront" || warn "Storefront JS build failed."
    fi
else
    # No source changes — just register synced assets.  Chain under one exec.
    run_app_command "$compose_project" \
        "$WORKFLOW_CONSOLE bundle:dump && $WORKFLOW_CONSOLE assets:install" \
        2>/dev/null || true
    info "Assets registered from synced files. No frontend builds needed."
fi

# NOTE: the trailing cache:clear was moved into post-provision.sh, which
# already clears the cache after theme:refresh.  Running it here too was
# ~5–10 s of duplicate work per create.
