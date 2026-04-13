#!/usr/bin/env bash
# Shopware 6 post-provision hook — theme refresh, cache clear.
#
# Available env vars: same as provision.sh

set -euo pipefail

if [ "$SWCTL_MODE" = "qa" ]; then
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
