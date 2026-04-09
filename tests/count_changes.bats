#!/usr/bin/env bats

load test_helper

@test "count_changes detects migration files" {
    diff_files="src/Migration/V6_5/Migration1234.php
src/Entity/ProductEntity.php
src/Resources/views/page.html.twig"
    count_changes "$diff_files"
    [ "$MIGRATION_CHANGES" -eq 1 ]
    [ "$ENTITY_CHANGES" -eq 1 ]
    [ "$FRONTEND_CHANGES" -eq 1 ]
}

@test "count_changes detects Migrations directory" {
    diff_files="custom/plugins/MyPlugin/Migrations/Migration001.php"
    count_changes "$diff_files"
    [ "$MIGRATION_CHANGES" -eq 1 ]
}

@test "count_changes counts multiple frontend files" {
    diff_files="src/Resources/app/storefront/main.js
src/Resources/app/storefront/style.scss
src/Resources/views/page.html.twig
src/Resources/app/administration/main.ts
src/Resources/app/storefront/component.vue"
    count_changes "$diff_files"
    [ "$FRONTEND_CHANGES" -eq 5 ]
}

@test "count_changes returns zero for non-matching files" {
    diff_files="src/Service/ProductService.php
src/Controller/ApiController.php"
    count_changes "$diff_files"
    [ "$MIGRATION_CHANGES" -eq 0 ]
    [ "$ENTITY_CHANGES" -eq 0 ]
    [ "$FRONTEND_CHANGES" -eq 0 ]
}

@test "count_changes handles empty input" {
    count_changes ""
    [ "$MIGRATION_CHANGES" -eq 0 ]
    [ "$ENTITY_CHANGES" -eq 0 ]
    [ "$FRONTEND_CHANGES" -eq 0 ]
}
