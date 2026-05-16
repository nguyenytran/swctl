#!/usr/bin/env bats

load test_helper

# Regression guard for the project-database preflight check
# (v0.6.17, 2026-05-16).
#
# Background: every per-instance container resolves the `database`
# hostname via project network DNS — it expects a sibling container
# (typically `<project>-database-1` from the project's own
# docker-compose.yml) to be aliased there.  When that container
# exits (OrbStack restart kills it under load, no restart policy in
# the project's compose), the next `swctl create` succeeds preflight
# against the standalone swctl-mariadb but the instance is DOA at
# first request with SQLSTATE[HY000] [2002] "getaddrinfo for
# database failed: Name does not resolve" (#137 incident
# 2026-05-16 morning, load 27→67).
#
# Fix: preflight detects when a project-side database container
# exists (`<project>-database-1` in any state) and checks IT
# instead of swctl-mariadb.  Remedy text points at
# `docker compose up -d` in the project root.
#
# Tests stub `docker` to control which containers appear running
# vs exited; assert preflight picks the right container + emits
# the right remedy.

setup() {
    SW_TMP="$(mktemp -d)"
    PROJECT_ROOT="$SW_TMP/proj"
    SWCTL_TEMPLATE_DIR="$SW_TMP"
    SW_TRAEFIK_NETWORK="net"
    SW_INFRA_DB_CONTAINER="swctl-mariadb"
    SW_WORKTREE_ROOT="$SW_TMP/_worktrees"
    ISSUE_ID="9999"
    WORKTREE_PATH="$SW_TMP/wt-9999"  # doesn't exist → path-free check passes
    mkdir -p "$PROJECT_ROOT"
    touch "$SWCTL_TEMPLATE_DIR/docker-compose.swctl.yml"
    export SW_TMP PROJECT_ROOT SWCTL_TEMPLATE_DIR SW_TRAEFIK_NETWORK \
           SW_INFRA_DB_CONTAINER SW_WORKTREE_ROOT ISSUE_ID WORKTREE_PATH
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# Stub docker with two switches:
#   $1 = running-list (comma-separated container names that `docker ps`
#        — without -a — should report)
#   $2 = all-list    (comma-separated container names that `docker ps -a`
#        should report; includes both running + exited)
# Everything else (info, image, network) is happy-path.
_stub_docker_dual() {
    local running="$1"
    local all="$2"
    cat > "$SW_TMP/docker" <<EOF
#!/usr/bin/env bash
# Filter helper: given a CSV list and a name filter, return matching items.
match_filter() {
    local list="\$1"; local needle="\$2"
    IFS=, read -ra items <<< "\$list"
    for it in "\${items[@]}"; do
        [ -z "\$it" ] && continue
        # The preflight uses '^NAME\$' anchors; strip them for substring match.
        local n="\${needle#^}"; n="\${n%\\\$}"
        [ "\$it" = "\$n" ] && echo "\$it"
    done
}

case "\$1" in
    info)    exit 0 ;;
    image)   exit 0 ;;
    network) exit 0 ;;
    ps)
        # Find the --filter 'name=…' arg.
        all_flag=0
        name_filter=""
        shift
        while [ \$# -gt 0 ]; do
            case "\$1" in
                -a)        all_flag=1; shift ;;
                --filter)  shift; case "\$1" in name=*) name_filter="\${1#name=}" ;; esac; shift ;;
                *)         shift ;;
            esac
        done
        if [ "\$all_flag" = "1" ]; then
            match_filter "$all" "\$name_filter"
        else
            match_filter "$running" "\$name_filter"
        fi
        exit 0
        ;;
    *) exit 0 ;;
esac
EOF
    chmod +x "$SW_TMP/docker"
    PATH="$SW_TMP:$PATH"
    export PATH
}

# ---------------------------------------------------------------------------
# Happy path A (legacy): no project-database container exists.  Preflight
# falls back to swctl-mariadb and passes when it's running.
# ---------------------------------------------------------------------------

@test "preflight db: no project DB → checks swctl-mariadb (legacy path)" {
    # docker ps -a sees only swctl-mariadb (no <slug>-database-1).
    _stub_docker_dual "swctl-mariadb" "swctl-mariadb"
    PROJECT_SLUG="trunk"
    export PROJECT_SLUG

    run _run_preflight_checks
    [ "$status" -eq 0 ]
    [[ "$output" == *"✓ shared mariadb running (swctl-mariadb)"* ]]
}

# ---------------------------------------------------------------------------
# v0.6.17 case: project-database container EXISTS and is running.
# Preflight checks IT instead of swctl-mariadb (even if the latter is also
# running) and reports the project label.
# ---------------------------------------------------------------------------

@test "preflight db: project DB exists + running → checks project DB" {
    _stub_docker_dual "trunk-database-1,swctl-mariadb" \
                      "trunk-database-1,swctl-mariadb"
    PROJECT_SLUG="trunk"
    export PROJECT_SLUG

    run _run_preflight_checks
    [ "$status" -eq 0 ]
    [[ "$output" == *"✓ project database running (trunk-database-1)"* ]]
    # And the legacy line MUST NOT appear — we picked the project DB.
    [[ "$output" != *"shared mariadb running (swctl-mariadb)"* ]]
}

# ---------------------------------------------------------------------------
# The actual incident: project DB exists (was created earlier) but is
# currently exited.  Preflight MUST fail with the project-side remedy,
# not silently pass against swctl-mariadb.
# ---------------------------------------------------------------------------

@test "preflight db: project DB exists but exited → fails with compose-up remedy" {
    # docker ps -a sees both; docker ps (running) sees only swctl-mariadb.
    _stub_docker_dual "swctl-mariadb" \
                      "trunk-database-1,swctl-mariadb"
    PROJECT_SLUG="trunk"
    export PROJECT_SLUG

    run _run_preflight_checks
    [ "$status" -eq 1 ]
    [[ "$output" == *"✗ project database running (trunk-database-1)"* ]]
    # Remedy points at the project's compose, not swctl init.
    [[ "$output" == *"docker compose up -d"* ]]
    # And the legacy fallback didn't sneak in.
    [[ "$output" != *"shared mariadb running"* ]]
}

# ---------------------------------------------------------------------------
# Defensive: PROJECT_SLUG unset → legacy path (no crash under set -u).
# ---------------------------------------------------------------------------

@test "preflight db: PROJECT_SLUG unset → legacy swctl-mariadb path" {
    _stub_docker_dual "swctl-mariadb" "swctl-mariadb"
    unset PROJECT_SLUG

    run _run_preflight_checks
    [ "$status" -eq 0 ]
    [[ "$output" == *"shared mariadb running (swctl-mariadb)"* ]]
}
