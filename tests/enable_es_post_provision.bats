#!/usr/bin/env bats

# Regression guard for `_swctl_enable_es_if_requested` —
# the helper inside workflows/shopware6/hooks/post-provision.sh that
# (a) appends SHOPWARE_ES_* env vars to .env.local and (b) runs
# es:index + drains the messenger queue after a fresh create.
#
# The hook is sourced from inside `run_workflow_hook`, which inherits
# every swctl function and variable.  To exercise it standalone, we
# source the hook directly with the swctl runtime mocked out:
#
#   - WORKTREE_PATH + COMPOSE_PROJECT point at our $SW_TMP scratch.
#   - WORKFLOW_CONSOLE is just the literal string "console" — what
#     matters for behaviour assertions is the chain of run_app_command
#     calls, which we record.
#   - run_app_command is stubbed to append its invocations to a log
#     file.  No docker exec actually happens.
#   - info / warn / ok are silenced so the bats output stays readable.
#
# The test asserts the OBSERVABLE behaviour of the helper:
#   1. SHOPWARE_ES_* lines appear in .env.local on first run.
#   2. Second run is a no-op for the env-write (idempotent).
#   3. The expected console commands are invoked in order.
#   4. SWCTL_ENABLE_ES=0 / unset → helper is a no-op.

setup() {
    SW_TMP="$(mktemp -d)"
    HOOK="$BATS_TEST_DIRNAME/../workflows/shopware6/hooks/post-provision.sh"
    [ -f "$HOOK" ] || { echo "missing hook: $HOOK"; return 1; }

    WORKTREE_PATH="$SW_TMP/wt"
    mkdir -p "$WORKTREE_PATH"
    cat > "$WORKTREE_PATH/.env.local" <<'EOF'
APP_ENV=dev
APP_URL=http://web.test.orb.local
EOF

    COMPOSE_PROJECT="trunk-test"
    WORKFLOW_CONSOLE="console"
    SWCTL_MODE="qa"
    DB_STATE="cloned"
    BACKEND_CHANGES=0
    ADMIN_CHANGES=0
    STOREFRONT_CHANGES=0
    COMPOSER_CHANGES=0
    PACKAGE_CHANGES=0

    # Record every run_app_command invocation so tests can assert the
    # command chain.  First arg = compose project, second = command.
    CALL_LOG="$SW_TMP/calls.log"
    : > "$CALL_LOG"
    run_app_command() {
        printf '%s | %s\n' "$1" "$2" >> "$CALL_LOG"
    }
    info() { :; }
    warn() { :; }
    ok()   { :; }
    export -f run_app_command info warn ok

    export SW_TMP HOOK WORKTREE_PATH COMPOSE_PROJECT WORKFLOW_CONSOLE \
           SWCTL_MODE DB_STATE \
           BACKEND_CHANGES ADMIN_CHANGES STOREFRONT_CHANGES \
           COMPOSER_CHANGES PACKAGE_CHANGES CALL_LOG
}

teardown() {
    [ -n "${SW_TMP:-}" ] && rm -rf "$SW_TMP"
}

# Source the hook into the current shell so `_swctl_enable_es_if_requested`
# is callable from each test.  The hook body's QA-mode return short-
# circuits BEFORE the function call, but we just need the function
# definition — so we strip the runtime invocation off the top.
_load_hook_function() {
    # `set +e` because the hook body has `set -euo pipefail` and a
    # `return` at the QA-mode branch; sourcing it would exit the bats
    # shell.  Extract the function body only.
    sed -n '/^_swctl_enable_es_if_requested()/,/^}$/p' "$HOOK" > "$SW_TMP/hook-fn.sh"
    . "$SW_TMP/hook-fn.sh"
}

# ---------------------------------------------------------------------------
# Happy path: SWCTL_ENABLE_ES=1 + clean .env.local → ES env appended +
# cache:clear + es:index + messenger:consume invoked in order.
# ---------------------------------------------------------------------------

