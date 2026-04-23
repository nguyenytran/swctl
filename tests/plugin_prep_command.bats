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
    [[ "$result" == *"&& bin/console plugin:install --activate X" ]]
    # Exactly two commands separated by one &&
    count="$(printf '%s' "$result" | awk -F' && ' '{print NF}')"
    [ "$count" -eq 2 ]
}

@test "_build_plugin_prep_command: no deps → 2 commands" {
    result="$(_build_plugin_prep_command "Primary" "")"
    count="$(printf '%s' "$result" | awk -F' && ' '{print NF}')"
    [ "$count" -eq 2 ]
}

@test "_build_plugin_prep_command: one dep → 3 commands" {
    result="$(_build_plugin_prep_command "Primary" "DepA")"
    count="$(printf '%s' "$result" | awk -F' && ' '{print NF}')"
    [ "$count" -eq 3 ]
    [[ "$result" == *"plugin:install --activate DepA" ]]
}

@test "_build_plugin_prep_command: multiple deps → refresh + primary + one per dep" {
    result="$(_build_plugin_prep_command "Primary" "DepA,DepB,DepC")"
    count="$(printf '%s' "$result" | awk -F' && ' '{print NF}')"
    [ "$count" -eq 5 ]
    [[ "$result" == *"plugin:install --activate DepA"* ]]
    [[ "$result" == *"plugin:install --activate DepB"* ]]
    [[ "$result" == *"plugin:install --activate DepC" ]]
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
    # Should skip empty entries, giving 4 commands (refresh + primary + 2 deps)
    count="$(printf '%s' "$result" | awk -F' && ' '{print NF}')"
    [ "$count" -eq 4 ]
    [[ "$result" == *"--activate DepA"* ]]
    [[ "$result" == *"--activate DepB" ]]
}
