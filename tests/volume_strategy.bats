#!/usr/bin/env bats

load test_helper

setup() {
    SW_PROJECT_SLUG="sw"
}

@test "resolve_vendor_volume returns dedicated for migration changes" {
    MIGRATION_CHANGES=1 ENTITY_CHANGES=0 COMPOSER_CHANGES=0
    result="$(resolve_vendor_volume "1234")"
    [ "$result" = "vendor-1234" ]
}

@test "resolve_vendor_volume returns dedicated for composer changes" {
    MIGRATION_CHANGES=0 ENTITY_CHANGES=0 COMPOSER_CHANGES=1
    result="$(resolve_vendor_volume "1234")"
    [ "$result" = "vendor-1234" ]
}

@test "resolve_vendor_volume returns shared base when no dep changes" {
    MIGRATION_CHANGES=0 ENTITY_CHANGES=0 COMPOSER_CHANGES=0
    result="$(resolve_vendor_volume "1234")"
    [ "$result" = "vendor-base-sw" ]
}

@test "resolve_node_modules_volume returns dedicated for package changes" {
    MIGRATION_CHANGES=0 ENTITY_CHANGES=0 PACKAGE_CHANGES=1
    result="$(resolve_node_modules_volume "1234")"
    [ "$result" = "node_modules-1234" ]
}

@test "resolve_node_modules_volume returns shared base when no package changes" {
    MIGRATION_CHANGES=0 ENTITY_CHANGES=0 PACKAGE_CHANGES=0
    result="$(resolve_node_modules_volume "1234")"
    [ "$result" = "node_modules-base-sw" ]
}

@test "resolve_node_modules_volume returns dedicated for entity changes" {
    MIGRATION_CHANGES=0 ENTITY_CHANGES=1 PACKAGE_CHANGES=0
    result="$(resolve_node_modules_volume "1234")"
    [ "$result" = "node_modules-1234" ]
}
