#!/usr/bin/env bats

load integration_helper

# Regression guard for the resolve auto-respawn guard
# (app/server/lib/resolve.ts::startResolveStream, added 2026-05-11
# after burning ~80M tokens on a single issue in production).
#
# Bug this prevents: the browser EventSource API auto-reconnects when
# an SSE connection drops.  Without the guard, every reconnect
# re-entered startResolveStream, called recordStart() (writing a fresh
# 'running' row to resolve-runs.json), and spawned a brand-new claude
# session with a freshly randomised --session-id — restarting the
# 8-step shopware-resolve skill from step 1.  Each restart cost
# 7–15M tokens, and the loop fired multiple times per minute.
#
# Guard semantics (locked down here):
#   1. If resolve-runs.json has a 'running' entry for the same issue
#      whose startedAt is within RUNNING_WINDOW_MS (30 min), refuse
#      the new request with an SSE log + clean done event.  Older
#      'running' entries are treated as stale (crashed claude) so
#      the user is never permanently locked out.
#   2. If the most recent entry for this issue terminated within
#      RECENT_FINISH_WINDOW_MS (90 s) — done OR failed OR
#      budget-exceeded — refuse.  This catches the EventSource
#      auto-reconnect-immediately-after-finish window.
#   3. The refusal is always emitted as `event: done` with
#      `exitCode: 0` so the browser doesn't keep reconnecting on
#      what it would otherwise interpret as a network error.
#
# These tests stand up resolve-runs.json with synthetic entries and
# hit the live `/api/skill/resolve/stream` endpoint via curl, then
# assert the SSE stream content.

setup() {
    require_docker
    if ! curl -sf -o /dev/null http://swctl.orb.local/api/github/labels/defaults 2>/dev/null; then
        skip "swctl-ui not reachable at http://swctl.orb.local — run 'swctl ui start' first"
    fi

    # Use a deliberately-unused issue number so we never collide with
    # the user's actual workload.  88880-88889 range chosen to be
    # obviously synthetic.
    ISSUE_NUMBER=88880
    ISSUE_URL="https://github.com/shopware/shopware/issues/$ISSUE_NUMBER"
    RUNS_FILE="$HOME/.local/state/swctl/resolve-runs.json"
    BACKUP="$BATS_TMPDIR/resolve-runs.bak.$$"
    cp "$RUNS_FILE" "$BACKUP" 2>/dev/null || echo '[]' > "$BACKUP"

    export ISSUE_NUMBER ISSUE_URL RUNS_FILE BACKUP
}

teardown() {
    # Always restore the user's resolve-runs.json so the test never
    # leaves synthetic entries behind that could confuse the UI.
    [ -f "$BACKUP" ] && cp "$BACKUP" "$RUNS_FILE"
    rm -f "$BACKUP"

    # Safety net: the "negative" tests deliberately let the request
    # past the guard, so the server actually starts a create flow
    # against our synthetic issue number.  Without this cleanup the
    # worktree directory + registry .env survive across runs and
    # confuse subsequent test invocations (and pollute swctl status).
    if [ -f "$HOME/.local/state/swctl/instances/trunk/${ISSUE_NUMBER}.env" ] \
        || [ -d "/Users/ytran/Shopware/_worktrees/sw-${ISSUE_NUMBER}" ]; then
        swctl clean "$ISSUE_NUMBER" --force >/dev/null 2>&1 || true
        rm -f "$HOME/.local/state/swctl/instances/trunk/${ISSUE_NUMBER}.env"
    fi
}

# Replace resolve-runs.json with a fresh array containing ONLY the
# synthetic entry.  Earlier versions prepended to the real history,
# but that turned out to be flaky when prior tests in the suite left
# entries for the same issue number in $BACKUP — the guard then keyed
# off the wrong entry.  A fresh single-element array is hermetic.
#
# Atomic write (temp file + rename) is required: a plain
# `printf > $RUNS_FILE` truncates the file before writing the new
# content, opening a tiny window where the swctl-ui server reads
# zero bytes, `JSON.parse('')` throws, the try/catch in readRuns()
# silently returns `[]`, the guard finds nothing to match against,
# and the request proceeds past the guard — making this test flake
# in ~15% of runs.  rename(2) is atomic on POSIX so the server
# always sees either the old contents or the complete new array.
_inject_run_entry() {
    local entry="$1"
    local tmp="${RUNS_FILE}.test.$$"
    printf '[%s]\n' "$entry" > "$tmp"
    mv "$tmp" "$RUNS_FILE"
}

_call_resolve_stream() {
    # Refusal returns instantly (event: done closes the stream).
    # Allowed requests stream indefinitely — we cap at 4 s with curl's
    # --max-time and accept its exit-28 (timeout) as a success signal,
    # since by then we've captured the first SSE events we need to
    # assert on.
    #
    # Capture via --output instead of $() to avoid a pipe race:
    # when the server closes the SSE stream immediately after writing
    # the refusal events, curl can exit before bash drains the last
    # bytes out of the pipe, silently losing the "event: done" tail —
    # which makes the test flake out roughly 1 run in 5.  Writing to a
    # file is byte-deterministic.
    local tmp="${BATS_TEST_TMPDIR:-$BATS_TMPDIR}/sse-output.$$"
    curl -sN --max-time 4 --output "$tmp" \
        "http://swctl.orb.local/api/skill/resolve/stream?issue=${ISSUE_URL}&mode=qa&backend=claude" \
        2>&1 || true
    cat "$tmp" 2>/dev/null
    rm -f "$tmp"
}

