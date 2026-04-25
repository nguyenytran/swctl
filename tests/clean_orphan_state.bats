#!/usr/bin/env bats

load test_helper

# Regression guard for _clean_orphan_state (swctl helper).
#
# Bug this prevents: when a `swctl resolve` creates a worktree branch but
# crashes before writing the instance metadata env file,
# `swctl clean <issue>` would bail with "no tracked worktree found" and
# leave the dangling branch (and sometimes a bare directory) in
# PROJECT_ROOT.  The next `swctl create` for the same issue would then
# silently reuse the stale branch and produce a phantom worktree pointing
# at a random trunk commit — exactly the failure mode that motivated this
# helper.
#
# Each test stands up a fresh disposable git repo, fakes the relevant
# state, calls _clean_orphan_state directly, and asserts the post-condition
# on branches and worktree directories.

setup() {
    SW_TMP="$(mktemp -d)"
    PROJECT_ROOT="$SW_TMP/repo"
    SW_WORKTREE_ROOT="$SW_TMP/_worktrees"
    SW_BASE_BRANCH="trunk"

    mkdir -p "$PROJECT_ROOT" "$SW_WORKTREE_ROOT"
    git -C "$PROJECT_ROOT" init -q -b trunk
    git -C "$PROJECT_ROOT" config user.email 'bats@example.com'
    git -C "$PROJECT_ROOT" config user.name  'Bats'
    git -C "$PROJECT_ROOT" commit -q --allow-empty -m 'root'

    export PROJECT_ROOT SW_WORKTREE_ROOT SW_BASE_BRANCH
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# ---------------------------------------------------------------------------
# Empty branch (no unique commits) → deleted automatically
# ---------------------------------------------------------------------------

@test "deletes empty fix/<id> orphan branch and reports success" {
    git -C "$PROJECT_ROOT" branch fix/6689 trunk

    run _clean_orphan_state 6689 0
    [ "$status" -eq 0 ]
    [[ "$output" == *"Deleted empty orphan branch 'fix/6689'"* ]]

    run git -C "$PROJECT_ROOT" rev-parse --verify --quiet refs/heads/fix/6689
    [ "$status" -ne 0 ]  # branch is gone
}

@test "deletes empty feat/<id> orphan branch" {
    git -C "$PROJECT_ROOT" branch feat/6689 trunk
    run _clean_orphan_state 6689 0
    [ "$status" -eq 0 ]
    run git -C "$PROJECT_ROOT" rev-parse --verify --quiet refs/heads/feat/6689
    [ "$status" -ne 0 ]
}

@test "deletes empty chore/<id> orphan branch" {
    git -C "$PROJECT_ROOT" branch chore/6689 trunk
    run _clean_orphan_state 6689 0
    [ "$status" -eq 0 ]
    run git -C "$PROJECT_ROOT" rev-parse --verify --quiet refs/heads/chore/6689
    [ "$status" -ne 0 ]
}

@test "deletes empty fix/<id>-<slug> variant" {
    git -C "$PROJECT_ROOT" branch fix/6689-some-slug trunk
    run _clean_orphan_state 6689 0
    [ "$status" -eq 0 ]
    [[ "$output" == *"fix/6689-some-slug"* ]]
    run git -C "$PROJECT_ROOT" rev-parse --verify --quiet refs/heads/fix/6689-some-slug
    [ "$status" -ne 0 ]
}

@test "sweeps multiple matching orphan branches in one call" {
    git -C "$PROJECT_ROOT" branch fix/6689        trunk
    git -C "$PROJECT_ROOT" branch feat/6689-alpha trunk
    run _clean_orphan_state 6689 0
    [ "$status" -eq 0 ]
    run git -C "$PROJECT_ROOT" branch --list 'fix/6689' 'feat/6689-alpha'
    [ -z "$output" ]  # both gone
}

# ---------------------------------------------------------------------------
# Branch with real work → preserved unless --force
# ---------------------------------------------------------------------------

@test "skips branch with commits ahead, requires --force" {
    git -C "$PROJECT_ROOT" branch fix/6689 trunk
    git -C "$PROJECT_ROOT" checkout -q fix/6689
    git -C "$PROJECT_ROOT" commit -q --allow-empty -m 'real work'
    git -C "$PROJECT_ROOT" checkout -q trunk

    run _clean_orphan_state 6689 0
    [ "$status" -eq 0 ]
    [[ "$output" == *"Skipping orphan branch 'fix/6689'"* ]]
    [[ "$output" == *"--force"* ]]

    # Branch must still exist
    git -C "$PROJECT_ROOT" rev-parse --verify --quiet refs/heads/fix/6689
}

@test "--force deletes branch even with unique commits" {
    git -C "$PROJECT_ROOT" branch fix/6689 trunk
    git -C "$PROJECT_ROOT" checkout -q fix/6689
    git -C "$PROJECT_ROOT" commit -q --allow-empty -m 'real work'
    git -C "$PROJECT_ROOT" checkout -q trunk

    run _clean_orphan_state 6689 1
    [ "$status" -eq 0 ]
    [[ "$output" == *"forced"* ]]

    run git -C "$PROJECT_ROOT" rev-parse --verify --quiet refs/heads/fix/6689
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# Branch checked out by another worktree → never deleted
# ---------------------------------------------------------------------------

@test "skips branch that's checked out by an active worktree" {
    git -C "$PROJECT_ROOT" branch fix/6689 trunk
    git -C "$PROJECT_ROOT" worktree add -q "$SW_TMP/active" fix/6689

    run _clean_orphan_state 6689 0
    [ "$status" -eq 0 ]
    [[ "$output" == *"checked out at"* ]]

    # Branch must still exist
    git -C "$PROJECT_ROOT" rev-parse --verify --quiet refs/heads/fix/6689
}

# ---------------------------------------------------------------------------
# Orphan worktree directory (not registered) → removed
# ---------------------------------------------------------------------------

@test "removes unregistered worktree directory at default path" {
    mkdir -p "$SW_WORKTREE_ROOT/sw-6689"
    touch "$SW_WORKTREE_ROOT/sw-6689/leftover.txt"

    run _clean_orphan_state 6689 0
    [ "$status" -eq 0 ]
    [[ "$output" == *"Removed orphan directory"* ]]
    [ ! -d "$SW_WORKTREE_ROOT/sw-6689" ]
}

@test "leaves a registered worktree directory alone" {
    git -C "$PROJECT_ROOT" worktree add -q "$SW_WORKTREE_ROOT/sw-6689" -b fix/6689
    # Write a real commit so the branch isn't empty (otherwise the branch
    # cleanup path would try to delete it — separate concern).
    git -C "$SW_WORKTREE_ROOT/sw-6689" commit -q --allow-empty -m 'real work'

    run _clean_orphan_state 6689 0
    # The registered worktree must NOT be removed even though _clean_orphan_state
    # found something else to act on (the branch with commits triggers the
    # "skip; --force needed" warning).
    [ -d "$SW_WORKTREE_ROOT/sw-6689" ]
    [ "$status" -eq 0 ]  # branch warning counts as "found"
}

# ---------------------------------------------------------------------------
# Nothing to clean → returns non-zero so caller falls through
# ---------------------------------------------------------------------------

@test "returns non-zero when there's no orphan state" {
    # Branch for a different issue exists, but nothing for 6689
    git -C "$PROJECT_ROOT" branch fix/9999 trunk

    run _clean_orphan_state 6689 0
    [ "$status" -ne 0 ]

    # The unrelated branch must NOT have been touched
    git -C "$PROJECT_ROOT" rev-parse --verify --quiet refs/heads/fix/9999
}

@test "returns non-zero when PROJECT_ROOT isn't a git repo" {
    PROJECT_ROOT="$SW_TMP/not-a-repo"
    mkdir -p "$PROJECT_ROOT"
    run _clean_orphan_state 6689 0
    [ "$status" -ne 0 ]
}

@test "returns non-zero when PROJECT_ROOT is unset" {
    unset PROJECT_ROOT
    run _clean_orphan_state 6689 0
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# Issue-id sanitization: doesn't accidentally match prefixes/suffixes
# ---------------------------------------------------------------------------

@test "doesn't match unrelated branches with overlapping numbers" {
    # 66890 starts with 6689 but is a different issue; must NOT be deleted
    git -C "$PROJECT_ROOT" branch fix/66890 trunk
    git -C "$PROJECT_ROOT" branch fix/16689 trunk

    run _clean_orphan_state 6689 0
    [ "$status" -ne 0 ]  # nothing matched 6689 exactly

    git -C "$PROJECT_ROOT" rev-parse --verify --quiet refs/heads/fix/66890
    git -C "$PROJECT_ROOT" rev-parse --verify --quiet refs/heads/fix/16689
}

# ---------------------------------------------------------------------------
# Regression guard: the exact scenario from the user report
# ---------------------------------------------------------------------------

@test "regression: orphan fix/6689 branch left by half-failed resolve" {
    # Reproduces the user's state on 2026-04-25:
    # - fix/6689 branch exists at the same commit as trunk
    # - no worktree directory
    # - no metadata env file
    #
    # Expected: _clean_orphan_state finds the branch, deletes it (empty
    # branch, no work to lose), returns 0 so cmd_clean reports success
    # instead of "nothing to clean".
    git -C "$PROJECT_ROOT" branch fix/6689 trunk
    [ ! -d "$SW_WORKTREE_ROOT/sw-6689" ]

    run _clean_orphan_state 6689 0
    [ "$status" -eq 0 ]
    [[ "$output" == *"fix/6689"* ]]

    run git -C "$PROJECT_ROOT" rev-parse --verify --quiet refs/heads/fix/6689
    [ "$status" -ne 0 ]
}
