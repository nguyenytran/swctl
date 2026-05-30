#!/usr/bin/env bats

load test_helper

# Regression guard for `_resume_fast_path_heal` (v0.6.21, 2026-05-17).
#
# Background: see helper's header comment in swctl.  Short version:
# under heavy load, postflight could false-alarm and tag STATUS=failed
# on a healthy instance.  Pre-0.6.21 the user's UI Retry triggered a
# full ~10 min re-provision pipeline that would itself false-alarm
# again — an unwinnable retry loop.  0.6.21 short-circuits: when
# STATUS=failed AND the container is running AND postflight passes
# right now, flip STATUS=complete in ~3 s and return.
#
# Tests stub `container_running` + `_postflight_instance_ready` +
# `write_metadata` so we can pin the four decision paths
# deterministically.

setup() {
    SW_TMP="$(mktemp -d)"
    SWCTL_ACTIVE_META_FILE="$SW_TMP/instance.env"
    ISSUE_ID="6072"
    COMPOSE_PROJECT="trunk-6072"
    APP_URL="http://web.trunk-6072.orb.local"
    SW_SERVICE_NAME="web"
    export SW_TMP SWCTL_ACTIVE_META_FILE ISSUE_ID COMPOSE_PROJECT APP_URL SW_SERVICE_NAME

    # Silence helper's user-facing log lines.
    info() { :; }
    ok()   { :; }
    warn() { :; }
    err()  { :; }
    export -f info ok warn err

    # write_metadata mock — records the call by writing what STATUS +
    # FAILED_AT looked like at write time, so tests can assert on the
    # post-flip state.
    write_metadata() {
        printf 'STATUS=%s\nFAILED_AT=%s\n' "${STATUS:-}" "${FAILED_AT:-}" > "$1"
    }
    export -f write_metadata
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# ---------------------------------------------------------------------------
# STATUS=failed + container running + postflight passes → fast-path
# heals the registry without re-provisioning.  The #6072 case.
# ---------------------------------------------------------------------------

@test "_resume_fast_path_heal: failed + container up + postflight ok → flips to complete" {
    STATUS="failed"; FAILED_AT="some-stale-reason"
    container_running()         { return 0; }
    _postflight_instance_ready() { return 0; }
    export -f container_running _postflight_instance_ready

    set +e
    _resume_fast_path_heal
    rc=$?
    set -e

    [ "$rc" -eq 0 ]
    [ "$STATUS" = "complete" ]
    [ -z "$FAILED_AT" ]
    grep -q '^STATUS=complete$' "$SWCTL_ACTIVE_META_FILE"
    ! grep -q '^FAILED_AT=some-stale-reason$' "$SWCTL_ACTIVE_META_FILE"
}

# ---------------------------------------------------------------------------
# STATUS=failed + container running + postflight FAILS → fall through to
# full resume.  Pin the negative: registry must NOT be flipped to
# complete on a real failure.
# ---------------------------------------------------------------------------

@test "_resume_fast_path_heal: failed + container up + postflight fails → returns 1, no flip" {
    STATUS="failed"; FAILED_AT="real-failure"
    container_running()         { return 0; }
    _postflight_instance_ready() { return 1; }
    export -f container_running _postflight_instance_ready

    set +e
    _resume_fast_path_heal
    rc=$?
    set -e

    [ "$rc" -eq 1 ]
    [ "$STATUS" = "failed" ]
    [ "$FAILED_AT" = "real-failure" ]
    # write_metadata must NOT have been called → file must not exist.
    [ ! -f "$SWCTL_ACTIVE_META_FILE" ]
}

# ---------------------------------------------------------------------------
# STATUS=failed but container NOT running → fast-path is the wrong tool;
# fall through to full resume so the container actually gets created.
# ---------------------------------------------------------------------------

@test "_resume_fast_path_heal: failed + container down → returns 1, no postflight call" {
    STATUS="failed"; FAILED_AT="container-stopped"
    container_running()         { return 1; }
    _postflight_instance_ready() {
        # Should never reach here.  Touch a marker file so we can assert.
        touch "$SW_TMP/postflight-was-called"
        return 0
    }
    export -f container_running _postflight_instance_ready

    set +e
    _resume_fast_path_heal
    rc=$?
    set -e

    [ "$rc" -eq 1 ]
    [ "$STATUS" = "failed" ]
    [ ! -f "$SW_TMP/postflight-was-called" ]
}

# ---------------------------------------------------------------------------
# STATUS=creating → fast-path explicitly skipped (the instance was
# never finished, so re-provisioning IS the right answer).  Pin this
# to prevent a future "make fast-path apply to creating too" regression.
# ---------------------------------------------------------------------------

@test "_resume_fast_path_heal: STATUS=creating → returns 1 (no fast-path)" {
    STATUS="creating"; FAILED_AT=""
    container_running()         { return 0; }
    _postflight_instance_ready() { return 0; }
    export -f container_running _postflight_instance_ready

    set +e
    _resume_fast_path_heal
    rc=$?
    set -e

    [ "$rc" -eq 1 ]
    [ "$STATUS" = "creating" ]
}

# ---------------------------------------------------------------------------
# STATUS=provisioning-deferred → same rule: not eligible.  The
# work hasn't run yet; full resume must take over.
# ---------------------------------------------------------------------------

@test "_resume_fast_path_heal: STATUS=provisioning-deferred → returns 1 (no fast-path)" {
    STATUS="provisioning-deferred"; FAILED_AT=""
    container_running()         { return 0; }
    _postflight_instance_ready() { return 0; }
    export -f container_running _postflight_instance_ready

    set +e
    _resume_fast_path_heal
    rc=$?
    set -e

    [ "$rc" -eq 1 ]
    [ "$STATUS" = "provisioning-deferred" ]
}
