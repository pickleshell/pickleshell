#!/usr/bin/env bash
set -Eeuo pipefail

# Immutable release installer. It deliberately does not copy operator state.

usage() {
  printf '%s\n' \
    'Usage: release.sh --source REPOSITORY --root ABSOLUTE_ROOT --commit SHA' \
    '                   [--profile production|isolated|chatgpt]' \
    '                   [--config-root PATH] [--state-root PATH] [--cache-root PATH]' \
    '                   [--workspace-root PATH] [--mcp-runtime-dir PATH] [--terminal-runtime-dir PATH]' \
    '                   [--terminal-socket PATH] [--node-executable PATH] [--terminal-node-executable PATH]' \
    '                   [--tunnel-client-executable PATH] [--tunnel-profile PATH]' \
    '                   [--mcp-bind-source PATH] [--mcp-bind-target PATH] [--mcp-temp-dir PATH]' \
    '                   [--gateway-user USER] [--mcp-user USER] [--terminal-user USER]' \
    '                   [--gateway-group GROUP] [--mcp-group GROUP] [--terminal-group GROUP]' \
    '                   [--gateway-service NAME] [--mcp-service NAME] [--terminal-service NAME]' \
    '                   [--include-terminal] [--no-systemd] [--dry-run] [--rollback]'
}

die() { printf 'release: error: %s\n' "$1" >&2; exit 1; }
log() { printf 'release: %s\n' "$1"; }

SOURCE=''
ROOT=''
COMMIT=''
PROFILE=production
GATEWAY_USER='pickleshell'
MCP_USER='pickleshell-tunnel'
TERMINAL_USER='pickleshell-terminal'
GATEWAY_GROUP='pickleshell'
MCP_GROUP='pickleshell-tunnel'
TERMINAL_GROUP='pickleshell-terminal'
GATEWAY_SERVICE='pickleshell-gateway.service'
MCP_SERVICE='pickleshell-tunnel.service'
TERMINAL_SERVICE='pickleshell-terminal.service'
SETTINGS_ROOT='/var/lib/pickleshell-settings'
CONFIG_ROOT='/etc/pickleshell'
STATE_ROOT='/var/lib/pickleshell'
CACHE_ROOT='/var/cache/pickleshell'
WORKSPACE_ROOT='/srv/pickleshell/workspace'
TERMINAL_WORKSPACE_ROOT='/srv/pickleshell/workspace'
MCP_RUNTIME_DIR='/run/pickleshell-mcp'
MCP_BIND_SOURCE='/run/pickleshell-mcp'
MCP_BIND_TARGET='/run/pickleshell-mcp'
MCP_TEMP_DIR='/var/lib/pickleshell/mcp-temp'
TERMINAL_RUNTIME_DIR='/run/pickleshell-terminal'
TERMINAL_SOCKET='/run/pickleshell-terminal/service.sock'
NODE_EXECUTABLE='/opt/pickleshell/runtime/node-v20.20.2/bin/node'
TERMINAL_NODE_EXECUTABLE='/usr/bin/node'
TUNNEL_CLIENT_EXECUTABLE='/usr/local/bin/tunnel-client'
TUNNEL_PROFILE='/etc/pickleshell/tunnel-client/pickleshell.yaml'
GATEWAY_ENV_FILE=''
MCP_ENV_FILE=''
INCLUDE_TERMINAL=0
NO_SYSTEMD=0
DRY_RUN=0
ROLLBACK=0
SYSTEMCTL=systemctl
UNITS_DIR=/etc/systemd/system
RESOLVED=''

