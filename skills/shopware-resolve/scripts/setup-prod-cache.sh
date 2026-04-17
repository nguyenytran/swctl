#!/usr/bin/env bash
# Toggle production mode with HTTP cache and Redis for testing cache invalidation bugs.
#
# Usage:
#   setup-prod-cache.sh enable [--env-file <path>]    Enable prod + HTTP cache + Redis
#   setup-prod-cache.sh disable [--env-file <path>]   Restore dev mode
#   setup-prod-cache.sh status [--env-file <path>]    Show current config
#
# When used with swctl:
#   swctl exec <issue> 'bash /path/to/setup-prod-cache.sh enable'
#
# This modifies .env.local and creates/removes config/packages/cache.yaml.

set -euo pipefail

ACTION="${1:-status}"
ENV_FILE=".env.local"

shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    *) shift ;;
  esac
done

CACHE_YAML="config/packages/cache.yaml"

show_status() {
  echo "=== Current config ==="
  if [[ -f "$ENV_FILE" ]]; then
    grep -E "APP_ENV|HTTP_CACHE|REDIS" "$ENV_FILE" 2>/dev/null || echo "(no matching vars)"
  else
    echo "(no $ENV_FILE)"
  fi
  echo ""
  if [[ -f "$CACHE_YAML" ]]; then
    echo "cache.yaml: exists"
    head -3 "$CACHE_YAML"
  else
    echo "cache.yaml: not present (using default adapter)"
  fi
}

enable_prod_cache() {
  echo "Enabling prod + HTTP cache + Redis..."

  # Update APP_ENV
  if grep -q "^APP_ENV=" "$ENV_FILE" 2>/dev/null; then
    sed -i.bak "s/^APP_ENV=.*/APP_ENV=prod/" "$ENV_FILE"
  else
    echo "APP_ENV=prod" >> "$ENV_FILE"
  fi

  # Add HTTP cache
  grep -q "^SHOPWARE_HTTP_CACHE_ENABLED" "$ENV_FILE" 2>/dev/null && \
    sed -i.bak "s/^SHOPWARE_HTTP_CACHE_ENABLED=.*/SHOPWARE_HTTP_CACHE_ENABLED=1/" "$ENV_FILE" || \
    echo "SHOPWARE_HTTP_CACHE_ENABLED=1" >> "$ENV_FILE"

  # Add TTL
  grep -q "^SHOPWARE_HTTP_DEFAULT_TTL" "$ENV_FILE" 2>/dev/null && \
    sed -i.bak "s/^SHOPWARE_HTTP_DEFAULT_TTL=.*/SHOPWARE_HTTP_DEFAULT_TTL=7200/" "$ENV_FILE" || \
    echo "SHOPWARE_HTTP_DEFAULT_TTL=7200" >> "$ENV_FILE"

  # Create Redis cache config
  mkdir -p "$(dirname "$CACHE_YAML")"
  cat > "$CACHE_YAML" << 'YAML'
framework:
    cache:
        app: cache.adapter.redis
        default_redis_provider: '%env(REDIS_URL)%'
        pools:
            cache.object:
                default_lifetime: 172800
                tags: cache.tags
                adapters:
                    - cache.app
            cache.http:
                default_lifetime: 172800
                tags: cache.tags
                adapters:
                    - cache.app
            cache.tags:
                adapters:
                    - cache.app
YAML

  rm -f "${ENV_FILE}.bak"
  echo ""
  show_status
  echo ""
  echo "Run 'bin/console cache:clear' to apply."
}

disable_prod_cache() {
  echo "Restoring dev mode..."

  # Restore APP_ENV
  if grep -q "^APP_ENV=" "$ENV_FILE" 2>/dev/null; then
    sed -i.bak "s/^APP_ENV=.*/APP_ENV=dev/" "$ENV_FILE"
  fi

  # Remove HTTP cache vars
  sed -i.bak "/^SHOPWARE_HTTP_CACHE_ENABLED/d" "$ENV_FILE"
  sed -i.bak "/^SHOPWARE_HTTP_DEFAULT_TTL/d" "$ENV_FILE"

  # Remove cache.yaml
  rm -f "$CACHE_YAML"

  rm -f "${ENV_FILE}.bak"
  echo ""
  show_status
  echo ""
  echo "Run 'bin/console cache:clear' to apply."
}

case "$ACTION" in
  enable)  enable_prod_cache ;;
  disable) disable_prod_cache ;;
  status)  show_status ;;
  *)
    echo "Usage: $0 {enable|disable|status} [--env-file <path>]"
    exit 1
    ;;
esac
