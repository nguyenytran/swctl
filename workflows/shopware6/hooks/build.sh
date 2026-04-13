#!/usr/bin/env bash
# Shopware 6 frontend build hook — conditional admin + storefront builds.
#
# Available env vars: same as provision.sh, plus:
#   FORCE_PLUGIN_BUILD — "1" if plugin has admin/storefront extensions

set -euo pipefail

local compose_project="$COMPOSE_PROJECT"
local force_plugin_build="${FORCE_PLUGIN_BUILD:-0}"

# QA mode: skip unless plugin has extensions
if [ "$SWCTL_MODE" = "qa" ] && [ "$force_plugin_build" -ne 1 ]; then
    info "QA mode: skipping frontend builds (using synced assets)."
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
    info "Frontend changes detected. Running bundle:dump."
    run_app_command "$compose_project" "$WORKFLOW_CONSOLE bundle:dump" || warn "bundle:dump failed."

    if [ "$needs_admin_build" -eq 1 ] && [ "$needs_storefront_build" -eq 1 ]; then
        info "Admin + Storefront changes detected. Building with parallel npm."
        run_app_command "$compose_project" "$WORKFLOW_CONSOLE feature:dump" || warn "feature:dump failed."
        run_app_command "$compose_project" "$WORKFLOW_CONSOLE admin:generate-entity-schema-types" 2>/dev/null || true
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

[ $ADMIN_OK -eq 0 ] || echo "[WARN] Admin npm build failed."
[ $STOREFRONT_OK -eq 0 ] || echo "[WARN] Storefront npm build failed."
exit $((ADMIN_OK + STOREFRONT_OK))
' || warn "Parallel JS build had errors."
        run_app_command "$compose_project" "$WORKFLOW_CONSOLE theme:compile --sync" 2>/dev/null || true
        run_app_command "$compose_project" "$WORKFLOW_CONSOLE assets:install" || warn "assets:install failed."
    elif [ "$needs_admin_build" -eq 1 ]; then
        info "Admin changes detected. Running composer build:js:admin."
        run_app_command "$compose_project" "composer build:js:admin" || warn "Admin JS build failed."
    else
        info "Storefront changes detected. Running composer build:js:storefront."
        run_app_command "$compose_project" "composer build:js:storefront" || warn "Storefront JS build failed."
    fi
else
    run_app_command "$compose_project" "$WORKFLOW_CONSOLE bundle:dump" 2>/dev/null || true
    run_app_command "$compose_project" "$WORKFLOW_CONSOLE assets:install" 2>/dev/null || true
    info "Assets registered from synced files. No frontend builds needed."
fi

# Clear cache for any code change
if [ "$((BACKEND_CHANGES + ADMIN_CHANGES + STOREFRONT_CHANGES + COMPOSER_CHANGES + PACKAGE_CHANGES))" -gt 0 ] && [ "${DB_STATE:-}" != "fresh" ]; then
    run_app_command "$compose_project" "$WORKFLOW_CONSOLE cache:clear" || warn "cache:clear failed."
fi
