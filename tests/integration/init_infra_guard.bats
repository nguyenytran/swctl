#!/usr/bin/env bats

load integration_helper

# Integration tests for the init_infra guard (v0.5.3): refuse to create
# a second `database`-aliased container on a network that already has one.
#
# We test the extracted _find_alias_owner helper — init_infra uses its
# output to decide whether to skip the swctl-mariadb start.  That decision
# is so simple (`[ -n "$_existing_db" ] && return 0`) that testing the
# detection helper fully locks the guard down.

setup() {
    require_docker
    _it_net="$(it_uniq)-net"
    _it_db="$(it_uniq)-db"
    _it_app="$(it_uniq)-app"
    docker network create "$_it_net" >/dev/null
}

teardown() {
    it_cleanup_container "$_it_db"
    it_cleanup_container "$_it_app"
    it_cleanup_network   "$_it_net"
}

@test "_find_alias_owner: returns container name when alias claimed" {
    docker run -d --name "$_it_db" --network-alias database \
        --network "$_it_net" alpine sh -c 'tail -f /dev/null' >/dev/null
    result="$(_find_alias_owner "$_it_net" "database")"
    [ "$result" = "$_it_db" ]
}

@test "_find_alias_owner: empty when alias not present" {
    docker run -d --name "$_it_app" \
        --network "$_it_net" alpine sh -c 'tail -f /dev/null' >/dev/null
    result="$(_find_alias_owner "$_it_net" "database")"
    [ -z "$result" ]
}

@test "_find_alias_owner: empty when network doesn't exist" {
    result="$(_find_alias_owner "swctl-nonexistent-net-$$" "database")"
    [ -z "$result" ]
}

@test "_find_alias_owner: empty when network exists but has no containers" {
    result="$(_find_alias_owner "$_it_net" "database")"
    [ -z "$result" ]
}

@test "_find_alias_owner: only returns one name even when multiple containers claim alias" {
    # Edge case: cleanup that missed a container leaves two aliased as the
    # same name.  The guard in init_infra just needs ONE to refuse the
    # operation, so single-line output is correct.
    docker run -d --name "$_it_db" --network-alias database \
        --network "$_it_net" alpine sh -c 'tail -f /dev/null' >/dev/null
    docker run -d --name "$_it_app" --network-alias database \
        --network "$_it_net" alpine sh -c 'tail -f /dev/null' >/dev/null
    result="$(_find_alias_owner "$_it_net" "database")"
    # Expect exactly one line of output
    line_count="$(printf '%s\n' "$result" | wc -l | tr -d ' ')"
    [ "$line_count" -eq 1 ]
    # And the line should be one of the two we created
    [ "$result" = "$_it_db" ] || [ "$result" = "$_it_app" ]
}

@test "_find_alias_owner: works with non-database aliases" {
    docker run -d --name "$_it_db" --network-alias redis \
        --network "$_it_net" alpine sh -c 'tail -f /dev/null' >/dev/null
    result="$(_find_alias_owner "$_it_net" "redis")"
    [ "$result" = "$_it_db" ]
}

@test "_find_alias_owner: missing args return empty" {
    result="$(_find_alias_owner "" "database")"
    [ -z "$result" ]
    result="$(_find_alias_owner "$_it_net" "")"
    [ -z "$result" ]
}
