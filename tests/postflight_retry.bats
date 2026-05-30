#!/usr/bin/env bats

load test_helper

# Regression guard for `_postflight_instance_ready`'s /admin retry
# (v0.6.13).
#
# Before v0.6.13: the /admin check was a single `curl --max-time 8`.
# Under batch-load (load average 15+ from 3-4 parallel creates), curl
# would time out before PHP-FPM/Caddy answered even though the
# container was technically "up."  Postflight marked STATUS=failed →
# the user found a perfectly working instance with a misleading
# "failed" badge.  (#4799 + #6774 on 2026-05-15 afternoon: every
# check passed manually 30 s later, but the create flow had already
# tagged them failed.)
#
# v0.6.13: retry the /admin probe up to 3 times with a 5 s backoff —
# ~40 s total budget.  Bails fast on success.  Genuinely-broken
# containers still fail cleanly with a final HTTP code in the message.
#
# Tests use a tiny HTTP server inside bats's $SW_TMP — `python3
# -m http.server` listening on a random port, with a controllable
# response.  Each test stages a different latency / status pattern
# and asserts the retry shape.

setup() {
    SW_TMP="$(mktemp -d)"
    PORT=$(awk 'BEGIN{srand(); print 32000 + int(rand()*1000)}')
    BASE_URL="http://127.0.0.1:$PORT"
    export SW_TMP PORT BASE_URL

    # Stub `docker` so the postflight container-id + filesystem checks
    # all return success — we only want to exercise the /admin retry.
    # The filesystem checks (`docker exec ... test -f ...`) all return 0.
    cat > "$SW_TMP/docker" <<'SH'
#!/usr/bin/env bash
case "$1" in
    ps) echo "abcdef012345" ;;
    exec) exit 0 ;;
    *) exit 0 ;;
esac
SH
    chmod +x "$SW_TMP/docker"
    PATH="$SW_TMP:$PATH"
    export PATH

    info() { :; }
    ok()   { :; }
    warn() { :; }
    err()  { :; }
    export -f info ok warn err
}

teardown() {
    # Kill the test HTTP server if still running.
    [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# Spawn a Python HTTP server that serves $1 = file with status code on
# each request line.  Used to simulate a server that fails the first
# few requests then recovers.
_start_flaky_server() {
    local response_pattern="$1"
    cat > "$SW_TMP/server.py" <<PY
import http.server
import sys

class FlakyHandler(http.server.BaseHTTPRequestHandler):
    counter = 0
    pattern = [int(x) for x in "$response_pattern".split(",")]
    def do_GET(self):
        idx = FlakyHandler.counter
        FlakyHandler.counter += 1
        code = FlakyHandler.pattern[idx] if idx < len(FlakyHandler.pattern) else FlakyHandler.pattern[-1]
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"ok" if 200 <= code < 400 else b"err")
    def log_message(self, *args, **kwargs): pass  # silence

if __name__ == "__main__":
    server = http.server.HTTPServer(("127.0.0.1", $PORT), FlakyHandler)
    server.serve_forever()
PY
    python3 "$SW_TMP/server.py" &
    SERVER_PID=$!
    # Wait for server to start (max 2s)
    local i
    for i in 1 2 3 4 5 6 7 8 9 10; do
        if curl -sf -o /dev/null --max-time 1 "$BASE_URL/health" 2>/dev/null \
            || curl -sS -o /dev/null --max-time 1 "$BASE_URL/" 2>/dev/null; then
            return 0
        fi
        sleep 0.2
    done
    return 1
}

# ---------------------------------------------------------------------------
# Happy path: server returns 200 on first hit → no retries.
# ---------------------------------------------------------------------------

@test "postflight /admin: succeeds on first attempt when server is healthy" {
    _start_flaky_server "200"
    run _postflight_instance_ready "trunk-test" "$BASE_URL"
    [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# The actual incident: first attempt returns 502 (PHP-FPM not ready),
# second attempt 200.  v0.6.12 would have failed; v0.6.13 retries
# and succeeds.
# ---------------------------------------------------------------------------

@test "postflight /admin: recovers after one transient 502 (the #4799/#6774 case)" {
    _start_flaky_server "502,200,200"
    run _postflight_instance_ready "trunk-test" "$BASE_URL"
    [ "$status" -eq 0 ]
}

@test "postflight /admin: recovers after two transient failures" {
    _start_flaky_server "502,502,200"
    run _postflight_instance_ready "trunk-test" "$BASE_URL"
    [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Hard failure: ALL three attempts fail → postflight returns non-zero.
# Pins that we don't accidentally make the check always pass via a
# too-permissive retry loop.
# ---------------------------------------------------------------------------

@test "postflight /admin: fails when ALL three attempts return 500" {
    _start_flaky_server "500,500,500"
    run _postflight_instance_ready "trunk-test" "$BASE_URL"
    [ "$status" -eq 1 ]
}
