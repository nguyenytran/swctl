#!/usr/bin/env bats

load test_helper

# Coverage for the perf-tracking infrastructure:
#   - SWCTL_PERF_LOG: helpers append `<step>\t<seconds>\n` lines
#   - _write_perf_snapshot: serializes the TSV log into a JSON document
#     under ~/.swctl/perf/
#   - cmd_perf: reads recent snapshots and surfaces per-step medians,
#     p95, and the delta vs the previous run for regression detection
#
# Why we're investing in tests for this: the user noticed `swctl create`
# went from ~5 min to >10 min and we had no structured data to point at
# the regressing step.  This system makes future regressions instantly
# diagnosable; the tests pin its contract.

setup() {
    SW_TMP="$(mktemp -d)"
    SWCTL_PERF_DIR="$SW_TMP/perf"
    SWCTL_PERF_LOG="$SW_TMP/perf.tsv"
    SWCTL_TMP_DIR="$SW_TMP/tmp"
    mkdir -p "$SWCTL_TMP_DIR" "$SWCTL_PERF_DIR"
    : > "$SWCTL_PERF_LOG"
    export SW_TMP SWCTL_PERF_DIR SWCTL_PERF_LOG SWCTL_TMP_DIR

    # Minimal context for _write_perf_snapshot
    PROJECT_ROOT="$SW_TMP/project"
    SW_PROJECT_SLUG="trunk"
    ISSUE_ID="9999"
    BRANCH="fix/test"
    SWCTL_MODE="qa"
    LINKED_PLUGINS=""
    mkdir -p "$PROJECT_ROOT"
    git -C "$PROJECT_ROOT" init -q -b trunk 2>/dev/null
    git -C "$PROJECT_ROOT" config user.email 'bats@example.com'
    git -C "$PROJECT_ROOT" config user.name 'Bats'
    git -C "$PROJECT_ROOT" commit -q --allow-empty -m 'root'
    export PROJECT_ROOT SW_PROJECT_SLUG ISSUE_ID BRANCH SWCTL_MODE LINKED_PLUGINS

    info() { :; }
    warn() { :; }
    ok()   { :; }
    export -f info warn ok
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# ---------------------------------------------------------------------------
# _init_perf_log: creates SWCTL_TMP_DIR if missing, sets SWCTL_PERF_LOG to
# a fresh empty file, defines _perf_log helper.  Regression guard for the
# bug shipped in PR #38 where the first create after `/tmp` was wiped
# silently failed to capture any perf data.
# ---------------------------------------------------------------------------

@test "_init_perf_log: creates SWCTL_TMP_DIR if missing + sets SWCTL_PERF_LOG" {
    SWCTL_TMP_DIR="$SW_TMP/swctl-tmp-fresh"
    [ ! -d "$SWCTL_TMP_DIR" ]   # precondition: dir doesn't exist
    export SWCTL_TMP_DIR

    _init_perf_log "9999"

    [ -d "$SWCTL_TMP_DIR" ]
    [ -n "$SWCTL_PERF_LOG" ]
    [ -f "$SWCTL_PERF_LOG" ]
    [[ "$SWCTL_PERF_LOG" == *"perf-9999-"*".tsv" ]]
    # And the inline _perf_log helper writes to it
    _perf_log demo 42
    grep -q '^demo	42$' "$SWCTL_PERF_LOG"
}

@test "_init_perf_log: gracefully unsets SWCTL_PERF_LOG when log can't be written" {
    # Force the perf log to land in a path we can't open: a regular file
    # standing in where the tmp dir should be.  Direct call (not `run`)
    # so the env-var changes propagate to the test scope.
    SWCTL_TMP_DIR="$SW_TMP/blocked"
    : > "$SWCTL_TMP_DIR"   # NOT a directory
    export SWCTL_TMP_DIR

    # Capture warn output to verify the warning was surfaced
    warn() { printf 'WARN: %s\n' "$*" >> "$SW_TMP/warns.log"; }
    export -f warn

    _init_perf_log "9999"

    # SWCTL_PERF_LOG must be unset so downstream guards skip writes
    [ -z "${SWCTL_PERF_LOG:-}" ]
    # And a warning was emitted
    grep -q "Perf log unavailable" "$SW_TMP/warns.log"
}

# ---------------------------------------------------------------------------
# sync_plugin_gitignored_artifacts: emits TSV line on a real sync
# ---------------------------------------------------------------------------

@test "sync_plugin_gitignored_artifacts: appends a TSV line to SWCTL_PERF_LOG" {
    local src="$SW_TMP/src-plugin"
    local dst="$SW_TMP/dst-plugin"
    mkdir -p "$src/src/Foo/Resources/public"
    echo asset > "$src/src/Foo/Resources/public/x.js"
    mkdir -p "$dst"

    sync_plugin_gitignored_artifacts "$src" "$dst"

    # Line format: `sync_plugin_gitignored_artifacts.<basename>\t<seconds>`
    grep -qE "^sync_plugin_gitignored_artifacts\.src-plugin\s+[0-9]+$" "$SWCTL_PERF_LOG"
}

@test "sync_plugin_gitignored_artifacts: no TSV line when nothing to sync" {
    local src="$SW_TMP/empty-src"
    local dst="$SW_TMP/empty-dst"
    mkdir -p "$src" "$dst"

    sync_plugin_gitignored_artifacts "$src" "$dst"

    # No artifact dirs found → we deliberately don't log a zero entry,
    # otherwise the perf log fills with no-op rows.
    [ ! -s "$SWCTL_PERF_LOG" ]
}

# ---------------------------------------------------------------------------
# _pre_activate_linked_plugins: emits TSV line when LINKED_PLUGINS is set
# ---------------------------------------------------------------------------

@test "_pre_activate_linked_plugins: appends a TSV line when active" {
    LINKED_PLUGINS="SwagFoo"
    SW_BIN_CONSOLE="bin/console"
    export LINKED_PLUGINS SW_BIN_CONSOLE
    run_app_command() { :; }
    export -f run_app_command

    _pre_activate_linked_plugins "trunk-9999"

    grep -qE "^pre_activate_linked_plugins\s+[0-9]+$" "$SWCTL_PERF_LOG"
}

@test "_pre_activate_linked_plugins: no TSV line when LINKED_PLUGINS empty" {
    LINKED_PLUGINS=""
    export LINKED_PLUGINS

    _pre_activate_linked_plugins "trunk-9999"
    [ ! -s "$SWCTL_PERF_LOG" ]
}

# ---------------------------------------------------------------------------
# _write_perf_snapshot: TSV → JSON conversion
# ---------------------------------------------------------------------------

@test "_write_perf_snapshot: serializes TSV into a valid JSON snapshot" {
    cat > "$SWCTL_PERF_LOG" <<'EOF'
create_worktree	28
count_changes	2
sync	145
provision	220
frontend	198
total	593
EOF

    _write_perf_snapshot 593

    # Exactly one JSON file in the perf dir
    local _files=()
    while IFS= read -r f; do _files+=("$f"); done < <(find "$SWCTL_PERF_DIR" -name '*.json')
    [ "${#_files[@]}" -eq 1 ]

    # Validate shape via python (already a dep of swctl)
    python3 -c "
import json, sys
d = json.load(open('${_files[0]}'))
assert d['project'] == 'trunk', d
assert d['issue']   == '9999',  d
assert d['branch']  == 'fix/test', d
assert d['mode']    == 'qa',    d
assert d['total_seconds'] == 593, d
assert d['steps']['create_worktree'] == 28, d
assert d['steps']['provision']       == 220, d
assert d['steps']['total']           == 593, d
print('ok')
"
}

@test "_write_perf_snapshot: silent no-op when SWCTL_PERF_LOG is unset" {
    unset SWCTL_PERF_LOG
    _write_perf_snapshot 100
    # No JSON files written
    local _files=()
    while IFS= read -r f; do _files+=("$f"); done < <(find "$SWCTL_PERF_DIR" -name '*.json' 2>/dev/null)
    [ "${#_files[@]}" -eq 0 ]
}

# ---------------------------------------------------------------------------
# cmd_perf: reads JSON snapshots and surfaces a useful summary
# ---------------------------------------------------------------------------

# Helper: write a synthetic snapshot for cmd_perf tests
_write_snapshot() {
    local ts="$1" total="$2" sync="$3"
    local fname="$SWCTL_PERF_DIR/${ts}-9999-${RANDOM}.json"
    cat > "$fname" <<EOF
{
  "ts": "${ts:0:4}-${ts:4:2}-${ts:6:2}T${ts:9:2}:${ts:11:2}:${ts:13:2}Z",
  "project": "trunk",
  "issue": "9999",
  "branch": "fix/test",
  "rev": "abcd",
  "mode": "qa",
  "linked_plugins": "",
  "total_seconds": ${total},
  "steps": {
    "create_worktree": 28,
    "sync": ${sync},
    "provision": 200,
    "frontend": 100,
    "total": ${total}
  }
}
EOF
}

@test "cmd_perf: shows latest run + median + delta" {
    # Three runs: last total = 600, prev = 500, oldest = 480
    _write_snapshot 20260101T100000Z 480 100
    _write_snapshot 20260102T100000Z 500 110
    _write_snapshot 20260103T100000Z 600 200

    run cmd_perf -n 5
    [ "$status" -eq 0 ]
    [[ "$output" == *"Latest run"* ]]
    [[ "$output" == *"total: 600s"* ]]
    [[ "$output" == *"Across last 3 runs"* ]]
    # Δ vs prev for `total`: +100s (600 → 500)
    [[ "$output" == *"+100s"* ]]
}

@test "cmd_perf: --json emits a JSON array of the most-recent N snapshots" {
    _write_snapshot 20260101T100000Z 480 100
    _write_snapshot 20260102T100000Z 500 110

    run cmd_perf --json -n 5
    [ "$status" -eq 0 ]
    # Validate it parses as a JSON array of length 2
    echo "$output" | python3 -c "
import json, sys
arr = json.loads(sys.stdin.read())
assert isinstance(arr, list), arr
assert len(arr) == 2, arr
assert arr[0]['total_seconds'] == 500, arr  # most recent first (sort -r)
assert arr[1]['total_seconds'] == 480, arr
print('ok')
"
}

@test "cmd_perf: dies cleanly when no snapshots exist" {
    run cmd_perf
    [ "$status" -ne 0 ]
    [[ "$output" == *"No perf"* ]]
}

@test "cmd_perf: -n caps the number of runs included in aggregates" {
    for i in 1 2 3 4 5; do
        _write_snapshot "2026010${i}T100000Z" $((400 + i * 10)) $((100 + i * 5))
    done

    run cmd_perf -n 2
    [ "$status" -eq 0 ]
    [[ "$output" == *"Across last 2 runs"* ]]
    # The 3 older runs must not be counted
    [[ "$output" != *"Across last 5 runs"* ]]
}
