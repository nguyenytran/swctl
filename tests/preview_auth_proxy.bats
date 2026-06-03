#!/usr/bin/env bats

load test_helper

# Regression guard for the v0.7.3 per-tunnel HTTP Basic Auth sidecar.
#
# Background: pre-v0.7.3 every started preview tunnel was world-
# readable — anyone with the URL could hit the dev Shopware admin
# (default creds: admin/shopware).  v0.7.3 inserts a caddy:2-alpine
# reverse-proxy between cloudflared and the app container; the proxy
# does basic_auth then forwards to http://<app>:8000.  The plaintext
# password lives in $SWCTL_PREVIEW_PASSWORD (set by the UI server or
# the interactive caller) and is never persisted by swctl — only the
# bcrypt hash inside the Caddyfile.
#
# These tests stub `docker` entirely (PATH shadow) so we can pin the
# exact invocations + flag shape without touching the daemon.

setup() {
    SW_TMP="$(mktemp -d)"
    DOCKER_CALLS="$SW_TMP/docker-calls"
    : > "$DOCKER_CALLS"
    SWCTL_STATE_DIR="$SW_TMP/state"
    mkdir -p "$SWCTL_STATE_DIR"
    ISSUE_ID="10833"
    SW_PROJECT_SLUG="trunk"
    export SW_TMP DOCKER_CALLS SWCTL_STATE_DIR ISSUE_ID SW_PROJECT_SLUG

    # Stub docker.  `caddy hash-password` (the FIRST docker run swctl
    # makes) is detected by the `caddy:2-alpine` image + `hash-password`
    # arg and prints a deterministic fake bcrypt hash.  Everything else
    # records to DOCKER_CALLS and returns 0.
    cat > "$SW_TMP/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_CALLS"
case "$*" in
    *"caddy:2-alpine"*"hash-password"*)
        # Fake bcrypt-shaped output.  Real bcrypt is $2a$NN$… — the
        # exact value doesn't matter for the test, only that it's
        # non-empty.
        echo '$2a$14$STUBhashSTUBhashSTUBhashSTUBhashSTUBhashSTUBhashSTUBhash'
        exit 0
        ;;
    *"caddy:2-alpine"*"caddy run"*)
        # The actual proxy run.  Just record + succeed.
        exit "$(cat "$SW_TMP/proxy-exit" 2>/dev/null || echo 0)"
        ;;
    *"docker rm -f"*|"rm -f"*)
        exit 0
        ;;
esac
exit 0
SH
    chmod +x "$SW_TMP/docker"
    PATH="$SW_TMP:$PATH"
    export PATH

    # Silence user-facing log lines.
    info() { :; }
    ok()   { :; }
    warn() { :; }
    err()  { :; }
    require_cmd() { :; }
    # Trivial sanitize_slug — the real one is more thorough but for
    # these tests we just need a function that returns the id verbatim
    # (the test IDs are already slug-safe).
    sanitize_slug() { printf '%s' "$1"; }
    export -f info ok warn err require_cmd sanitize_slug
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# ---------------------------------------------------------------------------
# Happy path: _start_auth_proxy hashes password, writes Caddyfile,
# runs caddy with the expected --name + --network + bind mount, and
# returns the in-network proxy URL.
# ---------------------------------------------------------------------------

@test "_start_auth_proxy: runs hash-password + caddy with correct flags + returns proxy URL" {
    run _start_auth_proxy "test-password-abc" "http://trunk-10833-web-1:8000" "trunk-10833_default"
    [ "$status" -eq 0 ]
    [ "$output" = "http://swctl-tunnel-auth-10833:8080" ]

    # Hash step ran first.
    grep -q 'caddy:2-alpine.*hash-password.*--plaintext test-password-abc' "$DOCKER_CALLS"
    # Proxy run uses the right name + network + Caddyfile mount.
    grep -q -- '--name swctl-tunnel-auth-10833' "$DOCKER_CALLS"
    grep -q -- '--network trunk-10833_default' "$DOCKER_CALLS"
    grep -q -- '/etc/caddy:ro' "$DOCKER_CALLS"
    grep -q 'caddy run --config /etc/caddy/Caddyfile --adapter caddyfile' "$DOCKER_CALLS"

    # Caddyfile was written + has the bcrypt hash + the upstream target.
    local cfg="$SWCTL_STATE_DIR/auth-proxy/10833/Caddyfile"
    [ -f "$cfg" ]
    grep -q '\$2a\$14\$STUBhash' "$cfg"
    grep -q 'reverse_proxy http://trunk-10833-web-1:8000' "$cfg"
    grep -q 'basic_auth {' "$cfg"
}

