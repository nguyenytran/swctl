#!/usr/bin/env bats

load test_helper

# Regression guard for `read_plugin_platform_ref` + the platform.ref pin
# behavior in `swctl create --plugin`.
#
# A plugin issue may depend on platform-side changes that haven't merged
# to trunk yet (a coordinated fix split across the plugin repo and
# shopware/shopware).  swctl supports pinning the trunk worktree to a
# specific git ref via:
#
#   1) CLI flag:    `swctl create --plugin Foo --platform-ref <ref> 1234`
#   2) Plugin yaml: `.swctl.deps.yaml` -> `platform.ref: <ref>`
#
# CLI wins over yaml.  When neither is set, the trunk worktree is created
# at the project's base branch (default behavior, unchanged).

setup() {
    SW_TMP="$(mktemp -d)"
    PLUGIN_DIR="$SW_TMP/plugin"
    mkdir -p "$PLUGIN_DIR"
    export SW_TMP PLUGIN_DIR
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# ---------------------------------------------------------------------------
# read_plugin_platform_ref: yaml parsing
# ---------------------------------------------------------------------------

@test "read_plugin_platform_ref: returns ref from .swctl.deps.yaml" {
    cat > "$PLUGIN_DIR/.swctl.deps.yaml" <<'EOF'
dependencies:
  - SwagOther
platform:
  ref: feat/12477-core-hook
EOF
    run read_plugin_platform_ref "$PLUGIN_DIR"
    [ "$status" -eq 0 ]
    [ "$output" = "feat/12477-core-hook" ]
}

@test "read_plugin_platform_ref: empty when platform key absent" {
    cat > "$PLUGIN_DIR/.swctl.deps.yaml" <<'EOF'
dependencies:
  - SwagOther
EOF
    run read_plugin_platform_ref "$PLUGIN_DIR"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "read_plugin_platform_ref: empty when platform.ref absent" {
    cat > "$PLUGIN_DIR/.swctl.deps.yaml" <<'EOF'
dependencies: []
platform:
  notes: leave on trunk
EOF
    run read_plugin_platform_ref "$PLUGIN_DIR"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "read_plugin_platform_ref: empty when no .swctl.deps.yaml file" {
    run read_plugin_platform_ref "$PLUGIN_DIR"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "read_plugin_platform_ref: empty file does not break parser" {
    : > "$PLUGIN_DIR/.swctl.deps.yaml"
    run read_plugin_platform_ref "$PLUGIN_DIR"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "read_plugin_platform_ref: handles SHA refs as well as branches" {
    cat > "$PLUGIN_DIR/.swctl.deps.yaml" <<'EOF'
platform:
  ref: 2c0f25600276
EOF
    run read_plugin_platform_ref "$PLUGIN_DIR"
    [ "$status" -eq 0 ]
    [ "$output" = "2c0f25600276" ]
}

# ---------------------------------------------------------------------------
# read_plugin_deps: existing behavior unchanged by the new platform key
# (regression guard — make sure we didn't accidentally break dep listing)
# ---------------------------------------------------------------------------

@test "read_plugin_deps: still returns plugin names with platform key present" {
    cat > "$PLUGIN_DIR/.swctl.deps.yaml" <<'EOF'
dependencies:
  - SwagOne
  - SwagTwo
platform:
  ref: feat/x
EOF
    run read_plugin_deps "$PLUGIN_DIR"
    [ "$status" -eq 0 ]
    [[ "$output" == *"SwagOne"* ]]
    [[ "$output" == *"SwagTwo"* ]]
}

@test "read_plugin_deps: empty when no dependencies key" {
    cat > "$PLUGIN_DIR/.swctl.deps.yaml" <<'EOF'
platform:
  ref: feat/x
EOF
    run read_plugin_deps "$PLUGIN_DIR"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}
