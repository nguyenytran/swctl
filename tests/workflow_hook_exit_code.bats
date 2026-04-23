#!/usr/bin/env bats

load test_helper

# Lock down the exit-code propagation path from a workflow hook
# (build.sh) up through run_workflow_hook → run_frontend_build_if_needed
# → the cmd_create `|| die` check.
#
# Regression guard for v0.5.0 / v0.5.2 hotfix: the admin npm build's
# fatal failure (exit 2 from inside the docker exec, bubbled up through
# build.sh's `return 2`) must reach cmd_create so it can abort with
# STATUS=failed.  Before this fix, the hook's return code was silently
# swallowed and the create "succeeded" with a broken admin.

setup() {
    _it_hookdir="$BATS_TEST_TMPDIR/hooks-$$"
    mkdir -p "$_it_hookdir/hooks"
    SWCTL_WORKFLOW_DIR="$_it_hookdir"
}

@test "run_workflow_hook: propagates hook return code on success (0)" {
    cat > "$_it_hookdir/hooks/build.sh" <<'EOF'
#!/usr/bin/env bash
return 0 2>/dev/null || exit 0
EOF
    run_workflow_hook "build"
    [ "$?" -eq 0 ]
}

@test "run_workflow_hook: propagates hook return code on failure (2)" {
    # Matches build.sh's pattern — `return 2 2>/dev/null || exit 2` so the
    # same hook works whether sourced or invoked directly.
    cat > "$_it_hookdir/hooks/build.sh" <<'EOF'
#!/usr/bin/env bash
return 2 2>/dev/null || exit 2
EOF
    run run_workflow_hook "build"
    [ "$status" -eq 2 ]
}

@test "run_workflow_hook: returns 0 when hook file missing (no-op)" {
    # No build.sh exists → hook is silently skipped, should NOT fail the
    # caller.  Matches the current pass-through behaviour.
    rm -f "$_it_hookdir/hooks/build.sh"
    run_workflow_hook "build"
    [ "$?" -eq 0 ]
}

@test "run_workflow_hook: returns 0 when SWCTL_WORKFLOW_DIR unset" {
    SWCTL_WORKFLOW_DIR=""
    run run_workflow_hook "build"
    [ "$status" -eq 0 ]
}

@test "run_frontend_build_if_needed: propagates hook exit code 2 (v0.5.2 regression guard)" {
    # This is the MOST IMPORTANT assertion — if this ever fails, fatal
    # admin build failures start being silently swallowed again.
    cat > "$_it_hookdir/hooks/build.sh" <<'EOF'
#!/usr/bin/env bash
return 2 2>/dev/null || exit 2
EOF
    run run_frontend_build_if_needed "dummy-compose-project"
    [ "$status" -eq 2 ]
}

@test "run_frontend_build_if_needed: returns 0 when hook succeeds" {
    cat > "$_it_hookdir/hooks/build.sh" <<'EOF'
#!/usr/bin/env bash
return 0 2>/dev/null || exit 0
EOF
    run_frontend_build_if_needed "dummy-compose-project"
    [ "$?" -eq 0 ]
}
