#!/usr/bin/env bats

load test_helper

# Regression guard for `_postflight_docker_check` (v0.6.20, 2026-05-17).
#
# Background: v0.6.13 added retry-with-backoff to ONE postflight
# check (/admin reachable).  Under heavy host load (load avg > 30
# from Spotlight indexing + Claude Desktop + Chrome competing for
# cores) the OTHER 4 postflight checks — `docker exec test -f` for
# vendor/index.php/public-media and `bin/console debug:container`
# for DB — could still false-alarm because they were single-shot.
# (#15266 incident 2026-05-17: every postflight check passed
# manually 30 s after create, but the create flow had already tagged
# STATUS=failed because one of the file-existence checks transient-
# timed-out on the busy docker daemon.)
#
# v0.6.20: generalise the retry shape into `_postflight_docker_check`
# — 2 attempts × 2 s backoff.  All `docker exec` postflight checks
# go through it.  Trivial-success path (the common case) returns in
# the same time as before; transient stalls heal automatically;
# genuinely-broken containers still fail in <100 ms (both attempts
# fail fast).
#
# Tests use a stub docker that simulates flaky exec via a counter
# file.

setup() {
    SW_TMP="$(mktemp -d)"
    export SW_TMP
    # Pin the postflight retry helper's container var so the stub
    # always sees a consistent "container" arg.
    container="stub-container"
    export container

    # Stub docker.  Reads $SW_TMP/exec-policy to decide what
    # `docker exec stub-container sh -c '<cmd>'` should return.
    # Policy lines (one per attempt):
    #     0  -> success
    #     1  -> failure
    # Stub also writes the call count to $SW_TMP/exec-count.
    cat > "$SW_TMP/docker" <<'SH'
#!/usr/bin/env bash
if [ "$1" = "exec" ]; then
    count=$(cat "$SW_TMP/exec-count" 2>/dev/null || echo 0)
    next=$((count + 1))
    echo "$next" > "$SW_TMP/exec-count"
    # Read the Nth line of exec-policy.
    line=$(sed -n "${next}p" "$SW_TMP/exec-policy" 2>/dev/null)
    exit "${line:-0}"
fi
exit 0
SH
    chmod +x "$SW_TMP/docker"
    PATH="$SW_TMP:$PATH"
    export PATH

    # Silence the helper's stderr.
    info() { :; }
    ok()   { :; }
    warn() { :; }
    err()  { :; }
    export -f info ok warn err
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# Define _postflight_docker_check INLINE in each test by extracting
# it from swctl.  Cheaper than re-sourcing the whole file.  Pattern
# matches the helper's exact body so a refactor would break the test
# (which is desired — we want to know).
_load_helper() {
    sed -n '/^    _postflight_docker_check() {/,/^    }/p' "$BATS_TEST_DIRNAME/../swctl" \
        | sed 's/^    //' > "$SW_TMP/helper.sh"
    # shellcheck disable=SC1091
    . "$SW_TMP/helper.sh"
}

# ---------------------------------------------------------------------------
# Happy path: first attempt succeeds → no retry → returns 0.
# ---------------------------------------------------------------------------

@test "_postflight_docker_check: 1-attempt success → returns 0 (no retry)" {
    printf '0\n' > "$SW_TMP/exec-policy"
    _load_helper
    run _postflight_docker_check 'test -f /some/file'
    [ "$status" -eq 0 ]
    # Only one docker exec call made.
    [ "$(cat "$SW_TMP/exec-count")" = "1" ]
}

# ---------------------------------------------------------------------------
# The actual incident: first attempt fails (transient daemon stall),
# second succeeds (load just dropped).  v0.6.20 catches this; v0.6.19
# would have tagged STATUS=failed.
# ---------------------------------------------------------------------------

@test "_postflight_docker_check: fail-then-success → returns 0 (transient stall healed)" {
    printf '1\n0\n' > "$SW_TMP/exec-policy"
    _load_helper
    run _postflight_docker_check 'test -f /some/file'
    [ "$status" -eq 0 ]
    [ "$(cat "$SW_TMP/exec-count")" = "2" ]
}

# ---------------------------------------------------------------------------
# Genuinely broken: both attempts fail → returns 1.  Test the
# negative path so we don't accidentally make the check always-pass.
# ---------------------------------------------------------------------------

@test "_postflight_docker_check: both attempts fail → returns 1 (genuinely broken)" {
    printf '1\n1\n' > "$SW_TMP/exec-policy"
    _load_helper
    run _postflight_docker_check 'test -f /some/file'
    [ "$status" -eq 1 ]
    [ "$(cat "$SW_TMP/exec-count")" = "2" ]
}

# ---------------------------------------------------------------------------
# Bound: helper retries at MOST 2 attempts (1 initial + 1 retry).
# Pin this so a refactor doesn't accidentally bump it to 5 attempts
# (which would make the postflight take forever on real failures).
# ---------------------------------------------------------------------------

@test "_postflight_docker_check: never makes more than 2 attempts" {
    # Always fail; assert exactly 2 attempts.
    printf '1\n1\n1\n1\n1\n' > "$SW_TMP/exec-policy"
    _load_helper
    run _postflight_docker_check 'test -f /some/file'
    [ "$status" -eq 1 ]
    [ "$(cat "$SW_TMP/exec-count")" = "2" ]
}
