#!/usr/bin/env bats

load test_helper

@test "resolve_path returns absolute target as-is" {
    result="$(resolve_path "/some/base" "/absolute/path")"
    [ "$result" = "/absolute/path" ]
}

@test "resolve_path resolves relative target against base" {
    result="$(resolve_path "/" "usr/local/bin")"
    [ "$result" = "/usr/local/bin" ]
}

@test "resolve_path handles .. components" {
    result="$(resolve_path "/" "usr/local/../bin")"
    [ "$result" = "/usr/bin" ]
}

@test "resolve_path handles . components" {
    result="$(resolve_path "/" "usr/./local/bin")"
    [ "$result" = "/usr/local/bin" ]
}

@test "resolve_path handles multiple .. at start" {
    result="$(resolve_path "/usr/local/bin" "../../x")"
    [ "$result" = "/usr/x" ]
}
