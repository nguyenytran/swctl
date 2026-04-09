#!/usr/bin/env bats

load test_helper

setup() {
    TEST_DIR="$(mktemp -d)"
}

teardown() {
    rm -rf "$TEST_DIR"
}

@test "detect pnpm when pnpm-lock.yaml exists" {
    touch "$TEST_DIR/pnpm-lock.yaml"
    result="$(detect_package_install_command "$TEST_DIR")"
    [ "$result" = "pnpm install --frozen-lockfile" ]
}

@test "detect yarn when yarn.lock exists" {
    touch "$TEST_DIR/yarn.lock"
    result="$(detect_package_install_command "$TEST_DIR")"
    [ "$result" = "yarn install --frozen-lockfile" ]
}

@test "detect npm ci when package-lock.json exists" {
    touch "$TEST_DIR/package-lock.json"
    result="$(detect_package_install_command "$TEST_DIR")"
    [ "$result" = "npm ci" ]
}

@test "detect npm install when only package.json exists" {
    touch "$TEST_DIR/package.json"
    result="$(detect_package_install_command "$TEST_DIR")"
    [ "$result" = "npm install" ]
}

@test "returns empty when no lock file or package.json" {
    result="$(detect_package_install_command "$TEST_DIR")"
    [ -z "$result" ]
}

@test "pnpm takes priority over yarn" {
    touch "$TEST_DIR/pnpm-lock.yaml"
    touch "$TEST_DIR/yarn.lock"
    result="$(detect_package_install_command "$TEST_DIR")"
    [ "$result" = "pnpm install --frozen-lockfile" ]
}
