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

@test "resolve_admin_nm_volume returns dedicated for admin changes" {
    ADMIN_CHANGES=1 PACKAGE_CHANGES=0
    result="$(resolve_admin_nm_volume "1234")"
    [ "$result" = "admin-nm-1234" ]
}

@test "resolve_admin_nm_volume returns dedicated for package changes" {
    ADMIN_CHANGES=0 PACKAGE_CHANGES=1
    result="$(resolve_admin_nm_volume "1234")"
    [ "$result" = "admin-nm-1234" ]
}

@test "resolve_admin_nm_volume returns shared base when no admin/package changes" {
    ADMIN_CHANGES=0 PACKAGE_CHANGES=0
    result="$(resolve_admin_nm_volume "1234")"
    [ "$result" = "admin-nm-base-sw" ]
}

@test "resolve_storefront_nm_volume returns dedicated for storefront changes" {
    STOREFRONT_CHANGES=1 PACKAGE_CHANGES=0
    result="$(resolve_storefront_nm_volume "1234")"
    [ "$result" = "storefront-nm-1234" ]
}

@test "resolve_storefront_nm_volume returns dedicated for package changes" {
    STOREFRONT_CHANGES=0 PACKAGE_CHANGES=1
    result="$(resolve_storefront_nm_volume "1234")"
    [ "$result" = "storefront-nm-1234" ]
}

@test "resolve_storefront_nm_volume returns shared base when no storefront/package changes" {
    STOREFRONT_CHANGES=0 PACKAGE_CHANGES=0
    result="$(resolve_storefront_nm_volume "1234")"
    [ "$result" = "storefront-nm-base-sw" ]
}

@test "admin and storefront nm volumes are independent" {
    # Admin changes shouldn't force a dedicated storefront volume.
    ADMIN_CHANGES=1 STOREFRONT_CHANGES=0 PACKAGE_CHANGES=0
    [ "$(resolve_admin_nm_volume "42")" = "admin-nm-42" ]
    [ "$(resolve_storefront_nm_volume "42")" = "storefront-nm-base-sw" ]
}
