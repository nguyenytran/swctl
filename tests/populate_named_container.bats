#!/usr/bin/env bats

load test_helper

# Regression guard for the v0.6.22 named-populate-container fix
# (2026-05-18).
#
# Background: `docker run --rm alpine cp -a` doesn't tie its container
# lifetime to the parent shell.  If swctl gets SIGKILL'd (UI restart,
# OOM, Ctrl-C) mid-populate, the alpine container keeps running
# orphaned.  Pre-0.6.22, the next swctl run would remove the
# now-stale swctl_lock (the parent shell's pid is dead) and spawn a
# SECOND `cp -a` racing the orphan on the same destination volume —
# partial files, weird perms, occasional hangs.  (Symptom user
# reported 2026-05-18: "create stuck at 30% with [WARN] Removing
# stale lock 'volume-admin-nm-base-shopware' (pid 246 is dead)".)
#
# v0.6.22: name the populate container deterministically
# (`swctl-populate-<vol>`), pre-emptively `docker rm -f` it before
# the run, and clean up after a failed run.  Docker enforces
# uniqueness atomically so even if the lock somehow leaks, the
# second invocation cannot start a parallel cp.
#
# These tests stub the entire `docker` command — they don't actually
# touch the daemon — and assert the sequence of invocations.

setup() {
    SW_TMP="$(mktemp -d)"
    DOCKER_CALLS_FILE="$SW_TMP/docker-calls"
    : > "$DOCKER_CALLS_FILE"
    export SW_TMP DOCKER_CALLS_FILE

    # Stub docker.  Records every invocation into $DOCKER_CALLS_FILE
    # and consults a per-test policy for return codes.
    #     - `docker run --name <n> ...` → exit code from $SW_TMP/run-exit (default 0)
    #     - `docker rm -f <n>`           → exit code 0 (always succeeds)
    #     - `docker volume inspect ...`  → exit code from $SW_TMP/volume-inspect-exit (default 0)
    #     - `docker volume create ...`   → exit 0
    #     - everything else              → exit 0
    cat > "$SW_TMP/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_CALLS_FILE"
case "$1" in
    run)    exit "$(cat "$SW_TMP/run-exit" 2>/dev/null || echo 0)" ;;
    rm)     exit 0 ;;
    volume)
        case "$2" in
            inspect) exit "$(cat "$SW_TMP/volume-inspect-exit" 2>/dev/null || echo 0)" ;;
            create)  exit 0 ;;
        esac
        ;;
esac
exit 0
SH
    chmod +x "$SW_TMP/docker"
    PATH="$SW_TMP:$PATH"
    export PATH

    # Silence swctl's user-facing log lines.
    info() { :; }
    ok()   { :; }
    warn() { :; }
    err()  { :; }
    # _ensure_alpine_image is a separate dependency; stub it as a no-op
    # so we don't accidentally cover its logic in this test.
    _ensure_alpine_image() { :; }
    export -f info ok warn err _ensure_alpine_image

    # Source dir for cp -a — must exist or _ensure_base_volume_populated
    # bails with the "Source missing" warn before reaching docker run.
    SRC_DIR="$SW_TMP/source"
    mkdir -p "$SRC_DIR"
    export SRC_DIR
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# ---------------------------------------------------------------------------
# Happy path: volume not yet populated, no orphan present → docker rm -f
# fires first (idempotent cleanup), then docker run --name fires, no
# trailing rm because run succeeded.
# ---------------------------------------------------------------------------

@test "_ensure_base_volume_populated: names populate container as swctl-populate-<vol>" {
    # First inspect returns 1 → triggers `docker volume create`.
    # Second inspect (the fast-path `docker run alpine sh -c 'test -f .ready'`)
    # is actually a `docker run`, not `docker volume inspect`.  Pre-populate
    # the volume-inspect to "exists" so create is skipped.
    echo 0 > "$SW_TMP/volume-inspect-exit"
    # Fast-path check: stub the run to fail (no .ready yet) so we reach
    # the slow-path cp -a.  We special-case via a counter file.
    cat > "$SW_TMP/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_CALLS_FILE"
case "$1" in
    run)
        # The fast-path check is a `docker run --rm -v vol:/v alpine sh -c "test -f /v/.ready && ..."`.
        # The slow-path cp is `docker run --rm --name swctl-populate-<vol> ...`.
        # Distinguish by --name presence.
        if [[ "$*" == *"--name swctl-populate-"* ]]; then
            exit 0   # slow-path success
        fi
        exit 1       # fast-path miss → fall through to slow-path
        ;;
    rm)     exit 0 ;;
    volume) exit 0 ;;
