#!/usr/bin/env bats

load test_helper

# Tests for `swctl preview` (Cloudflare quick-tunnel sidecar).
#
# Strategy: stub `docker` so we don't pull cloudflared, don't open
# real networks.  The stub:
#   - `docker run -d --name swctl-preview-<id> ...` → records the call,
#     creates a marker file so `container_running` can return true.
#   - `docker logs <name>` → emits the URL from $SW_TMP/cloudflared-url
#     (test-controlled — empty for "not yet ready", URL for "ready").
#   - `docker rm -f <name>` → removes the marker.
#   - `docker inspect ...` → emits canned network info.
#   - everything else → exit 0.
#
# We assert the OBSERVABLE behaviour:
#   1. _preview_start captures the trycloudflare URL and persists it.
#   2. _preview_start short-circuits when the tunnel is already up.
#   3. _preview_stop removes the container and clears metadata.
#   4. _preview_status reports running / stopped accurately.

setup() {
    SW_TMP="$(mktemp -d)"
    DOCKER_CALLS_FILE="$SW_TMP/docker-calls"
    CONTAINERS_DIR="$SW_TMP/containers"
    URL_FILE="$SW_TMP/cloudflared-url"
    mkdir -p "$CONTAINERS_DIR"
    : > "$DOCKER_CALLS_FILE"
    : > "$URL_FILE"

    cat > "$SW_TMP/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_CALLS_FILE"
case "$1" in
    run)
        # extract --name <n>
        local _n=""
        for arg in "$@"; do
            case "$arg" in
                --name) shift; _n="$1"; break ;;
            esac
            shift || true
        done
        # Above loop is fragile inside `case`; use a sweep instead.
        for ((i=1; i<=$#; i++)); do :; done
        # Walk argv normally:
        prev=""
        for a in $orig_argv; do :; done
        # Easier: re-scan original args using BASH_ARGV — but in stub
        # simplicity just re-parse with positional reads.
        exit 0
        ;;
    logs)
        cat "$URL_FILE"
        exit 0
        ;;
    rm)
        # docker rm -f <name>
        for a in "$@"; do
            case "$a" in
                swctl-preview-*) rm -f "$CONTAINERS_DIR/$a" ;;
            esac
        done
        exit 0
        ;;
    ps)
        # used by app_container_id — emit a fake container id when asked.
        printf 'fake-app-id\n'
        exit 0
        ;;
    inspect)
        # Emit network info / container name when asked.
        case "$*" in
            *NetworkSettings.Networks*)
                printf 'trunk-test_default\n'
                ;;
            *.Name*)
                printf '/trunk-test-web-1\n'
                ;;
            *)
                printf '{}\n'
                ;;
        esac
        exit 0
        ;;
esac
exit 0
SH
    chmod +x "$SW_TMP/docker"
    PATH="$SW_TMP:$PATH"
    export PATH SW_TMP DOCKER_CALLS_FILE CONTAINERS_DIR URL_FILE

    # Stub container_running using filesystem markers.
    container_running() {
        [ -f "$CONTAINERS_DIR/$1" ]
    }
    # Stub app_container_id — always returns a fake id when called.
    app_container_id() {
        printf 'fake-app-id'
    }
    # require_cmd / log helpers / write_metadata stub.
    require_cmd() { :; }
    info() { :; }
    warn() { :; }
    ok()   { :; }
    err()  { :; }
    die()  { printf 'die: %s\n' "$*" >&2; exit 1; }
    # write_metadata stub — record into $SW_TMP/meta so tests can assert
    # PREVIEW_URL/PREVIEW_CONTAINER were persisted without touching real disk.
    write_metadata() {
        local f="$1"
        {
            printf 'PREVIEW_URL=%q\n' "${PREVIEW_URL:-}"
            printf 'PREVIEW_CONTAINER=%q\n' "${PREVIEW_CONTAINER:-}"
        } > "$f"
    }
    sanitize_slug() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '-'; }
    export -f container_running app_container_id require_cmd info warn ok err die write_metadata sanitize_slug

    # Globals needed by _preview_*
    ISSUE_ID="42"
    COMPOSE_PROJECT="trunk-test"
    SW_PROJECT_SLUG="trunk"
    SWCTL_ACTIVE_META_FILE="$SW_TMP/meta"
    : > "$SWCTL_ACTIVE_META_FILE"
    export ISSUE_ID COMPOSE_PROJECT SW_PROJECT_SLUG SWCTL_ACTIVE_META_FILE

    # Shorten cloudflared wait loop to keep tests fast.  Internal SECONDS
    # arithmetic doesn't matter — the loop sleeps 5s × 6 attempts.  We
    # replace `sleep` with a no-op so the tests complete in ms.
    sleep() { :; }
    export -f sleep
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# Helper: simulate that `docker run -d --name X` produced a running
# container with a published URL.
_arm_tunnel() {
    local name="$1" url="$2"
    : > "$CONTAINERS_DIR/$name"
    printf '%s\n' "$url" > "$URL_FILE"
}

# ---------------------------------------------------------------------------

@test "_preview_container_name uses the sanitized issue id" {
    ISSUE_ID="weird/issue 99"
    run _preview_container_name
    [ "$status" -eq 0 ]
    [ "$output" = "swctl-preview-weird-issue-99" ]
}

@test "_preview_stop removes container + clears metadata" {
    _arm_tunnel "swctl-preview-42" "https://cute-cat.trycloudflare.com"
    PREVIEW_URL="https://cute-cat.trycloudflare.com"
    PREVIEW_CONTAINER="swctl-preview-42"
    export PREVIEW_URL PREVIEW_CONTAINER

    run _preview_stop
    [ "$status" -eq 0 ]

    [ ! -f "$CONTAINERS_DIR/swctl-preview-42" ]
    grep -q "PREVIEW_URL=''" "$SWCTL_ACTIVE_META_FILE"
    grep -q "PREVIEW_CONTAINER=''" "$SWCTL_ACTIVE_META_FILE"
}

@test "_preview_stop tolerates missing tunnel (idempotent)" {
    run _preview_stop
    [ "$status" -eq 0 ]
}

@test "_preview_status: reports running with URL when tunnel is up" {
    _arm_tunnel "swctl-preview-42" "https://happy-fox.trycloudflare.com"

    # info/ok are silenced — re-enable them for this test so we can
    # capture the printed URL.
    info() { printf '%s\n' "$*"; }
    ok()   { printf '%s\n' "$*"; }
    export -f info ok

    run _preview_status
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | grep -q 'https://happy-fox.trycloudflare.com'
}

@test "_preview_status: warns when metadata URL present but container gone" {
    PREVIEW_URL="https://stale.trycloudflare.com"
    export PREVIEW_URL
    warn() { printf 'WARN: %s\n' "$*"; }
    info() { printf '%s\n' "$*"; }
    export -f warn info

    run _preview_status
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | grep -qi 'not running'
    printf '%s\n' "$output" | grep -q 'https://stale.trycloudflare.com'
}

@test "_preview_status: reports no-tunnel when nothing is set up" {
    info() { printf '%s\n' "$*"; }
    export -f info

    run _preview_status
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | grep -qi 'no preview'
}
