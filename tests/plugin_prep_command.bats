#!/usr/bin/env bats

load test_helper

# _build_plugin_prep_command emits the chained bin/console command that
# cmd_create runs AFTER the DB has been cloned to ensure the primary
# plugin (and any declared dep plugins) is registered + activated before
# bundle:dump / the admin build.
#
# Regression guard: in swctl <= v0.5.1 the primary plugin was never
# explicitly activated, which silently broke /api/_info/config whenever
# the cloned source DB had the plugin row as active=0.  These tests make
# sure the primary stays in the chain forever.

@test "_build_plugin_prep_command: primary activation is ALWAYS in the chain (v0.5.2 regression guard)" {
    result="$(_build_plugin_prep_command "SwagCustomizedProducts" "")"
    [[ "$result" == *"plugin:install --activate SwagCustomizedProducts"* ]]
}

@test "_build_plugin_prep_command: starts with plugin:refresh" {
    result="$(_build_plugin_prep_command "X" "")"
    [[ "$result" == "bin/console plugin:refresh"* ]]
}

@test "_build_plugin_prep_command: joins commands with ' && ' so one failure aborts the chain" {
    result="$(_build_plugin_prep_command "X" "")"
    # v0.7.8: chain now ends with the destructive migrate for the primary.
    [[ "$result" == *"&& bin/console database:migrate-destructive X --all" ]]
    # v0.7.8: 4 commands for a single plugin =
    #   plugin:refresh + plugin:install --activate + database:migrate + database:migrate-destructive
    count="$(printf '%s' "$result" | awk -F' && ' '{print NF}')"
    [ "$count" -eq 4 ]
}

@test "_build_plugin_prep_command: no deps → 4 commands (v0.7.8: +migrate +destructive)" {
    result="$(_build_plugin_prep_command "Primary" "")"
    count="$(printf '%s' "$result" | awk -F' && ' '{print NF}')"
    [ "$count" -eq 4 ]
}

@test "_build_plugin_prep_command: one dep → 7 commands (v0.7.8: 1 refresh + 2 plugins × 3)" {
    # Per plugin: plugin:install --activate + database:migrate + database:migrate-destructive
    # = 3 commands.  Plus 1 plugin:refresh at the start.
    # primary + 1 dep = 1 + 2*3 = 7.
    result="$(_build_plugin_prep_command "Primary" "DepA")"
    count="$(printf '%s' "$result" | awk -F' && ' '{print NF}')"
    [ "$count" -eq 7 ]
    [[ "$result" == *"plugin:install --activate DepA"* ]]
    [[ "$result" == *"database:migrate DepA --all"* ]]
    [[ "$result" == *"database:migrate-destructive DepA --all" ]]
}

@test "_build_plugin_prep_command: multiple deps → refresh + 3-cmd block per plugin" {
    result="$(_build_plugin_prep_command "Primary" "DepA,DepB,DepC")"
    count="$(printf '%s' "$result" | awk -F' && ' '{print NF}')"
    # 1 (refresh) + 4 plugins × 3 cmds each = 13.
    [ "$count" -eq 13 ]
    for p in Primary DepA DepB DepC; do
        [[ "$result" == *"plugin:install --activate $p"* ]] \
            || { echo "missing: plugin:install --activate $p"; false; }
        [[ "$result" == *"database:migrate $p --all"* ]] \
            || { echo "missing: database:migrate $p --all"; false; }
        [[ "$result" == *"database:migrate-destructive $p --all"* ]] \
            || { echo "missing: database:migrate-destructive $p --all"; false; }
    done
}

# v0.7.8 — explicit regression guard for per-plugin database:migrate.
# Background: `plugin:install --activate` runs Plugin::install() which
# runs migrations ONLY when installed_at is NULL.  Cloned DBs already
# have installed_at set, so any plugin migrations added AFTER the
# clone get silently skipped.  We chain database:migrate <plugin> --all
# unconditionally to catch this.  Idempotent — already-applied rows
# in the migration table are no-ops.
@test "_build_plugin_prep_command: v0.7.8 — primary gets database:migrate <plugin> --all" {
    result="$(_build_plugin_prep_command "SwagCommercial" "")"
    [[ "$result" == *"database:migrate SwagCommercial --all"* ]]
    [[ "$result" == *"database:migrate-destructive SwagCommercial --all"* ]]
}

@test "_build_plugin_prep_command: v0.7.8 — migrate runs AFTER activate for the same plugin" {
    result="$(_build_plugin_prep_command "X" "")"
    activate_pos="$(awk -v s="$result" 'BEGIN{print index(s, "plugin:install --activate X")}')"
    migrate_pos="$(awk -v s="$result" 'BEGIN{print index(s, "database:migrate X")}')"
    [ "$activate_pos" -gt 0 ]
    [ "$migrate_pos" -gt 0 ]
    [ "$activate_pos" -lt "$migrate_pos" ]
}

@test "_build_plugin_prep_command: primary comes BEFORE deps" {
    # Symfony's plugin:install --activate for a dep depends on the primary
    # plugin's namespace being registered, which plugin:refresh handles
    # for the primary.  Primary must be activated first so the dep
    # activation can register its services without errors.
    result="$(_build_plugin_prep_command "Primary" "Dep1")"
    primary_pos="$(awk -v s="$result" 'BEGIN{print index(s, "--activate Primary")}')"
    dep_pos="$(awk -v s="$result" 'BEGIN{print index(s, "--activate Dep1")}')"
    [ "$primary_pos" -gt 0 ]
    [ "$dep_pos" -gt 0 ]
    [ "$primary_pos" -lt "$dep_pos" ]
}

@test "_build_plugin_prep_command: respects custom bin/console path" {
    result="$(_build_plugin_prep_command "X" "" "/var/www/html/bin/console")"
    [[ "$result" == "/var/www/html/bin/console plugin:refresh"* ]]
    [[ "$result" != "bin/console plugin:refresh"* ]]
}

@test "_build_plugin_prep_command: empty primary → non-zero exit" {
    run _build_plugin_prep_command "" ""
    [ "$status" -ne 0 ]
}

@test "_build_plugin_prep_command: handles trailing commas in dep list" {
    result="$(_build_plugin_prep_command "Primary" "DepA,,DepB,")"
    # Should skip empty entries.  v0.7.8: 1 refresh + 3 plugins × 3 cmds = 10.
    count="$(printf '%s' "$result" | awk -F' && ' '{print NF}')"
    [ "$count" -eq 10 ]
    [[ "$result" == *"--activate DepA"* ]]
    [[ "$result" == *"--activate DepB"* ]]
    [[ "$result" == *"database:migrate-destructive DepB --all" ]]
}
