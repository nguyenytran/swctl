#!/usr/bin/env bats

load test_helper

# _is_critical_alias is the filter cmd_doctor uses (step 8) to decide which
# shared-alias collisions on a docker network are worth warning about.
#
# Regression guard (v0.5.3): the original inline filter generated noise
# because every worktree joining trunk_default exposes its compose service
# as `web` (or `app`), and two+ worktrees sharing that alias is expected
# and harmless.  The allowlist must stay focused on the aliases that
# actually break the app when DNS round-robins: database-tier, cache-tier,
# search-tier, and mailer.

@test "_is_critical_alias: database is critical" {
    run _is_critical_alias "database"
    [ "$status" -eq 0 ]
}

@test "_is_critical_alias: mysql is critical" {
    run _is_critical_alias "mysql"
    [ "$status" -eq 0 ]
}

@test "_is_critical_alias: mariadb is critical" {
    run _is_critical_alias "mariadb"
    [ "$status" -eq 0 ]
}

@test "_is_critical_alias: postgres variants are critical" {
    run _is_critical_alias "postgres";    [ "$status" -eq 0 ]
    run _is_critical_alias "postgresql";  [ "$status" -eq 0 ]
}

@test "_is_critical_alias: redis is critical" {
    run _is_critical_alias "redis"
    [ "$status" -eq 0 ]
}

@test "_is_critical_alias: valkey is critical" {
    # v0.5.3 needed this: swctl-redis and trunk-valkey-1 both aliased as `valkey`.
    run _is_critical_alias "valkey"
    [ "$status" -eq 0 ]
}

@test "_is_critical_alias: opensearch + elasticsearch + es are critical" {
    run _is_critical_alias "opensearch";    [ "$status" -eq 0 ]
    run _is_critical_alias "elasticsearch"; [ "$status" -eq 0 ]
    run _is_critical_alias "es";            [ "$status" -eq 0 ]
}

@test "_is_critical_alias: mailer variants are critical" {
    run _is_critical_alias "mailer";  [ "$status" -eq 0 ]
    run _is_critical_alias "mailhog"; [ "$status" -eq 0 ]
    run _is_critical_alias "mailpit"; [ "$status" -eq 0 ]
}

@test "_is_critical_alias: messagebus + rabbitmq are critical" {
    run _is_critical_alias "rabbitmq";   [ "$status" -eq 0 ]
    run _is_critical_alias "messagebus"; [ "$status" -eq 0 ]
}

@test "_is_critical_alias: 'web' is NOT critical (regression guard)" {
    # Every trunk worktree's compose names its service `web` → they all
    # collide on trunk_default.  Alerting on `web` would produce a warn
    # on every healthy multi-worktree setup.  Must stay noisy-filter-negative.
    run _is_critical_alias "web"
    [ "$status" -ne 0 ]
}

@test "_is_critical_alias: 'app' is NOT critical" {
    run _is_critical_alias "app"
    [ "$status" -ne 0 ]
}

@test "_is_critical_alias: empty alias is NOT critical" {
    run _is_critical_alias ""
    [ "$status" -ne 0 ]
}

@test "_is_critical_alias: unknown aliases are NOT critical" {
    run _is_critical_alias "adminer"
    [ "$status" -ne 0 ]
    run _is_critical_alias "my-custom-service"
    [ "$status" -ne 0 ]
}

@test "_is_critical_alias: case-sensitive (matches exact compose service names)" {
    # Docker aliases are always lowercase in practice; upper-case variants
    # should not match the allowlist.  This guards against accidental
    # case-insensitive matching which would re-introduce the `Web` noise.
    run _is_critical_alias "Database"
    [ "$status" -ne 0 ]
    run _is_critical_alias "REDIS"
    [ "$status" -ne 0 ]
}
