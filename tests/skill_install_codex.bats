#!/usr/bin/env bats

load test_helper

# Regression-guard tests for the v0.5.x change to make
# `swctl skill install --target codex` actually work.
#
# Background: Codex doesn't have a slash-command skill registry like
# Claude (where dropping a SKILL.md into ~/.claude/skills/<name>/ is
# enough).  Codex reads `AGENTS.md` files for ambient project / global
# instructions.  So our install for the codex backend writes the
# bundled SKILL.md content into AGENTS.md, bracketed by marker
# comments so reinstall + uninstall are idempotent and don't disturb
# any other content the user has there.
#
# These tests cover:
#   - install creates the file + emits the marker block
#   - reinstall is idempotent (no duplication, line count steady)
#   - install preserves user content above and below the block
#   - install with a stale (different) block REPLACES it cleanly
#   - uninstall removes the block; deletes the file iff it's now empty
#   - uninstall preserves user content
#   - uninstall on a file with no block is a no-op (clean exit, no warn)
#   - block presence detection (used by `swctl skill status`)

setup() {
    # Hermetic HOME so tests can't touch the user's real ~/.codex/AGENTS.md.
    _h="$(mktemp -d)"
    export HOME="$_h"
    # `skill_bundle_path` derives the bundle location from $0 by default,
    # but inside bats $0 is the bats binary — so the lookup misses the
    # repo's `skills/` directory.  Pin SWCTL_SCRIPT_DIR explicitly to
    # the repo root so the helper finds skills/shopware-resolve/SKILL.md.
    export SWCTL_SCRIPT_DIR="$BATS_TEST_DIRNAME/.."
    _src_md="$(skill_bundle_path)/SKILL.md"
    _agents="$_h/.codex/AGENTS.md"
}

teardown() {
    rm -rf "${_h:-}"
}

# ---------------------------------------------------------------------------
# Direct helper coverage (block-write / block-strip / block-detect)
# ---------------------------------------------------------------------------

@test "install_block: creates file with marker block when none exists" {
    [ ! -f "$_agents" ]
    _codex_skill_install_block "$_agents" "$_src_md"
    [ -f "$_agents" ]
    grep -q '<!-- swctl:shopware-resolve:begin -->' "$_agents"
    grep -q '<!-- swctl:shopware-resolve:end -->'   "$_agents"
    # Block contains a known string from the bundled skill (front-matter name).
    grep -q 'name: shopware-resolve' "$_agents"
}

@test "install_block: preserves user content above + below the block" {
    mkdir -p "$(dirname "$_agents")"
    printf '# user content above\nrules I care about\n\n' > "$_agents"
    _codex_skill_install_block "$_agents" "$_src_md"
    # Original user content survived
    grep -q 'user content above' "$_agents"
    grep -q 'rules I care about' "$_agents"
    # Marker block was added below
    grep -q '<!-- swctl:shopware-resolve:begin -->' "$_agents"
    # User content appears BEFORE the marker
    awk '/user content above/{p1=NR} /shopware-resolve:begin/{p2=NR} END{exit !(p1<p2)}' "$_agents"
}

@test "install_block: reinstall is idempotent (no duplicated block)" {
    _codex_skill_install_block "$_agents" "$_src_md"
    local first_lines
    first_lines="$(wc -l < "$_agents")"
    _codex_skill_install_block "$_agents" "$_src_md"
    local second_lines
    second_lines="$(wc -l < "$_agents")"
    [ "$first_lines" = "$second_lines" ]
    # Exactly one begin marker
    [ "$(grep -c 'swctl:shopware-resolve:begin' "$_agents")" = "1" ]
}

@test "install_block: replaces stale block content (e.g. updated bundled skill)" {
    # Seed a "stale" block manually with placeholder content.
    mkdir -p "$(dirname "$_agents")"
    cat > "$_agents" <<EOF
some preamble

<!-- swctl:shopware-resolve:begin -->
OLD STALE CONTENT — should be replaced
<!-- swctl:shopware-resolve:end -->
EOF
    _codex_skill_install_block "$_agents" "$_src_md"
    # Old content gone, new content present
    ! grep -q 'OLD STALE CONTENT' "$_agents"
    grep -q 'name: shopware-resolve' "$_agents"
    # Preamble preserved
    grep -q 'some preamble' "$_agents"
    # Still exactly one block
    [ "$(grep -c 'swctl:shopware-resolve:begin' "$_agents")" = "1" ]
}

