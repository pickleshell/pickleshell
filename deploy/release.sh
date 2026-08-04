#!/usr/bin/env bash
set -Eeuo pipefail

# Immutable release installer. It deliberately does not copy operator state.

usage() {
  printf '%s\n' \
    'Usage: release.sh --source REPOSITORY --root ABSOLUTE_ROOT --commit SHA' \
    '                   [--gateway-user USER] [--mcp-user USER] [--terminal-user USER]' \
    '                   [--gateway-service NAME] [--mcp-service NAME] [--terminal-service NAME]' \
    '                   [--include-terminal] [--no-systemd] [--dry-run] [--rollback]'
}

die() { printf 'release: error: %s\n' "$1" >&2; exit 1; }
log() { printf 'release: %s\n' "$1"; }

SOURCE=''
ROOT=''
COMMIT=''
GATEWAY_USER='pickleshell'
MCP_USER='pickleshell-tunnel'
TERMINAL_USER='pickleshell-terminal'
GATEWAY_SERVICE='pickleshell-gateway.service'
MCP_SERVICE='pickleshell-tunnel.service'
TERMINAL_SERVICE='pickleshell-terminal.service'
INCLUDE_TERMINAL=0
NO_SYSTEMD=0
DRY_RUN=0
ROLLBACK=0
SYSTEMCTL=systemctl
UNITS_DIR=/etc/systemd/system
RESOLVED=''

