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
run_app_command "$COMPOSE_PROJECT" \
    "$WORKFLOW_CONSOLE plugin:refresh && $WORKFLOW_CONSOLE plugin:install --activate $PLUGIN_NAME" \
    || warn "Plugin refresh/activate failed for '$PLUGIN_NAME'."
