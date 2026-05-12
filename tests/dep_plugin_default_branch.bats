#!/usr/bin/env bats

load test_helper

# Regression guard for `_resolve_remote_default_branch` — the helper
# `create_dep_plugin_worktree` uses to pick the ref for `git worktree
# add` of a dependency plugin.  2026-05-12 incident: a user ran
# `swctl create --deps SwagCommercial` for issue #6345 from the UI;
# Commercial was nested into the worktree silently empty because the
# old helper used `git symbolic-ref --short HEAD` (i.e. whatever
# branch the user happened to have checked out locally — in this case
# `fix/recommended-bundles-cms-migration-backfill`, which has no
# `origin/` counterpart).  The `origin/<that-branch>` worktree-add
# failed, fell through to a bare-branch fallback (also failed), and
# `cmd_create` continued with no dep plugin linked.  Admin showed
# "0 plugins, 0 installed" and the user lost an hour debugging.
#
# Fix: resolve the REMOTE'S default branch (origin/HEAD), not the
# local HEAD.  Falls back to set-head -a, then conventional names
# (trunk → main → master), then returns 1 so the caller bails loudly.
#
# Tests build disposable git repos with explicit origin/HEAD setups
# and assert the resolver returns the right branch (or fails loudly).

setup() {
    SW_TMP="$(mktemp -d)"

    # Build a disposable "remote" repo with a known default branch.
    REMOTE="$SW_TMP/remote.git"
    mkdir -p "$REMOTE"
    git -C "$REMOTE" init --bare -q -b trunk

    # And a "local clone" of that remote (simulating
    # ~/Shopware/trunk/custom/plugins/SwagCommercial).
    LOCAL="$SW_TMP/local"
    git -C "$SW_TMP" clone -q "$REMOTE" local
    git -C "$LOCAL" config user.email 'bats@example.com'
    git -C "$LOCAL" config user.name  'Bats'

    # Push an initial commit on trunk so origin/HEAD has something to
    # point at; set up origin/HEAD explicitly to mimic a real shopware
    # plugin repo (which always has `trunk` as the default).
    git -C "$LOCAL" commit -q --allow-empty -m 'root on trunk'
    git -C "$LOCAL" push -q origin trunk
    git -C "$LOCAL" remote set-head origin trunk

    export SW_TMP REMOTE LOCAL
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# ---------------------------------------------------------------------------
# Happy path: origin/HEAD is set, resolver returns its branch name.
# ---------------------------------------------------------------------------

@test "_resolve_remote_default_branch: returns 'trunk' when origin/HEAD points there" {
    run _resolve_remote_default_branch "$LOCAL"
    [ "$status" -eq 0 ]
    [ "$output" = "trunk" ]
}

# ---------------------------------------------------------------------------
# Critical regression case: local HEAD is on a stray feature branch
# that doesn't exist on origin.  The OLD code returned this branch
# name, breaking `git worktree add origin/<branch>` because the
# remote ref doesn't exist.  The NEW code must IGNORE local HEAD
# and still return the remote default 'trunk'.
# ---------------------------------------------------------------------------

@test "_resolve_remote_default_branch: ignores stray local HEAD (the #6345 case)" {
    # Create a local branch that has no origin counterpart, switch to it.
    git -C "$LOCAL" checkout -q -b fix/recommended-bundles-cms-migration-backfill
    git -C "$LOCAL" commit -q --allow-empty -m 'local-only commit'

    # The resolver MUST still return the remote default, not the local branch.
    run _resolve_remote_default_branch "$LOCAL"
    [ "$status" -eq 0 ]
    [ "$output" = "trunk" ]
}

# ---------------------------------------------------------------------------
# Fallback path B: origin/HEAD is not set, but `remote set-head -a`
# can fix it on the fly.  We simulate the "not set" state by deleting
# the origin/HEAD ref.  The resolver should auto-heal via set-head -a
# (which queries the remote bare repo's HEAD).
# ---------------------------------------------------------------------------

@test "_resolve_remote_default_branch: auto-heals via 'remote set-head -a'" {
    # Delete the origin/HEAD symbolic-ref so the first resolution path fails.
    git -C "$LOCAL" symbolic-ref -d refs/remotes/origin/HEAD 2>/dev/null || \
        rm -f "$LOCAL/.git/refs/remotes/origin/HEAD"

    run _resolve_remote_default_branch "$LOCAL"
    [ "$status" -eq 0 ]
    [ "$output" = "trunk" ]
}

# ---------------------------------------------------------------------------
# Fallback path C: origin/HEAD unset + offline (set-head -a fails).
# Resolver should try conventional names (trunk → main → master).
# Repo only has 'trunk' branch, so it should resolve to 'trunk'.
# ---------------------------------------------------------------------------

@test "_resolve_remote_default_branch: falls back to conventional 'trunk' when origin/HEAD is unset" {
    git -C "$LOCAL" symbolic-ref -d refs/remotes/origin/HEAD 2>/dev/null || \
        rm -f "$LOCAL/.git/refs/remotes/origin/HEAD"
    # Break the remote so `set-head -a` will fail (path B no-op).
    rm -rf "$REMOTE"

    run _resolve_remote_default_branch "$LOCAL"
    [ "$status" -eq 0 ]
    [ "$output" = "trunk" ]
}

@test "_resolve_remote_default_branch: prefers 'main' over 'master' in fallback list" {
    # Build a fresh repo whose origin only has main+master (no trunk),
    # with origin/HEAD intentionally unset and the remote dead so we
    # exercise path C only.
    local NEW_REMOTE="$SW_TMP/remote2.git"
    local NEW_LOCAL="$SW_TMP/local2"
    mkdir -p "$NEW_REMOTE"
    git -C "$NEW_REMOTE" init --bare -q -b main
    git -C "$SW_TMP" clone -q "$NEW_REMOTE" local2
    git -C "$NEW_LOCAL" config user.email 'b@e.com'
    git -C "$NEW_LOCAL" config user.name  'B'
    git -C "$NEW_LOCAL" commit -q --allow-empty -m 'on main'
    git -C "$NEW_LOCAL" push -q origin main
    git -C "$NEW_LOCAL" checkout -q -b master
    git -C "$NEW_LOCAL" push -q origin master
    git -C "$NEW_LOCAL" symbolic-ref -d refs/remotes/origin/HEAD 2>/dev/null || \
        rm -f "$NEW_LOCAL/.git/refs/remotes/origin/HEAD"
    rm -rf "$NEW_REMOTE"

    run _resolve_remote_default_branch "$NEW_LOCAL"
    [ "$status" -eq 0 ]
    # `trunk` doesn't exist → falls to `main` (next in the list).
    [ "$output" = "main" ]
}

# ---------------------------------------------------------------------------
# Loud failure: NO origin/HEAD AND no trunk/main/master.  Resolver
# returns 1 — caller bails with an `err` line instead of silently
# carrying on.
# ---------------------------------------------------------------------------

@test "_resolve_remote_default_branch: returns 1 when no conventional branch exists" {
    # Wipe ALL origin/* refs so paths A, B, and C all fail.
    rm -rf "$LOCAL/.git/refs/remotes/origin/"
    git -C "$LOCAL" symbolic-ref -d refs/remotes/origin/HEAD 2>/dev/null || true
    # Also break the remote so set-head -a can't repopulate.
    rm -rf "$REMOTE"

    run _resolve_remote_default_branch "$LOCAL"
    [ "$status" -eq 1 ]
}
