#!/usr/bin/env bats

load test_helper

# Regression guard for the host-load preflight check (v0.6.19, 2026-05-17).
#
# Background: across 2026-05-15 and 2026-05-16, repeated batch creates
# on a Mac that was already at load 27-67 (Spotlight indexing recent
# worktrees + Claude Desktop renderer + Chrome + antivirus all
# competing for cores) caused docker daemon EOFs mid-create.  The
# fallout was a cascade of stale-registry / half-cloned-DB / dead-
# database-container issues that took a full v0.6.16/17/18 series to
# fully recover from.  Preventing the create in the first place is
# cheaper than healing.
#
# The check: refuse to create when `uptime`'s 1-minute load > 10 (or
# whatever SWCTL_MAX_LOAD is set to).  Override with `SWCTL_MAX_LOAD=0`
# to disable entirely.  1-minute (not 5/15) because the user's
# previous failed batch already poisoned the longer averages.
#
# Tests stub `uptime` via PATH shadow so we can simulate any load
# value deterministically.

setup() {
    SW_TMP="$(mktemp -d)"
    PROJECT_ROOT="$SW_TMP"
    SWCTL_TEMPLATE_DIR="$SW_TMP"
    SW_TRAEFIK_NETWORK="net"
    SW_INFRA_DB_CONTAINER="swctl-mariadb"
    SW_WORKTREE_ROOT="$SW_TMP"
    ISSUE_ID="9999"
    WORKTREE_PATH="$SW_TMP/wt-9999"
    touch "$SWCTL_TEMPLATE_DIR/docker-compose.swctl.yml"
    # test_helper.bash defaults SWCTL_MAX_LOAD=0 (gate disabled) so
    # the broader preflight suite isn't tripped by CI load.  Each
    # test in THIS file wants to exercise the gate with the real
    # production default — set it explicitly.  Individual tests
    # override with SWCTL_MAX_LOAD=30 / =0 to test custom values.
    SWCTL_MAX_LOAD=10
    export SW_TMP PROJECT_ROOT SWCTL_TEMPLATE_DIR SW_TRAEFIK_NETWORK \
           SW_INFRA_DB_CONTAINER SW_WORKTREE_ROOT ISSUE_ID WORKTREE_PATH \
           SWCTL_MAX_LOAD

    # Happy-path docker stub: every check passes so the load gate is
    # the only thing left to influence the preflight result.
    cat > "$SW_TMP/docker" <<'SH'
#!/usr/bin/env bash
case "$1" in
    ps)      echo "stub-ok" ;;
    image)   exit 0 ;;
    info)    exit 0 ;;
    network) exit 0 ;;
    *)       exit 0 ;;
esac
SH
    chmod +x "$SW_TMP/docker"
    PATH="$SW_TMP:$PATH"
    export PATH
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# Stub `uptime` to output a load-averages line.  Accepts a single
# argument: the 1-min load value to surface.  Mimics macOS-flavour
# output (no comma between numbers); we also test the Linux comma
# variant in a separate test.
_stub_uptime() {
    local one_min="$1"
    cat > "$SW_TMP/uptime" <<EOF
#!/usr/bin/env bash
printf '12:00  up 1 day, 0:00, 1 user, load averages: %s 1.50 1.20\n' "$one_min"
EOF
    chmod +x "$SW_TMP/uptime"
}

# ---------------------------------------------------------------------------
# Happy path: load well below threshold → check passes.
# ---------------------------------------------------------------------------

@test "preflight load: 1-min avg = 2 → passes (default threshold 10)" {
    _stub_uptime "2.50"
    run _run_preflight_checks
    [ "$status" -eq 0 ]
    [[ "$output" == *"✓ host load OK (1-min avg: 2"* ]]
}

# ---------------------------------------------------------------------------
# Right at the boundary: load = 10 with threshold 10 → still passes
# (uses > not >=).  This matches the intent: 10 is "warm but workable."
# ---------------------------------------------------------------------------

@test "preflight load: 1-min avg = 10 exactly → passes (threshold inclusive)" {
    _stub_uptime "10.00"
    run _run_preflight_checks
    [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# The incident case: load above threshold → preflight fails with the
# clear remedy text.
# ---------------------------------------------------------------------------

@test "preflight load: 1-min avg = 27 → fails (the 2026-05-15 morning load)" {
    _stub_uptime "27.50"
    run _run_preflight_checks
    [ "$status" -eq 1 ]
    [[ "$output" == *"✗ host load too high (1-min avg: 27"* ]]
    [[ "$output" == *"Wait until load <10"* ]]
}

@test "preflight load: 1-min avg = 67 → fails (the afternoon thrash load)" {
    _stub_uptime "67.89"
    run _run_preflight_checks
    [ "$status" -eq 1 ]
    [[ "$output" == *"✗ host load too high"* ]]
}

# ---------------------------------------------------------------------------
# Custom threshold via SWCTL_MAX_LOAD.  Big-machine users (Mac Studio,
# Ultra) might legitimately sit at load 15-20 with plenty of headroom.
# ---------------------------------------------------------------------------

@test "preflight load: SWCTL_MAX_LOAD=30 lets load=20 pass" {
    _stub_uptime "20.00"
    SWCTL_MAX_LOAD=30
    export SWCTL_MAX_LOAD
    run _run_preflight_checks
    [ "$status" -eq 0 ]
    [[ "$output" == *"threshold: 30"* ]]
}

# ---------------------------------------------------------------------------
# Escape hatch: SWCTL_MAX_LOAD=0 disables the check entirely.  No load
# line in output at all — preflight skips it.
# ---------------------------------------------------------------------------

@test "preflight load: SWCTL_MAX_LOAD=0 disables the check (no load line in output)" {
    _stub_uptime "999.99"  # would normally fail
    SWCTL_MAX_LOAD=0
    export SWCTL_MAX_LOAD
    run _run_preflight_checks
    [ "$status" -eq 0 ]
    [[ "$output" != *"host load"* ]]
}

# ---------------------------------------------------------------------------
# Linux-style uptime (load average, singular + commas between values).
# Same shell, same parsing path, just a different output shape.
# ---------------------------------------------------------------------------

@test "preflight load: parses Linux-style 'load average: 2.50, 1.50, 1.20'" {
    cat > "$SW_TMP/uptime" <<'EOF'
#!/usr/bin/env bash
echo " 12:00:00 up 1 day,  1:23,  1 user,  load average: 2.50, 1.50, 1.20"
EOF
    chmod +x "$SW_TMP/uptime"
    run _run_preflight_checks
    [ "$status" -eq 0 ]
    [[ "$output" == *"host load OK (1-min avg: 2"* ]]
}

# ---------------------------------------------------------------------------
# Defensive: uptime missing or broken → falls back to "?" and still
# passes (never block create on a missing utility).
# ---------------------------------------------------------------------------

@test "preflight load: missing 'uptime' binary → graceful skip" {
    rm -f "$SW_TMP/uptime"
    # System uptime might still exist; force PATH-only by emptying SW_TMP entry
    cat > "$SW_TMP/uptime" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
    chmod +x "$SW_TMP/uptime"
    run _run_preflight_checks
    # Either passes (load value is empty → check skipped) OR shows ? — both OK.
    [ "$status" -eq 0 ]
}
