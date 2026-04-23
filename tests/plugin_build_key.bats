#!/usr/bin/env bats

load test_helper

# _resolve_plugin_build_key derives a docker-volume-safe cache key from:
#   1. the plugin's display name (must be lowercased + purged of characters
#      disallowed by docker volume names)
#   2. the plugin's current git HEAD (10-char short SHA)
#   3. the md5 of its package-lock.json (8-char prefix), or "no-lock" when
#      the plugin has no package-lock.json
#
# These tests lock that contract down so regressions in the caching layer
# (wrong key → wrong cache → silent stale builds) surface immediately.

setup() {
    _plugin_dir="$BATS_TEST_TMPDIR/plugin-$$"
    mkdir -p "$_plugin_dir"
    # Deterministic HEAD: commit a known file with fixed author/date.
    git -C "$_plugin_dir" init --quiet --initial-branch=main
    git -C "$_plugin_dir" config user.email "test@swctl"
    git -C "$_plugin_dir" config user.name "swctl-test"
    printf 'contents\n' > "$_plugin_dir/README.md"
    git -C "$_plugin_dir" add README.md
    GIT_COMMITTER_DATE="2026-01-01T00:00:00Z" \
    GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" \
        git -C "$_plugin_dir" commit --quiet -m "init" \
        --allow-empty-message
    _head="$(git -C "$_plugin_dir" rev-parse --short=10 HEAD)"
}

teardown() {
    rm -rf "$_plugin_dir"
}

@test "_resolve_plugin_build_key: name + head + no-lock suffix when package-lock missing" {
    result="$(_resolve_plugin_build_key "SwagCustomizedProducts" "$_plugin_dir")"
    [ "$result" = "pb-swagcustomizedproducts-${_head}-no-lock" ]
}

@test "_resolve_plugin_build_key: lowercases plugin names" {
    result="$(_resolve_plugin_build_key "MyMixedCasePlugin" "$_plugin_dir")"
    [[ "$result" == pb-mymixedcaseplugin-* ]]
}

@test "_resolve_plugin_build_key: translates disallowed chars to dashes" {
    # Docker volume names: [a-zA-Z0-9][a-zA-Z0-9_.-]*.  Slashes, colons and
    # spaces must all collapse to '-' so the returned key is always valid.
    result="$(_resolve_plugin_build_key "weird:name with/slashes" "$_plugin_dir")"
    [[ "$result" == pb-weird-name-with-slashes-* ]]
}

@test "_resolve_plugin_build_key: keeps underscores, dots and dashes" {
    result="$(_resolve_plugin_build_key "my_plugin.v2-beta" "$_plugin_dir")"
    [[ "$result" == pb-my_plugin.v2-beta-* ]]
}

@test "_resolve_plugin_build_key: includes package-lock md5 when present" {
    printf '{"lockfileVersion":3}\n' > "$_plugin_dir/package-lock.json"
    result="$(_resolve_plugin_build_key "SwagCustomizedProducts" "$_plugin_dir")"
    # Key should NOT end in 'no-lock' anymore
    [[ "$result" != *-no-lock ]]
    # The 8-char suffix comes from md5 of package-lock.json.
    # Compute independently and compare.
    if command -v md5 >/dev/null 2>&1; then
        expected_md5="$(md5 -q "$_plugin_dir/package-lock.json")"
    else
        expected_md5="$(md5sum "$_plugin_dir/package-lock.json" | awk '{print $1}')"
    fi
    [[ "$result" == *-${expected_md5:0:8} ]]
}

@test "_resolve_plugin_build_key: same HEAD + same lockfile → same key (idempotent)" {
    printf '{"lockfileVersion":3}\n' > "$_plugin_dir/package-lock.json"
    first="$(_resolve_plugin_build_key "plugin" "$_plugin_dir")"
    second="$(_resolve_plugin_build_key "plugin" "$_plugin_dir")"
    [ "$first" = "$second" ]
}

@test "_resolve_plugin_build_key: different HEAD → different key" {
    printf 'one\n' > "$_plugin_dir/one.txt"
    git -C "$_plugin_dir" add one.txt
    git -C "$_plugin_dir" commit --quiet -m "one"
    key_a="$(_resolve_plugin_build_key "plugin" "$_plugin_dir")"

    printf 'two\n' > "$_plugin_dir/two.txt"
    git -C "$_plugin_dir" add two.txt
    git -C "$_plugin_dir" commit --quiet -m "two"
    key_b="$(_resolve_plugin_build_key "plugin" "$_plugin_dir")"

    [ "$key_a" != "$key_b" ]
}

@test "_resolve_plugin_build_key: different lockfile → different key (even at same HEAD)" {
    printf '{"lockfileVersion":3}\n' > "$_plugin_dir/package-lock.json"
    key_a="$(_resolve_plugin_build_key "plugin" "$_plugin_dir")"

    printf '{"lockfileVersion":3,"name":"x"}\n' > "$_plugin_dir/package-lock.json"
    key_b="$(_resolve_plugin_build_key "plugin" "$_plugin_dir")"

    [ "$key_a" != "$key_b" ]
}

@test "_resolve_plugin_build_key: returns non-zero when plugin name empty" {
    run _resolve_plugin_build_key "" "$_plugin_dir"
    [ "$status" -ne 0 ]
}

@test "_resolve_plugin_build_key: returns non-zero when worktree path missing" {
    run _resolve_plugin_build_key "plugin" "/nonexistent/path/$$"
    [ "$status" -ne 0 ]
}

@test "_resolve_plugin_build_key: key starts with pb- prefix" {
    result="$(_resolve_plugin_build_key "x" "$_plugin_dir")"
    [[ "$result" == pb-* ]]
}
