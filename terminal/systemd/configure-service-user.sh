#!/usr/bin/env bash
set -euo pipefail

unit_name='pickleshell-terminal.service'
drop_in_dir="/etc/systemd/system/${unit_name}.d"
drop_in_path="${drop_in_dir}/identity.conf"
user=''
group=''
check_only=0

usage() {
  printf 'Usage: %s --user USER [--group GROUP]\n' "$0" >&2
  printf '       %s --check USER [GROUP]\n' "$0" >&2
}

valid_name() {
  [[ "$1" =~ ^[a-z_][a-z0-9_-]{0,31}\$?$ ]]
}

lookup_group() {
  local candidate="$1"
  getent group "$candidate" >/dev/null
}

validate_identity() {
  local candidate_user="$1"
  local candidate_group="${2:-}"
  valid_name "$candidate_user" || { printf 'invalid service user name\n' >&2; return 1; }
  [[ "$candidate_user" != root ]] || { printf 'root is not an allowed Terminal service user\n' >&2; return 1; }
  getent passwd "$candidate_user" >/dev/null || { printf 'service user does not exist: %s\n' "$candidate_user" >&2; return 1; }
  if [[ -n "$candidate_group" ]]; then
    valid_name "$candidate_group" || { printf 'invalid service group name\n' >&2; return 1; }
    [[ "$candidate_group" != root ]] || { printf 'root is not an allowed Terminal service group\n' >&2; return 1; }
    lookup_group "$candidate_group" || { printf 'service group does not exist: %s\n' "$candidate_group" >&2; return 1; }
  fi
}

while (($#)); do
  case "$1" in
    --user)
      (($# >= 2)) || { usage; exit 2; }
      user="$2"; shift 2 ;;
    --group)
      (($# >= 2)) || { usage; exit 2; }
      group="$2"; shift 2 ;;
    --check)
      (($# >= 2 && $# <= 3)) || { usage; exit 2; }
      user="$2"; [[ $# == 3 ]] && group="$3"; check_only=1; shift $# ;;
    *) usage; exit 2 ;;
  esac
done

[[ -n "$user" ]] || { usage; exit 2; }
validate_identity "$user" "$group"
if ((check_only)); then
  exit 0
fi

[[ "$(id -u)" == 0 ]] || { printf 'configuring a systemd unit requires root\n' >&2; exit 1; }
if [[ -z "$group" ]]; then
  group="$(id -gn -- "$user")"
  validate_identity "$user" "$group"
fi

install -d -m 0755 "$drop_in_dir"
tmp_path="$(mktemp "${drop_in_path}.tmp.XXXXXX")"
trap 'rm -f "$tmp_path"' EXIT
cat >"$tmp_path" <<EOF
[Service]
# Explicit deployment-time identity; Linux permissions and systemd remain authoritative.
User=$user
Group=$group
# Permit the selected account's existing sudo policy to take effect; this grants nothing.
NoNewPrivileges=false
EOF
chown root:root "$tmp_path"
chmod 0644 "$tmp_path"
mv -f "$tmp_path" "$drop_in_path"
trap - EXIT
printf 'Wrote %s for User=%s Group=%s\n' "$drop_in_path" "$user" "$group"
printf 'Run systemctl daemon-reload and restart %s to apply it.\n' "$unit_name"
