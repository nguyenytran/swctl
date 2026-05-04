#!/usr/bin/env bats

load test_helper

# Regression guard for `swctl checkout` auto-QA-mode behavior.
#
# `swctl checkout <issue>` checks out the worktree's branch into the main
# repo for editing.  While the user is in checkout mode, edits land in the
# main repo — the worktree filesystem is untouched.  So the worktree's
# runtime should be in QA mode (read-only vendor symlink, no console ops,
# no frontend rebuilds): a lean idle backend.  `swctl checkout --return`
# must restore whatever mode was active before checkout.
#
# These tests cover only the bookkeeping (state file format + decision
# logic).  Stubs replace cmd_switch + git so the test doesn't touch
# docker / a real git repo.

setup() {
    SW_TMP="$(mktemp -d)"
    SWCTL_STATE_DIR="$SW_TMP/state"
    SWCTL_REGISTRY_DIR="$SW_TMP/registry"
    SWCTL_TMP_DIR="$SW_TMP/swctl-tmp"
    PROJECT_ROOT="$SW_TMP/repo"
    WORKTREE_PATH="$SW_TMP/worktree"

    mkdir -p "$SWCTL_STATE_DIR" "$SWCTL_REGISTRY_DIR/trunk" "$SWCTL_TMP_DIR" \
             "$PROJECT_ROOT" "$WORKTREE_PATH"

    # Fake instance metadata env file — what load_instance_metadata reads.
    cat > "$SWCTL_REGISTRY_DIR/trunk/9999.env" <<EOF
ISSUE_ID=9999
PROJECT_ROOT=$PROJECT_ROOT
WORKTREE_PATH=$WORKTREE_PATH
BRANCH=fix/9999-thing
COMPOSE_PROJECT=trunk-9999
CONFIG_PATH=$PROJECT_ROOT/.swctl.conf
SWCTL_MODE=dev
EOF

    # Fake project config — what load_project_config sources.
    cat > "$PROJECT_ROOT/.swctl.conf" <<'EOF'
SW_PROJECT="trunk"
SW_BASE_BRANCH="trunk"
EOF

    export SW_TMP SWCTL_STATE_DIR SWCTL_REGISTRY_DIR SWCTL_TMP_DIR \
           PROJECT_ROOT WORKTREE_PATH

    # ---- Stubs: replace docker-touching / git-touching functions ----------
    # These are defined AFTER swctl is sourced (via test_helper at file top),
    # so they shadow the real implementations for the duration of the test.

    git() {
        # Record git invocations to a log; emulate just enough behavior.
        printf 'git %s\n' "$*" >> "$SW_TMP/git.log"
        case "$*" in
            *"branch --show-current"*) printf 'main\n'; return 0 ;;
            *"rev-parse --abbrev-ref HEAD"*) printf 'main\n'; return 0 ;;
            *"rev-parse --git-common-dir"*)
                # Tests that exercise the plugin-external path set
                # FAKE_GIT_COMMON_DIR; default to a realistic-looking value.
                printf '%s\n' "${FAKE_GIT_COMMON_DIR:-$SW_TMP/plugin-repo/.git}"
                return 0 ;;
            *"checkout --detach HEAD"*) return 0 ;;
            *"checkout "*) return 0 ;;
            *) return 0 ;;
        esac
    }
    export -f git

    cmd_switch() {
        # Record the call so tests can assert on whether/how it was invoked.
        printf 'cmd_switch %s\n' "$*" >> "$SW_TMP/cmd_switch.log"
        # Mutate SWCTL_MODE the way the real cmd_switch would.
        local issue="$1"
        local flag="$2"
        case "$flag" in
            --qa)  SWCTL_MODE="qa" ;;
            --dev) SWCTL_MODE="dev" ;;
        esac
        return 0
    }
    export -f cmd_switch

    # Silence info/warn/ok in test output, but die still aborts.
    info() { :; }
    ok()   { :; }
    warn() { :; }
    export -f info ok warn

    # maybe_load_project_config and ensure_infra_ready aren't strictly needed
    # for this test path, but we silence them to keep output clean.
    ensure_infra_ready() { :; }
    auto_register_project() { :; }
    load_workflow() { :; }
    detect_template_path() { printf '/tmp/x.yml\n'; }
    export -f ensure_infra_ready auto_register_project load_workflow detect_template_path
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# ---------------------------------------------------------------------------
# Default behavior: dev → qa, save previous mode for --return
# ---------------------------------------------------------------------------

