#!/usr/bin/env bats

load test_helper

# Coverage for the rebase-conflict halt behavior in check_branch_staleness.
#
# Background: swctl create auto-rebases the worktree's branch onto BASE_REF
# when behind.  Earlier behavior was `warn + rebase --abort + continue`,
# silently shipping a non-rebased branch.  The user's fix would be tested
# against a stale base — schema migrations, plugin-platform version skew,
# and DI compile breakage all routinely cascade from this.
#
# New behavior: rebase conflicts are FATAL.  swctl aborts the rebase
# (leaving the worktree in a clean state), then dies with explicit
# recovery instructions.  An escape hatch (SWCTL_SKIP_STALENESS_REBASE=1)
# lets users opt out when they intentionally want to proceed against a
# stale base.

setup() {
    SW_TMP="$(mktemp -d)"
    WORKTREE_PATH="$SW_TMP/wt"
    BASE_REPO="$SW_TMP/base"
    BASE_REF="trunk"
    BRANCH="fix/test"
    SW_BASE_BRANCH="trunk"
    ISSUE_ID="9999"

    # Set up a real git repo so we can produce a real conflict.
    mkdir -p "$BASE_REPO"
    git -C "$BASE_REPO" init -q -b trunk
    git -C "$BASE_REPO" config user.email 'bats@example.com'
    git -C "$BASE_REPO" config user.name  'Bats'
    echo 'line 1' > "$BASE_REPO/conflict.txt"
    git -C "$BASE_REPO" add conflict.txt
    git -C "$BASE_REPO" commit -q -m 'base'

    # Branch off, edit conflict.txt one way, commit
    git -C "$BASE_REPO" checkout -q -b "$BRANCH"
    echo 'branch edit' > "$BASE_REPO/conflict.txt"
    git -C "$BASE_REPO" commit -q -am 'branch change'

    # Back to trunk, edit conflict.txt the OTHER way, commit
    git -C "$BASE_REPO" checkout -q trunk
    echo 'trunk edit' > "$BASE_REPO/conflict.txt"
    git -C "$BASE_REPO" commit -q -am 'trunk change'

    # Stand up a worktree at the branch tip.  Now rebasing branch onto
    # trunk will produce a real conflict.
    git -C "$BASE_REPO" worktree add -q "$WORKTREE_PATH" "$BRANCH"

    export SW_TMP WORKTREE_PATH BASE_REPO BASE_REF BRANCH SW_BASE_BRANCH ISSUE_ID

    info() { :; }
    warn() { :; }
    ok()   { :; }
    export -f info warn ok
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# ---------------------------------------------------------------------------
# Conflict path: rebase fails → die with recovery instructions, worktree
# left in a clean (un-rebased) state.
# ---------------------------------------------------------------------------

@test "conflict during auto-rebase: dies with recovery instructions" {
    run check_branch_staleness
    [ "$status" -ne 0 ]
    [[ "$output" == *"Rebase of '$BRANCH' onto '$SW_BASE_BRANCH' has conflicts"* ]]
    # Recovery hints surfaced inline so user knows what to do without
    # context-switching out of swctl
    [[ "$output" == *"git rebase $BASE_REF"* ]]
    [[ "$output" == *"git rebase --continue"* ]]
    [[ "$output" == *"swctl refresh"* ]]
    # The escape-hatch env var is documented in the error
    [[ "$output" == *"SWCTL_SKIP_STALENESS_REBASE=1"* ]]
}

@test "conflict during auto-rebase: worktree left in a clean state (rebase aborted)" {
    # Sanity precondition: branch is not currently in a rebase
    [ ! -d "$WORKTREE_PATH/.git/rebase-merge" ] && [ ! -d "$WORKTREE_PATH/.git/rebase-apply" ]

    run check_branch_staleness
    [ "$status" -ne 0 ]

    # After the failure, no half-finished rebase should be sitting in
    # the worktree's git state — the function calls `rebase --abort`
    # before dying so the user can inspect / re-rebase manually
    if [ -d "$WORKTREE_PATH/.git" ]; then
        [ ! -d "$WORKTREE_PATH/.git/rebase-merge" ]
        [ ! -d "$WORKTREE_PATH/.git/rebase-apply" ]
    else
        # Worktrees have a .git FILE, not a directory — points at the
        # main repo's worktree dir.  Resolve it.
        local _gitdir
        _gitdir="$(sed 's/^gitdir: //' "$WORKTREE_PATH/.git" 2>/dev/null)"
        [ -n "$_gitdir" ]
        [ ! -d "$_gitdir/rebase-merge" ]
        [ ! -d "$_gitdir/rebase-apply" ]
    fi

    # And HEAD is still at the branch tip (un-rebased)
    local head_msg
    head_msg="$(git -C "$WORKTREE_PATH" log -1 --format='%s')"
    [ "$head_msg" = "branch change" ]
}

# ---------------------------------------------------------------------------
# Escape-hatch path: SWCTL_SKIP_STALENESS_REBASE=1 → no rebase attempted,
# function returns 0 even when the branch IS behind.
# ---------------------------------------------------------------------------

@test "SWCTL_SKIP_STALENESS_REBASE=1: skips rebase entirely (no conflict, no failure)" {
    SWCTL_SKIP_STALENESS_REBASE=1 run check_branch_staleness
    [ "$status" -eq 0 ]

    # Branch HEAD unchanged (no rebase happened)
    local head_msg
    head_msg="$(git -C "$WORKTREE_PATH" log -1 --format='%s')"
    [ "$head_msg" = "branch change" ]
}

# ---------------------------------------------------------------------------
# Happy path: branch up-to-date → no rebase, no error.
# ---------------------------------------------------------------------------

@test "branch already up-to-date: no rebase, no error, no output" {
    # Reset the branch onto trunk's tip so it's not behind
    git -C "$WORKTREE_PATH" rebase --strategy-option=ours trunk -q 2>/dev/null

    run check_branch_staleness
    [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Happy path: branch behind but rebase succeeds (no conflicts) → ok, no die.
# ---------------------------------------------------------------------------

@test "branch behind, rebase succeeds: returns 0 and HEAD advances onto trunk" {
    # Tear down the conflict-fixture worktree.
    git -C "$BASE_REPO" worktree remove --force "$WORKTREE_PATH" 2>/dev/null
    rm -rf "$WORKTREE_PATH"
    git -C "$BASE_REPO" worktree prune 2>/dev/null

    # Make a NON-conflicting branch (touches a different file) directly.
    # Using `branch` not `checkout -b` keeps BASE_REPO on trunk so the new
    # branch is freely available for `worktree add`.
    git -C "$BASE_REPO" branch clean-fix trunk~1
    git -C "$BASE_REPO" worktree add -q "$WORKTREE_PATH" clean-fix
    echo 'clean change' > "$WORKTREE_PATH/clean.txt"
    git -C "$WORKTREE_PATH" add clean.txt
    git -C "$WORKTREE_PATH" -c user.email=bats@example.com -c user.name=Bats \
        commit -q -m 'clean branch change'
    BRANCH="clean-fix"

    run check_branch_staleness
    [ "$status" -eq 0 ]

    # Worktree's HEAD merge-base with trunk should now be trunk's tip
    # (the rebase moved the branch's parent to trunk's HEAD)
    local mb trunk_head
    mb="$(git -C "$WORKTREE_PATH" merge-base HEAD trunk)"
    trunk_head="$(git -C "$BASE_REPO" rev-parse trunk)"
    [ "$mb" = "$trunk_head" ]
}