@test "post-provision ES step: writes env + runs cache/index/consume" {
    SWCTL_ENABLE_ES=1
    export SWCTL_ENABLE_ES
    _load_hook_function

    _swctl_enable_es_if_requested

    grep -q '^SHOPWARE_ES_ENABLED=1' "$WORKTREE_PATH/.env.local"
    grep -q '^SHOPWARE_ES_INDEXING_ENABLED=1' "$WORKTREE_PATH/.env.local"
    grep -q '^SHOPWARE_ES_HOSTS=http://opensearch:9200' "$WORKTREE_PATH/.env.local"
    grep -q '^SHOPWARE_ES_THROW_EXCEPTION=1' "$WORKTREE_PATH/.env.local"

    # cache:clear + es:index chained under one docker exec
    grep -q 'cache:clear && console es:index --no-interaction' "$CALL_LOG"
    # messenger:consume drains the queue
    grep -q 'messenger:consume async' "$CALL_LOG"
}

# ---------------------------------------------------------------------------
# Idempotency: a second invocation (e.g. `swctl refresh`) must NOT
# append a duplicate SHOPWARE_ES_* stanza.  Counts must stay at 1.
# ---------------------------------------------------------------------------

@test "post-provision ES step: idempotent on repeated invocation" {
    SWCTL_ENABLE_ES=1
    export SWCTL_ENABLE_ES
    _load_hook_function

    _swctl_enable_es_if_requested
    _swctl_enable_es_if_requested

    [ "$(grep -c '^SHOPWARE_ES_ENABLED=' "$WORKTREE_PATH/.env.local")" = "1" ]
    [ "$(grep -c '^SHOPWARE_ES_HOSTS='   "$WORKTREE_PATH/.env.local")" = "1" ]
}

# ---------------------------------------------------------------------------
# Off path: SWCTL_ENABLE_ES=0 / unset → no env write, no console calls.
# ---------------------------------------------------------------------------

@test "post-provision ES step: no-op when SWCTL_ENABLE_ES is 0" {
    SWCTL_ENABLE_ES=0
    export SWCTL_ENABLE_ES
    _load_hook_function

    _swctl_enable_es_if_requested

    ! grep -q SHOPWARE_ES_ENABLED "$WORKTREE_PATH/.env.local"
    [ ! -s "$CALL_LOG" ]
}

@test "post-provision ES step: no-op when SWCTL_ENABLE_ES is unset" {
    unset SWCTL_ENABLE_ES
    _load_hook_function

    _swctl_enable_es_if_requested

    ! grep -q SHOPWARE_ES_ENABLED "$WORKTREE_PATH/.env.local"
    [ ! -s "$CALL_LOG" ]
}

# ---------------------------------------------------------------------------
# Defensive: missing .env.local doesn't crash — emits a warn and bails.
# ---------------------------------------------------------------------------

@test "post-provision ES step: missing .env.local is a graceful warn, not a crash" {
    rm -f "$WORKTREE_PATH/.env.local"
    SWCTL_ENABLE_ES=1
    export SWCTL_ENABLE_ES
    _load_hook_function

    run _swctl_enable_es_if_requested
    [ "$status" -eq 0 ]
    [ ! -s "$CALL_LOG" ]
}

# ---------------------------------------------------------------------------
# Existing user-supplied SHOPWARE_ES_ENABLED is respected (not overwritten).
# Console commands still run — the user may have set a custom host.
# ---------------------------------------------------------------------------

@test "post-provision ES step: leaves pre-existing SHOPWARE_ES_ENABLED untouched" {
    SWCTL_ENABLE_ES=1
    export SWCTL_ENABLE_ES
    cat >> "$WORKTREE_PATH/.env.local" <<'EOF'

SHOPWARE_ES_ENABLED=1
SHOPWARE_ES_HOSTS=http://custom-es:9200
EOF
    _load_hook_function

    _swctl_enable_es_if_requested

    # Custom host preserved
    grep -q '^SHOPWARE_ES_HOSTS=http://custom-es:9200' "$WORKTREE_PATH/.env.local"
    # Helper did NOT append a second SHOPWARE_ES_HOSTS line
    [ "$(grep -c '^SHOPWARE_ES_HOSTS=' "$WORKTREE_PATH/.env.local")" = "1" ]
    # But console commands still fired — we don't know if the existing
    # config has a fresh index, so re-running es:index is safe.
    grep -q 'es:index' "$CALL_LOG"
}
