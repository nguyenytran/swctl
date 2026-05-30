#!/usr/bin/env bats

load test_helper

# Regression guard for `_run_preflight_checks`'s alpine auto-pull
# (added 2026-05-11).
#
# Bug this prevents: fresh-install / second-machine setup hit
# `[preflight] ✗ alpine image cached / Run: docker pull alpine:latest`
# and bailed out, forcing the user to manually `docker pull
# alpine:latest` before `swctl create` would proceed.  Alpine is a
# ~3 MB public image needed only as a tiny shim for vendor population;
# making the user discover-and-run a pull command for it was
# friction-for-nothing.
#
# Fix: when neither `alpine:latest` nor `alpine` is cached, preflight
# now attempts `docker pull alpine:latest` itself, then re-evaluates
# the inspect check.  If the auto-pull fails (network, daemon, auth)
# the preflight still fails with an actionable message — the
# behavior degrades gracefully back to the pre-fix path.
#
# Tests use a tiny stub that simulates docker by reading a one-shot
# state file: first `inspect` returns 1, then `pull` flips the state
# to "cached" and subsequent `inspect` returns 0.

setup() {
    SW_TMP="$(mktemp -d)"
    SW_WORKTREE_ROOT="$SW_TMP"
    PROJECT_ROOT="$SW_TMP"
    SWCTL_TEMPLATE_DIR="$SW_TMP"
    touch "$SW_TMP/docker-compose.swctl.yml"   # templates check passes
    SW_TRAEFIK_NETWORK="net"
    SW_INFRA_DB_CONTAINER="db"
    ISSUE_ID="9999"
    WORKTREE_PATH="$SW_TMP/wt-9999"
    export SW_TMP SW_WORKTREE_ROOT PROJECT_ROOT SWCTL_TEMPLATE_DIR \
           SW_TRAEFIK_NETWORK SW_INFRA_DB_CONTAINER ISSUE_ID WORKTREE_PATH
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# Stub for the auto-pull scenario: simulates a cold install where
# `alpine:latest` is absent, then becomes available after `docker pull`.
#
# Records every invocation to $SW_TMP/calls.log so tests can assert
# the pull DID happen (and only once) without inspecting docker state.
_install_alpine_autopull_docker() {
    cat > "$SW_TMP/docker" <<EOF
#!/usr/bin/env bash
echo "docker \$*" >> "$SW_TMP/calls.log"
case "\$1" in
    info)        exit 0 ;;
    ps)          # mariadb check expects a name on success
                 echo "stub-ok"; exit 0 ;;
    image)
        if [ "\$2" = "inspect" ]; then
            # First call (before pull): 1.  After pull-marker exists: 0.
            if [ -f "$SW_TMP/.alpine-pulled" ]; then
                exit 0
            fi
            exit 1
        fi
        exit 0
        ;;
    pull)
        # The auto-pull invocation — record it and flip cache state.
        touch "$SW_TMP/.alpine-pulled"
        exit 0
        ;;
    network)     exit 0 ;;
    *)           exit 0 ;;
esac
EOF
    chmod +x "$SW_TMP/docker"
    PATH="$SW_TMP:$PATH"
    export PATH
}

# Stub for the "pull fails" path: inspect always 1, pull always 1.
_install_alpine_pullfail_docker() {
    cat > "$SW_TMP/docker" <<EOF
#!/usr/bin/env bash
echo "docker \$*" >> "$SW_TMP/calls.log"
case "\$1" in
    info)        exit 0 ;;
    ps)          echo "stub-ok"; exit 0 ;;
    image)       exit 1 ;;
    pull)        exit 1 ;;
    network)     exit 0 ;;
    *)           exit 0 ;;
esac
EOF
    chmod +x "$SW_TMP/docker"
    PATH="$SW_TMP:$PATH"
    export PATH
}

# Stub for the "already cached" path: inspect always 0, pull MUST NOT
# be invoked (auto-pull should skip when cache hit).
_install_alpine_cached_docker() {
    cat > "$SW_TMP/docker" <<EOF
#!/usr/bin/env bash
echo "docker \$*" >> "$SW_TMP/calls.log"
case "\$1" in
    info)        exit 0 ;;
    ps)          echo "stub-ok"; exit 0 ;;
    image)       exit 0 ;;
    pull)
        # If we get here on the cached path it's a bug — record loudly.
        echo "BUG: unexpected pull on already-cached path" >> "$SW_TMP/calls.log"
        exit 99
        ;;
    network)     exit 0 ;;
    *)           exit 0 ;;
esac
EOF
    chmod +x "$SW_TMP/docker"
    PATH="$SW_TMP:$PATH"
    export PATH
}

# ---------------------------------------------------------------------------
# Auto-pull path: alpine missing → preflight pulls it → check passes.
# ---------------------------------------------------------------------------

@test "_run_preflight_checks: auto-pulls alpine when missing, then check passes" {
    _install_alpine_autopull_docker

    run _run_preflight_checks
    [ "$status" -eq 0 ]
    # Pull was invoked exactly once
    [ "$(grep -c '^docker pull alpine:latest' "$SW_TMP/calls.log")" = "1" ]
    # Alpine check appears as ✓ (passed) in the aggregator output
    [[ "$output" == *"✓ alpine image cached"* ]]
    # Informational notice surfaced so the user sees what we did
    [[ "$output" == *"alpine:latest not cached"* ]] || \
        [[ "$output" == *"pulling for first-time setup"* ]]
}

# ---------------------------------------------------------------------------
# Already-cached path: pull is NOT invoked.  Guards against the
# pathological case of re-pulling on every preflight invocation.
# ---------------------------------------------------------------------------

@test "_run_preflight_checks: skips pull when alpine is already cached" {
    _install_alpine_cached_docker

    run _run_preflight_checks
    [ "$status" -eq 0 ]
    # No pull invocation in the log
    [ "$(grep -c '^docker pull' "$SW_TMP/calls.log" || true)" = "0" ]
    # And no surprise "pulling for first-time setup" notice
    [[ "$output" != *"pulling for first-time setup"* ]]
    [[ "$output" == *"✓ alpine image cached"* ]]
}

# ---------------------------------------------------------------------------
# Graceful degradation: pull fails (network down, daemon broken) →
# preflight still surfaces the original actionable hint instead of
# swallowing the failure.
# ---------------------------------------------------------------------------

@test "_run_preflight_checks: pull failure falls back to actionable error" {
    _install_alpine_pullfail_docker

    run _run_preflight_checks
    [ "$status" -eq 1 ]
    [[ "$output" == *"✗ alpine image cached"* ]]
    # Remediation hint mentions docker pull so user knows what to do
    [[ "$output" == *"docker pull alpine"* ]]
}
