#!/usr/bin/env bash
set -euo pipefail

runner="$(dirname "$0")/run-cgroup-integration.sh"
fake_dir="$(mktemp -d)"
trap 'rm -rf "$fake_dir"' EXIT
cat >"$fake_dir/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${@: -1}" in
  nonexistent.service) printf 'not-found\n' ;;
  loaded.service) printf 'loaded\n' ;;
  broken.service) exit 1 ;;
  *) printf 'unknown\n' ;;
esac
EOF
chmod 0755 "$fake_dir/systemctl"

PATH="$fake_dir:$PATH" bash -c 'source "$1"; ! unit_is_known nonexistent.service; unit_is_known loaded.service; ! unit_is_known broken.service' bash "$runner"
printf 'cgroup runner unit-state tests passed\n'
