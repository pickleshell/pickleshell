#!/usr/bin/env bash
set -Eeuo pipefail

die() { printf 'memory-release: error: %s\n' "$1" >&2; exit 1; }
usage() { printf '%s\n' 'Usage: memory-release.sh --source REPO --root ROOT --commit FULL_SHA [options] [--rollback]'; }

SOURCE=''; ROOT='/opt/pickleshell-memory'; COMMIT=''; PROFILE=production
CONFIG_ROOT='/etc/pickleshell-memory'; STATE_ROOT='/var/lib/pickleshell-memory'; LOG_ROOT='/var/log/pickleshell-memory'
UNITS_DIR='/etc/systemd/system'; LOGROTATE_DIR='/etc/logrotate.d'; WRAPPER_DIR='/usr/local/libexec'
SERVICE_USER='pickleshell-memory'; SERVICE_GROUP='pickleshell-memory'; SERVICE='pickleshell-memory-backend.service'
NODE_EXECUTABLE='/usr/bin/node'; BACKEND_EXECUTABLE='/usr/local/bin/pickleshell-memory-backend'; SYSTEMCTL=systemctl; ROLLBACK=0
while (($#)); do case "$1" in
  --source) SOURCE=${2:-}; shift 2;; --root) ROOT=${2:-}; shift 2;; --commit) COMMIT=${2:-}; shift 2;;
  --profile) PROFILE=${2:-}; shift 2;; --config-root) CONFIG_ROOT=${2:-}; shift 2;; --state-root) STATE_ROOT=${2:-}; shift 2;;
  --log-root) LOG_ROOT=${2:-}; shift 2;; --units-dir) UNITS_DIR=${2:-}; shift 2;; --logrotate-dir) LOGROTATE_DIR=${2:-}; shift 2;;
  --wrapper-dir) WRAPPER_DIR=${2:-}; shift 2;; --service-user) SERVICE_USER=${2:-}; shift 2;; --service-group) SERVICE_GROUP=${2:-}; shift 2;;
  --service) SERVICE=${2:-}; shift 2;; --node-executable) NODE_EXECUTABLE=${2:-}; shift 2;;
  --backend-executable) BACKEND_EXECUTABLE=${2:-}; shift 2;; --systemctl) SYSTEMCTL=${2:-}; shift 2;; --rollback) ROLLBACK=1; shift;;
  -h|--help) usage; exit 0;; *) usage >&2; die "unknown option: $1";; esac done