# ---------------------------------------------------------------------------
# Guard A: in-flight 'running' entry → refusal.
# ---------------------------------------------------------------------------

@test "guard refuses when a 'running' entry exists for the same issue" {
    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    _inject_run_entry "{
        \"issue\": \"$ISSUE_URL\",
        \"mode\": \"qa\",
        \"backend\": \"claude\",
        \"startedAt\": \"$now\",
        \"status\": \"running\"
    }"

    local output
    output="$(_call_resolve_stream)"
    [[ "$output" == *"resolve already running for $ISSUE_URL"* ]]
    [[ "$output" == *"refusing duplicate spawn"* ]]
    [[ "$output" == *'"exitCode":0'* ]]
}

# ---------------------------------------------------------------------------
# Guard B: recent 'done' finish → refusal (post-finish reconnect window).
# This is THE bug — claude finished, server marked status=done, browser
# reconnected 1 sec later, and the original guard let it through.
# ---------------------------------------------------------------------------

@test "guard refuses immediate reconnect after a recent 'done' finish (<90s)" {
    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    _inject_run_entry "{
        \"issue\": \"$ISSUE_URL\",
        \"mode\": \"qa\",
        \"backend\": \"claude\",
        \"startedAt\": \"$now\",
        \"status\": \"done\",
        \"exitCode\": 0,
        \"finishedAt\": \"$now\",
        \"lastCompletedStep\": 8,
        \"tokensTotal\": 9000000
    }"

    local output
    output="$(_call_resolve_stream)"
    if ! [[ "$output" == *"refusing duplicate spawn"* ]]; then
        echo "RUNS FILE STATE:" >&3
        cat "$RUNS_FILE" >&3
        echo "CURL OUTPUT (${#output} bytes):" >&3
        echo "$output" >&3
    fi
    [[ "$output" == *"only just finished"* ]]
    [[ "$output" == *"status=done"* ]]
    [[ "$output" == *"refusing duplicate spawn"* ]]
}

# ---------------------------------------------------------------------------
# Guard B again: recent 'failed' finish also triggers refusal.
# A SIGKILL → SIGTERM cycle from a single click also produces a
# rapid 'failed' that the browser would otherwise reconnect into.
# ---------------------------------------------------------------------------

@test "guard refuses reconnect after a recent 'failed' finish (<90s)" {
    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    _inject_run_entry "{
        \"issue\": \"$ISSUE_URL\",
        \"mode\": \"qa\",
        \"backend\": \"claude\",
        \"startedAt\": \"$now\",
        \"status\": \"failed\",
        \"exitCode\": 143,
        \"finishedAt\": \"$now\",
        \"lastCompletedStep\": 5,
        \"tokensTotal\": 5500000
    }"

    local output
    output="$(_call_resolve_stream)"
    [[ "$output" == *"only just finished"* ]]
    [[ "$output" == *"status=failed"* ]]
    [[ "$output" == *"refusing duplicate spawn"* ]]
}

# ---------------------------------------------------------------------------
# Negative: an OLD finished entry (>90 s ago) does NOT refuse — the
# user can legitimately re-resolve the same issue once enough time
# has passed.  Without this allowance the guard would lock the issue
# out forever after a single click.
# ---------------------------------------------------------------------------

@test "guard allows new start when previous finish is older than RECENT window" {
    local long_ago
    long_ago=$(date -u -v-10M +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null \
        || date -u -d "10 minutes ago" +"%Y-%m-%dT%H:%M:%S.000Z")
    _inject_run_entry "{
        \"issue\": \"$ISSUE_URL\",
        \"mode\": \"qa\",
        \"backend\": \"claude\",
        \"startedAt\": \"$long_ago\",
        \"status\": \"done\",
        \"exitCode\": 0,
        \"finishedAt\": \"$long_ago\",
        \"lastCompletedStep\": 8,
        \"tokensTotal\": 1000000
    }"

    local output
    output="$(_call_resolve_stream)"
    # Critical: the refusal log MUST NOT appear — guard let the request
    # through.  We don't assert on the post-guard start path because
    # it's network-bound (issue-label fetch, scope detection) and the
    # 4-second curl cap may close the stream before the first
    # post-guard log line is forwarded.  Absence-of-refusal is the
    # specific behaviour under test.
    [[ "$output" != *"refusing duplicate spawn"* ]]
    [[ "$output" != *"only just finished"* ]]
    [[ "$output" != *"resolve already running"* ]]
}

# ---------------------------------------------------------------------------
# Stale 'running' (older than RUNNING_WINDOW_MS) is treated as a
# crashed-claude leftover — the user is allowed to start a fresh run.
# Otherwise a missed close handler would lock the issue out forever.
# ---------------------------------------------------------------------------

@test "guard allows new start when 'running' entry is older than RUNNING window" {
    local long_ago
    long_ago=$(date -u -v-1H +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null \
        || date -u -d "1 hour ago" +"%Y-%m-%dT%H:%M:%S.000Z")
    _inject_run_entry "{
        \"issue\": \"$ISSUE_URL\",
        \"mode\": \"qa\",
        \"backend\": \"claude\",
        \"startedAt\": \"$long_ago\",
        \"status\": \"running\"
    }"

    local output
    output="$(_call_resolve_stream)"
    [[ "$output" != *"refusing duplicate spawn"* ]]
}
