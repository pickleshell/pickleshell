#!/usr/bin/env bash
set -euo pipefail

unit_is_known() {
  local load_state
  load_state="$(systemctl show -p LoadState --value --no-pager "$1" 2>/dev/null)" || return 2
  [[ -n "$load_state" && "$load_state" != not-found ]]
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if [[ "${PICKLESHELL_RUN_CGROUP_INTEGRATION:-}" != 1 ]]; then
    printf 'SKIP: set PICKLESHELL_RUN_CGROUP_INTEGRATION=1 to use the isolated systemd contour\n'
    exit 77
  fi
  if [[ "$(id -u)" != 0 ]]; then
    printf 'SKIP: isolated delegated cgroup integration requires root to create a temporary systemd service\n'
    exit 77
  fi
  command -v systemd-run >/dev/null || { printf 'SKIP: systemd-run is unavailable\n'; exit 77; }
  unit="pickleshell-terminal-cgroup-test-$$"
  repo_root="$(cd "$(dirname "$0")/.." && pwd)"
  node_bin="${NODE_BIN:-$(command -v node)}"
  if unit_is_known "$unit"; then
    printf 'Refusing to reuse existing systemd unit %s\n' "$unit" >&2
    exit 1
  else
    check_status=$?
    if [[ "$check_status" != 1 ]]; then
      printf 'Unable to verify systemd unit collision state for %s\n' "$unit" >&2
      exit 1
    fi
  fi

  unit_started=0
  cleanup() {
    local status=$?
    if [[ "$unit_started" == 1 ]]; then
      systemctl stop "$unit" >/dev/null 2>&1 || true
      systemctl reset-failed "$unit" >/dev/null 2>&1 || true
    fi
    exit "$status"
  }
  trap cleanup EXIT INT TERM
  unit_started=1
  systemd-run --quiet --wait --collect --unit="$unit" \
    --property=Delegate=yes --property=ProtectControlGroups=false \
    --setenv=PICKLESHELL_CGROUP_INTEGRATION_INNER=1 \
    "$node_bin" "$repo_root/test/cgroup-integration.test.js"
fi