@test "uninstall_block: strips block + deletes file when nothing else remains" {
    _codex_skill_install_block "$_agents" "$_src_md"
    [ -f "$_agents" ]
    _codex_skill_uninstall_block "$_agents"
    [ ! -f "$_agents" ]   # empty after strip → deleted
}

@test "uninstall_block: keeps the file when user content remains" {
    mkdir -p "$(dirname "$_agents")"
    printf '# my own notes\nkeep me\n' > "$_agents"
    _codex_skill_install_block "$_agents" "$_src_md"
    _codex_skill_uninstall_block "$_agents"
    [ -f "$_agents" ]
    grep -q 'my own notes' "$_agents"
    grep -q 'keep me' "$_agents"
    # No marker comments, no SKILL content.
    ! grep -q 'swctl:shopware-resolve' "$_agents"
    ! grep -q 'name: shopware-resolve' "$_agents"
}

@test "uninstall_block: no-op (returns non-zero) when no marker present" {
    mkdir -p "$(dirname "$_agents")"
    printf 'no swctl block here\n' > "$_agents"
    run _codex_skill_uninstall_block "$_agents"
    [ "$status" -ne 0 ]
    # File untouched
    grep -q 'no swctl block here' "$_agents"
}

@test "uninstall_block: no-op when file doesn't exist at all" {
    [ ! -f "$_agents" ]
    run _codex_skill_uninstall_block "$_agents"
    [ "$status" -ne 0 ]
    [ ! -f "$_agents" ]
}

@test "block_present: detects installed block" {
    _codex_skill_install_block "$_agents" "$_src_md"
    run _codex_skill_block_present "$_agents"
    [ "$status" -eq 0 ]
}

@test "block_present: false when file has no block" {
    mkdir -p "$(dirname "$_agents")"
    printf 'just some content\n' > "$_agents"
    run _codex_skill_block_present "$_agents"
    [ "$status" -ne 0 ]
}

@test "block_present: false when file doesn't exist" {
    run _codex_skill_block_present "$_agents"
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# End-to-end via cmd_skill_install / cmd_skill_uninstall
# ---------------------------------------------------------------------------

@test "cmd_skill_install --target codex: creates AGENTS.md with block" {
    run cmd_skill_install --user --target codex
    [ "$status" -eq 0 ]
    [ -f "$_agents" ]
    grep -q 'swctl:shopware-resolve:begin' "$_agents"
}

@test "cmd_skill_install --target codex: idempotent" {
    cmd_skill_install --user --target codex
    cmd_skill_install --user --target codex
    [ "$(grep -c 'swctl:shopware-resolve:begin' "$_agents")" = "1" ]
}

@test "cmd_skill_uninstall --target codex: removes block" {
    cmd_skill_install --user --target codex
    run cmd_skill_uninstall --user --target codex
    [ "$status" -eq 0 ]
    # File deleted (was just our block)
    [ ! -f "$_agents" ]
}

@test "_ai_skill_dst codex/user: ~/.codex/AGENTS.md (file, not skills/ dir)" {
    result="$(_ai_skill_dst codex user)"
    [ "$result" = "$HOME/.codex/AGENTS.md" ]
}

@test "_ai_skill_dst codex/repo: <pwd>/AGENTS.md" {
    result="$(_ai_skill_dst codex repo)"
    [ "$result" = "$(pwd)/AGENTS.md" ]
}

@test "_ai_skill_dst claude/user: still ~/.claude/skills/shopware-resolve (regression guard)" {
    # The Claude path must NOT have been broken by the codex refactor.
    result="$(_ai_skill_dst claude user)"
    [ "$result" = "$HOME/.claude/skills/shopware-resolve" ]
}
