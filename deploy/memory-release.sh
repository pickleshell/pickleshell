#!/usr/bin/env bash
set -Eeuo pipefail

die() { printf 'memory-release: error: %s\n' "$1" >&2; exit 1; }
usage() { printf '%s\n' 'Usage: memory-release.sh --source REPO --root ROOT --commit FULL_SHA [options] [--rollback]'; }

SOURCE=''; ROOT='/opt/pickleshell-memory'; COMMIT=''; PROFILE=production
CONFIG_ROOT='/etc/pickleshell-memory'; STATE_ROOT='/var/lib/pickleshell-memory'; LOG_ROOT='/var/log/pickleshell-memory'
UNITS_DIR='/etc/systemd/system'; LOGROTATE_DIR='/etc/logrotate.d'; WRAPPER_DIR='/usr/local/libexec'
SERVICE_USER='pickleshell-memory'; SERVICE_GROUP='pickleshell-memory'; SERVICE='pickleshell-memory-backend.service'
NODE_EXECUTABLE='/usr/bin/node'; BACKEND_EXECUTABLE='/usr/local/bin/pickleshell-memory-backend'; SYSTEMCTL=systemctl; ROLLBACK=0
PYTHON_EXECUTABLE='/usr/bin/python3.12'; MANAGED_BACKEND=1
ISOLATED_ROOT_SET=0; ISOLATED_CONFIG_SET=0; ISOLATED_STATE_SET=0; ISOLATED_LOG_SET=0
ISOLATED_UNITS_SET=0; ISOLATED_LOGROTATE_SET=0; ISOLATED_WRAPPER_SET=0
ISOLATED_USER_SET=0; ISOLATED_GROUP_SET=0; ISOLATED_SERVICE_SET=0
ISOLATED_BACKEND_SET=0; ISOLATED_SYSTEMCTL_SET=0
while (($#)); do case "$1" in
  --source) SOURCE=${2:-}; shift 2;; --root) ROOT=${2:-}; ISOLATED_ROOT_SET=1; shift 2;; --commit) COMMIT=${2:-}; shift 2;;
  --profile) PROFILE=${2:-}; shift 2;; --config-root) CONFIG_ROOT=${2:-}; ISOLATED_CONFIG_SET=1; shift 2;; --state-root) STATE_ROOT=${2:-}; ISOLATED_STATE_SET=1; shift 2;;
  --log-root) LOG_ROOT=${2:-}; ISOLATED_LOG_SET=1; shift 2;; --units-dir) UNITS_DIR=${2:-}; ISOLATED_UNITS_SET=1; shift 2;; --logrotate-dir) LOGROTATE_DIR=${2:-}; ISOLATED_LOGROTATE_SET=1; shift 2;;
  --wrapper-dir) WRAPPER_DIR=${2:-}; ISOLATED_WRAPPER_SET=1; shift 2;; --service-user) SERVICE_USER=${2:-}; ISOLATED_USER_SET=1; shift 2;; --service-group) SERVICE_GROUP=${2:-}; ISOLATED_GROUP_SET=1; shift 2;;
  --service) SERVICE=${2:-}; ISOLATED_SERVICE_SET=1; shift 2;; --node-executable) NODE_EXECUTABLE=${2:-}; shift 2;;
  --python-executable) PYTHON_EXECUTABLE=${2:-}; shift 2;;
  --backend-executable) BACKEND_EXECUTABLE=${2:-}; MANAGED_BACKEND=0; ISOLATED_BACKEND_SET=1; shift 2;;
  --managed-backend-executable) BACKEND_EXECUTABLE=${2:-}; MANAGED_BACKEND=1; ISOLATED_BACKEND_SET=1; shift 2;;
  --systemctl) SYSTEMCTL=${2:-}; ISOLATED_SYSTEMCTL_SET=1; shift 2;; --rollback) ROLLBACK=1; shift;;
  -h|--help) usage; exit 0;; *) usage >&2; die "unknown option: $1";; esac done
