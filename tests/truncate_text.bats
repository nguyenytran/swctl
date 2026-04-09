#!/usr/bin/env bats

load test_helper

@test "truncate_text returns full text when under limit" {
    result="$(truncate_text 20 "hello")"
    [ "$result" = "hello" ]
}

@test "truncate_text returns full text when at exact limit" {
    result="$(truncate_text 5 "hello")"
    [ "$result" = "hello" ]
}

@test "truncate_text appends ellipsis when over limit" {
    result="$(truncate_text 8 "abcdefghij")"
    [ "$result" = "abcde..." ]
}

@test "truncate_text handles max <= 3 without ellipsis" {
    result="$(truncate_text 3 "abcdefgh")"
    [ "$result" = "abc" ]
}

@test "truncate_text handles max of 1" {
    result="$(truncate_text 1 "abcdefgh")"
    [ "$result" = "a" ]
}
