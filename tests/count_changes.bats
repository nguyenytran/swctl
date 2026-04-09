#!/usr/bin/env bats

load test_helper

@test "count_changes detects migration files" {
    diff_files="src/Migration/V6_5/Migration1234.php
src/Entity/ProductEntity.php
src/Resources/views/page.html.twig"
    count_changes "$diff_files"
    [ "$MIGRATION_CHANGES" -eq 1 ]
    [ "$ENTITY_CHANGES" -eq 1 ]
    [ "$STOREFRONT_CHANGES" -eq 1 ]
}

@test "count_changes detects Migrations directory" {
    diff_files="custom/plugins/MyPlugin/Migrations/Migration001.php"
    count_changes "$diff_files"
    [ "$MIGRATION_CHANGES" -eq 1 ]
}

@test "count_changes separates admin and storefront" {
    diff_files="src/Administration/Resources/app/administration/src/main.ts
src/Storefront/Resources/app/storefront/src/main.js
src/Resources/views/page.html.twig"
    count_changes "$diff_files"
    [ "$ADMIN_CHANGES" -eq 1 ]
    [ "$STOREFRONT_CHANGES" -eq 2 ]
    [ "$FRONTEND_CHANGES" -eq 3 ]
}

@test "count_changes counts admin-only changes" {
    diff_files="src/Administration/Resources/app/administration/src/module/sw-product/page/list.vue
src/Administration/Resources/app/administration/src/app/component/form.js"
    count_changes "$diff_files"
    [ "$ADMIN_CHANGES" -eq 2 ]
    [ "$STOREFRONT_CHANGES" -eq 0 ]
    [ "$FRONTEND_CHANGES" -eq 2 ]
}

@test "count_changes counts storefront-only changes" {
    diff_files="src/Storefront/Resources/app/storefront/src/plugin/listing.js
src/Storefront/Resources/app/storefront/src/scss/base.scss
src/Storefront/Resources/views/storefront/page/product-detail/index.html.twig"
    count_changes "$diff_files"
    [ "$ADMIN_CHANGES" -eq 0 ]
    [ "$STOREFRONT_CHANGES" -eq 3 ]
}

@test "count_changes detects composer changes" {
    diff_files="composer.json
composer.lock"
    count_changes "$diff_files"
    [ "$COMPOSER_CHANGES" -eq 2 ]
    [ "$BACKEND_CHANGES" -eq 0 ]
}

@test "count_changes detects package lock files" {
    diff_files="package.json
pnpm-lock.yaml"
    count_changes "$diff_files"
    [ "$PACKAGE_CHANGES" -eq 2 ]
}

@test "count_changes detects yarn and npm locks" {
    diff_files="yarn.lock
package-lock.json"
    count_changes "$diff_files"
    [ "$PACKAGE_CHANGES" -eq 2 ]
}

@test "count_changes detects backend PHP without migrations" {
    diff_files="src/Core/Content/Product/ProductService.php
src/Core/Checkout/Cart/CartController.php"
    count_changes "$diff_files"
    [ "$BACKEND_CHANGES" -eq 2 ]
    [ "$MIGRATION_CHANGES" -eq 0 ]
    [ "$ENTITY_CHANGES" -eq 0 ]
}

@test "count_changes excludes migration PHP from backend count" {
    diff_files="src/Core/Migration/V6_5/Migration1234.php
src/Core/Content/Product/ProductService.php"
    count_changes "$diff_files"
    [ "$MIGRATION_CHANGES" -eq 1 ]
    [ "$BACKEND_CHANGES" -eq 1 ]
}

@test "count_changes returns zero for non-matching files" {
    diff_files="README.md
.github/workflows/ci.yml"
    count_changes "$diff_files"
    [ "$MIGRATION_CHANGES" -eq 0 ]
    [ "$ENTITY_CHANGES" -eq 0 ]
    [ "$ADMIN_CHANGES" -eq 0 ]
    [ "$STOREFRONT_CHANGES" -eq 0 ]
    [ "$COMPOSER_CHANGES" -eq 0 ]
    [ "$PACKAGE_CHANGES" -eq 0 ]
    [ "$BACKEND_CHANGES" -eq 0 ]
    [ "$FRONTEND_CHANGES" -eq 0 ]
}

@test "count_changes handles empty input" {
    count_changes ""
    [ "$MIGRATION_CHANGES" -eq 0 ]
    [ "$ENTITY_CHANGES" -eq 0 ]
    [ "$ADMIN_CHANGES" -eq 0 ]
    [ "$STOREFRONT_CHANGES" -eq 0 ]
    [ "$FRONTEND_CHANGES" -eq 0 ]
}

@test "count_changes full mixed scenario" {
    diff_files="src/Core/Migration/V6_5/Migration1234.php
src/Core/Content/Product/Entity/ProductDefinition.php
src/Administration/Resources/app/administration/src/main.ts
src/Storefront/Resources/app/storefront/src/main.js
src/Storefront/Resources/views/storefront/page.html.twig
composer.json
package.json
src/Core/Service/FooService.php"
    count_changes "$diff_files"
    [ "$MIGRATION_CHANGES" -eq 1 ]
    [ "$ENTITY_CHANGES" -eq 1 ]
    [ "$ADMIN_CHANGES" -eq 1 ]
    [ "$STOREFRONT_CHANGES" -eq 2 ]
    [ "$COMPOSER_CHANGES" -eq 1 ]
    [ "$PACKAGE_CHANGES" -eq 1 ]
    [ "$BACKEND_CHANGES" -eq 1 ]
    [ "$FRONTEND_CHANGES" -eq 3 ]
}
