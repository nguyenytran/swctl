#!/usr/bin/env bats

load test_helper

# Tests for the swctl snapshot/restore feature (2026-05-30).
#
# Strategy: stub `docker`, `mariadb-dump`, `mariadb`, `gzip`, `gunzip`,
# `stat`, `du`.  We don't actually touch a database; we verify that
# the helper functions invoke the right commands with the right args
# and produce the expected on-disk files.

setup() {
    SW_TMP="$(mktemp -d)"
    DOCKER_CALLS_FILE="$SW_TMP/docker-calls"
    MARIADB_DUMP_BODY="$SW_TMP/dump-body"
    : > "$DOCKER_CALLS_FILE"
    export SW_TMP DOCKER_CALLS_FILE MARIADB_DUMP_BODY

    # Stub docker.  Three modes we care about:
    #   docker exec -i <c> mariadb-dump ...   → writes $MARIADB_DUMP_BODY to stdout
    #   docker exec -i <c> mariadb ...        → consumes stdin (verifies pipe shape)
    #   docker ps / inspect / other           → exit 0
    cat > "$SW_TMP/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_CALLS_FILE"
# `docker exec -i <c> mariadb-dump ...`
if [ "$1" = "exec" ] && printf '%s\n' "$@" | grep -q 'mariadb-dump'; then
    # Emit a small placeholder dump; gzip in the caller pipeline will compress it.
    cat "$MARIADB_DUMP_BODY" 2>/dev/null || printf 'CREATE TABLE test (id INT);\n'
    exit 0
fi
# `docker exec -i <c> mariadb ...`  → consume stdin
if [ "$1" = "exec" ] && printf '%s\n' "$@" | grep -q 'mariadb '; then
    cat > /dev/null
    exit 0
fi
exit 0
SH
    chmod +x "$SW_TMP/docker"
    PATH="$SW_TMP:$PATH"
    export PATH

    # Pre-populate the dump body so we can assert file size > 0.
    printf 'CREATE TABLE sample (\n  id INT PRIMARY KEY\n);\nINSERT INTO sample VALUES (1), (2);\n' > "$MARIADB_DUMP_BODY"

    # Silence log lines.
    info() { :; }
    ok()   { :; }
    warn() { :; }
    err()  { :; }
    # Match the real die() semantics — terminate the (sub)shell with exit 1
    # so `bats run` captures a non-zero status when a guard trips.
    die()  { printf 'die: %s\n' "$*" >&2; exit 1; }
    export -f info ok warn err die

    # Provide stubs for swctl globals the snapshot helpers read.
    SW_DB_ROOT_USER="root"
    SW_DB_ROOT_PASSWORD="rootpw"
    SW_INFRA_DB_CONTAINER="swctl-mariadb"
    SW_PROJECT_SLUG="testproj"
    ISSUE_ID="12345"
    DB_NAME="sw_test_12345"
    SWCTL_STATE_DIR="$SW_TMP/state"
    export SW_DB_ROOT_USER SW_DB_ROOT_PASSWORD SW_INFRA_DB_CONTAINER \
           SW_PROJECT_SLUG ISSUE_ID DB_NAME SWCTL_STATE_DIR

    # container_running is invoked before exec; stub it to always pass.
    container_running() { return 0; }
    # resolve_db_container — return our infra name without consulting docker.
    resolve_db_container() { printf '%s' "$SW_INFRA_DB_CONTAINER"; }
    # require_cmd — disable, the test environment may not have everything.
    require_cmd() { :; }
    export -f container_running resolve_db_container require_cmd

    SNAP_DIR="$(_snapshot_dir)"
    mkdir -p "$SNAP_DIR"
    export SNAP_DIR
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# ---------------------------------------------------------------------------

@test "snapshot create writes a gzip file under the issue snapshots dir" {
    run _snapshot_create "$SNAP_DIR" "before-migration"
    [ "$status" -eq 0 ]
    [ -f "$SNAP_DIR/before-migration.sql.gz" ]
    # File should be non-empty (gzip wrapper around the stub dump body).
    [ -s "$SNAP_DIR/before-migration.sql.gz" ]
    # And actually be gzip — first two bytes are 1f 8b.
    head -c 2 "$SNAP_DIR/before-migration.sql.gz" | od -An -tx1 | tr -d ' ' | grep -q '1f8b'
}

@test "snapshot create invokes mariadb-dump with --single-transaction and the right DB" {
    run _snapshot_create "$SNAP_DIR" "v1"
    [ "$status" -eq 0 ]
    grep -q 'mariadb-dump' "$DOCKER_CALLS_FILE"
    grep -q -- '--single-transaction' "$DOCKER_CALLS_FILE"
    grep -q -- '--quick' "$DOCKER_CALLS_FILE"
    grep -q "$DB_NAME" "$DOCKER_CALLS_FILE"
}

@test "snapshot create refuses to overwrite an existing snapshot" {
    _snapshot_create "$SNAP_DIR" "dup" >/dev/null
    run _snapshot_create "$SNAP_DIR" "dup"
    [ "$status" -ne 0 ]
}

@test "snapshot list shows snapshots in a header + row format" {
    _snapshot_create "$SNAP_DIR" "alpha" >/dev/null
    _snapshot_create "$SNAP_DIR" "beta"  >/dev/null
    run _snapshot_list "$SNAP_DIR"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | grep -q '^NAME'
    printf '%s\n' "$output" | grep -q 'alpha'
    printf '%s\n' "$output" | grep -q 'beta'
}

@test "snapshot list reports nothing when dir is empty" {
    run _snapshot_list "$SNAP_DIR"
    [ "$status" -eq 0 ]
}

@test "snapshot delete removes the file" {
    _snapshot_create "$SNAP_DIR" "to-delete" >/dev/null
    [ -f "$SNAP_DIR/to-delete.sql.gz" ]
    run _snapshot_delete "$SNAP_DIR" "to-delete"
    [ "$status" -eq 0 ]
    [ ! -f "$SNAP_DIR/to-delete.sql.gz" ]
}

@test "snapshot delete fails for an unknown name" {
    run _snapshot_delete "$SNAP_DIR" "does-not-exist"
    [ "$status" -ne 0 ]
}

@test "snapshot restore drops + recreates the DB then pipes gunzip output" {
    _snapshot_create "$SNAP_DIR" "rollback" >/dev/null

    # Stub the prompt to auto-confirm.
    prompt_text() { printf 'yes'; }
    export -f prompt_text

    run _snapshot_restore "$SNAP_DIR" "rollback"
    [ "$status" -eq 0 ]

    # The drop+create statement and the import-via-mariadb must both have run.
    grep -q 'DROP DATABASE' "$DOCKER_CALLS_FILE"
    grep -q "CREATE DATABASE \`${DB_NAME}\`" "$DOCKER_CALLS_FILE"
    grep -q "mariadb -u" "$DOCKER_CALLS_FILE"
}

@test "snapshot restore aborts when user does not type 'yes'" {
    _snapshot_create "$SNAP_DIR" "keep-it" >/dev/null

    # Decline confirmation.
    prompt_text() { printf 'no'; }
    export -f prompt_text

    run _snapshot_restore "$SNAP_DIR" "keep-it"
    [ "$status" -ne 0 ]
    # Neither drop nor restore should have happened.
    ! grep -q 'DROP DATABASE' "$DOCKER_CALLS_FILE"
}

@test "snapshot restore fails when the named snapshot doesn't exist" {
    run _snapshot_restore "$SNAP_DIR" "nope"
    [ "$status" -ne 0 ]
}
