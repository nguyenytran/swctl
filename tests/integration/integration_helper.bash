#!/usr/bin/env bash
# Shared helper for swctl integration tests.  Sourced via `load` in each bats file.
#
# - Sources swctl (gives access to internal helpers like _ensure_base_volume_populated).
# - Provides `require_docker` which skips the test when docker is unavailable.
# - Provides `it_uniq` which returns a process-unique + test-unique identifier
#   so tests never collide on docker volume / network / container names.
# - Provides `it_cleanup_volume / _network / _container` for idempotent teardown.
#
# Tests in this directory WILL create real docker volumes, networks, and
# containers.  Every resource is prefixed with `swctl-it-` so a stray
# `docker system prune` can clean up if a test crashed before teardown.

export SWCTL_SOURCED=1
# shellcheck source=../../swctl
source "$BATS_TEST_DIRNAME/../../swctl"

require_docker() {
    if ! command -v docker >/dev/null 2>&1; then
        skip "docker CLI not available"
    fi
    if ! docker info >/dev/null 2>&1; then
        skip "docker daemon not running"
    fi
}

# Unique-per-test-and-process identifier, safe for docker resource names.
# Callers: `local vol="$(it_uniq)-vendor"` — gives something like
# `swctl-it-99342-3-vendor`.
it_uniq() {
    printf 'swctl-it-%d-%s' "$$" "${BATS_TEST_NUMBER:-0}"
}

it_cleanup_volume() {
    local v="$1"
    [ -n "$v" ] || return 0
    docker volume rm -f "$v" >/dev/null 2>&1 || true
}

it_cleanup_container() {
    local c="$1"
    [ -n "$c" ] || return 0
    docker rm -f "$c" >/dev/null 2>&1 || true
}

it_cleanup_network() {
    local n="$1"
    [ -n "$n" ] || return 0
    docker network rm "$n" >/dev/null 2>&1 || true
}