# ---------------------------------------------------------------------------
# Pre-existing orphan auth-proxy: docker rm -f fires before the run
# so a SIGKILL'd previous swctl run can't block --name uniqueness.
# ---------------------------------------------------------------------------

@test "_start_auth_proxy: idempotent docker rm -f before the run" {
    run _start_auth_proxy "p" "http://app:8000" "net"
    [ "$status" -eq 0 ]
    # The pre-emptive rm comes BEFORE the caddy run.  Verify ordering
    # via line numbers in the call log.
    awk '/^rm -f swctl-tunnel-auth-10833$/ { rm_at=NR }
         /caddy run --config/ { run_at=NR }
         END { exit !(rm_at && run_at && rm_at < run_at) }' "$DOCKER_CALLS"
}

# ---------------------------------------------------------------------------
# Failed proxy start: the caddy run exits non-zero → die.  Also
# the Caddyfile dir is removed so a subsequent successful run starts
# from a clean slate.
# ---------------------------------------------------------------------------

@test "_start_auth_proxy: failed caddy run dies + cleans up cfg dir" {
    echo 1 > "$SW_TMP/proxy-exit"
    run _start_auth_proxy "p" "http://app:8000" "net"
    [ "$status" -ne 0 ]
    [ ! -d "$SWCTL_STATE_DIR/auth-proxy/10833" ]
}

# ---------------------------------------------------------------------------
# Stop: docker rm -f + Caddyfile dir cleanup.  Both idempotent — Stop
# without a Start should be a no-op (no Caddyfile to remove, docker
# rm -f silently succeeds on missing container).
# ---------------------------------------------------------------------------

@test "_stop_auth_proxy: removes container + Caddyfile dir" {
    # Pretend a previous _start_auth_proxy created the state dir.
    mkdir -p "$SWCTL_STATE_DIR/auth-proxy/10833"
    echo "stub" > "$SWCTL_STATE_DIR/auth-proxy/10833/Caddyfile"

    _stop_auth_proxy

    grep -q '^rm -f swctl-tunnel-auth-10833$' "$DOCKER_CALLS"
    [ ! -d "$SWCTL_STATE_DIR/auth-proxy/10833" ]
}

@test "_stop_auth_proxy: idempotent — safe to call when nothing is running" {
    run _stop_auth_proxy
    [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Safety rail: empty password → die early.  An unprotected proxy is
# WORSE than no proxy at all — the user expects basic_auth and sees
# a working URL, but anyone can hit it.  Fail loud.
# ---------------------------------------------------------------------------

@test "_start_auth_proxy: empty password dies before any docker call" {
    run _start_auth_proxy "" "http://app:8000" "net"
    [ "$status" -ne 0 ]
    # No docker calls should have been made.
    [ ! -s "$DOCKER_CALLS" ]
}

@test "_start_auth_proxy: empty target dies" {
    run _start_auth_proxy "p" "" "net"
    [ "$status" -ne 0 ]
}

@test "_start_auth_proxy: empty network dies" {
    run _start_auth_proxy "p" "http://app:8000" ""
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# Container name follows the v0.6.22 deterministic-naming pattern so
# docker enforces uniqueness atomically (no two parallel swctl runs
# can race-start a proxy with the same name on the same network).
# ---------------------------------------------------------------------------

@test "_auth_proxy_container_name: deterministic per ISSUE_ID" {
    [ "$(_auth_proxy_container_name)" = "swctl-tunnel-auth-10833" ]
    ISSUE_ID="6072"
    [ "$(_auth_proxy_container_name)" = "swctl-tunnel-auth-6072" ]
}
