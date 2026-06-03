#!/usr/bin/env bats

load test_helper

# Regression guard for v0.7.6 — auto-heal of the chronic
# "project DB container running but detached from its network" state.
#
# Background: 3 separate days this week (2026-05-17, 2026-05-18,
# 2026-06-03) hit the same failure:
#   docker ps      → "trunk-database-1   Up X hours (healthy)"
#   docker inspect → NetworkSettings.Networks={}   ← broken
# Every per-instance container then fails with SQLSTATE [2002]
# "getaddrinfo for database failed: Name does not resolve".
#
# Docker's `restart: unless-stopped` doesn't catch this — it doesn't
# consider the detached state a crash.  We have to detect + recreate
# in user-space.

setup() {
    SW_TMP="$(mktemp -d)"
    DOCKER_CALLS="$SW_TMP/docker-calls"
    : > "$DOCKER_CALLS"
    export SW_TMP DOCKER_CALLS

    # Per-test policy file controls the stub's reply to
    # `docker inspect ... --format ...`.  Two values are queried in
    # sequence: the status (running/exited/...) and the network count
    # (0..N).  Tests prep both via $POLICY_STATUS + $POLICY_NETCOUNT.
    POLICY_STATUS=running
    POLICY_NETCOUNT=1
    COMPOSE_EXIT=0
    export POLICY_STATUS POLICY_NETCOUNT COMPOSE_EXIT

    cat > "$SW_TMP/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_CALLS"
case "$*" in
    inspect*State.Status*)               printf '%s\n' "$POLICY_STATUS"; exit 0 ;;
    inspect*NetworkSettings.Networks*)   printf '%s\n' "$POLICY_NETCOUNT"; exit 0 ;;
    "compose up -d --force-recreate database") exit "$COMPOSE_EXIT" ;;
    "compose up -d database")            exit "$COMPOSE_EXIT" ;;
esac
exit 0
SH
    chmod +x "$SW_TMP/docker"
    PATH="$SW_TMP:$PATH"
    export PATH

    info() { :; }
    ok()   { :; }
    warn() { :; }
    err()  { :; }
    export -f info ok warn err

    PROJECT_ROOT="$SW_TMP/project"
    mkdir -p "$PROJECT_ROOT"
    export PROJECT_ROOT
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# ---------------------------------------------------------------------------
# Healthy: running + at least one network → no-op, return 0.
# ---------------------------------------------------------------------------

@test "_preflight_project_db_repair: healthy DB → returns 0, no recreate" {
    POLICY_STATUS=running
    POLICY_NETCOUNT=1
    export POLICY_STATUS POLICY_NETCOUNT

    run _preflight_project_db_repair "trunk-database-1" "$PROJECT_ROOT"
    [ "$status" -eq 0 ]
    ! grep -q "compose up" "$DOCKER_CALLS"
}

# ---------------------------------------------------------------------------
# The recurring bug: running but Networks={} → auto-heal via recreate.
# ---------------------------------------------------------------------------

@test "_preflight_project_db_repair: running + detached → recreates, returns 0" {
    POLICY_STATUS=running
    POLICY_NETCOUNT=0
    export POLICY_STATUS POLICY_NETCOUNT

    run _preflight_project_db_repair "trunk-database-1" "$PROJECT_ROOT"
    [ "$status" -eq 0 ]
    grep -q "compose up -d --force-recreate database" "$DOCKER_CALLS"
}

# ---------------------------------------------------------------------------
# Detached AND recreate fails → return 1 (preflight surfaces the
# error so the user knows manual intervention is needed).
# ---------------------------------------------------------------------------

@test "_preflight_project_db_repair: recreate fails → returns 1" {
    POLICY_STATUS=running
    POLICY_NETCOUNT=0
    COMPOSE_EXIT=1
    export POLICY_STATUS POLICY_NETCOUNT COMPOSE_EXIT

    run _preflight_project_db_repair "trunk-database-1" "$PROJECT_ROOT"
    [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Not running (exited/created/restarting) → simple `compose up -d`
# (no force-recreate needed; container just needs to start).
# ---------------------------------------------------------------------------

@test "_preflight_project_db_repair: exited DB → up -d (no force-recreate)" {
    POLICY_STATUS=exited
    POLICY_NETCOUNT=0
    export POLICY_STATUS POLICY_NETCOUNT

    run _preflight_project_db_repair "trunk-database-1" "$PROJECT_ROOT"
    [ "$status" -eq 0 ]
    grep -q "compose up -d database" "$DOCKER_CALLS"
    # And we did NOT use force-recreate (cheaper start path).
    ! grep -q "force-recreate" "$DOCKER_CALLS"
}

# ---------------------------------------------------------------------------
# Container doesn't exist → return 2 (caller's outer logic decides
# what "no DB container at all" means — not a heal failure).
# ---------------------------------------------------------------------------

@test "_preflight_project_db_repair: missing container → returns 2" {
    # Override the stub to return empty status (= no container).
    cat > "$SW_TMP/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_CALLS"
case "$*" in
    inspect*State.Status*) exit 0 ;;   # no output → empty status
esac
exit 0
SH
    chmod +x "$SW_TMP/docker"

    run _preflight_project_db_repair "trunk-database-1" "$PROJECT_ROOT"
    [ "$status" -eq 2 ]
    # MUST NOT attempt a recreate when we don't know what we're recreating.
    ! grep -q "compose up" "$DOCKER_CALLS"
}

# ---------------------------------------------------------------------------
# Argument validation: missing container name → returns 1.
# ---------------------------------------------------------------------------

@test "_preflight_project_db_repair: missing args → returns 1" {
    run _preflight_project_db_repair "" "$PROJECT_ROOT"
    [ "$status" -eq 1 ]
    run _preflight_project_db_repair "trunk-database-1" ""
    [ "$status" -eq 1 ]
}
