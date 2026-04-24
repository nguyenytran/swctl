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

# ---------------------------------------------------------------------------
# _ensure_alpine_image + stderr-surface guards (v0.5.9)
#
# Regression guards for the user-reported symptom:
#   [ERR] Failed to populate volume 'vendor-base-trunk' from '<path>'
# …with no further detail, caused by:
#   (a) alpine:latest not cached locally, Docker auto-pulled silently,
#       pull failed under `2>/dev/null` in the populate docker run
#   (b) any genuine docker/cp error being hidden by the same redirect
# ---------------------------------------------------------------------------

@test "_ensure_alpine_image: idempotent when alpine is already cached" {
    # alpine is guaranteed present — require_docker in setup triggers
    # a pull, and most other tests already ran it.  First call is
    # normally a no-op; second is definitely a no-op.
    run _ensure_alpine_image
    [ "$status" -eq 0 ]
    run _ensure_alpine_image
    [ "$status" -eq 0 ]
}

@test "_ensure_alpine_image: pulls when image missing (user-reported repro)" {
    # This is the ACTUAL bug the user hit: alpine:latest wasn't cached
    # on their daemon, the populate's auto-pull under `2>/dev/null`
    # lost its output, and "Failed to populate volume X from Y" came
    # back with no clue that the cause was a missing image.
    #
    # Force the scenario by removing alpine (best-effort — if another
    # running container is using it, docker will block the rm; we skip
    # in that case since there's no way to force-remove safely).
    if ! docker image rm alpine:latest >/dev/null 2>&1; then
        skip "alpine:latest is in use by another container — can't force the uncached scenario"
    fi
    run _ensure_alpine_image
    [ "$status" -eq 0 ]
    # Post-condition: alpine must be cached now.
    docker image inspect alpine:latest >/dev/null 2>&1
    # Log must announce the pull (user-visible signal that explains the
    # delay and differentiates "first create is slow" from "daemon hung").
    [[ "$output" == *"Pulling alpine"* ]]
}

@test "populate: early guard (missing src) emits actionable warning" {
    # Covers the $src pre-check at the top of _ensure_base_volume_populated.
    # Distinct from the "inside-container failure" test below — this
    # path never reaches docker run.
    run _ensure_base_volume_populated "$_it_vol" "/definitely/nonexistent/src-$$" "autoload.php"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Source"*"missing"* ]] || [[ "$output" == *"missing"* ]]
}

@test "populate: inside-container failure emits docker stderr (regression guard)" {
    # Shim `docker` so the populate's `docker run` exits with a known
    # stderr message.  Other docker calls (inspect / create / fast-path
    # check / image inspect) pass through to the real CLI, so setup
    # state is correct up to the populate step.
    #
    # This is the test that would have caught the v0.5.9 user bug
    # directly: before the 2>"$run_err" fix, the populate docker run
    # swallowed this stderr and the user saw only the generic
    # "Failed to populate volume" message.
    local magic='SIMULATED_POPULATE_FAILURE_EFB3A1'
    docker() {
        # Only intercept the populate's `docker run cp -a`: it's the
        # only invocation that bind-mounts `:/src:ro`.
        if [ "$1" = "run" ] && printf '%s\n' "$@" | grep -q ':/src:ro'; then
            # Emit to stderr so the caller's 2>"$run_err" capture sees
            # it (swapping the order reveals the bug cleanly).
            printf '%s\n' "$magic" >&2
            return 1
        fi
        command docker "$@"
    }

    run _ensure_base_volume_populated "$_it_vol" "$_it_src" "autoload.php"
    [ "$status" -ne 0 ]
    # The magic string must appear in $output — that's the whole point
    # of the stderr-capture fix.
    [[ "$output" == *"$magic"* ]] || {
        echo "FAIL: expected docker stderr '$magic' in output, got:" >&2
        echo "$output" >&2
        return 1
    }
    # The swctl-level "Failed to populate..." error must also appear —
    # it's what sets up the "here's why" follow-up.
    [[ "$output" == *"Failed to populate volume"* ]]
    # Cleanup: remove the function shim so later tests see the real docker.
    unset -f docker
}

@test "clone uses the same stderr-surface path as populate" {
    # Hard to trigger a real docker-level clone failure in a unit
    # test — docker's `-v <vol>:/src:ro` auto-creates missing volumes
    # rather than erroring.  Instead, verify structurally: the clone
    # function uses the same mktemp+sed+unlink pattern as populate
    # (which IS regression-tested above).  If someone reverts one
    # and not the other, this catches the drift.
    run grep -c 'mktemp' <(declare -f _clone_docker_volume)
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output")" -ge 1 ]
    run grep -c 'sed .s/\^/  /' <(declare -f _clone_docker_volume)
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output")" -ge 1 ]
}
