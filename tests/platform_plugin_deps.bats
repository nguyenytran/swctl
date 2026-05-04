#!/usr/bin/env bats

load test_helper

# Regression guard for read_platform_plugin_deps + the
# `<PROJECT_ROOT>/.swctl.deps.yaml` fallback used by `swctl create`
# (platform case) to auto-spin-up plugins required by a platform issue.
#
# Why this exists: a platform fix in shopware/core sometimes only
# manifests when a specific plugin is active (e.g. SwagCommercial
# exercising a hook).  Forcing every `swctl create` invocation to pass
# `--deps SwagCommercial` is friction; declaring it once at the platform
# repo root is friction-free.
#
# Schema (at platform repo root):
#   plugins:
#     - SwagCommercial
#     - SwagPlatformSecurity
#
# CLI's `--deps` overrides this when present.  Yaml is the default.

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
# Yaml parsing: shape of `.swctl.deps.yaml`
# ---------------------------------------------------------------------------

@test "read_platform_plugin_deps: lists plugins from .swctl.deps.yaml" {
    cat > "$PROJECT_ROOT/.swctl.deps.yaml" <<'EOF'
plugins:
  - SwagCommercial
  - SwagPlatformSecurity
EOF
    run read_platform_plugin_deps "$PROJECT_ROOT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"SwagCommercial"* ]]
    [[ "$output" == *"SwagPlatformSecurity"* ]]
    # Must be one plugin per line (matches what the create loop expects)
    [ "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" = "2" ]
}

@test "read_platform_plugin_deps: empty when no .swctl.deps.yaml" {
    run read_platform_plugin_deps "$PROJECT_ROOT"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "read_platform_plugin_deps: empty when no plugins key" {
    cat > "$PROJECT_ROOT/.swctl.deps.yaml" <<'EOF'
# A plugin-style yaml at the platform root (legitimate but unrelated)
dependencies:
  - SomePlugin
platform:
  ref: feat/x
EOF
    run read_platform_plugin_deps "$PROJECT_ROOT"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "read_platform_plugin_deps: empty plugins list yields no output" {
    cat > "$PROJECT_ROOT/.swctl.deps.yaml" <<'EOF'
plugins: []
EOF
    run read_platform_plugin_deps "$PROJECT_ROOT"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "read_platform_plugin_deps: empty file does not break parser" {
    : > "$PROJECT_ROOT/.swctl.deps.yaml"
    run read_platform_plugin_deps "$PROJECT_ROOT"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "read_platform_plugin_deps: ignores other top-level keys" {
    cat > "$PROJECT_ROOT/.swctl.deps.yaml" <<'EOF'
plugins:
  - SwagCommercial
unknown_future_key:
  some: value
EOF
    run read_platform_plugin_deps "$PROJECT_ROOT"
    [ "$status" -eq 0 ]
    [ "$output" = "SwagCommercial" ]
}

# ---------------------------------------------------------------------------
# Coexistence with the plugin-side schema (read_plugin_deps /
# read_plugin_platform_ref).  Same filename, different roots, different
# top-level keys — they must not interfere.
# ---------------------------------------------------------------------------

@test "platform yaml and plugin yaml are independent (different roots)" {
    # Platform yaml at PROJECT_ROOT — uses `plugins:` key.
    cat > "$PROJECT_ROOT/.swctl.deps.yaml" <<'EOF'
plugins:
  - SwagCommercial
EOF
    # Plugin yaml in a hypothetical plugin dir — uses `dependencies:` key.
    local plugin_dir="$PROJECT_ROOT/custom/plugins/SwagCommercial"
    mkdir -p "$plugin_dir"
    cat > "$plugin_dir/.swctl.deps.yaml" <<'EOF'
dependencies:
  - SwagPlatformSecurity
platform:
  ref: feat/x
EOF

    # The platform helper sees only the platform-level list.
    run read_platform_plugin_deps "$PROJECT_ROOT"
    [ "$output" = "SwagCommercial" ]

    # The plugin helper sees only the plugin's deps.
    run read_plugin_deps "$plugin_dir"
    [ "$output" = "SwagPlatformSecurity" ]

    # The plugin's platform.ref is independent of the platform's plugins list.
    run read_plugin_platform_ref "$plugin_dir"
    [ "$output" = "feat/x" ]
}