[[ $PROFILE == production || $PROFILE == isolated ]] || die 'profile must be production or isolated'
safe_path() { [[ $1 = /* && $1 != / && $1 != /etc && $1 != /opt && $1 != /var && $1 != /usr && $1 != /home && $1 != *'..'* && $1 != *[[:space:]@]* && $1 != *[\;\|\&\$\(\)\<\>\\\"\'\`\*\?\[\]]* ]] || die "$2 is unsafe"; }
for pair in "$ROOT:root" "$CONFIG_ROOT:config root" "$STATE_ROOT:state root" "$LOG_ROOT:log root" "$UNITS_DIR:units directory" "$LOGROTATE_DIR:logrotate directory" "$WRAPPER_DIR:wrapper directory" "$NODE_EXECUTABLE:node executable" "$BACKEND_EXECUTABLE:backend executable"; do safe_path "${pair%%:*}" "${pair#*:}"; done
[[ $SERVICE_USER =~ ^[a-z_][a-z0-9_-]*$ && $SERVICE_GROUP =~ ^[a-z_][a-z0-9_-]*$ && $SERVICE_USER != root ]] || die 'unsafe service identity'
[[ $SERVICE =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*\.service$ && $SERVICE != *..* ]] || die 'unsafe service name'
for path in "$ROOT" "$CONFIG_ROOT" "$STATE_ROOT" "$LOG_ROOT" "$UNITS_DIR" "$LOGROTATE_DIR" "$WRAPPER_DIR"; do [[ ! -L $path ]] || die "sensitive path is a symlink: $path"; done
[[ -f $NODE_EXECUTABLE && -x $NODE_EXECUTABLE && ! -L $NODE_EXECUTABLE ]] || die 'node executable must be a regular executable'
[[ -f $BACKEND_EXECUTABLE && -x $BACKEND_EXECUTABLE && ! -L $BACKEND_EXECUTABLE ]] || die 'backend executable must be a regular executable'
BACKEND_ENV_FILE="$CONFIG_ROOT/backend.env"; MCP_ENV_FILE="$CONFIG_ROOT/mcp.env"; AUDIT_LOG="$LOG_ROOT/audit.jsonl"
service_gid=$(getent group "$SERVICE_GROUP" | cut -d: -f3); [[ -n $service_gid ]] || die 'service group does not exist'
for file in "$BACKEND_ENV_FILE" "$MCP_ENV_FILE"; do
  [[ -f $file && ! -L $file ]] || die "required operator config is missing or a symlink: $file"
  [[ $(stat -c %a "$file") == 640 ]] || die "operator config must have mode 0640: $file"
  [[ $(stat -c %u "$file") == $(id -u) && $(stat -c %g "$file") == "$service_gid" ]] || die "operator config owner/group is unsafe: $file"
done
[[ $(grep -c '^PICKLESHELL_MEMORY_AUDIT_LOG=' "$MCP_ENV_FILE") == 1 ]] || die 'mcp.env must define PICKLESHELL_MEMORY_AUDIT_LOG exactly once'
configured_audit=$(grep '^PICKLESHELL_MEMORY_AUDIT_LOG=' "$MCP_ENV_FILE" | cut -d= -f2-)
[[ $configured_audit == "$AUDIT_LOG" ]] || die 'mcp.env audit log must match the managed audit path'
mkdir -p -- "$ROOT" "$STATE_ROOT" "$LOG_ROOT" "$UNITS_DIR" "$LOGROTATE_DIR" "$WRAPPER_DIR"
chmod 0750 "$STATE_ROOT" "$LOG_ROOT"
if [[ $(id -u) -eq 0 ]]; then chown "$SERVICE_USER:$SERVICE_GROUP" "$STATE_ROOT" "$LOG_ROOT"; fi
[[ ! -e $AUDIT_LOG || ( -f $AUDIT_LOG && ! -L $AUDIT_LOG ) ]] || die 'audit log path is unsafe'
if [[ ! -e $AUDIT_LOG ]]; then install -m 0640 /dev/null "$AUDIT_LOG"; else chmod 0640 "$AUDIT_LOG"; fi
if [[ $(id -u) -eq 0 ]]; then chown "$SERVICE_USER:$SERVICE_GROUP" "$AUDIT_LOG"; fi
RELEASES="$ROOT/releases"; ACTIVE="$ROOT/active"; DEPLOY_STATE="$ROOT/state"; mkdir -p -- "$RELEASES" "$DEPLOY_STATE"
active_target() { [[ -L $ACTIVE ]] || return 1; local target; target=$(readlink -- "$ACTIVE"); [[ $target == releases/* && $target != *..* && -d $ROOT/$target && ! -L $ROOT/$target ]] || die 'active target is unsafe'; printf %s "$target"; }
switch() { local target=$1 previous=$2 tmp="$ROOT/.active.new.$$"; printf '%s\n' "$previous" > "$DEPLOY_STATE/previous-target"; printf '%s\n' "$target" > "$DEPLOY_STATE/current-target"; ln -s "$target" "$tmp"; mv -Tf "$tmp" "$ACTIVE"; }
render_artifacts() {
  local release=$1 contents token value template target
  for spec in \
    "pickleshell-memory-backend.service.in:$UNITS_DIR/$SERVICE:0644" \
    "pickleshell-memory-backend.sh.in:$WRAPPER_DIR/backend-wrapper:0755" \
    "pickleshell-memory-mcp.sh.in:$WRAPPER_DIR/pickleshell-memory-mcp:0755" \
    "pickleshell-memory.logrotate.in:$LOGROTATE_DIR/pickleshell-memory:0644"; do
    template="$release/deploy/systemd/${spec%%:*}"; target=${spec#*:}; mode=${target##*:}; target=${target%:*}; contents=$(<"$template")
    for token in ACTIVE_ROOT CONFIG_ROOT STATE_ROOT LOG_ROOT BACKEND_ENV_FILE MCP_ENV_FILE AUDIT_LOG SERVICE_USER SERVICE_GROUP BACKEND_EXECUTABLE NODE_EXECUTABLE BACKEND_WRAPPER; do
      case $token in ACTIVE_ROOT) value="$ROOT/active";; CONFIG_ROOT) value=$CONFIG_ROOT;; STATE_ROOT) value=$STATE_ROOT;; LOG_ROOT) value=$LOG_ROOT;; BACKEND_ENV_FILE) value=$BACKEND_ENV_FILE;; MCP_ENV_FILE) value=$MCP_ENV_FILE;; AUDIT_LOG) value=$AUDIT_LOG;; SERVICE_USER) value=$SERVICE_USER;; SERVICE_GROUP) value=$SERVICE_GROUP;; BACKEND_EXECUTABLE) value=$BACKEND_EXECUTABLE;; NODE_EXECUTABLE) value=$NODE_EXECUTABLE;; BACKEND_WRAPPER) value="$WRAPPER_DIR/backend-wrapper";; esac
      contents=${contents//"@$token@"/"$value"}
    done
    [[ $contents != *'@'* ]] || die 'unresolved deployment placeholder'
    printf '%s\n' "$contents" | install -m "$mode" /dev/stdin "$target"
  done
  printf '#!/usr/bin/env bash\nexec %q %q %q\n' "$NODE_EXECUTABLE" "$release/pickleshell-memory-mcp/src/readiness.js" "$WRAPPER_DIR/pickleshell-memory-mcp" | install -m 0755 /dev/stdin "$WRAPPER_DIR/pickleshell-memory-ready"
}
restart_verify() { "$SYSTEMCTL" daemon-reload; "$SYSTEMCTL" restart "$SERVICE"; "$SYSTEMCTL" is-active "$SERVICE" >/dev/null; "$WRAPPER_DIR/pickleshell-memory-ready"; }
if ((ROLLBACK)); then
  current=$(<"$DEPLOY_STATE/current-target") || die 'current target is missing'; previous=$(<"$DEPLOY_STATE/previous-target") || die 'previous target is missing'
  [[ -n $previous && $(active_target) == "$current" && -d $ROOT/$previous ]] || die 'rollback target is unavailable or inconsistent'
  render_artifacts "$ROOT/$previous"; switch "$previous" "$current"; restart_verify || { switch "$current" "$previous"; die 'rollback readiness failed'; }
  printf 'memory-release: rolled back to %s\n' "$previous"; exit 0
fi
[[ -n $SOURCE && $COMMIT =~ ^[0-9a-fA-F]{40}$ ]] || die 'source and full commit are required'
SOURCE=$(realpath -e -- "$SOURCE") || die 'source does not exist'; [[ -d $SOURCE/.git && $SOURCE != "$ROOT" ]] || die 'source must be a different Git worktree'
[[ -z $(git -C "$SOURCE" status --porcelain=v1 --untracked-files=all) ]] || die 'source worktree is dirty'
RESOLVED=$(git -C "$SOURCE" rev-parse --verify "$COMMIT^{commit}") || die 'commit does not resolve'; [[ $RESOLVED == "$COMMIT" ]] || die 'commit is not exact'
RELEASE="$RELEASES/$RESOLVED"; STAGING="$RELEASES/.staging-$RESOLVED-$$"; trap 'rm -rf -- "${STAGING:-}"' EXIT
[[ ! -e $RELEASE && ! -L $RELEASE ]] || die 'release already exists; use a new exact commit or rollback'
mkdir -- "$STAGING"; git -C "$SOURCE" archive "$RESOLVED" deploy/systemd/pickleshell-memory-backend.service.in deploy/systemd/pickleshell-memory-backend.sh.in deploy/systemd/pickleshell-memory-mcp.sh.in deploy/systemd/pickleshell-memory.logrotate.in pickleshell-memory-mcp | tar -x -C "$STAGING"
printf '%s\n' "$RESOLVED" > "$STAGING/.release-sha"; npm --prefix "$STAGING/pickleshell-memory-mcp" ci --omit=dev
while IFS= read -r -d '' link; do
  resolved_link=$(realpath -e -- "$link") || die 'release contains a broken symlink'
  [[ $resolved_link == "$STAGING/pickleshell-memory-mcp"/* ]] || die 'release symlink escapes the memory package'
done < <(find -P "$STAGING" -type l -print0)
find -P "$STAGING" -type d -exec chmod 0555 {} +; find -P "$STAGING" -type f -exec chmod 0444 {} +
mv -T "$STAGING" "$RELEASE"; STAGING=''; previous=''; [[ ! -e $ACTIVE && ! -L $ACTIVE ]] || previous=$(active_target)
render_artifacts "$RELEASE"; switch "releases/$RESOLVED" "$previous"
if ! restart_verify; then
  if [[ -n $previous ]]; then switch "$previous" ''; else rm -f -- "$ACTIVE"; printf '' > "$DEPLOY_STATE/current-target"; fi
  die 'activation readiness failed'
fi
printf 'memory-release: active release: releases/%s\n' "$RESOLVED"
