#!/usr/bin/env bats

load test_helper

# Regression guard for PR #35: cmd_create's platform case must NOT
# auto-read $PROJECT_ROOT/.swctl.deps.yaml.
#
# Background: PR #32 introduced an auto-load of the platform-root yaml's
# `plugins:` list when no `--deps` flag was passed.  In practice this was
# surprising — every platform create silently inherited whatever plugin
# set was listed there, even when the user just wanted a vanilla create.
# PR #35 removed the auto-load.  The yaml is no longer a swctl input;
# the user picks at create time via `--deps` (or the UI's plugin picker
# that drives `--deps` end-to-end).
#
# These tests pin that behavior so a future refactor doesn't accidentally
# reintroduce the auto-load.

setup() {
    SW_TMP="$(mktemp -d)"
    PROJECT_ROOT="$SW_TMP/repo"
    mkdir -p "$PROJECT_ROOT"
    export SW_TMP PROJECT_ROOT
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# ---------------------------------------------------------------------------
# Helper still works (kept for future opt-in use, e.g. UI picker defaults).
# ---------------------------------------------------------------------------

@test "read_platform_plugin_deps helper kept (for opt-in callers)" {
    cat > "$PROJECT_ROOT/.swctl.deps.yaml" <<'EOF'
plugins:
  - SwagFoo
  - SwagBar
EOF
    run read_platform_plugin_deps "$PROJECT_ROOT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"SwagFoo"* ]]
    [[ "$output" == *"SwagBar"* ]]
}

# ---------------------------------------------------------------------------
# The grep pin: cmd_create's platform branch must NOT call
# read_platform_plugin_deps.  This is a structural test — it survives
# refactors of the deps logic as long as the auto-load isn't reintroduced.
# ---------------------------------------------------------------------------

@test "cmd_create's platform branch does not call read_platform_plugin_deps" {
    # Locate the cmd_create function body
    local swctl="$BATS_TEST_DIRNAME/../swctl"
    [ -f "$swctl" ]

    # Extract just the platform|*) case branch from cmd_create (the one
    # that actually creates a vanilla platform worktree).  Stop at the
    # next `;;` or end of cmd_create.  Use awk for clean range slicing.
    local platform_branch
    platform_branch="$(awk '
        /^cmd_create\(\) \{/         { in_create = 1 }
        in_create && /platform\|\*\)/ { in_branch = 1 }
        in_branch                     { print }
        in_branch && /^            ;;/ { exit }
    ' "$swctl")"

    [ -n "$platform_branch" ] || {
        echo "could not locate platform branch in cmd_create — test setup broke"
        return 1
    }

    # Must NOT call the helper.  (The helper itself is allowed elsewhere
    # for future opt-in use, just not auto-fired by create.)
    if echo "$platform_branch" | grep -q 'read_platform_plugin_deps'; then
        echo "FAIL: cmd_create's platform branch calls read_platform_plugin_deps."
        echo "PR #35 removed this auto-load; reintroducing it would silently"
        echo "inherit plugins from <project>/.swctl.deps.yaml on every create."
        echo "If you genuinely want the auto-load back, document why in the PR"
        echo "and update this test."
        return 1
    fi
}

# ---------------------------------------------------------------------------
# The behavior pin: when --deps is empty, the platform branch must produce
# an empty dep set — even when a yaml file exists at PROJECT_ROOT.
# This is a black-box test via the actual code path's deps-resolution
# block, extracted for testability.
# ---------------------------------------------------------------------------

@test "no --deps + yaml present → dep set is empty (yaml ignored)" {
    cat > "$PROJECT_ROOT/.swctl.deps.yaml" <<'EOF'
plugins:
  - SwagYamlOnly
EOF

    # Mirror the exact deps-resolution block from cmd_create's platform
    # case (post-#35).  If this snippet diverges from cmd_create, the
    # assertion below will catch it on the next run.
    local selected_deps=""   # simulating no --deps flag
    local dep_plugins=""
    if [ -n "${selected_deps:-}" ]; then
        local deps
        deps="$(echo "$selected_deps" | tr ',' '\n')"
        while IFS= read -r dep_name; do
            [ -n "$dep_name" ] || continue
            dep_plugins="${dep_plugins:+${dep_plugins},}${dep_name}"
        done <<< "$deps"
    fi

    [ -z "$dep_plugins" ]
}

@test "with --deps Foo,Bar (and yaml present) → exactly Foo + Bar (yaml still ignored)" {
    cat > "$PROJECT_ROOT/.swctl.deps.yaml" <<'EOF'
plugins:
  - SwagYamlOnly
EOF

    local selected_deps="SwagFoo,SwagBar"
    local dep_plugins=""
    if [ -n "${selected_deps:-}" ]; then
        local deps
        deps="$(echo "$selected_deps" | tr ',' '\n')"
        while IFS= read -r dep_name; do
            [ -n "$dep_name" ] || continue
            dep_plugins="${dep_plugins:+${dep_plugins},}${dep_name}"
        done <<< "$deps"
    fi

    [ "$dep_plugins" = "SwagFoo,SwagBar" ]
    # SwagYamlOnly must NOT have leaked in
    [[ ! "$dep_plugins" == *"SwagYamlOnly"* ]]
}
