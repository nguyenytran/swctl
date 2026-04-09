#!/usr/bin/env bats

load test_helper

@test "sanitize_slug lowercases input" {
    result="$(sanitize_slug "HELLO-World")"
    [ "$result" = "hello-world" ]
}

@test "sanitize_slug replaces non-alphanumeric with hyphens" {
    result="$(sanitize_slug "feature/SW-1245_fix")"
    [ "$result" = "feature-sw-1245-fix" ]
}

@test "sanitize_slug strips leading and trailing hyphens" {
    result="$(sanitize_slug "--hello--")"
    [ "$result" = "hello" ]
}

@test "sanitize_slug collapses multiple hyphens" {
    result="$(sanitize_slug "a---b")"
    [ "$result" = "a-b" ]
}

@test "sanitize_slug handles empty string" {
    result="$(sanitize_slug "")"
    [ "$result" = "" ]
}

@test "sanitize_db_identifier uses underscores" {
    result="$(sanitize_db_identifier "SW-1245/feature")"
    [ "$result" = "sw_1245_feature" ]
}

@test "sanitize_db_identifier strips leading/trailing underscores" {
    result="$(sanitize_db_identifier "__test__")"
    [ "$result" = "test" ]
}

@test "sanitize_db_identifier collapses multiple underscores" {
    result="$(sanitize_db_identifier "a___b")"
    [ "$result" = "a_b" ]
}

@test "sanitize_router_id uses underscores" {
    result="$(sanitize_router_id "sw66/1245")"
    [ "$result" = "sw66_1245" ]
}

@test "sanitize_router_id matches sanitize_db_identifier on same input" {
    input="SW-1245/feature"
    r1="$(sanitize_router_id "$input")"
    r2="$(sanitize_db_identifier "$input")"
    [ "$r1" = "$r2" ]
}
