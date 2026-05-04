#!/usr/bin/env bats

load test_helper

# Regression guard for sync_plugin_gitignored_artifacts.
#
# When `swctl create` nests a plugin worktree (via `git worktree add`), only
# tracked files come along.  Plugins commonly gitignore their build output
# directories (`Resources/public/`, `Resources/app/storefront/dist/`,
# `Resources/app/administration/dist/`) — those are absent from the new
# worktree.  Without them, two failures cascade:
#   1. Storefront 500: Symfony tries to register asset paths that don't exist.
#   2. Admin npm rebuild aborts: nested plugin admin apps with their own
#      vite.config.ts can't find `vite` in a local node_modules that's
#      similarly absent.
#
# The helper copies the parent plugin's prebuilt artifacts into the nested
# worktree so the create can ship a functional UI without reinstalling
# every nested admin app's npm tree.

setup() {
    SW_TMP="$(mktemp -d)"
    SRC="$SW_TMP/src-plugin"
    DST="$SW_TMP/dst-plugin"
    mkdir -p "$SRC" "$DST"
    export SW_TMP SRC DST

    # Silence info/warn (noise in test output)
    info() { :; }
    warn() { :; }
    ok()   { :; }
    export -f info warn ok
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# ---------------------------------------------------------------------------
# Happy path: each known build-artifact pattern gets copied
# ---------------------------------------------------------------------------

@test "sync: copies Resources/public dirs from src to dst" {
    mkdir -p "$SRC/src/Captcha/Resources/public"
    echo 'compiled-asset' > "$SRC/src/Captcha/Resources/public/asset.js"

    run sync_plugin_gitignored_artifacts "$SRC" "$DST"
    [ "$status" -eq 0 ]
    [ -f "$DST/src/Captcha/Resources/public/asset.js" ]
    [ "$(cat "$DST/src/Captcha/Resources/public/asset.js")" = "compiled-asset" ]
}

@test "sync: copies Resources/app/storefront/dist dirs" {
    mkdir -p "$SRC/src/Subscription/Resources/app/storefront/dist/storefront/js"
    echo 'storefront-bundle' > "$SRC/src/Subscription/Resources/app/storefront/dist/storefront/js/main.js"

    run sync_plugin_gitignored_artifacts "$SRC" "$DST"
    [ "$status" -eq 0 ]
    [ -f "$DST/src/Subscription/Resources/app/storefront/dist/storefront/js/main.js" ]
}

@test "sync: copies Resources/app/administration/dist dirs" {
    mkdir -p "$SRC/src/AdminTool/Resources/app/administration/dist"
    echo 'admin-bundle' > "$SRC/src/AdminTool/Resources/app/administration/dist/index.js"

    run sync_plugin_gitignored_artifacts "$SRC" "$DST"
    [ "$status" -eq 0 ]
    [ -f "$DST/src/AdminTool/Resources/app/administration/dist/index.js" ]
}

@test "sync: copies multiple matching dirs in one invocation" {
    # Mirror the SwagCommercial layout — many nested plugins each with
    # their own Resources/public/.  Helper should sweep them all.
    for plug in B2B/EmployeeManagement B2B/QuoteManagement Captcha Subscription; do
        mkdir -p "$SRC/src/$plug/Resources/public"
        echo "$plug-bundle" > "$SRC/src/$plug/Resources/public/bundle.js"
    done

    run sync_plugin_gitignored_artifacts "$SRC" "$DST"
    [ "$status" -eq 0 ]
    [ -f "$DST/src/B2B/EmployeeManagement/Resources/public/bundle.js" ]
    [ -f "$DST/src/B2B/QuoteManagement/Resources/public/bundle.js" ]
    [ -f "$DST/src/Captcha/Resources/public/bundle.js" ]
    [ -f "$DST/src/Subscription/Resources/public/bundle.js" ]
}

# ---------------------------------------------------------------------------
# Idempotence + safety
# ---------------------------------------------------------------------------

@test "sync: skips dirs that already exist in dst (no-clobber)" {
    mkdir -p "$SRC/src/Captcha/Resources/public"
    echo 'src-version' > "$SRC/src/Captcha/Resources/public/asset.js"
    mkdir -p "$DST/src/Captcha/Resources/public"
    echo 'dst-version' > "$DST/src/Captcha/Resources/public/asset.js"

    run sync_plugin_gitignored_artifacts "$SRC" "$DST"
    [ "$status" -eq 0 ]
    # Existing dst content must not be overwritten — preserves any local
    # rebuild the user did before the sync ran.
    [ "$(cat "$DST/src/Captcha/Resources/public/asset.js")" = "dst-version" ]
}

@test "sync: nothing to sync when src has no matching dirs (succeeds quietly)" {
    mkdir -p "$SRC/src/JustSource"
    echo 'class Foo {}' > "$SRC/src/JustSource/Foo.php"

    run sync_plugin_gitignored_artifacts "$SRC" "$DST"
    [ "$status" -eq 0 ]
    [ ! -d "$DST/src/JustSource" ]
}

@test "sync: missing src returns 0 (no-op)" {
    run sync_plugin_gitignored_artifacts "$SW_TMP/nonexistent" "$DST"
    [ "$status" -eq 0 ]
}

@test "sync: missing dst returns 0 (no-op)" {
    mkdir -p "$SRC/src/X/Resources/public"
    run sync_plugin_gitignored_artifacts "$SRC" "$SW_TMP/nonexistent"
    [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Targeted-pattern guard: must not drag in unrelated gitignored junk
# (.idea/, .DS_Store, vendor/, node_modules/) — those bloat the worktree
# and are expensive to clone on cold creates.
# ---------------------------------------------------------------------------

@test "sync: does NOT copy unrelated gitignored dirs (.idea, vendor, node_modules)" {
    mkdir -p "$SRC/.idea" "$SRC/vendor" "$SRC/node_modules" "$SRC/src/Captcha/Resources/public"
    echo 'phpstorm' > "$SRC/.idea/workspace.xml"
    echo 'vendor' > "$SRC/vendor/composer.installed"
    echo 'nm' > "$SRC/node_modules/package.json"
    echo 'asset' > "$SRC/src/Captcha/Resources/public/asset.js"

    run sync_plugin_gitignored_artifacts "$SRC" "$DST"
    [ "$status" -eq 0 ]

    # Targeted artifacts: copied
    [ -f "$DST/src/Captcha/Resources/public/asset.js" ]
    # Unrelated dirs: NOT copied
    [ ! -d "$DST/.idea" ]
    [ ! -d "$DST/vendor" ]
    [ ! -d "$DST/node_modules" ]
}
