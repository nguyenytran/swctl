#!/usr/bin/env bats

load test_helper

# Regression guard for the v0.6.2 bug:
#
#   swctl create on a fresh OrbStack machine, after a successful
#   `swctl init`, fails preflight with:
#
#     [preflight] ✗ docker network (swctl-proxy)
#                 └─ Run 'swctl init' to create the shared network ...
#
# `init_infra` deliberately SKIPS creating swctl-proxy under OrbStack
# (every container is reachable at <container>.orb.local without a
# shared bridge), so the preflight check left swctl in a state no
# `swctl init` invocation could fix.
#
# Fix (v0.6.3): the network preflight now skips itself when
# `detect_runtime` reports orbstack — same guard init_infra uses.
# Traefik users still see the check.

setup() {
    SW_TMP="$(mktemp -d)"
    export SW_TMP
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# ---------------------------------------------------------------------------
# OrbStack: network preflight is a no-op (init_infra didn't create it,
# preflight shouldn't demand it).
# ---------------------------------------------------------------------------

@test "preflight: skips docker network check under OrbStack" {
    # Force runtime detection to OrbStack.  detect_runtime honors
    # SW_RUNTIME first, so this is a clean override.
    SW_RUNTIME=orbstack
    export SW_RUNTIME

    # Stubs for the OTHER preflight checks so failure-aggregation doesn't
    # mask the network skip we're testing.
    docker() {
        case "$1" in
            info)             return 0 ;;
            image)            return 0 ;;
            ps)               printf 'swctl-mariadb\n'; return 0 ;;
            network)
                # If reached, the test fails the assertion below — the
                # whole point is preflight does NOT call this under
                # OrbStack.
                printf '__NETWORK_INSPECT_CALLED__\n' >> "$SW_TMP/calls.log"
                return 0
                ;;
        esac
        return 0
    }
    export -f docker

    SWCTL_TEMPLATE_DIR="$SW_TMP/tpl"
    mkdir -p "$SWCTL_TEMPLATE_DIR"
    : > "$SWCTL_TEMPLATE_DIR/docker-compose.swctl.orbstack.yml"
    SW_WORKTREE_ROOT="$SW_TMP/worktrees"
    mkdir -p "$SW_WORKTREE_ROOT"
    export SWCTL_TEMPLATE_DIR SW_WORKTREE_ROOT

    run _run_preflight_checks
    [ "$status" -eq 0 ]
    # The network row must not appear in the output
    [[ "$output" != *"docker network ("* ]]
    # And the docker stub for `network` must NOT have been called
    [ ! -f "$SW_TMP/calls.log" ] || ! grep -q __NETWORK_INSPECT_CALLED__ "$SW_TMP/calls.log"
}

# ---------------------------------------------------------------------------
# Traefik: network preflight still runs (no behavior change for that path).
# ---------------------------------------------------------------------------

@test "preflight: runs docker network check under Traefik runtime" {
    SW_RUNTIME=traefik
    export SW_RUNTIME

    docker() {
        case "$1" in
            info)             return 0 ;;
            image)            return 0 ;;
            ps)               printf 'swctl-mariadb\n'; return 0 ;;
            network)
                # Record the call — this MUST happen under traefik
                printf '__NETWORK_INSPECT_CALLED__\n' >> "$SW_TMP/calls.log"
                return 0
                ;;
        esac
        return 0
    }
    export -f docker

    SWCTL_TEMPLATE_DIR="$SW_TMP/tpl"
    mkdir -p "$SWCTL_TEMPLATE_DIR"
    : > "$SWCTL_TEMPLATE_DIR/docker-compose.swctl.yml"
    SW_WORKTREE_ROOT="$SW_TMP/worktrees"
    mkdir -p "$SW_WORKTREE_ROOT"
    export SWCTL_TEMPLATE_DIR SW_WORKTREE_ROOT

    run _run_preflight_checks
    [ "$status" -eq 0 ]
    # Network check label appears in output
    [[ "$output" == *"docker network ("* ]]
    # And docker network was actually called
    grep -q __NETWORK_INSPECT_CALLED__ "$SW_TMP/calls.log"
}
