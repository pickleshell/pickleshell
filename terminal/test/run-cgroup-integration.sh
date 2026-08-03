#!/usr/bin/env bash
set -euo pipefail

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
if systemctl show "$unit" >/dev/null 2>&1; then
  printf 'Refusing to reuse existing systemd unit %s\n' "$unit" >&2
  exit 1
fi
exec systemd-run --quiet --wait --collect --unit="$unit" \
  --property=Delegate=yes --property=ProtectControlGroups=false \
  --setenv=PICKLESHELL_CGROUP_INTEGRATION_INNER=1 \
  "$node_bin" "$repo_root/test/cgroup-integration.test.js"
