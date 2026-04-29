#!/usr/bin/env bats

# Regression guard for the runtime-loaded resolve plugin.
#
# History: PR #14 introduced an HTML comment inside a JS template
# literal that contained backticks (markers swctl create emits).
# Backticks inside a `…` template literal terminate it, so the plugin
# silently failed to parse browser-side and the entire /resolve route
# rendered empty.  The user only noticed when the page went blank;
# server logs were clean (the plugin file IS valid for the server's
# fs.readFileSync; it's the browser ESM parse that fails).
#
# This test runs the plugin's source through node's ESM loader.  If
# anyone edits the file in a way that breaks template-literal parsing
# again, this test fires before the change ships.

setup() {
    PLUGIN_FILE="$BATS_TEST_DIRNAME/../../examples/plugins/shopware-resolve/index.js"
}

@test "shopware-resolve plugin parses as ESM (regression: backticks in template literals)" {
    [ -f "$PLUGIN_FILE" ]
    # Plain `node import()` returns 0 on success, non-zero on syntax/load
    # error.  --input-type=module lets us write the import inline.
    run node --input-type=module -e "
        await import('$PLUGIN_FILE')
    "
    [ "$status" -eq 0 ] || {
        echo "Plugin failed to load:"
        echo "$output"
        false
    }
}

@test "shopware-resolve plugin: no backticks inside HTML comments (template-literal trap)" {
    # Direct lint: any backtick character on a line that is part of an
    # HTML comment (between <!-- and -->) is an immediate parse-time
    # bomb.  We use awk to extract just the comment ranges.
    backticks_in_comments=$(awk '/<!--/,/-->/' "$PLUGIN_FILE" | grep -c '`' || true)
    [ "$backticks_in_comments" -eq 0 ] || {
        echo "Found $backticks_in_comments backtick(s) inside HTML comments —"
        echo "these terminate the surrounding JS template literal and break"
        echo "the entire plugin's parse.  Replace with quotes or plain text:"
        awk '/<!--/,/-->/' "$PLUGIN_FILE" | grep -n '`'
        false
    }
}
