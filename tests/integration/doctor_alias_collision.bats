#!/usr/bin/env bats

load integration_helper

# Integration test for cmd_doctor step 8 — DNS alias collision detection.
#
# Scenario (mirrors the v0.5.3 bug):
#   - A shared network has two containers both aliased as `database`.
#   - A tracked swctl instance lives on that network.
#   - cmd_doctor must exit non-zero and print the round-robin warning +
#     the `docker network disconnect` remedy.
#
# Also guards that the filter stays focused — a benign `web` collision
# (multiple worktrees sharing the compose service name) does NOT trip
# the warning.

setup() {
    require_docker
    _it_net="$(it_uniq)-net"
    _it_app="$(it_uniq)-app"     # simulates trunk-<issue>-web-1
    _it_db1="$(it_uniq)-db-good" # simulates trunk-database-1
    _it_db2="$(it_uniq)-db-stale" # simulates swctl-mariadb (the ghost)
    _it_registry="$BATS_TEST_TMPDIR/reg-$$"
    _it_proj="swctl-it-proj-$$-${BATS_TEST_NUMBER:-0}"

    docker network create "$_it_net" >/dev/null

    # Tracked app container: labeled so cmd_doctor finds it via the
    # compose-project filter, attached to the test network.
    docker run -d --name "$_it_app" --network "$_it_net" \
        --label "com.docker.compose.project=${_it_proj}" \
        alpine sh -c 'tail -f /dev/null' >/dev/null

    # Tracked instance metadata
    mkdir -p "$_it_registry/trunk"
    cat > "$_it_registry/trunk/it-test.env" <<EOF
ISSUE_ID=it-test
COMPOSE_PROJECT=${_it_proj}
EOF
}

teardown() {
    it_cleanup_container "$_it_app"
    it_cleanup_container "$_it_db1"
    it_cleanup_container "$_it_db2"
    it_cleanup_network   "$_it_net"
}

@test "doctor: warns when two containers share the 'database' alias" {
    # Two containers, same alias — this is the v0.5.3 bug.
    docker run -d --name "$_it_db1" --network-alias database \
        --network "$_it_net" alpine sh -c 'tail -f /dev/null' >/dev/null
    docker run -d --name "$_it_db2" --network-alias database \
        --network "$_it_net" alpine sh -c 'tail -f /dev/null' >/dev/null

    SWCTL_REGISTRY_DIR="$_it_registry" run cmd_doctor

    # Diagnostics if the test fails (bats only prints $output on failure;
    # emit the network + container-alias state so CI logs have full context)
    if [ "$status" -eq 0 ] || [[ "$output" != *"alias 'database' is claimed by multiple"* ]]; then
        echo "--- docker network inspect $_it_net ---" >&2
        docker network inspect "$_it_net" --format '{{range .Containers}}{{.Name}} {{end}}' >&2 || true
        for c in "$_it_app" "$_it_db1" "$_it_db2"; do
            echo "--- aliases for $c on $_it_net ---" >&2
            docker inspect "$c" --format '{{with (index .NetworkSettings.Networks "'"$_it_net"'")}}{{range .Aliases}}{{.}} {{end}}{{end}}' >&2 || true
        done
        echo "--- cmd_doctor output ---" >&2
        printf '%s\n' "$output" >&2
    fi

    # cmd_doctor returns non-zero whenever any step emitted a warning
    [ "$status" -ne 0 ]
    [[ "$output" == *"alias 'database' is claimed by multiple containers"* ]]
    [[ "$output" == *"$_it_db1"* ]]
    [[ "$output" == *"$_it_db2"* ]]
    [[ "$output" == *"docker network disconnect"* ]]
}

@test "doctor: warns on duplicate 'valkey' (v0.5.3 real-world symptom)" {
    docker run -d --name "$_it_db1" --network-alias valkey \
        --network "$_it_net" alpine sh -c 'tail -f /dev/null' >/dev/null
    docker run -d --name "$_it_db2" --network-alias valkey \
        --network "$_it_net" alpine sh -c 'tail -f /dev/null' >/dev/null

    SWCTL_REGISTRY_DIR="$_it_registry" run cmd_doctor
    [ "$status" -ne 0 ]
    [[ "$output" == *"alias 'valkey' is claimed by multiple containers"* ]]
}

@test "doctor: does NOT warn when only one container owns 'database'" {
    docker run -d --name "$_it_db1" --network-alias database \
        --network "$_it_net" alpine sh -c 'tail -f /dev/null' >/dev/null

    SWCTL_REGISTRY_DIR="$_it_registry" run cmd_doctor
    [[ "$output" != *"alias 'database' is claimed by multiple containers"* ]]
}

@test "doctor: ignores benign 'web' alias collisions (regression guard)" {
    # Spawn two containers aliased as 'web' — simulates multiple worktrees
    # joining trunk_default.  Must NOT trigger a warning.
    docker run -d --name "$_it_db1" --network-alias web \
        --network "$_it_net" alpine sh -c 'tail -f /dev/null' >/dev/null
    docker run -d --name "$_it_db2" --network-alias web \
        --network "$_it_net" alpine sh -c 'tail -f /dev/null' >/dev/null

    SWCTL_REGISTRY_DIR="$_it_registry" run cmd_doctor
    [[ "$output" != *"alias 'web' is claimed by multiple containers"* ]]
}

@test "doctor: warning includes both the remedy and the affected network" {
    docker run -d --name "$_it_db1" --network-alias opensearch \
        --network "$_it_net" alpine sh -c 'tail -f /dev/null' >/dev/null
    docker run -d --name "$_it_db2" --network-alias opensearch \
        --network "$_it_net" alpine sh -c 'tail -f /dev/null' >/dev/null

    SWCTL_REGISTRY_DIR="$_it_registry" run cmd_doctor
    [[ "$output" == *"network '$_it_net'"* ]]
    [[ "$output" == *"docker network disconnect $_it_net"* ]]
}
