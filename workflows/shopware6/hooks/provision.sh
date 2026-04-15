#!/usr/bin/env bash
# Shopware 6 provisioning hook — called after DB clone + container start.
#
# Available env vars (set by swctl):
#   WORKFLOW_CONSOLE  — path to console binary (bin/console)
#   COMPOSE_PROJECT   — Docker Compose project name
#   WORKTREE_PATH     — absolute path to worktree
#   PROJECT_ROOT      — absolute path to project root (trunk)
#   APP_URL           — full URL for the worktree
#   DB_NAME           — database name for this worktree
#   DB_STATE          — "fresh" or "cloned"
#   SWCTL_MODE        — "dev" or "qa"
#   SW_INSTALL_ARGS   — install command flags
#   SW_SHARED_DB_INSTALL_ARGS — install args for shared DB
#   SW_DB_SHARED_NAME — shared database name
#   MIGRATION_CHANGES, ENTITY_CHANGES, ADMIN_CHANGES, STOREFRONT_CHANGES,
#   COMPOSER_CHANGES, PACKAGE_CHANGES, BACKEND_CHANGES, FRONTEND_CHANGES

set -euo pipefail

# --- QA mode: minimal setup (no composer install, no npm, just DB + cache) ---
if [ "$SWCTL_MODE" = "qa" ]; then
    # Vendor is bind-mounted from trunk but the autoloader has host paths.
    # Regenerate it so paths resolve inside the container.
    run_app_command "$COMPOSE_PROJECT" "composer dump-autoload --no-interaction 2>&1" \
        || warn "composer dump-autoload failed."
    # Run migrations if the branch has schema changes
    if [ $((MIGRATION_CHANGES + ENTITY_CHANGES)) -gt 0 ]; then
        info "Schema changes detected in QA mode. Running migrations."
        run_app_command "$COMPOSE_PROJECT" \
            "$WORKFLOW_CONSOLE database:migrate --all && $WORKFLOW_CONSOLE database:migrate-destructive --all" \
            || warn "Migrations failed."
    fi
    _swctl_update_sales_channel_domain "$COMPOSE_PROJECT" "$APP_URL"
    _swctl_ensure_install_lock "$COMPOSE_PROJECT"
    # Always clear cache so DI container / routing / config changes take effect
    run_app_command "$COMPOSE_PROJECT" "$WORKFLOW_CONSOLE cache:clear" || warn "cache:clear failed."
    return 0 2>/dev/null || exit 0
fi

# --- Dev mode ---

# Bootstrap dependencies (composer install, npm install, JWT keys)
_swctl_bootstrap_dependencies "$COMPOSE_PROJECT"

if [ "$DB_STATE" = "fresh" ]; then
    # Fresh install
    info "Running Shopware system install for database '$DB_NAME'."
    run_app_command "$COMPOSE_PROJECT" "$WORKFLOW_CONSOLE system:install $SW_INSTALL_ARGS"
    _swctl_ensure_install_lock "$COMPOSE_PROJECT"

    # Populate shared DB so future worktrees can clone
    local source_db
    source_db="$(sanitize_db_identifier "$SW_DB_SHARED_NAME")"
    if ! mysql_db_has_tables "$source_db"; then
        info "Populating shared database '$source_db' from fresh install."
        clone_database "$DB_NAME" "$source_db"
    fi
elif [ $((MIGRATION_CHANGES + ENTITY_CHANGES)) -gt 0 ]; then
    info "Schema changes detected. Running migrations on cloned database."
    run_app_command "$COMPOSE_PROJECT" \
        "$WORKFLOW_CONSOLE database:migrate --all && $WORKFLOW_CONSOLE database:migrate-destructive --all" \
        || warn "Migrations failed."
fi

_swctl_update_sales_channel_domain "$COMPOSE_PROJECT" "$APP_URL"
_swctl_ensure_install_lock "$COMPOSE_PROJECT"
