#!/usr/bin/env bats

load test_helper

setup() {
    TEST_DIR="$(mktemp -d)"
}

teardown() {
    rm -rf "$TEST_DIR"
}

@test "parse_batch_file reads issue/branch pairs" {
    cat > "$TEST_DIR/batch.txt" <<'EOF'
1234 feature/SW-1234
5678 bugfix/SW-5678
EOF
    result="$(parse_batch_file "$TEST_DIR/batch.txt")"
    [ "$(printf '%s\n' "$result" | wc -l | tr -d ' ')" -eq 2 ]
    [ "$(printf '%s\n' "$result" | sed -n '1p')" = "1234 feature/SW-1234" ]
    [ "$(printf '%s\n' "$result" | sed -n '2p')" = "5678 bugfix/SW-5678" ]
}

@test "parse_batch_file skips comments and blank lines" {
    cat > "$TEST_DIR/batch.txt" <<'EOF'
# This is a comment
1234 feature/SW-1234

  # Another comment
5678 bugfix/SW-5678
EOF
    result="$(parse_batch_file "$TEST_DIR/batch.txt")"
    [ "$(printf '%s\n' "$result" | wc -l | tr -d ' ')" -eq 2 ]
}

@test "parse_batch_file strips inline comments" {
    cat > "$TEST_DIR/batch.txt" <<'EOF'
1234 feature/SW-1234 # inline comment
EOF
    result="$(parse_batch_file "$TEST_DIR/batch.txt")"
    [ "$result" = "1234 feature/SW-1234" ]
}

@test "parse_batch_file dies on missing file" {
    run parse_batch_file "$TEST_DIR/nonexistent.txt"
    [ "$status" -ne 0 ]
}

@test "parse_cli_pairs parses even number of args" {
    result="$(parse_cli_pairs 1234 branch1 5678 branch2)"
    [ "$(printf '%s\n' "$result" | wc -l | tr -d ' ')" -eq 2 ]
    [ "$(printf '%s\n' "$result" | sed -n '1p')" = "1234 branch1" ]
    [ "$(printf '%s\n' "$result" | sed -n '2p')" = "5678 branch2" ]
}

@test "parse_cli_pairs ignores trailing odd arg" {
    result="$(parse_cli_pairs 1234 branch1 5678)"
    [ "$(printf '%s\n' "$result" | wc -l | tr -d ' ')" -eq 1 ]
    [ "$result" = "1234 branch1" ]
}
