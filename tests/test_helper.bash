#!/usr/bin/env bash
export SWCTL_SOURCED=1
# shellcheck source=../swctl
source "$BATS_TEST_DIRNAME/../swctl"

# Disable the v0.6.19 host-load preflight gate by default in the test
# suite.  CI runners and dev machines under heavy interactive load
# would otherwise trip the >10 threshold and fail every preflight-
# touching test.  Individual tests that want to exercise the gate
# (see preflight_load.bats) override this by setting SWCTL_MAX_LOAD
# explicitly in their own setup().
export SWCTL_MAX_LOAD="${SWCTL_MAX_LOAD:-0}"
