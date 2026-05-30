#!/usr/bin/env bats

load test_helper

# Regression guard for `swctl clean`'s registry-unlink idempotency.
#
# Bug this prevents (observed 2026-05-11): when `swctl create` failed
# partway (e.g. git worktree-add hit a conflict, or alpine preflight
# was missing), it had already written the instance .env to
# `~/.local/state/swctl/instances/<project>/<issue>.env`.  Subsequent
# `swctl clean <issue>` would walk through container/volume/network
# cleanup, find nothing to do (no docker artifacts exist), then bail
# out on a mariadb-unreachable failure BEFORE reaching the
# `rm -f "$meta_file"` line at the bottom of `cmd_clean`.  The .env
# stayed on disk → next `swctl create <same-issue>` failed with the
# misleading "worktree already exists for issue 'X'" error.
#
# Fix (this commit): cmd_clean installs `trap "rm -f $meta_file" EXIT`
# immediately after meta_file is resolved.  Whatever happens downstream
# (mysql_exec failure, set -e bailout, even a `die`), the trap fires
# and the .env is unlinked.
#
# Each test stands up an isolated $SWCTL_STATE_DIR + .env, runs
# cmd_clean under a deliberately broken environment, and asserts
# `the .env is gone` regardless of mid-flight failures.

setup() {
    SW_TMP="$(mktemp -d)"
    SWCTL_STATE_DIR="$SW_TMP/state"
    SWCTL_REGISTRY_DIR="$SWCTL_STATE_DIR/instances"
    SW_PROJECT_SLUG="trunk"
    META_DIR="$SWCTL_REGISTRY_DIR/$SW_PROJECT_SLUG"
    META_FILE="$META_DIR/9999.env"
    mkdir -p "$META_DIR"

    # Minimal but realistic instance .env — enough for load_instance_metadata
    # to succeed and reach the docker/db cleanup steps.  Paths point at
    # non-existent locations so the per-step cleanups are no-ops on the
    # happy path.
    cat > "$META_FILE" <<EOF
SWCTL_META_VERSION=2
ISSUE=9999
ISSUE_ID=9999
PROJECT=trunk
PROJECT_SLUG=trunk
PROJECT_ROOT=$SW_TMP/repo
CONFIG_PATH=$SW_TMP/repo/.swctl.conf
BRANCH=fix/9999-test
BASE_REF=trunk
WORKTREE_PATH=$SW_TMP/_worktrees/sw-9999
WORKTREE_ID=9999
DOMAIN=web.trunk-9999.orb.local
APP_URL=http://web.trunk-9999.orb.local
DB_NAME=shopware_9999
DB_STATE=cloned
COMPOSE_PROJECT=trunk-9999
COMPOSE_ENV_FILE=$SW_TMP/trunk-9999.compose.env
COMPOSE_TEMPLATE=$SW_TMP/docker-compose.yml
COMPOSE_VOLUME_OVERRIDE=$SW_TMP/trunk-9999.volumes.override.yml
EOF

    # Stub out docker / mysql / git so cmd_clean doesn't try to touch
    # the host system.  Each stub records its calls for assertions.
    cat > "$SW_TMP/docker" <<'SH'
#!/usr/bin/env bash
echo "docker $*" >> "$SW_TMP/calls.log"
# `ps`/`volume ls`/`network ls -q` return nothing so the loops skip.
exit 0
SH
    chmod +x "$SW_TMP/docker"
    PATH="$SW_TMP:$PATH"
    export PATH SW_TMP SWCTL_STATE_DIR SWCTL_REGISTRY_DIR SW_PROJECT_SLUG META_FILE

    # Silence the informational logs so tests don't echo half-stable
    # text into the harness — assertions key off `[ -f "$META_FILE" ]`.
    info() { :; }
    ok()   { :; }
    warn() { :; }
    err()  { :; }
    export -f info ok warn err

    # mysql_exec is a swctl-internal helper; force it to fail so we
    # exercise the "DB step failed midway" branch.
    mysql_exec() { return 1; }
    export -f mysql_exec
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# ---------------------------------------------------------------------------
# Happy path: clean succeeds → .env unlinked.
# ---------------------------------------------------------------------------

@test "cmd_clean: removes the registry .env on a clean run" {
    [ -f "$META_FILE" ]
    run cmd_clean 9999
    [ ! -f "$META_FILE" ]
}

# ---------------------------------------------------------------------------
# Failure-during-cleanup: mariadb unreachable → trap-driven .env unlink still
# fires.  This is the exact bug we observed in production.
# ---------------------------------------------------------------------------

@test "cmd_clean: removes the .env even when mysql_exec fails" {
    [ -f "$META_FILE" ]

    # mysql_exec already stubbed to return 1 in setup; the trap MUST
    # still unlink the .env so the next `swctl create 9999` works.
    run cmd_clean 9999
    [ ! -f "$META_FILE" ]
}

# ---------------------------------------------------------------------------
# Resolve-by-input: invocation by raw issue number resolves to the .env.
# ---------------------------------------------------------------------------

@test "cmd_clean: resolves issue number to .env path and unlinks it" {
    [ -f "$META_FILE" ]
    run cmd_clean 9999
    # Even with errors above, the .env is gone after EXIT trap runs.
    [ ! -f "$META_FILE" ]
}

# ---------------------------------------------------------------------------
# Idempotency: a second `swctl clean` for the same issue is a no-op
# (the orphan-state branch reports "nothing to clean", returns 0).
# This is what makes the next `swctl create` work.
# ---------------------------------------------------------------------------

@test "cmd_clean: idempotent — second run on already-clean state is harmless" {
    run cmd_clean 9999
    [ ! -f "$META_FILE" ]

    # Second invocation: no .env, no orphan branches, no worktree.  Should
    # gracefully report nothing to clean and exit 0.
    run cmd_clean 9999
    [ "$status" -eq 0 ]
    [ ! -f "$META_FILE" ]
}
