#!/usr/bin/env bats

load test_helper

# Regression guard for `_create_failure_finalize` (swctl helper).
#
# Bug this prevents (observed 2026-05-11): when `swctl create` failed
# early — before any actual artifacts (worktree dir, docker volumes,
# DB) were produced — the EXIT trap inside cmd_create wrote
# `STATUS=failed` into the instance .env and left it on disk.  The
# user then saw "[ERR] A worktree already exists for issue '<X>'" on
# the next `swctl create <same-issue>` because the .env was
# registry-visible.  `swctl clean` couldn't fully recover (see
# clean_idempotency.bats), so the user had to `rm` from
# `~/.local/state/swctl/instances` by hand.
#
# Fix: extract `_create_failure_finalize` and have it branch on the
# real on-disk state.  If WORKTREE_PATH exists, keep the .env and
# mark `STATUS=failed` so `swctl clean` knows what to tear down.  If
# WORKTREE_PATH is absent (the early-failure case), unlink the .env
# directly — there's nothing for clean to do, and the next create
# should succeed without manual intervention.
#
# Decision matrix locked down here:
#
#                                  WORKTREE_PATH exists | absent
#   STATUS=creating @ trap fire   | mark failed, keep   | unlink
#   STATUS=<terminal> @ trap fire | (trap is no-op*)    | (trap is no-op*)
#
# *cmd_create's outer trap is guarded by `[ "$STATUS" = "creating" ]`
# so a successful finalize (STATUS=running/done) never calls this
# helper.  These tests therefore only exercise the STATUS=creating
# branch — that's the whole reason _create_failure_finalize exists.

setup() {
    SW_TMP="$(mktemp -d)"
    SWCTL_ACTIVE_META_FILE="$SW_TMP/9999.env"
    cat > "$SWCTL_ACTIVE_META_FILE" <<EOF
SWCTL_META_VERSION=2
ISSUE_ID=9999
STATUS=creating
WORKTREE_PATH=$SW_TMP/wt-9999
EOF
    export SW_TMP SWCTL_ACTIVE_META_FILE

    # Silence diagnostic loggers; assertions key off file existence.
    info() { :; }
    ok()   { :; }
    warn() { :; }
    err()  { :; }
    export -f info ok warn err
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# ---------------------------------------------------------------------------
# Early-failure path: no worktree → registry .env is unlinked, the next
# `swctl create` for the same issue can proceed.
# ---------------------------------------------------------------------------

@test "_create_failure_finalize: unlinks .env when WORKTREE_PATH does NOT exist" {
    WORKTREE_PATH="$SW_TMP/wt-9999"   # set but no mkdir → directory absent

    [ -f "$SWCTL_ACTIVE_META_FILE" ]
    _create_failure_finalize
    [ ! -f "$SWCTL_ACTIVE_META_FILE" ]
}

@test "_create_failure_finalize: unlinks .env when WORKTREE_PATH is unset" {
    unset WORKTREE_PATH

    [ -f "$SWCTL_ACTIVE_META_FILE" ]
    _create_failure_finalize
    [ ! -f "$SWCTL_ACTIVE_META_FILE" ]
}

# ---------------------------------------------------------------------------
# Mid-failure path: worktree exists → keep the .env so `swctl clean`
# knows it has real artifacts to tear down; flip STATUS to 'failed' so
# the dashboard surfaces the broken instance for user review.
# ---------------------------------------------------------------------------

@test "_create_failure_finalize: keeps .env + marks failed when WORKTREE_PATH exists" {
    WORKTREE_PATH="$SW_TMP/wt-9999"
    mkdir -p "$WORKTREE_PATH"
    STATUS=creating
    # Stub write_metadata to record the call so we can assert it ran
    # with the expected STATUS, without involving the heavy real
    # write_metadata body (which dumps every swctl runtime var).
    write_metadata() {
        printf 'STATUS=%s\n' "${STATUS:-}" > "$SWCTL_ACTIVE_META_FILE"
    }
    export -f write_metadata

    _create_failure_finalize
    [ -f "$SWCTL_ACTIVE_META_FILE" ]
    grep -q 'STATUS=failed' "$SWCTL_ACTIVE_META_FILE"
}

# ---------------------------------------------------------------------------
# Defensive: missing SWCTL_ACTIVE_META_FILE is a graceful no-op.
# Without this guard, an unset variable would explode under `set -u`.
# ---------------------------------------------------------------------------

@test "_create_failure_finalize: no-op when SWCTL_ACTIVE_META_FILE is unset" {
    unset SWCTL_ACTIVE_META_FILE
    run _create_failure_finalize
    [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# FAILED_AT is recorded from SWCTL_LAST_ERROR (when set) so the .env
# captures *why* the create failed.  This is what `swctl status`
# shows under the failed-instance card.
# ---------------------------------------------------------------------------

@test "_create_failure_finalize: persists SWCTL_LAST_ERROR into FAILED_AT" {
    WORKTREE_PATH="$SW_TMP/wt-9999"
    mkdir -p "$WORKTREE_PATH"
    STATUS=creating
    SWCTL_LAST_ERROR="rebase conflict in foo.php"

    write_metadata() {
        printf 'STATUS=%s\nFAILED_AT=%s\n' "${STATUS:-}" "${FAILED_AT:-}" \
            > "$SWCTL_ACTIVE_META_FILE"
    }
    export -f write_metadata

    _create_failure_finalize
    grep -q "FAILED_AT=rebase conflict in foo.php" "$SWCTL_ACTIVE_META_FILE"
}
