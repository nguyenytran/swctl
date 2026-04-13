#!/usr/bin/env bash
# Shopware 6 plugin activation hook.
#
# Available env vars: same as provision.sh, plus:
#   PLUGIN_NAME — name of the plugin to activate

set -euo pipefail

info "Activating plugin: $PLUGIN_NAME"
run_app_command "$COMPOSE_PROJECT" \
    "$WORKFLOW_CONSOLE plugin:refresh" || warn "plugin:refresh failed."
run_app_command "$COMPOSE_PROJECT" \
    "$WORKFLOW_CONSOLE plugin:install --activate $PLUGIN_NAME" \
    || warn "Plugin activation failed for '$PLUGIN_NAME'."