while (($#)); do
  case "$1" in
    --profile)
      PROFILE=${2:-}
      case "$PROFILE" in
        production) ;;
        isolated)
          ROOT=${ROOT:-/opt/pickleshell-test}
          GATEWAY_USER=pickleshell-test; MCP_USER=pickleshell-test-tunnel; TERMINAL_USER=pickleshell-test-terminal
          GATEWAY_GROUP=pickleshell-test; MCP_GROUP=pickleshell-test-tunnel; TERMINAL_GROUP=pickleshell-test-terminal
          GATEWAY_SERVICE=pickleshell-test-gateway.service; MCP_SERVICE=pickleshell-test-tunnel.service; TERMINAL_SERVICE=pickleshell-test-terminal.service
          CONFIG_ROOT=/etc/pickleshell-test; STATE_ROOT=/var/lib/pickleshell-test; CACHE_ROOT=/var/cache/pickleshell-test
          WORKSPACE_ROOT=/srv/pickleshell-test/workspace; TERMINAL_WORKSPACE_ROOT=/srv/pickleshell-test/workspace
          MCP_RUNTIME_DIR=/run/pickleshell-test-mcp; TERMINAL_RUNTIME_DIR=/run/pickleshell-test-terminal
          MCP_BIND_SOURCE=/run/pickleshell-test-mcp; MCP_BIND_TARGET=/run/pickleshell-mcp
          MCP_TEMP_DIR=/var/lib/pickleshell-test/mcp-temp
          TERMINAL_SOCKET=/run/pickleshell-test-terminal/service.sock
          NODE_EXECUTABLE=/usr/bin/node
          TERMINAL_NODE_EXECUTABLE=/usr/bin/node
          TUNNEL_CLIENT_EXECUTABLE=/usr/local/bin/tunnel-client
          TUNNEL_PROFILE=/etc/pickleshell-test/tunnel-client/pickleshell-test.yaml
          ;;
        chatgpt)
          ROOT=${ROOT:-/opt/pickleshell}
          GATEWAY_USER=chatgpt; MCP_USER=pickleshell-chatgpt-tunnel; TERMINAL_USER=pickleshell-terminal
          GATEWAY_GROUP=chatgpt; MCP_GROUP=pickleshell-chatgpt-tunnel; TERMINAL_GROUP=pickleshell-terminal
          GATEWAY_SERVICE=pickleshell-gateway-chatgpt.service; MCP_SERVICE=pickleshell-tunnel-chatgpt.service
          STATE_ROOT=/var/lib/pickleshell-chatgpt; CACHE_ROOT=/var/cache/pickleshell-chatgpt
          WORKSPACE_ROOT=/home/chatgpt/workspace; TERMINAL_WORKSPACE_ROOT=/home/chatgpt/workspace
          MCP_RUNTIME_DIR=/run/pickleshell-chatgpt-mcp; MCP_BIND_SOURCE=/run/pickleshell-chatgpt-mcp
          MCP_TEMP_DIR=/var/lib/pickleshell-chatgpt/mcp-temp
          SETTINGS_ROOT=/var/lib/pickleshell-chatgpt-settings
          TUNNEL_PROFILE=/etc/pickleshell/tunnel-client/chatgpt.yaml
          ;;
        *) usage >&2; die 'profile must be production, isolated, or chatgpt' ;;
      esac
      shift 2 ;;
    --source) SOURCE=${2:-}; shift 2 ;;
    --root) ROOT=${2:-}; shift 2 ;;
    --commit) COMMIT=${2:-}; shift 2 ;;
    --gateway-user) GATEWAY_USER=${2:-}; shift 2 ;;
    --mcp-user) MCP_USER=${2:-}; shift 2 ;;
    --terminal-user) TERMINAL_USER=${2:-}; shift 2 ;;
    --gateway-group) GATEWAY_GROUP=${2:-}; shift 2 ;;
    --mcp-group) MCP_GROUP=${2:-}; shift 2 ;;
    --terminal-group) TERMINAL_GROUP=${2:-}; shift 2 ;;
    --config-root) CONFIG_ROOT=${2:-}; shift 2 ;;
    --state-root) STATE_ROOT=${2:-}; shift 2 ;;
    --cache-root) CACHE_ROOT=${2:-}; shift 2 ;;
    --workspace-root) WORKSPACE_ROOT=${2:-}; shift 2 ;;
    --terminal-workspace-root) TERMINAL_WORKSPACE_ROOT=${2:-}; shift 2 ;;
    --mcp-runtime-dir) MCP_RUNTIME_DIR=${2:-}; shift 2 ;;
    --mcp-bind-source) MCP_BIND_SOURCE=${2:-}; shift 2 ;;
    --mcp-bind-target) MCP_BIND_TARGET=${2:-}; shift 2 ;;
    --mcp-temp-dir) MCP_TEMP_DIR=${2:-}; shift 2 ;;
    --terminal-runtime-dir) TERMINAL_RUNTIME_DIR=${2:-}; shift 2 ;;
    --terminal-socket) TERMINAL_SOCKET=${2:-}; shift 2 ;;
    --node-executable) NODE_EXECUTABLE=${2:-}; shift 2 ;;
    --terminal-node-executable) TERMINAL_NODE_EXECUTABLE=${2:-}; shift 2 ;;
    --tunnel-client-executable) TUNNEL_CLIENT_EXECUTABLE=${2:-}; shift 2 ;;
    --tunnel-profile) TUNNEL_PROFILE=${2:-}; shift 2 ;;
    --gateway-env-file) GATEWAY_ENV_FILE=${2:-}; shift 2 ;;
    --mcp-env-file) MCP_ENV_FILE=${2:-}; shift 2 ;;
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

validate_path() {
  local value=$1 label=$2
  [[ $value = /* && $value != / && $value != /opt && $value != /etc && $value != /usr && $value != /var && $value != /srv && $value != /run && $value != /home ]] || die "$label must be a specific absolute path"
  [[ $value != *'..'* && $value != *[[:space:]@]* ]] || die "$label contains an unsafe path component"
  [[ $value != *[\;\|\&\$\(\)\<\>\\\"\'\`\*\?\[\]]* ]] || die "$label contains an unsafe character"
  if [[ $PROFILE == isolated ]]; then
    case "$label" in
      app-root) [[ $value == /opt/pickleshell-test || $value == /opt/pickleshell-test/* ]] || die "$label is outside the isolated prefix" ;;
      config-root) [[ $value == /etc/pickleshell-test || $value == /etc/pickleshell-test/* ]] || die "$label is outside the isolated prefix" ;;
      state-root) [[ $value == /var/lib/pickleshell-test || $value == /var/lib/pickleshell-test/* ]] || die "$label is outside the isolated prefix" ;;
      cache-root) [[ $value == /var/cache/pickleshell-test || $value == /var/cache/pickleshell-test/* ]] || die "$label is outside the isolated prefix" ;;
      workspace-root|terminal-workspace-root) [[ $value == /srv/pickleshell-test || $value == /srv/pickleshell-test/* ]] || die "$label is outside the isolated prefix" ;;
      mcp-runtime-dir|terminal-runtime-dir|terminal-socket) [[ $value == /run/pickleshell-test-* || $value == /run/pickleshell-test-*/* ]] || die "$label is outside the isolated prefix" ;;
    esac
  fi
}