@test "checkout: dev worktree auto-switches to qa, saves dev for --return" {
    run cmd_checkout 9999
    [ "$status" -eq 0 ]

    # cmd_switch was called with --qa
    grep -q 'cmd_switch 9999 --qa' "$SW_TMP/cmd_switch.log"

    # State file records the previous mode (dev) so --return restores it
    state="$SWCTL_STATE_DIR/checkout.state"
    [ -f "$state" ]
    grep -q "^CHECKOUT_ACTIVE_ISSUE=" "$state"
    grep -q "^CHECKOUT_PREVIOUS_BRANCH=" "$state"
    grep -q "^CHECKOUT_PREVIOUS_MODE=dev" "$state"
}

# ---------------------------------------------------------------------------
# --keep-mode escape hatch: no auto-switch, empty restore field
# ---------------------------------------------------------------------------

@test "checkout --keep-mode: skips auto-switch, leaves restore mode empty" {
    run cmd_checkout 9999 --keep-mode
    [ "$status" -eq 0 ]

    # cmd_switch was NOT called
    [ ! -f "$SW_TMP/cmd_switch.log" ] || ! grep -q 'cmd_switch' "$SW_TMP/cmd_switch.log"

    # State file has CHECKOUT_PREVIOUS_MODE='' so --return is a no-op for mode
    state="$SWCTL_STATE_DIR/checkout.state"
    [ -f "$state" ]
    # bash's printf %q renders empty string as '' — match either '' or empty
    grep -qE "^CHECKOUT_PREVIOUS_MODE=('')?$" "$state"
}

# ---------------------------------------------------------------------------
# Already in qa: no-op (no spurious cmd_switch call)
# ---------------------------------------------------------------------------

@test "checkout: worktree already in qa mode does not re-invoke cmd_switch" {
    # Override the metadata to start in qa mode
    sed -i.bak 's/SWCTL_MODE=dev/SWCTL_MODE=qa/' "$SWCTL_REGISTRY_DIR/trunk/9999.env"

    run cmd_checkout 9999
    [ "$status" -eq 0 ]

    # cmd_switch must NOT be called when already in qa
    [ ! -f "$SW_TMP/cmd_switch.log" ] || ! grep -q 'cmd_switch' "$SW_TMP/cmd_switch.log"

    # No restore needed — empty CHECKOUT_PREVIOUS_MODE
    state="$SWCTL_STATE_DIR/checkout.state"
    grep -qE "^CHECKOUT_PREVIOUS_MODE=('')?$" "$state"
}

# ---------------------------------------------------------------------------
# --return restores previous mode by calling cmd_switch with the saved flag
# ---------------------------------------------------------------------------

@test "checkout --return: restores worktree to its pre-checkout mode" {
    # Simulate prior `swctl checkout 9999` (dev → qa) by pre-writing state
    cat > "$SWCTL_STATE_DIR/checkout.state" <<EOF
CHECKOUT_ACTIVE_ISSUE=9999
CHECKOUT_PREVIOUS_BRANCH=main
CHECKOUT_PREVIOUS_MODE=dev
EOF

    # Worktree currently in qa (the auto-switch result)
    sed -i.bak 's/SWCTL_MODE=dev/SWCTL_MODE=qa/' "$SWCTL_REGISTRY_DIR/trunk/9999.env"

    run cmd_checkout --return
    [ "$status" -eq 0 ]

    # cmd_switch was called with --dev to restore
    grep -q 'cmd_switch 9999 --dev' "$SW_TMP/cmd_switch.log"

    # State file removed
    [ ! -f "$SWCTL_STATE_DIR/checkout.state" ]
}

# ---------------------------------------------------------------------------
# --return with empty CHECKOUT_PREVIOUS_MODE skips the mode restore
# (this is the --keep-mode case)
# ---------------------------------------------------------------------------

@test "checkout --return: empty previous mode skips cmd_switch call" {
    cat > "$SWCTL_STATE_DIR/checkout.state" <<EOF
CHECKOUT_ACTIVE_ISSUE=9999
CHECKOUT_PREVIOUS_BRANCH=main
CHECKOUT_PREVIOUS_MODE=''
EOF

    run cmd_checkout --return
    [ "$status" -eq 0 ]

    # cmd_switch must NOT be called for the mode restore
    [ ! -f "$SW_TMP/cmd_switch.log" ] || ! grep -q 'cmd_switch' "$SW_TMP/cmd_switch.log"
    [ ! -f "$SWCTL_STATE_DIR/checkout.state" ]
}