esac
exit 0
SH
    chmod +x "$SW_TMP/docker"

    run _ensure_base_volume_populated "admin-nm-base-trunk" "$SRC_DIR" "autoload.php" ""
    [ "$status" -eq 0 ]

    # The pre-emptive `docker rm -f swctl-populate-admin-nm-base-trunk` must appear.
    grep -q '^rm -f swctl-populate-admin-nm-base-trunk' "$DOCKER_CALLS_FILE"
    # The actual populate run must use that exact --name.
    grep -q '\--name swctl-populate-admin-nm-base-trunk' "$DOCKER_CALLS_FILE"
    # Should NOT have called a trailing rm cleanup (run succeeded).
    [ "$(grep -c '^rm -f swctl-populate-admin-nm-base-trunk' "$DOCKER_CALLS_FILE")" = "1" ]
}

# ---------------------------------------------------------------------------
# Pre-existing orphan: `docker rm -f` is the orphan-kill — it runs whether
# or not an orphan exists (idempotent — that's the design).  Pin this so
# a future refactor doesn't accidentally add a "check first" guard that
# re-introduces the race window.
# ---------------------------------------------------------------------------

@test "_ensure_base_volume_populated: docker rm -f runs unconditionally (idempotent orphan kill)" {
    cat > "$SW_TMP/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_CALLS_FILE"
case "$1" in
    run)
        if [[ "$*" == *"--name swctl-populate-"* ]]; then exit 0; fi
        exit 1   # fast-path miss
        ;;
    rm|volume) exit 0 ;;
esac
exit 0
SH
    chmod +x "$SW_TMP/docker"

    run _ensure_base_volume_populated "vendor-base-trunk" "$SRC_DIR" "autoload.php" ""
    [ "$status" -eq 0 ]
    # The rm must precede the populate run in the call log (orphan-kill
    # runs first).  Use a regex over the file to assert order.
    awk '/^rm -f swctl-populate-vendor-base-trunk$/ { saw_rm=NR }
         /\--name swctl-populate-vendor-base-trunk/ { saw_run=NR }
         END { exit !(saw_rm && saw_run && saw_rm < saw_run) }' "$DOCKER_CALLS_FILE"
}

# ---------------------------------------------------------------------------
# Failed populate: trailing `docker rm -f` must still run so the next
# invocation isn't blocked by a duplicate-name error from an exited-but-
# not-removed container.  Without this cleanup, docker leaves the
# container in "exited" state if the cp errored — the next swctl run
# would get "Conflict. The container name ... is already in use."
# ---------------------------------------------------------------------------

@test "_ensure_base_volume_populated: failed populate cleans up the named container" {
    cat > "$SW_TMP/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_CALLS_FILE"
case "$1" in
    run)
        if [[ "$*" == *"--name swctl-populate-"* ]]; then exit 1; fi  # FAIL the cp
        exit 1   # fast-path miss
        ;;
    rm|volume) exit 0 ;;
esac
exit 0
SH
    chmod +x "$SW_TMP/docker"

    run _ensure_base_volume_populated "admin-nm-base-trunk" "$SRC_DIR" "autoload.php" ""
    [ "$status" -eq 1 ]
    # Should see EXACTLY TWO `rm -f` calls: the pre-emptive one and the
    # cleanup-on-failure one.
    [ "$(grep -c '^rm -f swctl-populate-admin-nm-base-trunk' "$DOCKER_CALLS_FILE")" = "2" ]
}

# ---------------------------------------------------------------------------
# Same protection for `_clone_docker_volume`: when COMPOSER_CHANGES > 0
# the per-instance vendor volume is cloned via the same alpine pattern;
# the orphan-after-SIGKILL bug applies identically and is fixed the same
# way.  Container name is `swctl-clone-<dst>`.
# ---------------------------------------------------------------------------

@test "_clone_docker_volume: names container as swctl-clone-<dst> + idempotent pre-kill" {
    cat > "$SW_TMP/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_CALLS_FILE"
case "$1" in
    run)
        if [[ "$*" == *"--name swctl-clone-"* ]]; then exit 0; fi
        exit 0
        ;;
    rm|volume) exit 0 ;;
esac
exit 0
SH
    chmod +x "$SW_TMP/docker"

    run _clone_docker_volume "vendor-base-trunk" "vendor-12345"
    [ "$status" -eq 0 ]
    grep -q '^rm -f swctl-clone-vendor-12345' "$DOCKER_CALLS_FILE"
    grep -q '\--name swctl-clone-vendor-12345' "$DOCKER_CALLS_FILE"
}

@test "_clone_docker_volume: failed clone cleans up the named container" {
    cat > "$SW_TMP/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_CALLS_FILE"
case "$1" in
    run)
        if [[ "$*" == *"--name swctl-clone-"* ]]; then exit 1; fi
        exit 0
        ;;
    rm|volume) exit 0 ;;
esac
exit 0
SH
    chmod +x "$SW_TMP/docker"

    run _clone_docker_volume "vendor-base-trunk" "vendor-12345"
    [ "$status" -eq 1 ]
    [ "$(grep -c '^rm -f swctl-clone-vendor-12345' "$DOCKER_CALLS_FILE")" = "2" ]
}