[[ $PROFILE == production || $PROFILE == isolated ]] || die 'profile must be production or isolated'
if [[ $PROFILE == isolated ]]; then
  ((ISOLATED_ROOT_SET && ISOLATED_CONFIG_SET && ISOLATED_STATE_SET && ISOLATED_LOG_SET && ISOLATED_UNITS_SET && ISOLATED_LOGROTATE_SET && ISOLATED_WRAPPER_SET && ISOLATED_USER_SET && ISOLATED_GROUP_SET && ISOLATED_SERVICE_SET && ISOLATED_BACKEND_SET && ISOLATED_SYSTEMCTL_SET)) || die 'isolated profile requires explicit dedicated deployment paths and service identity'
  ISOLATED_PREFIX=${ROOT%/*}
  [[ -n $ISOLATED_PREFIX && $ISOLATED_PREFIX != / && $ISOLATED_PREFIX != /opt && $ISOLATED_PREFIX != /etc && $ISOLATED_PREFIX != /var && $ISOLATED_PREFIX != /usr ]] || die 'isolated root must use a dedicated prefix'
  for path in "$ROOT" "$CONFIG_ROOT" "$STATE_ROOT" "$LOG_ROOT" "$UNITS_DIR" "$LOGROTATE_DIR" "$WRAPPER_DIR" "$BACKEND_EXECUTABLE" "$SYSTEMCTL"; do
    [[ $path == "$ISOLATED_PREFIX"/* ]] || die 'isolated deployment paths must share the dedicated root prefix'
  done
  [[ $SERVICE_USER != pickleshell-memory && $SERVICE_GROUP != pickleshell-memory && $SERVICE != pickleshell-memory-backend.service ]] || die 'isolated profile rejects production service identity'
fi
safe_path() { [[ $1 = /* && $1 != / && $1 != /etc && $1 != /opt && $1 != /var && $1 != /usr && $1 != /home && $1 != *'..'* && $1 != *[[:space:]@]* && $1 != *[\;\|\&\$\(\)\<\>\\\"\'\`\*\?\[\]]* ]] || die "$2 is unsafe"; }
for pair in "$ROOT:root" "$CONFIG_ROOT:config root" "$STATE_ROOT:state root" "$LOG_ROOT:log root" "$UNITS_DIR:units directory" "$LOGROTATE_DIR:logrotate directory" "$WRAPPER_DIR:wrapper directory" "$NODE_EXECUTABLE:node executable" "$PYTHON_EXECUTABLE:python executable" "$BACKEND_EXECUTABLE:backend executable"; do safe_path "${pair%%:*}" "${pair#*:}"; done
validate_no_symlink_components() {
  local path=$1 component current=''
  local -a components
  IFS=/ read -r -a components <<< "${path#/}"
  for component in "${components[@]}"; do
    [[ -n $component ]] || continue
    current="$current/$component"
    [[ ! -L $current ]] || die "configured deployment path has a symlink component: $path"
  done
}
for path in "$ROOT" "$CONFIG_ROOT" "$STATE_ROOT" "$LOG_ROOT" "$UNITS_DIR" "$LOGROTATE_DIR" "$WRAPPER_DIR" "$NODE_EXECUTABLE" "$PYTHON_EXECUTABLE" "$BACKEND_EXECUTABLE"; do validate_no_symlink_components "$path"; done
[[ $SERVICE_USER =~ ^[a-z_][a-z0-9_-]*$ && $SERVICE_GROUP =~ ^[a-z_][a-z0-9_-]*$ && $SERVICE_USER != root ]] || die 'unsafe service identity'
[[ $SERVICE =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*\.service$ && $SERVICE != *..* ]] || die 'unsafe service name'
service_uid=$(id -u "$SERVICE_USER") || die 'service user does not exist'
service_gid=$(getent group "$SERVICE_GROUP" | cut -d: -f3); [[ -n $service_gid ]] || die 'service group does not exist'
validate_operator_config_path() {
  local path=$CONFIG_ROOT component current='' owner group mode mode_value operator_uid acl
  local -a components service_gids
  operator_uid=$(id -u)
  read -r -a service_gids <<< "$(id -G "$SERVICE_USER")"
  [[ " ${service_gids[*]} " == *" $service_gid "* ]] || service_gids+=("$service_gid")
  ACL_INSPECTOR=$(command -v getfacl) || die 'cannot inspect operator config ACLs'
  [[ $ACL_INSPECTOR = /* && -f $ACL_INSPECTOR && -x $ACL_INSPECTOR && ! -L $ACL_INSPECTOR ]] ||
    die 'cannot inspect operator config ACLs'
  IFS=/ read -r -a components <<< "${path#/}"
  components=("" "${components[@]}")
  for component in "${components[@]}"; do
    if [[ -z $component ]]; then current=/; else current="${current%/}/$component"; fi
    [[ -e $current ]] || break
    read -r owner group mode < <(stat -c '%u %g %a' -- "$current") || die 'cannot inspect operator config path'
    mode_value=$((8#$mode))
    [[ $owner == 0 || $owner == "$operator_uid" ]] || die 'operator config path has an untrusted owner'
    if [[ $owner == "$service_uid" ]] && ((mode_value & 0200)); then
      die 'operator config path is writable by the service identity'
    fi
    if ((mode_value & 0020)) && [[ " ${service_gids[*]} " == *" $group "* ]]; then
      die 'operator config path is writable by the service identity'
    fi
    ((!(mode_value & 0002))) || die 'operator config path is writable by the service identity'
    [[ $owner != "$service_uid" ]] || die 'operator config path has an untrusted owner'
    acl=$("$ACL_INSPECTOR" -cpnEP -- "$current") || die 'cannot inspect operator config ACLs'
    operator_config_acl_allows_service_write "$acl" "$owner" "$group" "${service_gids[*]}" &&
      die 'operator config path is writable by the service identity'
  done
  return 0
}
operator_config_acl_allows_service_write() {
  local acl=$1 owner=$2 owning_group=$3 gids=$4 line entry scope kind qualifier perms extra
  local access_mask=rwx default_mask=rwx applies=0 mask
  while IFS= read -r line; do
    [[ -n $line ]] || continue
    case $line in
      mask::[r-][w-][x-]) access_mask=${line#mask::} ;;
      default:mask::[r-][w-][x-]) default_mask=${line#default:mask::} ;;
    esac
  done <<< "$acl"
  while IFS= read -r line; do
    [[ -n $line ]] || continue
    scope=access; entry=$line
    if [[ $entry == default:* ]]; then scope=default; entry=${entry#default:}; fi
    IFS=: read -r kind qualifier perms extra <<< "$entry"
    [[ -z ${extra:-} && $perms == [r-][w-][x-] ]] || die 'cannot inspect operator config ACLs'
    case $kind:$qualifier in
      mask:|user:|group:|other:) ;;
      user:[0-9]*|group:[0-9]*) [[ $qualifier =~ ^[0-9]+$ ]] || die 'cannot inspect operator config ACLs' ;;
      *) die 'cannot inspect operator config ACLs' ;;
    esac
    [[ $kind != mask ]] || continue
    applies=0
    case $kind:$qualifier in
      user:) [[ $owner == "$service_uid" ]] && applies=1 ;;
      user:*) [[ $qualifier == "$service_uid" ]] && applies=1 ;;
      group:) [[ " $gids " == *" $owning_group "* ]] && applies=1 ;;
      group:*) [[ " $gids " == *" $qualifier "* ]] && applies=1 ;;
      other:) applies=1 ;;
    esac
    ((applies)) || continue
    [[ $perms == *w* ]] || continue
    if [[ $kind == user && -z $qualifier || $kind == other ]]; then return 0; fi
    [[ $scope == access ]] && mask=$access_mask || mask=$default_mask
    [[ $mask != *w* ]] || return 0
  done <<< "$acl"
  return 1
}
if [[ $PROFILE == production ]]; then validate_operator_config_path; fi
for path in "$ROOT" "$CONFIG_ROOT" "$STATE_ROOT" "$LOG_ROOT" "$UNITS_DIR" "$LOGROTATE_DIR" "$WRAPPER_DIR"; do [[ ! -L $path ]] || die "sensitive path is a symlink: $path"; done
RELEASES="$ROOT/releases"; ACTIVE="$ROOT/active"; DEPLOY_STATE="$ROOT/state"
validate_internal_paths() {
  local path label
  for path in "$RELEASES" "$DEPLOY_STATE"; do
    [[ $path == "$RELEASES" ]] && label=releases || label=state
    [[ ! -L $path && ( ! -e $path || -d $path ) ]] || die "unsafe internal deployment path: $label"
  done
  for path in "$DEPLOY_STATE/current-target" "$DEPLOY_STATE/previous-target"; do
    label=${path##*/}
    [[ ! -L $path && ( ! -e $path || -f $path ) ]] || die "unsafe internal deployment path: $label"
  done
}
ensure_internal_directory() {
  local path=$1 label=$2
  if [[ ! -e $path && ! -L $path ]]; then mkdir -- "$path" || die "cannot create internal deployment path: $label"; fi
  [[ -d $path && ! -L $path ]] || die "unsafe internal deployment path: $label"
}
managed_release_target() {
  local target=$1 label=$2 sha path marker
  [[ $target =~ ^releases/[0-9a-f]{40}$ ]] || die "managed release target is unsafe: $label"
  sha=${target#releases/}; path="$RELEASES/$sha"; marker="$path/.release-sha"
  [[ -d $path && ! -L $path ]] || die "managed release target is unsafe: $label"
  [[ -f $marker && ! -L $marker && $(stat -c %s "$marker") == 41 && $(<"$marker") == "$sha" ]] ||
    die "managed release target is unsafe: $label"
  printf '%s' "$target"
}
optional_managed_release_target() {
  if [[ -z $1 ]]; then printf ''; else managed_release_target "$1" "$2"; fi
}
active_target() { [[ -L $ACTIVE ]] || return 1; local target; target=$(readlink -- "$ACTIVE") || die 'active target is unsafe'; managed_release_target "$target" active; }
prevalidate_rollback() {
  local current_value previous_value
  validate_internal_paths
  current_value=$(<"$DEPLOY_STATE/current-target") || die 'current target is missing'
  previous_value=$(<"$DEPLOY_STATE/previous-target") || die 'previous target is missing'
  current=$(managed_release_target "$current_value" current)
  previous=$(managed_release_target "$previous_value" previous)
  [[ $(active_target) == "$current" ]] || die 'rollback target is unavailable or inconsistent'
}
validate_internal_paths
[[ -f $NODE_EXECUTABLE && -x $NODE_EXECUTABLE && ! -L $NODE_EXECUTABLE ]] || die 'node executable must be a regular executable'
if ((MANAGED_BACKEND)); then
  [[ -f $PYTHON_EXECUTABLE && -x $PYTHON_EXECUTABLE && ! -L $PYTHON_EXECUTABLE ]] || die 'python executable must be a regular executable'
  "$PYTHON_EXECUTABLE" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' || die 'python executable must be version 3.11 or newer'
  [[ ! -L $BACKEND_EXECUTABLE && ( ! -e $BACKEND_EXECUTABLE || -f $BACKEND_EXECUTABLE ) ]] || die 'backend executable path is unsafe'
else
  [[ -f $BACKEND_EXECUTABLE && -x $BACKEND_EXECUTABLE && ! -L $BACKEND_EXECUTABLE ]] || die 'backend executable must be a regular executable'
fi
BACKEND_ENV_FILE="$CONFIG_ROOT/backend.env"; MCP_ENV_FILE="$CONFIG_ROOT/mcp.env"; AUDIT_LOG="$LOG_ROOT/audit.jsonl"
for file in "$BACKEND_ENV_FILE" "$MCP_ENV_FILE"; do
  [[ -f $file && ! -L $file ]] || die "required operator config is missing or a symlink: $file"
  [[ $(stat -c %a "$file") == 640 ]] || die "operator config must have mode 0640: $file"
  [[ $(stat -c %u "$file") == $(id -u) && $(stat -c %g "$file") == "$service_gid" ]] || die "operator config owner/group is unsafe: $file"
done
[[ $(grep -c '^PICKLESHELL_MEMORY_AUDIT_LOG=' "$MCP_ENV_FILE") == 1 ]] || die 'mcp.env must define PICKLESHELL_MEMORY_AUDIT_LOG exactly once'
configured_audit=$(grep '^PICKLESHELL_MEMORY_AUDIT_LOG=' "$MCP_ENV_FILE" | cut -d= -f2-)
[[ $configured_audit == "$AUDIT_LOG" ]] || die 'mcp.env audit log must match the managed audit path'
if ((MANAGED_BACKEND)); then
  [[ $(grep -c '^MEM0_DATA_DIR=' "$BACKEND_ENV_FILE") == 1 ]] || die 'backend.env must define MEM0_DATA_DIR exactly once'
  configured_backend_data=$(grep '^MEM0_DATA_DIR=' "$BACKEND_ENV_FILE" | cut -d= -f2-)
  [[ $configured_backend_data == "$STATE_ROOT/backend" ]] || die 'backend.env data directory must match the managed backend path'
fi
if ((ROLLBACK)); then
  prevalidate_rollback
else
  [[ -n $SOURCE && $COMMIT =~ ^[0-9a-fA-F]{40}$ ]] || die 'source and full commit are required'
  SOURCE=$(realpath -e -- "$SOURCE") || die 'source does not exist'
  SOURCE_TOPLEVEL=$(git -C "$SOURCE" rev-parse --show-toplevel 2>/dev/null) || die 'source must be a different Git worktree'
  SOURCE_TOPLEVEL=$(realpath -e -- "$SOURCE_TOPLEVEL") || die 'source must be a different Git worktree'
  [[ $SOURCE_TOPLEVEL == "$SOURCE" && $SOURCE != "$ROOT" ]] || die 'source must be a different Git worktree'
  [[ -z $(git -C "$SOURCE" status --porcelain=v1 --untracked-files=all) ]] || die 'source worktree is dirty'
  RESOLVED=$(git -C "$SOURCE" rev-parse --verify "$COMMIT^{commit}") || die 'commit does not resolve'
  [[ $RESOLVED == "$COMMIT" ]] || die 'commit is not exact'
  RELEASE="$RELEASES/$RESOLVED"; STAGING="$RELEASES/.staging-$RESOLVED-$$"
  [[ ! -e $RELEASE && ! -L $RELEASE ]] || die 'release already exists; use a new exact commit or rollback'
fi
mkdir -p -- "$ROOT" "$STATE_ROOT" "$LOG_ROOT" "$UNITS_DIR" "$LOGROTATE_DIR" "$WRAPPER_DIR"
if ((MANAGED_BACKEND)); then mkdir -p -- "$(dirname -- "$BACKEND_EXECUTABLE")"; fi
ensure_internal_directory "$RELEASES" releases
ensure_internal_directory "$DEPLOY_STATE" state
if ((MANAGED_BACKEND)); then
  [[ ! -e $STATE_ROOT/backend && ! -L $STATE_ROOT/backend ]] && mkdir -- "$STATE_ROOT/backend"
  [[ -d $STATE_ROOT/backend && ! -L $STATE_ROOT/backend ]] || die 'managed backend data path is unsafe'
  chmod 0750 "$STATE_ROOT/backend"
fi
validate_internal_paths
chmod 0750 "$STATE_ROOT" "$LOG_ROOT"
if [[ $(id -u) -eq 0 ]]; then chown "$SERVICE_USER:$SERVICE_GROUP" "$STATE_ROOT" "$LOG_ROOT"; ((MANAGED_BACKEND)) && chown "$SERVICE_USER:$SERVICE_GROUP" "$STATE_ROOT/backend"; fi
[[ ! -e $AUDIT_LOG || ( -f $AUDIT_LOG && ! -L $AUDIT_LOG ) ]] || die 'audit log path is unsafe'
if [[ ! -e $AUDIT_LOG ]]; then install -m 0660 /dev/null "$AUDIT_LOG"; else chmod 0660 "$AUDIT_LOG"; fi
if [[ $(id -u) -eq 0 ]]; then chown "$SERVICE_USER:$SERVICE_GROUP" "$AUDIT_LOG"; fi
SWITCH_TEMP_PATHS=()
switch() {
  local target=$1 previous=$2 previous_tmp current_tmp active_tmp="$ROOT/.active.switch.$$"
  target=$(managed_release_target "$target" target)
  previous=$(optional_managed_release_target "$previous" previous)
  previous_tmp=$(mktemp "$DEPLOY_STATE/.previous-target.switch.XXXXXX") || return
  SWITCH_TEMP_PATHS=("$previous_tmp")
  current_tmp=$(mktemp "$DEPLOY_STATE/.current-target.switch.XXXXXX") || return
  SWITCH_TEMP_PATHS+=("$current_tmp" "$active_tmp")
  if ! printf '%s\n' "$previous" > "$previous_tmp" || ! printf '%s\n' "$target" > "$current_tmp" ||
     ! ln -s "$target" "$active_tmp" || ! mv -Tf -- "$previous_tmp" "$DEPLOY_STATE/previous-target" ||
     ! mv -Tf -- "$current_tmp" "$DEPLOY_STATE/current-target" || ! mv -Tf -- "$active_tmp" "$ACTIVE"; then
    return 1
  fi
  SWITCH_TEMP_PATHS=()
}
render_artifacts() {
  local release=$1 contents token value template target mode staged backup index restore_index
  local -a targets=() staged_files=() backup_files=() had_prior=() committed=()
  local -a specs=(
    "pickleshell-memory-backend.service.in:$UNITS_DIR/$SERVICE:0644" \
    "pickleshell-memory-backend.sh.in:$WRAPPER_DIR/backend-wrapper:0755" \
    "pickleshell-memory-mcp.sh.in:$WRAPPER_DIR/pickleshell-memory-mcp:0755" \
    "pickleshell-memory.logrotate.in:$LOGROTATE_DIR/pickleshell-memory:0644"
  )
  ((MANAGED_BACKEND)) && specs+=("pickleshell-memory-backend-bin.sh.in:$BACKEND_EXECUTABLE:0755")
  for spec in "${specs[@]}"; do
    template="$release/deploy/systemd/${spec%%:*}"; target=${spec#*:}; mode=${target##*:}; target=${target%:*}; contents=$(<"$template") || return
    for token in ACTIVE_ROOT CONFIG_ROOT STATE_ROOT LOG_ROOT BACKEND_ENV_FILE MCP_ENV_FILE AUDIT_LOG SERVICE_USER SERVICE_GROUP BACKEND_EXECUTABLE NODE_EXECUTABLE BACKEND_WRAPPER; do
      case $token in ACTIVE_ROOT) value="$ROOT/active";; CONFIG_ROOT) value=$CONFIG_ROOT;; STATE_ROOT) value=$STATE_ROOT;; LOG_ROOT) value=$LOG_ROOT;; BACKEND_ENV_FILE) value=$BACKEND_ENV_FILE;; MCP_ENV_FILE) value=$MCP_ENV_FILE;; AUDIT_LOG) value=$AUDIT_LOG;; SERVICE_USER) value=$SERVICE_USER;; SERVICE_GROUP) value=$SERVICE_GROUP;; BACKEND_EXECUTABLE) value=$BACKEND_EXECUTABLE;; NODE_EXECUTABLE) value=$NODE_EXECUTABLE;; BACKEND_WRAPPER) value="$WRAPPER_DIR/backend-wrapper";; esac
      contents=${contents//"@$token@"/"$value"}
    done
    if [[ $contents == *'@'* ]]; then
      printf 'memory-release: error: unresolved deployment placeholder\n' >&2
      for staged in "${staged_files[@]}"; do rm -f -- "$staged"; done
      return 1
    fi
    staged=$(mktemp "$(dirname -- "$target")/.$(basename -- "$target").render.XXXXXX") || return
    if ! printf '%s\n' "$contents" | install -m "$mode" /dev/stdin "$staged"; then
      rm -f -- "$staged"
      for staged in "${staged_files[@]}"; do rm -f -- "$staged"; done
      return 1
    fi
    targets+=("$target"); staged_files+=("$staged")
  done
  target="$WRAPPER_DIR/pickleshell-memory-ready"; mode=0755
  staged=$(mktemp "$(dirname -- "$target")/.$(basename -- "$target").render.XXXXXX") || {
    for staged in "${staged_files[@]}"; do rm -f -- "$staged"; done
    return 1
  }
  if ! printf '#!/usr/bin/env bash\nexec %q %q %q\n' "$NODE_EXECUTABLE" "$release/pickleshell-memory-mcp/src/readiness.js" "$WRAPPER_DIR/pickleshell-memory-mcp" | install -m "$mode" /dev/stdin "$staged"; then
    rm -f -- "$staged"
    for staged in "${staged_files[@]}"; do rm -f -- "$staged"; done
    return 1
  fi
  targets+=("$target"); staged_files+=("$staged")

  for index in "${!targets[@]}"; do
    target=${targets[$index]}; staged=${staged_files[$index]}
    backup=$(mktemp "$(dirname -- "$target")/.$(basename -- "$target").backup.XXXXXX") || break
    rm -f -- "$backup" || break
    backup_files[$index]=$backup
    if [[ -e $target || -L $target ]]; then
      had_prior[$index]=1
      mv -T -- "$target" "$backup" || break
    else
      had_prior[$index]=0
    fi
    if ! mv -T -- "$staged" "$target"; then
      if [[ ${had_prior[$index]} == 1 ]]; then mv -T -- "$backup" "$target" || true; fi
      break
    fi
    committed+=("$index")
  done
  if ((${#committed[@]} != ${#targets[@]})); then
    for ((restore_index=${#committed[@]} - 1; restore_index >= 0; restore_index--)); do
      index=${committed[$restore_index]}; target=${targets[$index]}; backup=${backup_files[$index]}
      if [[ ${had_prior[$index]} == 1 ]]; then mv -Tf -- "$backup" "$target" || true; else rm -f -- "$target" || true; fi
    done
    for staged in "${staged_files[@]}"; do rm -f -- "$staged"; done
    for backup in "${backup_files[@]}"; do [[ -n $backup ]] && rm -f -- "$backup"; done
    return 1
  fi
  for backup in "${backup_files[@]}"; do rm -f -- "$backup"; done
}
TRANSACTION_RECOVERY_FAILURES=''
transactional_switch() {
  local release=$1 target=$2 previous=$3 backup_root="$ROOT/.switch-backup.$$" index path temp active_before=''
  local -a paths=(
    "$UNITS_DIR/$SERVICE" "$WRAPPER_DIR/backend-wrapper" "$WRAPPER_DIR/pickleshell-memory-mcp"
    "$WRAPPER_DIR/pickleshell-memory-ready" "$LOGROTATE_DIR/pickleshell-memory"
    "$DEPLOY_STATE/previous-target" "$DEPLOY_STATE/current-target"
  ) had_prior=() failures=()
  ((MANAGED_BACKEND)) && paths+=("$BACKEND_EXECUTABLE")
  validate_internal_paths
  target=$(managed_release_target "$target" target)
  previous=$(optional_managed_release_target "$previous" previous)
  [[ $release == "$ROOT/$target" ]] || die 'managed release target is unsafe: transaction'
  mkdir -- "$backup_root" || return 1
  if [[ -L $ACTIVE ]]; then active_before=$(active_target) || { rm -rf -- "$backup_root"; return 1; }; fi
  for index in "${!paths[@]}"; do
    path=${paths[$index]}
    if [[ -e $path || -L $path ]]; then
      had_prior[$index]=1
      cp -a -- "$path" "$backup_root/$index" || { rm -rf -- "$backup_root"; return 1; }
    else
      had_prior[$index]=0
    fi
  done
  if render_artifacts "$release" && switch "$target" "$previous"; then
    rm -rf -- "$backup_root" || { TRANSACTION_RECOVERY_FAILURES=backup-cleanup; return 2; }
    return 0
  fi
  for index in "${!paths[@]}"; do
    path=${paths[$index]}
    if [[ ${had_prior[$index]} == 1 ]]; then
      mv -Tf -- "$backup_root/$index" "$path" || failures+=(artifact-state-restore)
    else
      rm -f -- "$path" || failures+=(artifact-state-remove)
    fi
  done
  for temp in "${SWITCH_TEMP_PATHS[@]}"; do rm -f -- "$temp" || failures+=(switch-temp-remove); done
  SWITCH_TEMP_PATHS=()
  if [[ -n $active_before ]]; then
    if ! ln -s "$active_before" "$ROOT/.active.restore.$$" || ! mv -Tf -- "$ROOT/.active.restore.$$" "$ACTIVE"; then
      failures+=(active-restore)
    fi
  else
    rm -f -- "$ACTIVE" || failures+=(active-remove)
  fi
  if ((${#failures[@]})); then
    TRANSACTION_RECOVERY_FAILURES=$(IFS=,; printf '%s' "${failures[*]}")
    return 2
  fi
  rm -rf -- "$backup_root" || { TRANSACTION_RECOVERY_FAILURES=backup-cleanup; return 2; }
  return 1
}
restart_verify() { "$SYSTEMCTL" daemon-reload && "$SYSTEMCTL" restart "$SERVICE" && "$SYSTEMCTL" is-active "$SERVICE" >/dev/null && "$WRAPPER_DIR/pickleshell-memory-ready"; }
RESTORE_DISABLED_ON_FIRST_FAILURE=0
FIRST_ACTIVATION_BACKUP_ROOT=''
FIRST_ACTIVATION_PATHS=(
  "$UNITS_DIR/$SERVICE" "$WRAPPER_DIR/backend-wrapper" "$WRAPPER_DIR/pickleshell-memory-mcp"
  "$WRAPPER_DIR/pickleshell-memory-ready" "$LOGROTATE_DIR/pickleshell-memory"
  "$DEPLOY_STATE/previous-target" "$DEPLOY_STATE/current-target"
)
((MANAGED_BACKEND)) && FIRST_ACTIVATION_PATHS+=("$BACKEND_EXECUTABLE")
FIRST_ACTIVATION_HAD_PRIOR=()
capture_first_activation_state() {
  local index path
  validate_internal_paths
  FIRST_ACTIVATION_BACKUP_ROOT="$ROOT/.first-activation-backup.$$"
  mkdir -- "$FIRST_ACTIVATION_BACKUP_ROOT" || return 1
  for index in "${!FIRST_ACTIVATION_PATHS[@]}"; do
    path=${FIRST_ACTIVATION_PATHS[$index]}
    if [[ -e $path || -L $path ]]; then
      FIRST_ACTIVATION_HAD_PRIOR[$index]=1
      cp -a -- "$path" "$FIRST_ACTIVATION_BACKUP_ROOT/$index" || return 1
    else
      FIRST_ACTIVATION_HAD_PRIOR[$index]=0
    fi
  done
}
restore_first_activation_state() {
  local index path
  local -a failures=()
  for index in "${!FIRST_ACTIVATION_PATHS[@]}"; do
    path=${FIRST_ACTIVATION_PATHS[$index]}
    if [[ ${FIRST_ACTIVATION_HAD_PRIOR[$index]} == 1 ]]; then
      rm -f -- "$path" && mv -T -- "$FIRST_ACTIVATION_BACKUP_ROOT/$index" "$path" || failures+=(artifact-state-restore)
    else
      rm -f -- "$path" || failures+=(artifact-state-remove)
    fi
  done
  rm -f -- "$ACTIVE" || failures+=(active-remove)
  if ((${#failures[@]})); then
    FIRST_ACTIVATION_CLEANUP_FAILURES=$(IFS=,; printf '%s' "${failures[*]}")
    return 1
  fi
  rm -rf -- "$FIRST_ACTIVATION_BACKUP_ROOT" || { FIRST_ACTIVATION_CLEANUP_FAILURES=backup-cleanup; return 1; }
  FIRST_ACTIVATION_BACKUP_ROOT=''
}
cleanup_failed_first_activation() {
  local failures=()
  "$SYSTEMCTL" stop "$SERVICE" >/dev/null 2>&1 || failures+=(service-stop)
  if ((RESTORE_DISABLED_ON_FIRST_FAILURE)); then
    "$SYSTEMCTL" disable "$SERVICE" >/dev/null 2>&1 || failures+=(service-disable)
  fi
  restore_first_activation_state || failures+=(state-restore)
  "$SYSTEMCTL" daemon-reload >/dev/null 2>&1 || failures+=(daemon-reload)
  if ((${#failures[@]})); then
    FIRST_ACTIVATION_CLEANUP_FAILURES=$(IFS=,; printf '%s' "${failures[*]}")
    return 1
  fi
}
if ((ROLLBACK)); then
  transaction_status=0; transactional_switch "$ROOT/$previous" "$previous" "$current" || transaction_status=$?
  if ((transaction_status)); then
    ((transaction_status == 2)) && die "rollback switch failed; current deployment recovery failed (${TRANSACTION_RECOVERY_FAILURES:-unknown})"
    die 'rollback switch failed; current deployment restored'
  fi
  if ! restart_verify; then
    transaction_status=0; transactional_switch "$ROOT/$current" "$current" "$previous" || transaction_status=$?
    if ((transaction_status)); then
      ((transaction_status == 2)) && die "rollback readiness failed; current deployment recovery failed (${TRANSACTION_RECOVERY_FAILURES:-unknown})"
      die 'rollback readiness failed; current deployment switch recovery failed'
    fi
    restart_verify || die 'rollback readiness failed; current deployment recovery verification failed'
    die 'rollback readiness failed; current deployment restored and verified'
  fi
  printf 'memory-release: rolled back to %s\n' "$previous"; exit 0
fi
RELEASE_CREATED=0; ACTIVATION_SUCCEEDED=0
cleanup_exit() {
  local status=$? active_now='' release_cleanup_safe=1
  trap - EXIT
  [[ -z ${STAGING:-} ]] || rm -rf -- "$STAGING"
  [[ -z ${FIRST_ACTIVATION_BACKUP_ROOT:-} ]] || rm -rf -- "$FIRST_ACTIVATION_BACKUP_ROOT"
  if ((RELEASE_CREATED && ! ACTIVATION_SUCCEEDED)); then
    if [[ -L $ACTIVE ]]; then
      active_now=$(active_target) || release_cleanup_safe=0
      [[ $active_now != "releases/$RESOLVED" ]] || release_cleanup_safe=0
    elif [[ -e $ACTIVE ]]; then
      release_cleanup_safe=0
    fi
    if ((!release_cleanup_safe)); then
      printf 'memory-release: error: failed release cleanup; release may be active: %s\n' "$RELEASE" >&2
      status=1
    elif ! find -P "$RELEASE" -type d -exec chmod u+w {} + || ! rm -rf -- "$RELEASE"; then
      printf 'memory-release: error: failed to remove unsuccessful release: %s\n' "$RELEASE" >&2
      status=1
    fi
  fi
  exit "$status"
}
trap cleanup_exit EXIT
archive_paths=(deploy/systemd/pickleshell-memory-backend.service.in deploy/systemd/pickleshell-memory-backend.sh.in deploy/systemd/pickleshell-memory-mcp.sh.in deploy/systemd/pickleshell-memory.logrotate.in pickleshell-memory-mcp)
((MANAGED_BACKEND)) && archive_paths+=(deploy/systemd/pickleshell-memory-backend-bin.sh.in pickleshell-memory-backend)
mkdir -- "$STAGING"; git -C "$SOURCE" archive "$RESOLVED" "${archive_paths[@]}" | tar -x -C "$STAGING"
printf '%s\n' "$RESOLVED" > "$STAGING/.release-sha"; npm --prefix "$STAGING/pickleshell-memory-mcp" ci --omit=dev
if ((MANAGED_BACKEND)); then
  "$PYTHON_EXECUTABLE" -m venv --copies "$STAGING/pickleshell-memory-backend/.venv"
  "$STAGING/pickleshell-memory-backend/.venv/bin/pip" install --disable-pip-version-check --require-hashes --no-deps -r "$STAGING/pickleshell-memory-backend/requirements.lock"
  "$STAGING/pickleshell-memory-backend/.venv/bin/pip" install --disable-pip-version-check --no-build-isolation --no-deps "$STAGING/pickleshell-memory-backend"
fi
while IFS= read -r -d '' link; do
  resolved_link=$(realpath -e -- "$link") || die 'release contains a broken symlink'
  [[ $resolved_link == "$STAGING/pickleshell-memory-mcp"/* ||
     $resolved_link == "$STAGING/pickleshell-memory-backend"/* ]] || die 'release symlink escapes a memory package'
done < <(find -P "$STAGING" -type l -print0)
find -P "$STAGING" -type d -exec chmod 0555 {} +; find -P "$STAGING" -type f -exec chmod 0444 {} +
if ((MANAGED_BACKEND)); then
  find -P "$STAGING/pickleshell-memory-backend/.venv/bin" -type f -exec chmod 0555 {} +
  chmod 0555 "$STAGING/pickleshell-memory-backend/bin/pickleshell-memory-backend"
fi
mv -T "$STAGING" "$RELEASE"; STAGING=''; RELEASE_CREATED=1; previous=''; prior_previous=''; [[ ! -e $ACTIVE && ! -L $ACTIVE ]] || previous=$(active_target)
validate_internal_paths
if [[ -n $previous && -f $DEPLOY_STATE/previous-target && ! -L $DEPLOY_STATE/previous-target ]]; then
  prior_previous=$(optional_managed_release_target "$(<"$DEPLOY_STATE/previous-target")" previous)
fi
if [[ -z $previous ]]; then capture_first_activation_state || die 'cannot preserve pre-existing first-activation state'; fi
transaction_status=0; transactional_switch "$RELEASE" "releases/$RESOLVED" "$previous" || transaction_status=$?
if ((transaction_status)); then
  ((transaction_status == 2)) && die "deployment switch failed; previous deployment recovery failed (${TRANSACTION_RECOVERY_FAILURES:-unknown})"
  die 'deployment switch failed; previous deployment restored'
fi
if ! restart_verify; then
  if [[ -n $previous ]]; then
    transaction_status=0; transactional_switch "$ROOT/$previous" "$previous" "$prior_previous" || transaction_status=$?
    if ((transaction_status)); then
      ((transaction_status == 2)) && die "activation readiness failed; previous deployment recovery failed (${TRANSACTION_RECOVERY_FAILURES:-unknown})"
      die 'activation readiness failed; previous deployment switch recovery failed'
    fi
    restart_verify || die 'activation readiness failed; previous deployment recovery verification failed'
    die 'activation readiness failed; previous deployment restored and verified'
  fi
  if ! cleanup_failed_first_activation; then
    die "activation readiness failed; first-activation cleanup failed (${FIRST_ACTIVATION_CLEANUP_FAILURES:-unknown})"
  fi
  die 'activation readiness failed; first-activation state restored'
fi
if [[ -z $previous ]]; then
  if ! "$SYSTEMCTL" is-enabled "$SERVICE" >/dev/null 2>&1; then RESTORE_DISABLED_ON_FIRST_FAILURE=1; fi
  if ! "$SYSTEMCTL" enable "$SERVICE"; then
    if ! cleanup_failed_first_activation; then
      die "activation enablement failed; first-activation cleanup failed (${FIRST_ACTIVATION_CLEANUP_FAILURES:-unknown})"
    fi
    die 'activation enablement failed; first-activation state restored'
  fi
  rm -rf -- "$FIRST_ACTIVATION_BACKUP_ROOT" || die 'cannot remove first-activation backup'
  FIRST_ACTIVATION_BACKUP_ROOT=''
fi
ACTIVATION_SUCCEEDED=1
printf 'memory-release: active release: releases/%s\n' "$RESOLVED"