# ---------------------------------------------------------------------------
# Arg parsing: --return / -r are equivalent, --keep-mode is positional-free
# ---------------------------------------------------------------------------

@test "checkout: -r is alias for --return" {
    cat > "$SWCTL_STATE_DIR/checkout.state" <<EOF
CHECKOUT_ACTIVE_ISSUE=9999
CHECKOUT_PREVIOUS_BRANCH=main
CHECKOUT_PREVIOUS_MODE=''
EOF

    run cmd_checkout -r
    [ "$status" -eq 0 ]
    [ ! -f "$SWCTL_STATE_DIR/checkout.state" ]
}

@test "checkout: --keep-mode accepted before issue id" {
    run cmd_checkout --keep-mode 9999
    [ "$status" -eq 0 ]

    # No cmd_switch call (--keep-mode)
    [ ! -f "$SW_TMP/cmd_switch.log" ] || ! grep -q 'cmd_switch' "$SW_TMP/cmd_switch.log"
}

@test "checkout: rejects unknown flag" {
    run cmd_checkout --bogus 9999
    [ "$status" -ne 0 ]
    [[ "$output" == *"Unknown flag"* ]]
}

# ---------------------------------------------------------------------------
# Plugin-external: operate on the PLUGIN repo + plugin worktree, not trunk.
#
# The pre-existing bug this guards: cmd_checkout used to do
#   git -C "$PROJECT_ROOT" checkout "$BRANCH"
# unconditionally — but for plugin-external instances, $BRANCH lives in
# the plugin repo, NOT trunk.  The resulting "pathspec did not match any
# file(s) known to git" error stranded the worktree in detached HEAD with
# no way back via swctl.  Now cmd_checkout resolves the plugin's main
# repo via `git rev-parse --git-common-dir` from the plugin worktree.
# ---------------------------------------------------------------------------

# Helper to set up a plugin-external instance.  The plugin worktree is a
# nested directory inside the trunk worktree; its "main repo" is at
# $SW_TMP/plugin-repo (faked via FAKE_GIT_COMMON_DIR).
#
# IMPORTANT: cmd_checkout's resolver runs `pwd -P` on the resolved main
# repo path, which on macOS canonicalizes /var → /private/var.  We do the
# same here for EXPECTED_PLUGIN_MAIN so equality holds across platforms.
_setup_plugin_external() {
    local plugin_worktree="$WORKTREE_PATH/custom/plugins/SwagFoo"
    local plugin_main="$SW_TMP/plugin-repo"
    mkdir -p "$plugin_worktree" "$plugin_main/.git"

    # Rewrite the metadata to advertise plugin-external + paths
    cat > "$SWCTL_REGISTRY_DIR/trunk/9999.env" <<EOF
ISSUE_ID=9999
PROJECT_ROOT=$PROJECT_ROOT
WORKTREE_PATH=$WORKTREE_PATH
BRANCH=fix/9999-thing
COMPOSE_PROJECT=trunk-9999
CONFIG_PATH=$PROJECT_ROOT/.swctl.conf
SWCTL_MODE=dev
PROJECT_TYPE=plugin-external
PLUGIN_NAME=SwagFoo
PLUGIN_WORKTREE_PATHS=$plugin_worktree
EOF

    # The git stub returns this path for `rev-parse --git-common-dir`.
    # cmd_checkout takes dirname → $plugin_main → that's the "main repo".
    export FAKE_GIT_COMMON_DIR="$plugin_main/.git"
    # Canonicalize to match `pwd -P` output (macOS /var → /private/var).
    EXPECTED_PLUGIN_MAIN="$(cd "$plugin_main" && pwd -P)"
    EXPECTED_PLUGIN_WORKTREE="$plugin_worktree"
    export EXPECTED_PLUGIN_MAIN EXPECTED_PLUGIN_WORKTREE
}

