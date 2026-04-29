#!/usr/bin/env bats

load test_helper

# Regression guard for `swctl create`'s preflight suite.  Tests target
# the two pure helpers — `_preflight_one` (per-check primitive) and
# `_run_preflight_checks` (aggregator) — without touching docker or the
# real filesystem state.  Real-docker checks are exercised separately
# by integration tests with `require_docker`.
#
# History: every failure mode covered here was observed in production
# this week — bwrap-sandbox-blocked alpine pull, missing swctl-proxy
# network, orphan worktree dirs, full disks.  The preflight catches
# them BEFORE the slow create steps; this test pins down the
# aggregation + remediation-hint behaviour so refactors don't quietly
# regress it.

setup() {
    SW_TMP="$(mktemp -d)"
    export SW_TMP
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# ---------------------------------------------------------------------------
# _preflight_one: per-check primitive
# ---------------------------------------------------------------------------

@test "_preflight_one: passing check prints '✓ <label>' and returns 0" {
    run _preflight_one "label here" 'true' 'ignored hint'
    [ "$status" -eq 0 ]
    [[ "$output" == *"✓ label here"* ]]
    # Hint must NOT print on pass — it's only for the user's eye on failure
    [[ "$output" != *"ignored hint"* ]]
}

@test "_preflight_one: failing check prints '✗ <label>' and returns 1" {
    run _preflight_one "label here" 'false'
    [ "$status" -eq 1 ]
    [[ "$output" == *"✗ label here"* ]]
}

@test "_preflight_one: failure prints the remediation hint" {
    run _preflight_one "broken thing" 'false' 'Run: fix-the-broken-thing --now'
    [ "$status" -eq 1 ]
    [[ "$output" == *"✗ broken thing"* ]]
    [[ "$output" == *"Run: fix-the-broken-thing --now"* ]]
}

@test "_preflight_one: passes when command exits 0 even with stderr noise" {
    # Real docker commands print "Cannot connect" warnings to stderr
    # while still exiting 0 in some configurations — make sure we
    # don't false-alarm on those.
    run _preflight_one "noisy ok" 'echo "warning: foo" >&2; true'
    [ "$status" -eq 0 ]
    [[ "$output" == *"✓ noisy ok"* ]]
}

@test "_preflight_one: omitted hint is gracefully not shown" {
    run _preflight_one "no hint" 'false'
    [ "$status" -eq 1 ]
    [[ "$output" == *"✗ no hint"* ]]
    [[ "$output" != *"└─"* ]]  # no hint marker should appear
}

# ---------------------------------------------------------------------------
# _run_preflight_checks: aggregator
# ---------------------------------------------------------------------------
#
# We can't easily mock docker in bats without a heavy fixture, so these
# tests focus on the AGGREGATION behaviour: do all checks run even after
# one fails?  Is the summary line correct?  Is the exit code right?
#
# The trick: stub docker into a function returning a known exit code and
# put it on PATH ahead of the real one.  Disk + worktree checks read
# real fs state, so we point them at temp paths the test owns.

_install_stub_docker() {
    # Args: $1 = exit code for ALL invocations (sticky).
    # The stub also returns sensible stdout for the specific docker
    # subcommands the preflight uses, so checks that grep the output
    # don't false-fail due to an empty body.  Real-docker tests live
    # under tests/integration/ behind require_docker.
    local rc="$1"
    cat > "$SW_TMP/docker" <<EOF
#!/usr/bin/env bash
# 'docker ps --filter name=^FOO$ --format {{.Names}}' is used by the
# mariadb-running check.  When rc=0, echo a name back so grep -q .
# matches; when rc!=0, echo nothing so the check fails as expected.
if [ "$rc" = "0" ] && [ "\$1" = "ps" ]; then
    # Last arg before --format is the filter value; just echo "stub-ok"
    # so grep -q . sees a line.
    echo "stub-ok"
fi
exit $rc
EOF
    chmod +x "$SW_TMP/docker"
    PATH="$SW_TMP:$PATH"
    export PATH
}

@test "_run_preflight_checks: docker daemon down => failure aggregated" {
    _install_stub_docker 1 ""
    SW_WORKTREE_ROOT="$SW_TMP"
    PROJECT_ROOT="$SW_TMP"
    SWCTL_TEMPLATE_DIR="$SW_TMP"
    touch "$SW_TMP/docker-compose.swctl.yml"   # so the templates check passes
    SW_TRAEFIK_NETWORK="net"
    SW_INFRA_DB_CONTAINER="db"
    ISSUE_ID="9999"
    WORKTREE_PATH="$SW_TMP/wt-9999"  # doesn't exist => path-free check passes

    run _run_preflight_checks
    [ "$status" -eq 1 ]
    [[ "$output" == *"✗ docker daemon"* ]]
    # Summary line must mention FAILED
    [[ "$output" == *"preflight] FAILED"* ]]
}

@test "_run_preflight_checks: missing compose templates => specific failure" {
    _install_stub_docker 0
    SW_WORKTREE_ROOT="$SW_TMP"
    PROJECT_ROOT="$SW_TMP/no-such-dir"
    SWCTL_TEMPLATE_DIR="$SW_TMP/no-such-dir"
    SW_TRAEFIK_NETWORK="net"
    SW_INFRA_DB_CONTAINER="db"
    ISSUE_ID="9999"
    WORKTREE_PATH="$SW_TMP/wt-9999"

    run _run_preflight_checks
    [ "$status" -eq 1 ]
    [[ "$output" == *"✗ compose templates accessible"* ]]
    [[ "$output" == *"SWCTL_TEMPLATE_DIR"* ]]  # remediation hint visible
}

@test "_run_preflight_checks: aggregates multiple failures in one pass" {
    # docker fails AND templates dir missing — both should print, even
    # though the first failure could short-circuit the run.  This is
    # the regression guard for the whole "see all problems at once"
    # design goal.
    _install_stub_docker 1
    SW_WORKTREE_ROOT="$SW_TMP"
    PROJECT_ROOT="$SW_TMP/no-such-dir"
    SWCTL_TEMPLATE_DIR="$SW_TMP/no-such-dir"
    SW_TRAEFIK_NETWORK="net"
    SW_INFRA_DB_CONTAINER="db"
    ISSUE_ID="9999"
    WORKTREE_PATH="$SW_TMP/wt-9999"

    run _run_preflight_checks
    [ "$status" -eq 1 ]
    [[ "$output" == *"✗ docker daemon"* ]]
    [[ "$output" == *"✗ compose templates accessible"* ]]
}

@test "_run_preflight_checks: existing worktree path is flagged" {
    _install_stub_docker 0
    SW_WORKTREE_ROOT="$SW_TMP"
    PROJECT_ROOT="$SW_TMP"
    SWCTL_TEMPLATE_DIR="$SW_TMP"
    touch "$SW_TMP/docker-compose.swctl.yml"
    SW_TRAEFIK_NETWORK="net"
    SW_INFRA_DB_CONTAINER="db"
    ISSUE_ID="9999"
    # Create a directory at WORKTREE_PATH that's NOT registered with git.
    # Real `git worktree list` (called via the stubbed docker stub PATH)
    # will fail, so the check correctly sees it as orphan.
    WORKTREE_PATH="$SW_TMP/wt-collision"
    mkdir -p "$WORKTREE_PATH"

    run _run_preflight_checks
    [ "$status" -eq 1 ]
    [[ "$output" == *"✗ worktree path free"* ]]
    [[ "$output" == *"swctl clean 9999"* ]]  # remediation hint
}

@test "_run_preflight_checks: missing WORKTREE_PATH skips that check (no false alarm)" {
    # When the caller hasn't computed WORKTREE_PATH yet, the helper
    # should silently skip the worktree-collision check rather than
    # erroring on an empty value.  The other checks must still run.
    _install_stub_docker 0
    SW_WORKTREE_ROOT="$SW_TMP"
    PROJECT_ROOT="$SW_TMP"
    SWCTL_TEMPLATE_DIR="$SW_TMP"
    touch "$SW_TMP/docker-compose.swctl.yml"
    SW_TRAEFIK_NETWORK="net"
    SW_INFRA_DB_CONTAINER="db"
    unset ISSUE_ID
    unset WORKTREE_PATH

    run _run_preflight_checks
    [ "$status" -eq 0 ]
    [[ "$output" != *"worktree path free"* ]]   # this check shouldn't appear
    [[ "$output" == *"all checks passed"* ]]
}

@test "_run_preflight_checks: summary line shows elapsed seconds" {
    _install_stub_docker 0
    SW_WORKTREE_ROOT="$SW_TMP"
    PROJECT_ROOT="$SW_TMP"
    SWCTL_TEMPLATE_DIR="$SW_TMP"
    touch "$SW_TMP/docker-compose.swctl.yml"
    SW_TRAEFIK_NETWORK="net"
    SW_INFRA_DB_CONTAINER="db"
    unset ISSUE_ID; unset WORKTREE_PATH

    run _run_preflight_checks
    [ "$status" -eq 0 ]
    # Format is "all checks passed (Ns)" — match the parens + s suffix
    [[ "$output" =~ all\ checks\ passed\ \([0-9]+s\) ]]
}
