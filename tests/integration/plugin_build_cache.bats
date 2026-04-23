#!/usr/bin/env bats

load integration_helper

# Integration tests for the Tier-2B plugin build cache:
#   _plugin_build_cache_hit                    — detect if a cache is ready
#   _populate_plugin_build_cache               — write + mark ready
#   _populate_plugin_build_cache_if_missing    — serialised, idempotent
#
# The cache holds `<plugin-worktree>/src/Resources/public/` under a
# content-addressed docker volume (`pb-<name>-<head>-<lock>`).
# Cache HIT ⇒ mount RO over the plugin worktree, skip the 60–90 s npm
# admin build.

setup() {
    require_docker
    _it_plugin="$BATS_TEST_TMPDIR/plugin-$$"
    _it_vol="$(it_uniq)-pb"
    # A minimal plugin worktree with a populated Resources/public/
    mkdir -p "$_it_plugin/src/Resources/public/administration/.vite"
    printf '{"entryPoints":{}}\n' \
        > "$_it_plugin/src/Resources/public/administration/.vite/entrypoints.json"
    printf '{}\n' \
        > "$_it_plugin/src/Resources/public/administration/.vite/manifest.json"
    mkdir -p "$_it_plugin/src/Resources/public/administration/assets"
    printf 'console.log(1)\n' \
        > "$_it_plugin/src/Resources/public/administration/assets/main.js"
}

teardown() {
    it_cleanup_volume "$_it_vol"
}

# ---------------------------------------------------------------------------
# _plugin_build_cache_hit
# ---------------------------------------------------------------------------

@test "cache hit: returns non-zero when volume doesn't exist" {
    run _plugin_build_cache_hit "$_it_vol"
    [ "$status" -ne 0 ]
}

@test "cache hit: returns non-zero when volume exists but empty" {
    docker volume create "$_it_vol" >/dev/null
    run _plugin_build_cache_hit "$_it_vol"
    [ "$status" -ne 0 ]
}

@test "cache hit: returns non-zero when entrypoints.json present but .ready missing" {
    # This simulates an in-flight populate that hasn't reached its final step.
    # Critical regression guard: before the .ready sentinel, a parallel
    # read could mount a volume where cp -a had written some files but not
    # others → admin UI broken.
    docker volume create "$_it_vol" >/dev/null
    docker run --rm -v "${_it_vol}:/v" alpine sh -c '
        mkdir -p /v/administration/.vite
        touch /v/administration/.vite/entrypoints.json
    '
    run _plugin_build_cache_hit "$_it_vol"
    [ "$status" -ne 0 ]
}

@test "cache hit: returns 0 when both sentinels present" {
    docker volume create "$_it_vol" >/dev/null
    docker run --rm -v "${_it_vol}:/v" alpine sh -c '
        mkdir -p /v/administration/.vite
        touch /v/administration/.vite/entrypoints.json /v/.ready
    '
    run _plugin_build_cache_hit "$_it_vol"
    [ "$status" -eq 0 ]
}

@test "cache hit: empty volume name → non-zero" {
    run _plugin_build_cache_hit ""
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# _populate_plugin_build_cache
# ---------------------------------------------------------------------------

@test "populate: writes Resources/public contents into volume" {
    run _populate_plugin_build_cache "$_it_vol" "$_it_plugin"
    [ "$status" -eq 0 ]
    docker run --rm -v "${_it_vol}:/v" alpine cat /v/administration/.vite/entrypoints.json | grep -q entryPoints
    docker run --rm -v "${_it_vol}:/v" alpine test -f /v/administration/assets/main.js
}

@test "populate: writes .ready sentinel" {
    _populate_plugin_build_cache "$_it_vol" "$_it_plugin"
    run docker run --rm -v "${_it_vol}:/v" alpine test -f /v/.ready
    [ "$status" -eq 0 ]
}

@test "populate: chowns everything to uid 1000" {
    _populate_plugin_build_cache "$_it_vol" "$_it_plugin"
    owners="$(docker run --rm -v "${_it_vol}:/v" alpine sh -c 'find /v -maxdepth 3 -exec stat -c "%u" {} +' | sort -u)"
    [ "$owners" = "1000" ]
}

@test "populate: refuses when entrypoints.json missing (build-failure detection)" {
    # This is how we protect against caching a broken build output.  If
    # the admin build silently produced no entrypoints.json (old bug),
    # populate must NOT stamp a ready volume — otherwise every future
    # create of this commit would serve the empty cache.
    rm -rf "$_it_plugin/src/Resources/public/administration"
    run _populate_plugin_build_cache "$_it_vol" "$_it_plugin"
    [ "$status" -ne 0 ]
    # Volume must either not exist or not have .ready
    if docker volume inspect "$_it_vol" >/dev/null 2>&1; then
        run docker run --rm -v "${_it_vol}:/v" alpine test -f /v/.ready
        [ "$status" -ne 0 ]
    fi
}

@test "populate: refuses when Resources/public missing" {
    rm -rf "$_it_plugin/src/Resources"
    run _populate_plugin_build_cache "$_it_vol" "$_it_plugin"
    [ "$status" -ne 0 ]
}

@test "populate: labels the volume as plugin-build (for cmd_volume list discovery)" {
    _populate_plugin_build_cache "$_it_vol" "$_it_plugin"
    label="$(docker volume inspect "$_it_vol" --format '{{index .Labels "swctl.kind"}}')"
    [ "$label" = "plugin-build" ]
}

# ---------------------------------------------------------------------------
# _populate_plugin_build_cache_if_missing — the locked variant
# ---------------------------------------------------------------------------

@test "populate_if_missing: populates when no .ready exists" {
    _populate_plugin_build_cache_if_missing "$_it_vol" "$_it_plugin"
    run docker run --rm -v "${_it_vol}:/v" alpine test -f /v/.ready
    [ "$status" -eq 0 ]
}

@test "populate_if_missing: skips when .ready already present (lock-safe)" {
    # First populate
    _populate_plugin_build_cache_if_missing "$_it_vol" "$_it_plugin"
    # Put a marker that the second populate would wipe if it ran again
    docker run --rm -v "${_it_vol}:/v" alpine touch /v/do-not-wipe
    # Simulate a concurrent create arriving after the lock released
    _populate_plugin_build_cache_if_missing "$_it_vol" "$_it_plugin"
    # The marker must survive
    run docker run --rm -v "${_it_vol}:/v" alpine test -f /v/do-not-wipe
    [ "$status" -eq 0 ]
}