validate_name() {
  local value=$1 label=$2
  [[ $value =~ ^[a-z_][a-z0-9_-]*$ && $value != root ]] || die "unsafe $label name"
}

validate_executable() {
  local value=$1 label=$2 resolved parent mode trusted_exact=0
  validate_path "$value" "$label"
  resolved=$(realpath -e -- "$value") || die "$label must resolve to an executable"
  [[ -f $resolved && -x $resolved && ! -L $resolved ]] || die "$label must resolve to a regular executable"
  case "$resolved" in
    /usr/bin/*|/usr/local/bin/*|/opt/pickleshell/runtime/*) ;;
    *) die "$label is outside the trusted executable locations" ;;
  esac
  case "$resolved" in
    /usr/bin/node|/usr/local/bin/tunnel-client|/opt/pickleshell/runtime/node-v20.20.2/bin/node) trusted_exact=1 ;;
  esac
  parent=$resolved
  while [[ $parent == */* ]]; do
    parent=$(dirname -- "$parent")
    [[ ! -L $parent ]] || die "$label has an unsafe symlinked parent"
    [[ -d $parent ]] || die "$label has an invalid parent"
    [[ $(stat -c '%u' -- "$parent") == 0 ]] || die "$label parent must be root-owned"
    mode=$(stat -c '%a' -- "$parent")
    (( trusted_exact || (8#$mode & 022) == 0 )) || die "$label parent is writable"
    [[ $parent == / ]] && break
  done
  [[ $(stat -c '%u' -- "$resolved") == 0 ]] || die "$label must be root-owned"
  mode=$(stat -c '%a' -- "$resolved")
  (( trusted_exact || (8#$mode & 022) == 0 )) || die "$label is writable"
}

validate_profile() {
  local value=$1 base
  validate_path "$value" tunnel-profile
  [[ $value == "$CONFIG_ROOT"/tunnel-client/* ]] || die 'tunnel profile must be under config root tunnel-client'
  base=${value##*/}
  [[ $base =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*\.yaml$ ]] || die 'tunnel profile must have a safe .yaml basename'
}

validate_path "$ROOT" app-root
validate_path "$CONFIG_ROOT" config-root
validate_path "$STATE_ROOT" state-root
validate_path "$CACHE_ROOT" cache-root
validate_path "$WORKSPACE_ROOT" workspace-root
validate_path "$TERMINAL_WORKSPACE_ROOT" terminal-workspace-root
validate_path "$MCP_RUNTIME_DIR" mcp-runtime-dir
validate_path "$MCP_BIND_SOURCE" mcp-bind-source
validate_path "$MCP_BIND_TARGET" mcp-bind-target
validate_path "$MCP_TEMP_DIR" mcp-temp-dir
validate_path "$TERMINAL_RUNTIME_DIR" terminal-runtime-dir
validate_path "$TERMINAL_SOCKET" terminal-socket
validate_path "$SETTINGS_ROOT" settings-root
GATEWAY_ENV_FILE=${GATEWAY_ENV_FILE:-$CONFIG_ROOT/gateway.env}
MCP_ENV_FILE=${MCP_ENV_FILE:-$CONFIG_ROOT/mcp.env}
if [[ $PROFILE == chatgpt ]]; then
  GATEWAY_ENV_FILE=/etc/pickleshell/gateway-chatgpt.env
  MCP_ENV_FILE=/etc/pickleshell/mcp-chatgpt.env
fi
validate_path "$GATEWAY_ENV_FILE" gateway-env-file
validate_path "$MCP_ENV_FILE" mcp-env-file
validate_executable "$NODE_EXECUTABLE" node-executable
validate_executable "$TERMINAL_NODE_EXECUTABLE" terminal-node-executable
validate_executable "$TUNNEL_CLIENT_EXECUTABLE" tunnel-client-executable
validate_profile "$TUNNEL_PROFILE"
[[ $MCP_RUNTIME_DIR == /run/* && $TERMINAL_RUNTIME_DIR == /run/* ]] || die 'runtime directories must be under /run'
[[ $MCP_RUNTIME_DIR =~ ^/run/[A-Za-z0-9_.-]+$ && $TERMINAL_RUNTIME_DIR =~ ^/run/[A-Za-z0-9_.-]+$ ]] || die 'runtime directories must be single safe names under /run'
[[ $MCP_BIND_SOURCE == "$MCP_RUNTIME_DIR" ]] || die 'MCP bind source must equal MCP runtime directory'
[[ $MCP_BIND_SOURCE =~ ^/run/[A-Za-z0-9_.-]+$ ]] || die 'MCP bind source must be a dedicated runtime directory'
[[ $MCP_BIND_TARGET == /run/pickleshell-mcp ]] || die 'MCP bind target must be /run/pickleshell-mcp'
[[ $MCP_TEMP_DIR == "$STATE_ROOT"/mcp-temp ]] || die 'MCP temp directory must be state-root/mcp-temp'
[[ $TERMINAL_SOCKET == "$TERMINAL_RUNTIME_DIR"/* ]] || die 'terminal socket must be under terminal runtime directory'
[[ $MCP_RUNTIME_DIR != "$TERMINAL_RUNTIME_DIR" ]] || die 'runtime directories must be distinct'
[[ $ROOT != "$CONFIG_ROOT" && $ROOT != "$STATE_ROOT" && $ROOT != "$CACHE_ROOT" && $ROOT != "$WORKSPACE_ROOT" ]] || die 'deployment roots must be distinct'
validate_name "$GATEWAY_USER" gateway-user; validate_name "$MCP_USER" mcp-user; validate_name "$TERMINAL_USER" terminal-user
validate_name "$GATEWAY_GROUP" gateway-group; validate_name "$MCP_GROUP" mcp-group; validate_name "$TERMINAL_GROUP" terminal-group
if [[ $PROFILE == isolated ]]; then
  [[ $GATEWAY_USER == pickleshell-test && $MCP_USER == pickleshell-test-tunnel && $TERMINAL_USER == pickleshell-test-terminal ]] || die 'isolated profile requires its dedicated service users'
  [[ $GATEWAY_GROUP == pickleshell-test && $MCP_GROUP == pickleshell-test-tunnel && $TERMINAL_GROUP == pickleshell-test-terminal ]] || die 'isolated profile requires its dedicated service groups'
fi

[[ $ROOT = /* ]] || die 'root must be an absolute path'
[[ $ROOT != / && $ROOT != /etc && $ROOT != /usr && $ROOT != /var && $ROOT != /home ]] || die 'root is too broad'
[[ $ROOT != */.. && $ROOT != */../* && $ROOT != *'/.' ]] || die 'root contains an unsafe path component'
[[ $SYSTEMCTL != */* || $SYSTEMCTL = /* ]] || die 'unsafe systemctl command path'
[[ $UNITS_DIR = /* && $UNITS_DIR != / && $UNITS_DIR != /etc && $UNITS_DIR != /usr ]] || die 'unsafe units directory'
[[ $UNITS_DIR != *'..'* && $UNITS_DIR != *[[:space:]@]* ]] || die 'unsafe units directory'
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
  [[ $name =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*\.service$ ]] || die "unsafe $label service name"
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
if [[ -e $ROOT ]]; then
  ROOT=$(realpath -e -- "$ROOT") || die 'cannot resolve root'
else
  root_parent=$(realpath -e -- "$(dirname -- "$ROOT")") || die 'root parent does not exist'
  [[ ! -L $root_parent ]] || die 'root parent must not be a symlink'
  ROOT=$root_parent/$(basename -- "$ROOT")
fi
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
RELEASE=''
WORK_RELEASE=''
[[ ! -e $RELEASES || ( ! -L $RELEASES && -d $RELEASES ) ]] || die 'releases path is not a real directory'
[[ ! -e $STATE || ( ! -L $STATE && -d $STATE ) ]] || die 'state path is not a real directory'
if ((ROLLBACK)); then
  [[ -d $RELEASES && ! -L $RELEASES ]] || die 'rollback releases directory is missing or unsafe'
else
  RELEASE="$RELEASES/$RESOLVED"
  WORK_RELEASE="$RELEASES/.staging-$RESOLVED-$$"
  if ((DRY_RUN)); then
    log "would stage $RESOLVED under $RELEASE and activate it"
    exit 0
  fi
  mkdir -p -- "$RELEASES" "$STATE"
  [[ ! -e $RELEASE || -L $RELEASE ]] || die 'release path exists and is not a directory'
  [[ ! -e $WORK_RELEASE || -L $WORK_RELEASE ]] || die 'staging path exists and is not a directory'
fi

cleanup_staging() {
  if [[ -d $WORK_RELEASE && ! -L $WORK_RELEASE ]]; then
    while IFS= read -r -d '' path; do
      chmod u+w -- "$path"
    done < <(find -P "$WORK_RELEASE" -type d -print0)
  fi
  rm -rf -- "$WORK_RELEASE"
}

trap cleanup_staging EXIT

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
  local build_env_root="$WORK_RELEASE/.build-env/$user"
  local isolated_home="$build_env_root/home"
  local isolated_tmp="$build_env_root/tmp"
  local isolated_cache="$build_env_root/npm-cache"
  [[ $(id -u) -eq 0 ]] || [[ $(id -un) == "$user" ]] || die "run as $user or root to build components"
  run mkdir -p -- "$isolated_home" "$isolated_tmp" "$isolated_cache"
  if [[ $(id -u) -eq 0 ]]; then
    run chown -hR -- "$user" "$build_env_root"
  fi
  run chmod 0700 -- "$build_env_root" "$isolated_home" "$isolated_tmp" "$isolated_cache"
  if [[ $(id -u) -eq 0 ]]; then
    run runuser -u "$user" -- env \
      PATH="$PATH" \
      HOME="$isolated_home" \
      TMPDIR="$isolated_tmp" \
      NPM_CONFIG_CACHE="$isolated_cache" \
      "$@"
  else
    run env \
      PATH="$PATH" \
      HOME="$isolated_home" \
      TMPDIR="$isolated_tmp" \
      NPM_CONFIG_CACHE="$isolated_cache" \
      "$@"
  fi
}

required_files() {
  local component=$1
  [[ -f $WORK_RELEASE/$component/package.json && -f $WORK_RELEASE/$component/package-lock.json ]] || die "missing $component package files"
}

stage() {
  log "staging commit $RESOLVED"
  mkdir -p -- "$WORK_RELEASE"
  run git -C "$SOURCE" archive --format=tar "$RESOLVED" 'deploy/systemd' 'gateway' 'mcp-server' 'terminal' | run tar -xf - -C "$WORK_RELEASE"
  [[ -f $WORK_RELEASE/gateway/package.json && -f $WORK_RELEASE/mcp-server/package.json && -f $WORK_RELEASE/terminal/package.json ]] || die 'archive is missing a required component'
  while IFS= read -r -d '' path; do
    validate_release_symlink "$path"
  done < <(find -P "$WORK_RELEASE" -type l -print0)
  printf '%s\n' "$RESOLVED" > "$WORK_RELEASE/.release-sha"
  [[ $(<"$WORK_RELEASE/.release-sha") == "$RESOLVED" ]] || die 'staged SHA does not match requested commit'
}

validate_release_symlink() {
  local link=$1 target resolved component component_root
  target=$(readlink -- "$link") || die 'could not read release symbolic link'
  [[ $target != /* ]] || die 'release contains an absolute symbolic link'

  component=${link#"$WORK_RELEASE"/}
  component=${component%%/*}
  case "$component" in
    gateway|mcp-server|terminal) ;;
    *) die 'release symbolic link is outside a component' ;;
  esac
  component_root="$WORK_RELEASE/$component"
  resolved=$(realpath -e -- "$link") || die 'release contains a broken or cyclic symbolic link'
  [[ $resolved == "$component_root"/* ]] || die 'release symbolic link escapes its component'
}

component_user_group() {
  case "$1" in
    gateway) printf '%s:%s' "$GATEWAY_USER" "$GATEWAY_GROUP" ;;
    mcp-server) printf '%s:%s' "$MCP_USER" "$MCP_GROUP" ;;
    terminal) printf '%s:%s' "$TERMINAL_USER" "$TERMINAL_GROUP" ;;
    *) die "unknown component: $1" ;;
  esac
}

prepare_component() {
  local component=$1 directory="$WORK_RELEASE/$1" owner
  [[ -d $directory && ! -L $directory ]] || die "component directory is unsafe: $component"
  owner=$(component_user_group "$component")
  run chown -h -- "$owner" "$directory"
  run chmod u+rwx -- "$directory"
}

harden_release() {
  local component path mode
  if [[ $(id -u) -eq 0 ]]; then
    for component in gateway mcp-server terminal; do
      path="$WORK_RELEASE/$component"
      [[ -d $path && ! -L $path ]] || die "component directory is unsafe: $component"
      run chown -h -- root:root "$path"
    done
  fi
  while IFS= read -r -d '' path; do
    if [[ -L $path ]]; then
      validate_release_symlink "$path"
      if [[ $(id -u) -eq 0 ]]; then
        run chown -h -- root:root "$path"
      fi
      continue
    fi
    if [[ -d $path ]]; then
      run chmod 0555 -- "$path"
    else
      mode=$(stat -c '%a' -- "$path")
      if ((8#$mode & 0111)); then
        run chmod 0555 -- "$path"
      else
        run chmod 0444 -- "$path"
      fi
    fi
    if [[ $(id -u) -eq 0 ]]; then
      run chown -h -- root:root "$path"
    fi
  done < <(find -P "$WORK_RELEASE" -xdev -depth -print0)
}

build() {
  log 'building Gateway, MCP, and Terminal in the staged release'
  required_files gateway; required_files mcp-server; required_files terminal
  prepare_component gateway
  prepare_component mcp-server
  prepare_component terminal
  as_user "$GATEWAY_USER" npm --prefix "$WORK_RELEASE/gateway" ci --omit=dev
  as_user "$MCP_USER" npm --prefix "$WORK_RELEASE/mcp-server" ci
  as_user "$MCP_USER" npm --prefix "$WORK_RELEASE/mcp-server" run build
  as_user "$TERMINAL_USER" npm --prefix "$WORK_RELEASE/terminal" ci
  as_user "$TERMINAL_USER" npm --prefix "$WORK_RELEASE/terminal" run build
  [[ -f $WORK_RELEASE/mcp-server/dist/index.js && -x $WORK_RELEASE/terminal/bin/cgroup-launcher ]] || die 'component build did not produce required files'
  rm -rf -- "$WORK_RELEASE/.build-env"
  harden_release
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

render_unit() {
  local component=$1 template=$2 contents token value
  contents=$(<"$template")
  for token in APP_ROOT ACTIVE_ROOT CONFIG_ROOT STATE_ROOT CACHE_ROOT WORKSPACE_ROOT \
    TERMINAL_WORKSPACE_ROOT TERMINAL_WORKSPACE_BIND_TARGET \
    NODE_BIN_DIR NODE_EXECUTABLE TERMINAL_NODE_EXECUTABLE TUNNEL_CLIENT_EXECUTABLE GATEWAY_USER GATEWAY_GROUP \
    MCP_USER MCP_GROUP TERMINAL_USER TERMINAL_GROUP GATEWAY_SERVICE MCP_RUNTIME_NAME \
    MCP_BIND_SOURCE MCP_BIND_TARGET MCP_TEMP_DIR TUNNEL_PROFILE GATEWAY_ENV_FILE MCP_ENV_FILE SETTINGS_ROOT \
    TERMINAL_RUNTIME_NAME TERMINAL_RUNTIME_DIR TERMINAL_SOCKET; do
    case "$token" in
      APP_ROOT) value=$ROOT; ACTIVE_ROOT="$ROOT/active" ;;
      ACTIVE_ROOT) value=$ACTIVE_ROOT ;;
      CONFIG_ROOT) value=$CONFIG_ROOT ;;
      STATE_ROOT) value=$STATE_ROOT ;;
      CACHE_ROOT) value=$CACHE_ROOT ;;
      WORKSPACE_ROOT) value=$WORKSPACE_ROOT ;;
      TERMINAL_WORKSPACE_ROOT) value=$TERMINAL_WORKSPACE_ROOT ;;
      TERMINAL_WORKSPACE_BIND_TARGET) value=$TERMINAL_RUNTIME_DIR/workspace ;;
      NODE_BIN_DIR) value=$NODE_BIN_DIR ;;
      NODE_EXECUTABLE) value=$NODE_EXECUTABLE ;;
      TERMINAL_NODE_EXECUTABLE) value=$TERMINAL_NODE_EXECUTABLE ;;
      TUNNEL_CLIENT_EXECUTABLE) value=$TUNNEL_CLIENT_EXECUTABLE ;;
      GATEWAY_USER) value=$GATEWAY_USER ;;
      GATEWAY_GROUP) value=$GATEWAY_GROUP ;;
      MCP_USER) value=$MCP_USER ;;
      MCP_GROUP) value=$MCP_GROUP ;;
      TERMINAL_USER) value=$TERMINAL_USER ;;
      TERMINAL_GROUP) value=$TERMINAL_GROUP ;;
      GATEWAY_SERVICE) value=$GATEWAY_SERVICE ;;
      MCP_RUNTIME_NAME) value=${MCP_RUNTIME_DIR#/run/} ;;
      MCP_BIND_SOURCE) value=$MCP_BIND_SOURCE ;;
      MCP_BIND_TARGET) value=$MCP_BIND_TARGET ;;
      MCP_TEMP_DIR) value=$MCP_TEMP_DIR ;;
      TUNNEL_PROFILE) value=$TUNNEL_PROFILE ;;
      GATEWAY_ENV_FILE) value=$GATEWAY_ENV_FILE ;;
      MCP_ENV_FILE) value=$MCP_ENV_FILE ;;
      SETTINGS_ROOT) value=$SETTINGS_ROOT ;;
      TERMINAL_RUNTIME_NAME) value=${TERMINAL_RUNTIME_DIR#/run/} ;;
      TERMINAL_RUNTIME_DIR) value=$TERMINAL_RUNTIME_DIR ;;
      TERMINAL_SOCKET) value=$TERMINAL_SOCKET ;;
    esac
    contents=${contents//"@$token@"/"$value"}
  done
  [[ $contents != *'@'* ]] || die "unresolved placeholder in $component unit"
  if [[ $PROFILE == isolated ]]; then
    [[ $contents != *'/opt/pickleshell/'* && $contents != *'/etc/pickleshell/'* && $contents != *'/var/lib/pickleshell/'* && $contents != *'/var/cache/pickleshell/'* && $contents != *'/srv/pickleshell/'* && $contents != *$'\nUser=pickleshell\n'* && $contents != *$'\nUser=pickleshell-tunnel\n'* && $contents != *$'\nUser=pickleshell-terminal\n'* && $contents != *$'\nGroup=pickleshell\n'* && $contents != *$'\nGroup=pickleshell-tunnel\n'* && $contents != *$'\nGroup=pickleshell-terminal\n'* && $contents != *'pickleshell-gateway.service'* ]] || die "production value leaked into isolated $component unit"
  fi
  printf '%s\n' "$contents"
}

install_units() {
  ((NO_SYSTEMD)) && return 0
  [[ $(id -u) -eq 0 || $SYSTEMCTL != systemctl ]] || die 'systemd installation requires root'
  for group in "$GATEWAY_GROUP" "$MCP_GROUP" "$TERMINAL_GROUP"; do
    getent group "$group" >/dev/null 2>&1 || die "service group does not exist: $group"
  done
  local backup_dir=$STATE/unit-backups
  [[ ! -e $backup_dir || ! -L $backup_dir ]] || die 'unit backup directory is a symlink'
  mkdir -m 0700 -p -- "$backup_dir"
  chmod 0700 -- "$backup_dir"
  [[ -d $backup_dir && ! -L $backup_dir ]] || die 'unit backup directory is unsafe'
  local component unit source_unit target
  NODE_BIN_DIR=$(dirname -- "$NODE_EXECUTABLE")
  for component in gateway mcp; do
    unit=$(unit_for "$component")
    [[ $component == gateway ]] && source_unit=$RELEASE/deploy/systemd/pickleshell-gateway.service.in || source_unit=$RELEASE/deploy/systemd/pickleshell-tunnel.service.in
    [[ -f $source_unit && ! -L $source_unit ]] || { log "missing unit file for $component" >&2; return 1; }
    local unit_contents
    unit_contents=$(render_unit "$component" "$source_unit")
    target=$UNITS_DIR/$unit
    [[ ! -L $target ]] || die "unit path is a symlink: $unit"
    [[ ! -e $target || -f $target ]] || die "unit path is not a regular file: $unit"
    if [[ -e $target ]]; then
      [[ ! -L $backup_dir/$unit ]] || die "unit backup path is a symlink: $unit"
      run install -m 0600 -- "$target" "$backup_dir/$unit" || return 1
    else
      [[ ! -L $backup_dir/$unit ]] || die "unit backup path is a symlink: $unit"
      run rm -f -- "$backup_dir/$unit" || return 1
    fi
    printf '%s\n' "$unit_contents" | run install -m 0644 /dev/stdin "$target" || return 1
  done
  if ((INCLUDE_TERMINAL)); then
    unit=$(unit_for terminal)
    source_unit=$RELEASE/deploy/systemd/pickleshell-terminal.service.in
    [[ -f $source_unit && ! -L $source_unit ]] || { log 'missing unit file for terminal' >&2; return 1; }
    local unit_contents
    unit_contents=$(render_unit terminal "$source_unit")
    target=$UNITS_DIR/$unit
    [[ ! -L $target ]] || die "unit path is a symlink: $unit"
    [[ ! -e $target || -f $target ]] || die "unit path is not a regular file: $unit"
    if [[ -e $target ]]; then
      [[ ! -L $backup_dir/$unit ]] || die "unit backup path is a symlink: $unit"
      run install -m 0600 -- "$target" "$backup_dir/$unit" || return 1
    else
      [[ ! -L $backup_dir/$unit ]] || die "unit backup path is a symlink: $unit"
      run rm -f -- "$backup_dir/$unit" || return 1
    fi
    printf '%s\n' "$unit_contents" | run install -m 0644 /dev/stdin "$target" || return 1
  fi
  run "$SYSTEMCTL" daemon-reload || return 1
}

is_real_systemctl() {
  [[ ${SYSTEMCTL##*/} == systemctl ]]
}

prepare_service_dir() {
  local path=$1 owner=$2 mode=$3
  run mkdir -p -- "$path" || return 1
  [[ -d $path && ! -L $path ]] || die "service path is unsafe: $path"
  if [[ $(id -u) -eq 0 ]]; then
    run chown -h -- "$owner" "$path" || return 1
  fi
  run chmod "$mode" -- "$path" || return 1
}

prepare_terminal_workspace_acl() {
  command -v setfacl >/dev/null && command -v getfacl >/dev/null || die 'setfacl and getfacl are required to grant terminal workspace access'
  [[ -d $TERMINAL_WORKSPACE_ROOT && ! -L $TERMINAL_WORKSPACE_ROOT ]] || die "service path is unsafe: $TERMINAL_WORKSPACE_ROOT"
  run setfacl -R -P -m "u:$TERMINAL_USER:rwX" -- "$TERMINAL_WORKSPACE_ROOT" || return 1
  while IFS= read -r -d '' path; do
    run setfacl -m "d:u:$TERMINAL_USER:rwX" -- "$path" || return 1
  done < <(find -P "$TERMINAL_WORKSPACE_ROOT" -type d -print0)
  getfacl -cp -- "$TERMINAL_WORKSPACE_ROOT" | grep -Eq "^user:$TERMINAL_USER:rwx$" || die 'terminal workspace ACL verification failed'
}

prepare_service_paths() {
  ((NO_SYSTEMD)) && return 0
  is_real_systemctl || return 0
  prepare_service_dir "$SETTINGS_ROOT" "$GATEWAY_USER:$GATEWAY_GROUP" 0700 || return 1
  prepare_service_dir "$STATE_ROOT/agent-home" "$GATEWAY_USER:$GATEWAY_GROUP" 0700 || return 1
  prepare_service_dir "$STATE_ROOT/config/opencode" "$GATEWAY_USER:$GATEWAY_GROUP" 0700 || return 1
  prepare_service_dir "$STATE_ROOT/data/opencode" "$GATEWAY_USER:$GATEWAY_GROUP" 0700 || return 1
  prepare_service_dir "$STATE_ROOT/state/opencode" "$GATEWAY_USER:$GATEWAY_GROUP" 0700 || return 1
  prepare_service_dir "$CACHE_ROOT/opencode" "$GATEWAY_USER:$GATEWAY_GROUP" 0700 || return 1
  prepare_service_dir "$CACHE_ROOT/npm" "$GATEWAY_USER:$GATEWAY_GROUP" 0700 || return 1
  prepare_service_dir "$WORKSPACE_ROOT" "$GATEWAY_USER:$GATEWAY_GROUP" 0700 || return 1
  prepare_service_dir "$STATE_ROOT/mcp-home" "$MCP_USER:$MCP_GROUP" 0700 || return 1
  prepare_service_dir "$CACHE_ROOT/mcp" "$MCP_USER:$MCP_GROUP" 0700 || return 1
  prepare_service_dir "$CACHE_ROOT/ms-playwright" "$MCP_USER:$MCP_GROUP" 0700 || return 1
  # MCP owns the staging directory. Gateway gets the MCP group only as a
  # supplementary group, with traverse/read access to random request dirs and
  # staged files but no ability to list, create, replace, or remove them.
  prepare_service_dir "$MCP_TEMP_DIR" "$MCP_USER:$MCP_GROUP" 0710 || return 1
  prepare_service_dir "$MCP_BIND_SOURCE" "$MCP_USER:$MCP_GROUP" 0700 || return 1
  prepare_service_dir "$TERMINAL_RUNTIME_DIR" "$TERMINAL_USER:$TERMINAL_GROUP" 0750 || return 1
  prepare_service_dir "$TERMINAL_RUNTIME_DIR/workspace" "$TERMINAL_USER:$TERMINAL_GROUP" 0750 || return 1
  [[ -d $TERMINAL_WORKSPACE_ROOT && ! -L $TERMINAL_WORKSPACE_ROOT ]] || die "service path is unsafe: $TERMINAL_WORKSPACE_ROOT"
  prepare_terminal_workspace_acl || return 1
}

restore_units() {
  ((NO_SYSTEMD)) && return 0
  local backup_dir=$STATE/unit-backups
  [[ ! -L $backup_dir ]] || die 'unit backup directory is a symlink'
  local component unit backup target
  for component in gateway mcp; do
    unit=$(unit_for "$component")
    backup=$backup_dir/$unit
    target=$UNITS_DIR/$unit
    [[ ! -L $target ]] || die "unit path is a symlink: $unit"
    [[ ! -L $backup ]] || die "unit backup path is a symlink: $unit"
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
    [[ ! -L $target ]] || die "unit path is a symlink: $unit"
    [[ ! -L $backup ]] || die "unit backup path is a symlink: $unit"
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
  atomic_switch "releases/$RESOLVED" "$previous"
  [[ $(<"$RELEASE/.release-sha") == "$RESOLVED" ]] || die 'release SHA verification failed'
}

atomic_switch() {
  local target=$1 previous=$2
  printf '%s\n' "$previous" > "$STATE/previous-target"
  printf '%s\n' "$target" > "$STATE/current-target"
  local tmp="$ROOT/.active.new.$$"
  rm -f -- "$tmp"
  ln -s -- "$target" "$tmp"
  mv -Tf -- "$tmp" "$ACTIVE"
  [[ $(active_target) == "$target" ]] || die 'atomic active switch verification failed'
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
    printf '' > "$STATE/current-target"
    printf '' > "$STATE/previous-target"
  else
    [[ $previous == releases/* && $previous != *'..'* && -d $ROOT/$previous && ! -L $ROOT/$previous ]] || die 'recorded rollback target is unsafe or missing'
    atomic_switch "$previous" ''
  fi
  restore_units || die 'could not restore unit files'
  ((NO_SYSTEMD)) && return 0
  service_action restart "$(unit_for gateway)" || true
  service_action restart "$(unit_for mcp)" || true
  ((INCLUDE_TERMINAL)) && service_action restart "$(unit_for terminal)" || true
}

rollback() {
  local current previous active
  [[ -f $STATE/current-target && ! -L $STATE/current-target ]] || die 'no recorded current target'
  [[ -f $STATE/previous-target && ! -L $STATE/previous-target ]] || die 'no recorded previous target'
  current=$(<"$STATE/current-target")
  previous=$(<"$STATE/previous-target")
  [[ $current == releases/* && $current != *'..'* ]] || die 'recorded current target is unsafe'
  [[ -n $previous ]] || die 'no recorded previous release; first activation rollback requires manual backup restore'
  [[ $previous == releases/* && $previous != *'..'* ]] || die 'recorded rollback target is unsafe'
  [[ -d $ROOT/$current && ! -L $ROOT/$current ]] || die 'recorded current target is unsafe or missing'
  [[ -d $ROOT/$previous && ! -L $ROOT/$previous ]] || die 'recorded rollback target is unsafe or missing'
  [[ $(<"$ROOT/$current/.release-sha") == "${current#releases/}" ]] || die 'recorded current release is invalid'
  [[ $(<"$ROOT/$previous/.release-sha") == "${previous#releases/}" ]] || die 'recorded rollback release is invalid'
  active=$(active_target) || die 'active release is missing or unsafe'
  [[ $active == "$current" ]] || die 'active release does not match recorded current target'

  RELEASE="$ROOT/$previous"
  if ! install_units; then
    restore_units || true
    die 'unit installation failed during rollback'
  fi
  atomic_switch "$previous" "$current"
  if ! prepare_service_paths || ! restart_and_verify; then
    log 'rollback service verification failed; restoring previous release'
    restore_units || true
    atomic_switch "$current" "$previous"
    die 'rollback failed'
  fi
  log "rolled back to $(active_target)"
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
if ! prepare_service_paths || ! restart_and_verify; then
  log 'activation or service verification failed; restoring previous release'
  restore_previous
  die 'activation failed'
fi
log "active release: $(active_target)"