@test "checkout (plugin-external): persists plugin main repo + plugin worktree paths" {
    _setup_plugin_external

    run cmd_checkout 9999
    [ "$status" -eq 0 ]

    state="$SWCTL_STATE_DIR/checkout.state"
    [ -f "$state" ]

    # The state file must point at the PLUGIN repo, not trunk.
    grep -q "^CHECKOUT_MAIN_REPO=" "$state"
    grep -q "^CHECKOUT_TARGET_WORKTREE=" "$state"

    # shellcheck disable=SC1090
    . "$state"
    [ "$CHECKOUT_MAIN_REPO" = "$EXPECTED_PLUGIN_MAIN" ]
    [ "$CHECKOUT_TARGET_WORKTREE" = "$EXPECTED_PLUGIN_WORKTREE" ]
}

@test "checkout (plugin-external): detach + checkout target the plugin paths, not trunk" {
    _setup_plugin_external

    run cmd_checkout 9999
    [ "$status" -eq 0 ]

    # The detach must hit the PLUGIN worktree.
    grep -qF "git -C $EXPECTED_PLUGIN_WORKTREE checkout --detach HEAD" "$SW_TMP/git.log"

    # The branch checkout must target the PLUGIN repo, not $PROJECT_ROOT.
    grep -qF "git -C $EXPECTED_PLUGIN_MAIN checkout fix/9999-thing" "$SW_TMP/git.log"

    # Trunk's main repo (PROJECT_ROOT) must NOT be touched for the branch
    # checkout — only for the `branch --show-current` lookup.  This was
    # the original bug: trunk got the checkout call and bailed.
    ! grep -qF "git -C $PROJECT_ROOT checkout fix/9999-thing" "$SW_TMP/git.log"
}

@test "checkout --return (plugin-external): restores via persisted paths" {
    _setup_plugin_external

    # Simulate a prior `cmd_checkout 9999` by pre-writing state with
    # both the new persisted paths and the previous branch.
    cat > "$SWCTL_STATE_DIR/checkout.state" <<EOF
CHECKOUT_ACTIVE_ISSUE=9999
CHECKOUT_PREVIOUS_BRANCH=main
CHECKOUT_PREVIOUS_MODE=''
CHECKOUT_MAIN_REPO=$EXPECTED_PLUGIN_MAIN
CHECKOUT_TARGET_WORKTREE=$EXPECTED_PLUGIN_WORKTREE
EOF

    run cmd_checkout --return
    [ "$status" -eq 0 ]

    # --return must restore the PLUGIN repo's branch, not trunk's.
    grep -qF "git -C $EXPECTED_PLUGIN_MAIN checkout main" "$SW_TMP/git.log"
    # And re-attach the PLUGIN worktree, not trunk's.
    grep -qF "git -C $EXPECTED_PLUGIN_WORKTREE checkout fix/9999-thing" "$SW_TMP/git.log"

    [ ! -f "$SWCTL_STATE_DIR/checkout.state" ]
}

@test "checkout (plugin-external): rejects when PLUGIN_WORKTREE_PATHS empty" {
    cat > "$SWCTL_REGISTRY_DIR/trunk/9999.env" <<EOF
ISSUE_ID=9999
PROJECT_ROOT=$PROJECT_ROOT
WORKTREE_PATH=$WORKTREE_PATH
BRANCH=fix/9999-thing
COMPOSE_PROJECT=trunk-9999
CONFIG_PATH=$PROJECT_ROOT/.swctl.conf
SWCTL_MODE=dev
PROJECT_TYPE=plugin-external
PLUGIN_NAME=SwagFoo
PLUGIN_WORKTREE_PATHS=
EOF

    run cmd_checkout 9999
    [ "$status" -ne 0 ]
    [[ "$output" == *"PLUGIN_WORKTREE_PATHS"* ]]
}

@test "checkout: refuses when main repo is already on the target branch" {
    # Override git stub to report the current branch is the issue branch.
    git() {
        printf 'git %s\n' "$*" >> "$SW_TMP/git.log"
        case "$*" in
            *"branch --show-current"*) printf 'fix/9999-thing\n'; return 0 ;;
            *"rev-parse --abbrev-ref HEAD"*) printf 'fix/9999-thing\n'; return 0 ;;
            *"rev-parse --git-common-dir"*) printf '%s\n' "$SW_TMP/plugin-repo/.git"; return 0 ;;
            *) return 0 ;;
        esac
    }
    export -f git

    run cmd_checkout 9999
    [ "$status" -ne 0 ]
    [[ "$output" == *"already on"* ]]
    # No state file should be left behind.
    [ ! -f "$SWCTL_STATE_DIR/checkout.state" ]
}
