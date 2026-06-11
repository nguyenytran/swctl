#!/usr/bin/env bats

load test_helper

# Regression guard for the v0.7.10 preflight auto-pull of
# tunnel-related images (caddy:2-alpine, cloudflare/cloudflared:latest).
#
# Background: after an OrbStack restart (or daemon prune under low
# disk), these images can disappear from the local cache.  v0.7.3+
# tunnel features need them, but the user only discovers the gap
# when clicking Start tunnel — by then they're committed and have
# to wait through a cold pull mid-action.  v0.7.10 pre-pulls in the
# preflight so the failure surfaces before any user-facing action.
#
# Gated on features.tunnelsEnabled so users who never use tunnels
# don't pay the pull cost.  When the flag isn't set, the auto-pull
# blocks DO NOT fire — even if the images are missing.  Important:
# the preflight must NOT fail in that case (back-compat for
# tunnel-free workflows).

setup() {
    SW_TMP="$(mktemp -d)"
    SW_WORKTREE_ROOT="$SW_TMP"
    PROJECT_ROOT="$SW_TMP"
    SWCTL_TEMPLATE_DIR="$SW_TMP"
    touch "$SW_TMP/docker-compose.swctl.yml"
    SW_TRAEFIK_NETWORK="net"
    SW_INFRA_DB_CONTAINER="db"
    ISSUE_ID="9999"
    WORKTREE_PATH="$SW_TMP/wt-9999"
    SWCTL_CONFIG_FILE="$SW_TMP/swctl-config.json"
    export SW_TMP SW_WORKTREE_ROOT PROJECT_ROOT SWCTL_TEMPLATE_DIR \
           SW_TRAEFIK_NETWORK SW_INFRA_DB_CONTAINER ISSUE_ID \
           WORKTREE_PATH SWCTL_CONFIG_FILE
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# Stub docker.  Records every invocation to $SW_TMP/calls.log.
# Image-inspect state is per-image, controlled by marker files
# ($SW_TMP/.cached-<munged-image>).  pull always succeeds and flips
# the marker so a subsequent inspect returns 0.
_install_docker_stub() {
    cat > "$SW_TMP/docker" <<'SH'
#!/usr/bin/env bash
echo "docker $*" >> "$SW_TMP/calls.log"
case "$1" in
    info|network) exit 0 ;;
    ps)           echo "stub-ok"; exit 0 ;;
    image)
        if [ "$2" = "inspect" ]; then
            for arg in "$@"; do :; done
            # The image name is the last positional arg.
            img="$3"
            marker="$SW_TMP/.cached-$(printf '%s' "$img" | tr '/:.' '___')"
            [ -f "$marker" ]
            exit $?
        fi
        exit 0 ;;
    pull)
        img="$2"
        marker="$SW_TMP/.cached-$(printf '%s' "$img" | tr '/:.' '___')"
        touch "$marker"
        exit 0 ;;
esac
exit 0
SH
    chmod +x "$SW_TMP/docker"
    PATH="$SW_TMP:$PATH"
    export PATH
}

# Pretend alpine is already cached (we're testing tunnel-image
# behaviour, not alpine).  Marker mirrors the stub's encoding.
_prime_alpine_cached() {
    touch "$SW_TMP/.cached-alpine_latest"
    touch "$SW_TMP/.cached-alpine"
}

# Helper: write a config file with features.tunnelsEnabled.
_set_tunnels_enabled() { printf '%s\n' '{"features":{"tunnelsEnabled":true}}'  > "$SWCTL_CONFIG_FILE"; }
_set_tunnels_disabled() { printf '%s\n' '{"features":{"tunnelsEnabled":false}}' > "$SWCTL_CONFIG_FILE"; }
_set_no_tunnel_field() { printf '%s\n' '{"features":{}}' > "$SWCTL_CONFIG_FILE"; }

# ---------------------------------------------------------------------------
# tunnelsEnabled=true + images missing → preflight auto-pulls both +
# emits two green ticks.
# ---------------------------------------------------------------------------

@test "tunnel-autopull: missing images + tunnelsEnabled=true → preflight pulls + passes" {
    _install_docker_stub
    _prime_alpine_cached
    _set_tunnels_enabled

    run _run_preflight_checks
    [ "$status" -eq 0 ]
    grep -q '^docker pull caddy:2-alpine$' "$SW_TMP/calls.log"
    grep -q '^docker pull cloudflare/cloudflared:latest$' "$SW_TMP/calls.log"
    [[ "$output" == *"caddy:2-alpine cached (auth proxy)"* ]]
    [[ "$output" == *"cloudflared cached (named tunnel)"* ]]
}

# ---------------------------------------------------------------------------
# Both images already cached + tunnelsEnabled=true → no pull invoked.
# Pin this so the preflight stays fast on the common case (warm cache).
# ---------------------------------------------------------------------------

@test "tunnel-autopull: cached images + tunnelsEnabled=true → no pulls" {
    _install_docker_stub
    _prime_alpine_cached
    touch "$SW_TMP/.cached-caddy_2-alpine"
    touch "$SW_TMP/.cached-cloudflare_cloudflared_latest"
    _set_tunnels_enabled

    run _run_preflight_checks
    [ "$status" -eq 0 ]
    ! grep -q '^docker pull caddy:2-alpine$'  "$SW_TMP/calls.log"
    ! grep -q '^docker pull cloudflare/cloudflared:latest$' "$SW_TMP/calls.log"
}

# ---------------------------------------------------------------------------
# tunnelsEnabled=false → tunnel images are NOT inspected, NOT pulled.
# Users who never enable the feature don't pay the cost (and don't
# get confused by tunnel checks in the preflight output).
# ---------------------------------------------------------------------------

@test "tunnel-autopull: tunnelsEnabled=false → tunnel images skipped entirely" {
    _install_docker_stub
    _prime_alpine_cached
    _set_tunnels_disabled

    run _run_preflight_checks
    [ "$status" -eq 0 ]
    ! grep -q '^docker pull caddy:2-alpine$'  "$SW_TMP/calls.log"
    ! grep -q '^docker pull cloudflare/cloudflared:latest$' "$SW_TMP/calls.log"
    [[ "$output" != *"caddy:2-alpine"* ]]
    [[ "$output" != *"cloudflared cached"* ]]
}

@test "tunnel-autopull: tunnelsEnabled field absent → no tunnel pulls (back-compat)" {
    _install_docker_stub
    _prime_alpine_cached
    _set_no_tunnel_field

    run _run_preflight_checks
    [ "$status" -eq 0 ]
    ! grep -q '^docker pull caddy:2-alpine$' "$SW_TMP/calls.log"
}
