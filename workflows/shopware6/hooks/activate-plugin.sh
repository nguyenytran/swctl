#!/usr/bin/env bash
# Shopware 6 plugin activation hook.
#
# Available env vars: same as provision.sh, plus:
#   PLUGIN_NAME — name of the plugin to activate

set -euo pipefail

info "Activating plugin: $PLUGIN_NAME"
# Chain under one docker exec: plugin:refresh's output (fresh plugin table)
# is read by plugin:install --activate via the DB, not via an in-process
# cache — so sharing the PHP kernel boot is safe and saves ~3 s.
#
# v0.7.8: also chain `database:migrate <plugin> --all` (+ destructive)
# so plugin migrations added since the cloned DB was created get
# applied.  plugin:install is a no-op when installed_at is already
# set (the common case on a cloned DB), so without an explicit
# database:migrate any new plugin migrations are silently skipped.
# Idempotent — already-applied rows in the migration table are
# skipped by Shopware.
run_app_command "$COMPOSE_PROJECT" \
    "$WORKFLOW_CONSOLE plugin:refresh \
     && $WORKFLOW_CONSOLE plugin:install --activate $PLUGIN_NAME \
     && $WORKFLOW_CONSOLE database:migrate $PLUGIN_NAME --all \
     && $WORKFLOW_CONSOLE database:migrate-destructive $PLUGIN_NAME --all" \
    || warn "Plugin refresh/activate/migrate failed for '$PLUGIN_NAME'."
