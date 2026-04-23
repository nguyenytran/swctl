#!/usr/bin/env bats

load integration_helper

# Integration tests for the Tier-1 shared-volume plumbing:
#   _ensure_base_volume_populated  — populate a docker volume from a host
#                                    source dir, idempotently, with
#                                    .ready sentinel + uid 1000 ownership.
#   _clone_docker_volume           — copy one docker volume to another
#                                    with the same sentinel + chown.
#
# Locks down the v0.5.1 hotfix (idempotent populate, no rm -rf) and the
# v0.5.2 hotfix (chown -R 1000:1000 for container writability).

setup() {
    require_docker
    _it_src="$BATS_TEST_TMPDIR/src-$$"
    _it_vol="$(it_uniq)-vol"
    _it_vol2="$(it_uniq)-vol2"
    mkdir -p "$_it_src/sub"
    printf 'hello\n'       > "$_it_src/autoload.php"
    printf 'contents\n'    > "$_it_src/sub/file.txt"
}

teardown() {
    it_cleanup_volume "$_it_vol"
    it_cleanup_volume "$_it_vol2"
}

# ---------------------------------------------------------------------------
# _ensure_base_volume_populated
# ---------------------------------------------------------------------------

@test "volume populate: copies source files into fresh volume" {
    run _ensure_base_volume_populated "$_it_vol" "$_it_src" "autoload.php"
    [ "$status" -eq 0 ]
    # Verify content landed
    docker run --rm -v "${_it_vol}:/v" alpine cat /v/autoload.php | grep -q hello
    docker run --rm -v "${_it_vol}:/v" alpine cat /v/sub/file.txt | grep -q contents
}

@test "volume populate: writes .ready sentinel LAST" {
    _ensure_base_volume_populated "$_it_vol" "$_it_src" "autoload.php"
    run docker run --rm -v "${_it_vol}:/v" alpine test -f /v/.ready
    [ "$status" -eq 0 ]
}

@test "volume populate: chowns everything to uid 1000 (container write access)" {
    # Regression guard: before the v0.5.2 chown fix, container's www-data
    # (uid 1000) couldn't write node_modules/.vite-temp/ → Vite crashed
    # with EACCES.  Verify the fix stays in place.
    _ensure_base_volume_populated "$_it_vol" "$_it_src" "autoload.php"
    owners="$(docker run --rm -v "${_it_vol}:/v" alpine sh -c 'find /v -maxdepth 2 -exec stat -c "%u" {} +' | sort -u)"
    # Only uid 1000 should appear (and possibly the 0 for the mount root
    # itself, but our chown -R covers everything).
    [ "$owners" = "1000" ]
}

@test "volume populate: idempotent — second call is a no-op" {
    _ensure_base_volume_populated "$_it_vol" "$_it_src" "autoload.php"
    # Touch a timestamp marker — second populate should NOT wipe it
    # (v0.5.1 hotfix: idempotent cp -a, no rm -rf).
    docker run --rm -v "${_it_vol}:/v" alpine touch /v/idempotence-marker
    run _ensure_base_volume_populated "$_it_vol" "$_it_src" "autoload.php"
    [ "$status" -eq 0 ]
    run docker run --rm -v "${_it_vol}:/v" alpine test -f /v/idempotence-marker
    [ "$status" -eq 0 ]
}

@test "volume populate: sentinel check short-circuits on second call" {
    # The fast-path check skips re-running cp entirely.  Verify by making
    # the source UNREADABLE and calling populate again — it should still
    # succeed because it never touches the source.
    _ensure_base_volume_populated "$_it_vol" "$_it_src" "autoload.php"
    rm -rf "$_it_src"
    run _ensure_base_volume_populated "$_it_vol" "$_it_src" "autoload.php"
    [ "$status" -eq 0 ]
}

@test "volume populate: missing source + no existing volume → non-zero exit" {
    rm -rf "$_it_src"
    run _ensure_base_volume_populated "$_it_vol" "$_it_src" "autoload.php"
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# _clone_docker_volume
# ---------------------------------------------------------------------------

@test "volume clone: copies src contents to dst" {
    _ensure_base_volume_populated "$_it_vol" "$_it_src" "autoload.php"
    run _clone_docker_volume "$_it_vol" "$_it_vol2"
    [ "$status" -eq 0 ]
    docker run --rm -v "${_it_vol2}:/v" alpine cat /v/autoload.php | grep -q hello
    docker run --rm -v "${_it_vol2}:/v" alpine cat /v/sub/file.txt | grep -q contents
}

@test "volume clone: writes .ready sentinel on destination" {
    _ensure_base_volume_populated "$_it_vol" "$_it_src" "autoload.php"
    _clone_docker_volume "$_it_vol" "$_it_vol2"
    run docker run --rm -v "${_it_vol2}:/v" alpine test -f /v/.ready
    [ "$status" -eq 0 ]
}

@test "volume clone: chowns destination to uid 1000" {
    _ensure_base_volume_populated "$_it_vol" "$_it_src" "autoload.php"
    _clone_docker_volume "$_it_vol" "$_it_vol2"
    owners="$(docker run --rm -v "${_it_vol2}:/v" alpine sh -c 'find /v -maxdepth 2 -exec stat -c "%u" {} +' | sort -u)"
    [ "$owners" = "1000" ]
}

@test "volume clone: creates destination volume if missing" {
    _ensure_base_volume_populated "$_it_vol" "$_it_src" "autoload.php"
    # dst volume doesn't exist yet
    run docker volume inspect "$_it_vol2"
    [ "$status" -ne 0 ]
    _clone_docker_volume "$_it_vol" "$_it_vol2"
    run docker volume inspect "$_it_vol2"
    [ "$status" -eq 0 ]
}