while (($#)); do
  case "$1" in
    --source) SOURCE=${2:-}; shift 2 ;;
    --root) ROOT=${2:-}; shift 2 ;;
    --commit) COMMIT=${2:-}; shift 2 ;;
    --gateway-user) GATEWAY_USER=${2:-}; shift 2 ;;
    --mcp-user) MCP_USER=${2:-}; shift 2 ;;
    --terminal-user) TERMINAL_USER=${2:-}; shift 2 ;;
    --gateway-service) GATEWAY_SERVICE=${2:-}; shift 2 ;;
    --mcp-service|--tunnel-service) MCP_SERVICE=${2:-}; shift 2 ;;
    --terminal-service) TERMINAL_SERVICE=${2:-}; shift 2 ;;
    --include-terminal) INCLUDE_TERMINAL=1; shift ;;
    --no-systemd) NO_SYSTEMD=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    --systemctl) SYSTEMCTL=${2:-}; shift 2 ;;
    --units-dir) UNITS_DIR=${2:-}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[[ $ROOT = /* ]] || die 'root must be an absolute path'
[[ $ROOT != / && $ROOT != /etc && $ROOT != /usr && $ROOT != /var && $ROOT != /home ]] || die 'root is too broad'
[[ $ROOT != */.. && $ROOT != */../* && $ROOT != *'/.' ]] || die 'root contains an unsafe path component'
[[ $SYSTEMCTL != */* || $SYSTEMCTL = /* ]] || die 'unsafe systemctl command path'
[[ $UNITS_DIR = /* && $UNITS_DIR != / && $UNITS_DIR != /etc && $UNITS_DIR != /usr ]] || die 'unsafe units directory'
if [[ -e $UNITS_DIR ]]; then
  [[ -d $UNITS_DIR && ! -L $UNITS_DIR ]] || die 'units directory must be a real directory'
else
  units_parent=$(realpath -e -- "$(dirname -- "$UNITS_DIR")") || die 'units directory parent does not exist'
  [[ ! -L $units_parent ]] || die 'units directory parent must not be a symlink'
fi
[[ $GATEWAY_USER =~ ^[a-z_][a-z0-9_-]*$ && $MCP_USER =~ ^[a-z_][a-z0-9_-]*$ && $TERMINAL_USER =~ ^[a-z_][a-z0-9_-]*$ ]] || die 'unsafe service user name'
[[ $GATEWAY_USER != root && $MCP_USER != root && $TERMINAL_USER != root ]] || die 'root is not a valid component user'

validate_service_name() {
  local name=$1 label=$2
  [[ $name =~ ^[A-Za-z0-9][A-Za-z0-9_.@-]*\.service$ ]] || die "unsafe $label service name"
  [[ $name != *..* ]] || die "unsafe $label service name"
  case "$name" in
    pickleshell-terminal-chatgpt.service|terminal-chatgpt.service) die "protected $label service name" ;;
  esac
}

validate_service_name "$GATEWAY_SERVICE" gateway
validate_service_name "$MCP_SERVICE" mcp
validate_service_name "$TERMINAL_SERVICE" terminal
[[ $GATEWAY_SERVICE != "$MCP_SERVICE" && $GATEWAY_SERVICE != "$TERMINAL_SERVICE" && $MCP_SERVICE != "$TERMINAL_SERVICE" ]] || die 'service names must be distinct'

[[ ! -L $ROOT ]] || die 'root must not be a symlink'
if [[ -e $ROOT ]]; then
  [[ -d $ROOT ]] || die 'root is not a directory'
else
  root_parent=$(dirname -- "$ROOT")
  root_parent=$(realpath -e -- "$root_parent") || die 'root parent does not exist'
  [[ ! -L $root_parent ]] || die 'root parent must not be a symlink'
fi
if ((ROLLBACK)); then
  ROOT=$(realpath -e -- "$ROOT") || die 'cannot resolve root'
  [[ $ROOT != "$SOURCE" || -z $SOURCE ]] || die 'source and deployment root must be different'
else
  [[ -n $SOURCE && -n $COMMIT ]] || { usage >&2; die 'source and commit are required'; }
  [[ $COMMIT =~ ^[0-9a-fA-F]{40}$ ]] || die 'commit must be a full 40-character Git SHA'
  SOURCE=$(realpath -e -- "$SOURCE") || die 'source does not exist'
  [[ -d $SOURCE/.git ]] || die 'source is not a Git worktree'
fi
mkdir -p -- "$ROOT"
ROOT=$(realpath -e -- "$ROOT") || die 'cannot resolve root'
[[ -z $SOURCE || $ROOT != "$SOURCE" ]] || die 'source and deployment root must be different'

if ((ROLLBACK)); then
  [[ -d $ROOT/state && ! -L $ROOT/state ]] || die 'rollback state directory is missing or unsafe'
  STATE="$ROOT/state"
  RELEASES="$ROOT/releases"
  ACTIVE="$ROOT/active"
else
  if ! command -v node >/dev/null || ! command -v npm >/dev/null || ! command -v git >/dev/null || ! command -v tar >/dev/null; then
  die 'git, node, npm, and tar are required'
  fi
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]') || die 'cannot determine Node version'
  (( NODE_MAJOR >= 20 )) || die 'Node.js 20 or newer is required'

  for user in "$GATEWAY_USER" "$MCP_USER" "$TERMINAL_USER"; do
    id "$user" >/dev/null 2>&1 || die "service user does not exist: $user"
  done

  git_dirty=$(git -C "$SOURCE" status --porcelain=v1 --untracked-files=all)
  [[ -z $git_dirty ]] || die 'source worktree is dirty'
  RESOLVED=$(git -C "$SOURCE" rev-parse --verify "$COMMIT^{commit}") || die 'commit does not resolve'
  [[ $RESOLVED == "$COMMIT" ]] || die 'commit is not the exact resolved SHA'
fi

RELEASES="$ROOT/releases"
ACTIVE="$ROOT/active"
STATE="$ROOT/state"
RELEASE="${RELEASES:-}/$RESOLVED"
WORK_RELEASE="${RELEASES:-}/.staging-$RESOLVED-$$"
[[ ! -e $RELEASES || ( ! -L $RELEASES && -d $RELEASES ) ]] || die 'releases path is not a real directory'
[[ ! -e $STATE || ( ! -L $STATE && -d $STATE ) ]] || die 'state path is not a real directory'
if ((ROLLBACK)); then
  [[ -d $RELEASES && ! -L $RELEASES ]] || die 'rollback releases directory is missing or unsafe'
else
  mkdir -p -- "$RELEASES" "$STATE"
fi
[[ ! -e $RELEASE || -L $RELEASE ]] || die 'release path exists and is not a directory'
[[ ! -e $WORK_RELEASE || -L $WORK_RELEASE ]] || die 'staging path exists and is not a directory'
trap 'rm -rf -- "$WORK_RELEASE"' EXIT

if ((DRY_RUN && !ROLLBACK)); then
  log "would stage $RESOLVED under $RELEASE and activate it"
  exit 0
fi

run() {
  if ((DRY_RUN)); then
    printf 'release: dry-run:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

as_user() {
  local user=$1; shift
  if [[ $(id -u) -eq 0 ]]; then
    run runuser -u "$user" -- "$@"
  else
    [[ $(id -un) == "$user" ]] || die "run as $user or root to build components"
    run "$@"
  fi
}

required_files() {
  local component=$1
  [[ -f $WORK_RELEASE/$component/package.json && -f $WORK_RELEASE/$component/package-lock.json ]] || die "missing $component package files"
}

stage() {
  log "staging commit $RESOLVED"
  mkdir -p -- "$WORK_RELEASE"
  run git -C "$SOURCE" archive --format=tar "$RESOLVED" 'gateway' 'mcp-server' 'terminal' | run tar -xf - -C "$WORK_RELEASE"
  [[ -f $WORK_RELEASE/gateway/package.json && -f $WORK_RELEASE/mcp-server/package.json && -f $WORK_RELEASE/terminal/package.json ]] || die 'archive is missing a required component'
  while IFS= read -r -d '' path; do
    [[ ! -L $path ]] || die 'archive contains an unsafe symbolic link'
  done < <(find "$WORK_RELEASE" -type l -print0)
  printf '%s\n' "$RESOLVED" > "$WORK_RELEASE/.release-sha"
  [[ $(<"$WORK_RELEASE/.release-sha") == "$RESOLVED" ]] || die 'staged SHA does not match requested commit'
}

build() {
  log 'building Gateway, MCP, and Terminal in the staged release'
  required_files gateway; required_files mcp-server; required_files terminal
  as_user "$GATEWAY_USER" env PATH="$PATH" npm --prefix "$WORK_RELEASE/gateway" ci --omit=dev
  as_user "$MCP_USER" env PATH="$PATH" npm --prefix "$WORK_RELEASE/mcp-server" ci
  as_user "$MCP_USER" env PATH="$PATH" npm --prefix "$WORK_RELEASE/mcp-server" run build
  as_user "$TERMINAL_USER" env PATH="$PATH" npm --prefix "$WORK_RELEASE/terminal" ci
  as_user "$TERMINAL_USER" env PATH="$PATH" npm --prefix "$WORK_RELEASE/terminal" run build
  [[ -f $WORK_RELEASE/mcp-server/dist/index.js && -x $WORK_RELEASE/terminal/bin/cgroup-launcher ]] || die 'component build did not produce required files'
  mv -T -- "$WORK_RELEASE" "$RELEASE"
}

unit_for() {
  case "$1" in
    gateway) printf '%s' "$GATEWAY_SERVICE" ;;
    mcp) printf '%s' "$MCP_SERVICE" ;;
    terminal) printf '%s' "$TERMINAL_SERVICE" ;;
    *) die "unknown component: $1" ;;
  esac
}

install_units() {
  ((NO_SYSTEMD)) && return 0
  [[ $(id -u) -eq 0 || $SYSTEMCTL != systemctl ]] || die 'systemd installation requires root'
  local backup_dir=$STATE/unit-backups
  mkdir -p -- "$backup_dir"
  local component unit source_unit target
  for component in gateway mcp; do
    unit=$(unit_for "$component")
    [[ $component == gateway ]] && source_unit=$RELEASE/gateway/systemd/pickleshell-gateway.service || source_unit=$RELEASE/mcp-server/systemd/pickleshell-tunnel.service
    [[ -f $source_unit && ! -L $source_unit ]] || { log "missing unit file for $component" >&2; return 1; }
    local unit_contents
    unit_contents=$(<"$source_unit")
    unit_contents=${unit_contents//\/opt\/pickleshell/$ROOT}
    target=$UNITS_DIR/$unit
    [[ ! -L $target ]] || die "unit path is a symlink: $unit"
    [[ ! -e $target || -f $target ]] || die "unit path is not a regular file: $unit"
    if [[ -e $target ]]; then
      run cp -p -- "$target" "$backup_dir/$unit" || return 1
    else
      run rm -f -- "$backup_dir/$unit" || return 1
    fi
    printf '%s\n' "$unit_contents" | run install -m 0644 /dev/stdin "$target" || return 1
  done
  if ((INCLUDE_TERMINAL)); then
    unit=$(unit_for terminal)
    source_unit=$RELEASE/terminal/systemd/pickleshell-terminal.service
    [[ -f $source_unit && ! -L $source_unit ]] || { log 'missing unit file for terminal' >&2; return 1; }
    local unit_contents
    unit_contents=$(<"$source_unit")
    unit_contents=${unit_contents//\/opt\/pickleshell/$ROOT}
    target=$UNITS_DIR/$unit
    [[ ! -L $target ]] || die "unit path is a symlink: $unit"
    [[ ! -e $target || -f $target ]] || die "unit path is not a regular file: $unit"
    if [[ -e $target ]]; then
      run cp -p -- "$target" "$backup_dir/$unit" || return 1
    else
      run rm -f -- "$backup_dir/$unit" || return 1
    fi
    printf '%s\n' "$unit_contents" | run install -m 0644 /dev/stdin "$target" || return 1
  fi
  run "$SYSTEMCTL" daemon-reload || return 1
}

restore_units() {
  ((NO_SYSTEMD)) && return 0
  local backup_dir=$STATE/unit-backups
  local component unit backup target
  for component in gateway mcp; do
    unit=$(unit_for "$component")
    backup=$backup_dir/$unit
    target=$UNITS_DIR/$unit
    if [[ -f $backup && ! -L $backup ]]; then
      run install -m 0644 -- "$backup" "$target" || return 1
    else
      run rm -f -- "$target" || return 1
    fi
  done
  if ((INCLUDE_TERMINAL)); then
    unit=$(unit_for terminal)
    backup=$backup_dir/$unit
    target=$UNITS_DIR/$unit
    if [[ -f $backup && ! -L $backup ]]; then
      run install -m 0644 -- "$backup" "$target" || return 1
    else
      run rm -f -- "$target" || return 1
    fi
  fi
  run "$SYSTEMCTL" daemon-reload || return 1
}

service_action() {
  ((NO_SYSTEMD)) && return 0
  local action=$1; shift
  run "$SYSTEMCTL" "$action" "$@"
}

active_target() {
  [[ -L $ACTIVE ]] || return 1
  local target
  target=$(readlink -- "$ACTIVE") || return 1
  [[ $target == releases/* && $target != *'..'* ]] || die 'active symlink points outside releases'
  [[ -d $ROOT/$target && ! -L $ROOT/$target ]] || die 'active symlink target is missing or unsafe'
  printf '%s' "$target"
}

atomic_activate() {
  local previous=''
  if [[ -e $ACTIVE || -L $ACTIVE ]]; then
    [[ -L $ACTIVE ]] || die 'active exists but is not a symlink'
    previous=$(active_target)
  fi
  printf '%s\n' "$previous" > "$STATE/previous-target"
  printf '%s\n' "releases/$RESOLVED" > "$STATE/current-target"
  local tmp="$ROOT/.active.new.$$"
  rm -f -- "$tmp"
  ln -s -- "releases/$RESOLVED" "$tmp"
  mv -Tf -- "$tmp" "$ACTIVE"
  [[ $(active_target) == releases/$RESOLVED ]] || die 'atomic active switch verification failed'
  printf '%s\n' "$RESOLVED" > "$RELEASE/.release-sha"
}

restart_and_verify() {
  ((NO_SYSTEMD)) && return 0
  service_action restart "$(unit_for gateway)" || return 1
  service_action is-active "$(unit_for gateway)" || return 1
  service_action restart "$(unit_for mcp)" || return 1
  service_action is-active "$(unit_for mcp)" || return 1
  if ((INCLUDE_TERMINAL)); then
    service_action restart "$(unit_for terminal)" || return 1
    service_action is-active "$(unit_for terminal)" || return 1
  fi
}

restore_previous() {
  local previous
  previous=$(<"$STATE/previous-target")
  if [[ -z $previous ]]; then
    [[ ! -e $ACTIVE && ! -L $ACTIVE ]] || run rm -f -- "$ACTIVE"
  else
    [[ $previous == releases/* && $previous != *'..'* && -d $ROOT/$previous && ! -L $ROOT/$previous ]] || die 'recorded rollback target is unsafe or missing'
    local tmp="$ROOT/.active.rollback.$$"
    rm -f -- "$tmp"
    ln -s -- "$previous" "$tmp"
    mv -Tf -- "$tmp" "$ACTIVE"
  fi
  restore_units || die 'could not restore unit files'
  ((NO_SYSTEMD)) && return 0
  service_action restart "$(unit_for gateway)" || true
  service_action restart "$(unit_for mcp)" || true
  ((INCLUDE_TERMINAL)) && service_action restart "$(unit_for terminal)" || true
}

rollback() {
  [[ -f $STATE/previous-target ]] || die 'no recorded previous target'
  restore_previous
  if [[ -L $ACTIVE ]]; then
    log "rolled back to $(active_target)"
  else
    log 'rolled back with no active release'
  fi
}

if ((ROLLBACK)); then
  rollback
  exit 0
fi

stage
build
if ! install_units; then
  restore_units || true
  die 'unit installation failed'
fi
if ! atomic_activate; then
  log 'activation failed; restoring previous release'
  restore_previous
  die 'activation failed'
fi
if ! restart_and_verify; then
  log 'activation or service verification failed; restoring previous release'
  restore_previous
  die 'activation failed'
fi
log "active release: $(active_target)"
