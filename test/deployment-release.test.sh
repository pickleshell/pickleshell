#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT=$ROOT_DIR/deploy/release.sh
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT

SOURCE=$TMP/source
DEPLOY=$TMP/deploy
BIN=$TMP/bin
UNITS=$TMP/units
mkdir -p "$SOURCE" "$BIN" "$UNITS"
mkdir -p "$DEPLOY/gateway" "$DEPLOY/mcp-server" "$DEPLOY/terminal-chatgpt"
mkdir -p "$SOURCE/deploy/systemd"
printf 'operator state\n' > "$DEPLOY/gateway/operator-state"
printf 'operator state\n' > "$DEPLOY/mcp-server/operator-state"
printf 'separately managed\n' > "$DEPLOY/terminal-chatgpt/marker"

git -C "$SOURCE" init -q
git -C "$SOURCE" config user.email test@example.invalid
git -C "$SOURCE" config user.name test
for component in gateway mcp-server terminal; do
  mkdir -p "$SOURCE/$component/systemd"
  printf '{"name":"test-%s"}\n' "$component" > "$SOURCE/$component/package.json"
  printf '{}\n' > "$SOURCE/$component/package-lock.json"
done
cp "$ROOT_DIR/gateway/systemd/pickleshell-gateway.service" "$SOURCE/gateway/systemd/"
cp "$ROOT_DIR/mcp-server/systemd/pickleshell-tunnel.service" "$SOURCE/mcp-server/systemd/"
cp "$ROOT_DIR/terminal/systemd/pickleshell-terminal.service" "$SOURCE/terminal/systemd/"
cp "$ROOT_DIR/deploy/systemd/"*.in "$SOURCE/deploy/systemd/"
printf 'one\n' > "$SOURCE/gateway/version.txt"
git -C "$SOURCE" add .
git -C "$SOURCE" commit -q -m one
ONE=$(git -C "$SOURCE" rev-parse HEAD)

cat > "$BIN/npm" <<'FAKE_NPM'
#!/usr/bin/env bash
set -Eeuo pipefail
prefix=''
while (($#)); do
  if [[ $1 == --prefix ]]; then prefix=$2; shift 2; else shift; fi
done
[[ -n $prefix ]]
[[ -w $prefix ]] || { printf 'fake npm: prefix is not writable: %s\n' "$prefix" >&2; exit 13; }
if [[ ${FAKE_NPM_FAIL:-0} == 1 ]]; then exit 42; fi
if [[ $prefix == */mcp-server ]]; then mkdir -p "$prefix/dist"; printf '// test\n' > "$prefix/dist/index.js"; fi
if [[ $prefix == */terminal ]]; then mkdir -p "$prefix/bin"; printf '#!/bin/sh\n' > "$prefix/bin/cgroup-launcher"; chmod +x "$prefix/bin/cgroup-launcher"; fi
FAKE_NPM
chmod +x "$BIN/npm"

cat > "$BIN/tar" <<'FAKE_TAR'
#!/usr/bin/env bash
set -Eeuo pipefail
/usr/bin/tar "$@"
destination=''
while (($#)); do
  if [[ $1 == -C ]]; then destination=$2; shift 2; else shift; fi
done
[[ -n $destination ]]
for component in gateway mcp-server terminal; do chmod a-w "$destination/$component"; done
FAKE_TAR
chmod +x "$BIN/tar"

FAKE_CHOWN_LOG=$TMP/chown.log
export FAKE_CHOWN_LOG
cat > "$BIN/chown" <<'FAKE_CHOWN'
#!/usr/bin/env bash
set -Eeuo pipefail
while (($#)); do
  case "$1" in
    -h|-R|-hR|-Rh) shift ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
owner=$1
shift
[[ $# -eq 1 ]]
path=$1
printf '%s %s\n' "$owner" "$path" >> "${FAKE_CHOWN_LOG:-/dev/null}"
[[ $owner == root:root ]] && chmod a-w -- "$path" || chmod u+rwx -- "$path"
FAKE_CHOWN
chmod +x "$BIN/chown"

USER=$(id -un)
export PATH="$BIN:$PATH"
MATRIX_NODE_EXECUTABLE=$(command -v node)
[[ -n $MATRIX_NODE_EXECUTABLE && -x $MATRIX_NODE_EXECUTABLE ]]
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
(( NODE_MAJOR >= 20 ))
TEST_NODE_EXECUTABLE=${PICKLESHELL_TEST_NODE_EXECUTABLE:-/usr/bin/node}
[[ -x $TEST_NODE_EXECUTABLE ]]
[[ $TEST_NODE_EXECUTABLE != /opt/pickleshell/runtime/* ]]
release_script() {
  "$SCRIPT" --node-executable "$TEST_NODE_EXECUTABLE" --terminal-node-executable "$TEST_NODE_EXECUTABLE" "$@"
}

cat > "$BIN/id" <<'FAKE_ID'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ $1 == -u ]]; then printf '0\n'; exit 0; fi
case "$1" in
  pickleshell-test|pickleshell-test-tunnel|pickleshell-test-terminal|release-gateway|release-mcp|release-terminal) exit 0 ;;
  *) exec /usr/bin/id "$@" ;;
esac
FAKE_ID
chmod +x "$BIN/id"

cat > "$BIN/runuser" <<'FAKE_RUNUSER'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ $1 == -u && $3 == -- ]]
user=$2
shift 3
export FAKE_RUNUSER_USER=$user
exec "$@"
FAKE_RUNUSER
chmod +x "$BIN/runuser"

cat > "$BIN/rm" <<'FAKE_RM'
#!/usr/bin/env bash
set -Eeuo pipefail
path=${@: -1}
if [[ -d $path && ! -L $path ]]; then
  /usr/bin/find "$path" -type d -exec chmod u+w -- {} +
fi
exec /usr/bin/rm "$@"
FAKE_RM
chmod +x "$BIN/rm"

release_script --source "$SOURCE" --root "$DEPLOY" --commit "$ONE" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd
[[ -L $DEPLOY/active ]]
[[ $(readlink "$DEPLOY/active") == releases/$ONE ]]
[[ $(<"$DEPLOY/releases/$ONE/.release-sha") == "$ONE" ]]
[[ $(stat -c '%a' "$DEPLOY/releases/$ONE/gateway") == 555 ]]
[[ $(stat -c '%a' "$DEPLOY/releases/$ONE/gateway/package.json") == 444 ]]
[[ -f $DEPLOY/releases/$ONE/gateway/version.txt ]]
[[ ! -e $DEPLOY/releases/$ONE/.env ]]
[[ $(<"$DEPLOY/gateway/operator-state") == 'operator state' ]]
[[ $(<"$DEPLOY/mcp-server/operator-state") == 'operator state' ]]
[[ $(<"$DEPLOY/terminal-chatgpt/marker") == 'separately managed' ]]
[[ ! -e $UNITS/pickleshell-terminal.service ]]

printf 'two\n' > "$SOURCE/gateway/version.txt"
git -C "$SOURCE" add gateway/version.txt
git -C "$SOURCE" commit -q -m two
TWO=$(git -C "$SOURCE" rev-parse HEAD)
release_script --source "$SOURCE" --root "$DEPLOY" --commit "$TWO" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd
[[ $(readlink "$DEPLOY/active") == releases/$TWO ]]
[[ $(<"$DEPLOY/state/previous-target") == releases/$ONE ]]

cat > "$BIN/fake-systemctl" <<'FAKE_SYSTEMCTL'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "${FAKE_SYSTEMCTL_LOG:?}"
if [[ ${FAKE_SYSTEMCTL_FAIL:-0} == 1 && $1 == restart ]]; then exit 1; fi
exit 0
FAKE_SYSTEMCTL
chmod +x "$BIN/fake-systemctl"
printf 'old gateway unit\n' > "$UNITS/pickleshell-gateway.service"
printf 'old mcp unit\n' > "$UNITS/pickleshell-tunnel.service"
printf 'production terminal sentinel\n' > "$UNITS/pickleshell-terminal.service"
printf 'separately managed terminal profile\n' > "$UNITS/terminal-chatgpt.service"
FAKE_SYSTEMCTL_LOG=$TMP/systemctl.log
export FAKE_SYSTEMCTL_LOG
printf 'three\n' > "$SOURCE/gateway/version.txt"
git -C "$SOURCE" add gateway/version.txt
git -C "$SOURCE" commit -q -m three
THREE=$(git -C "$SOURCE" rev-parse HEAD)

PATH="$BIN:$PATH" release_script --profile isolated --source "$SOURCE" --root /opt/pickleshell-test --commit "$THREE" \
  --node-executable /usr/bin/node --tunnel-client-executable /usr/local/bin/tunnel-client --dry-run >/dev/null

ISOLATED_DEPLOY=$TMP/isolated-deploy
ISOLATED_UNITS=$TMP/isolated-units
mkdir -p "$ISOLATED_UNITS"
release_script --source "$SOURCE" --root "$ISOLATED_DEPLOY" --commit "$THREE" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" \
  --gateway-group "$USER" --mcp-group "$USER" --terminal-group "$USER" \
  --gateway-service pickleshell-test-gateway.service \
  --mcp-service pickleshell-test-tunnel.service \
  --terminal-service pickleshell-test-terminal.service --include-terminal \
  --config-root /etc/pickleshell-test --state-root /var/lib/pickleshell-test \
  --cache-root /var/cache/pickleshell-test --workspace-root /srv/pickleshell-test/workspace \
  --terminal-workspace-root /srv/pickleshell-test/workspace \
  --mcp-runtime-dir /run/pickleshell-test-mcp --terminal-runtime-dir /run/pickleshell-test-terminal \
  --mcp-bind-source /run/pickleshell-test-mcp --mcp-bind-target /run/pickleshell-mcp \
  --mcp-temp-dir /var/lib/pickleshell-test/mcp-temp \
  --tunnel-profile /etc/pickleshell-test/tunnel-client/pickleshell-test.yaml \
  --terminal-socket /run/pickleshell-test-terminal/service.sock \
  --node-executable /usr/bin/node \
  --tunnel-client-executable /usr/local/bin/tunnel-client \
  --systemctl "$BIN/fake-systemctl" --units-dir "$ISOLATED_UNITS"
for unit in pickleshell-test-gateway.service pickleshell-test-tunnel.service pickleshell-test-terminal.service; do
  [[ -s "$ISOLATED_UNITS/$unit" ]]
  ! grep -E '/opt/pickleshell/|/etc/pickleshell/|/var/lib/pickleshell/|/var/cache/pickleshell/|/srv/pickleshell/|User=pickleshell($|[^-])|User=pickleshell-tunnel|User=pickleshell-terminal|pickleshell-gateway.service' "$ISOLATED_UNITS/$unit"
  grep -q 'NoNewPrivileges=true' "$ISOLATED_UNITS/$unit"
done
grep -q 'After=network-online.target pickleshell-test-gateway.service' "$ISOLATED_UNITS/pickleshell-test-tunnel.service"
grep -q 'ExecStart=/usr/local/bin/tunnel-client run --profile-file /etc/pickleshell-test/tunnel-client/pickleshell-test.yaml' "$ISOLATED_UNITS/pickleshell-test-tunnel.service"
grep -q 'RuntimeDirectory=pickleshell-test-mcp' "$ISOLATED_UNITS/pickleshell-test-tunnel.service"
grep -q 'BindPaths=/run/pickleshell-test-mcp:/run/pickleshell-mcp' "$ISOLATED_UNITS/pickleshell-test-tunnel.service"
grep -q 'ReadWritePaths=/var/lib/pickleshell-test/mcp-temp' "$ISOLATED_UNITS/pickleshell-test-tunnel.service"
grep -q 'ReadWritePaths=/var/cache/pickleshell-test/ms-playwright' "$ISOLATED_UNITS/pickleshell-test-tunnel.service"
grep -q 'TasksMax=256' "$ISOLATED_UNITS/pickleshell-test-tunnel.service"
grep -q 'Environment=PICKLESHELL_TERMINAL_SOCKET=/run/pickleshell-test-terminal/service.sock' "$ISOLATED_UNITS/pickleshell-test-terminal.service"
grep -q 'Environment=PICKLESHELL_TERMINAL_ROOT_OVERRIDE=/run/pickleshell-test-terminal/workspace' "$ISOLATED_UNITS/pickleshell-test-terminal.service"
grep -q 'ProtectHome=true' "$ISOLATED_UNITS/pickleshell-test-terminal.service"
grep -q 'BindPaths=/srv/pickleshell-test/workspace:/run/pickleshell-test-terminal/workspace' "$ISOLATED_UNITS/pickleshell-test-terminal.service"
grep -q 'ReadWritePaths=/run/pickleshell-test-terminal' "$ISOLATED_UNITS/pickleshell-test-terminal.service"
! grep -q 'BindReadOnlyPaths=.*workspace' "$ISOLATED_UNITS/pickleshell-test-terminal.service"
! grep -q 'ReadOnlyPaths=.* /srv/pickleshell-test/workspace' "$ISOLATED_UNITS/pickleshell-test-terminal.service"
[[ ! -e "$ISOLATED_UNITS/terminal-chatgpt.service" ]]

PREP_HELPERS=$TMP/release-prep-helpers.sh
sed -n '/^run() {/,/^restore_units() {/p' "$SCRIPT" | sed '$d' > "$PREP_HELPERS"
ACL_BIN=$TMP/acl-bin
mkdir -p "$ACL_BIN"
ACL_LOG=$TMP/acl.log
export ACL_LOG
cat > "$ACL_BIN/setfacl" <<'FAKE_SETFACL'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'setfacl' >> "${ACL_LOG:?}"
for arg in "$@"; do printf ' %s' "$arg" >> "${ACL_LOG:?}"; done
printf '\n' >> "${ACL_LOG:?}"
FAKE_SETFACL
chmod +x "$ACL_BIN/setfacl"
cat > "$ACL_BIN/getfacl" <<'FAKE_GETFACL'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'user::rwx\nuser:release-terminal:rwx\ngroup::---\nmask::rwx\nother::---\n'
FAKE_GETFACL
chmod +x "$ACL_BIN/getfacl"
(
  set -Eeuo pipefail
  die() { printf 'release: error: %s\n' "$1" >&2; exit 1; }
  # shellcheck source=/dev/null
  source "$PREP_HELPERS"
  PATH="$ACL_BIN:$BIN:/usr/bin:/bin"
  NO_SYSTEMD=0; DRY_RUN=0; SYSTEMCTL=systemctl
  GATEWAY_USER=release-gateway; GATEWAY_GROUP=release-gateway
  MCP_USER=release-mcp; MCP_GROUP=release-mcp
  TERMINAL_USER=release-terminal; TERMINAL_GROUP=release-terminal
  STATE_ROOT=$TMP/prep/state; CACHE_ROOT=$TMP/prep/cache; WORKSPACE_ROOT=$TMP/prep/workspace
  MCP_TEMP_DIR=$TMP/prep/state/mcp-temp; MCP_BIND_SOURCE=$TMP/prep/run-mcp
  TERMINAL_RUNTIME_DIR=$TMP/prep/run-terminal; TERMINAL_WORKSPACE_ROOT=$TMP/prep/home/workspace
  mkdir -p "$TERMINAL_WORKSPACE_ROOT/existing"
  prepare_service_paths
)
[[ -d $TMP/prep/run-terminal/workspace ]]
grep -q '^setfacl -R -P -m u:release-terminal:rwX -- .*/home/workspace$' "$ACL_LOG"
grep -q '^setfacl -m d:u:release-terminal:rwX -- .*/home/workspace$' "$ACL_LOG"
grep -q '^setfacl -m d:u:release-terminal:rwX -- .*/home/workspace/existing$' "$ACL_LOG"
(
  set -Eeuo pipefail
  die() { printf 'release: error: %s\n' "$1" >&2; exit 1; }
  # shellcheck source=/dev/null
  source "$PREP_HELPERS"
  PATH="$TMP/no-acl-bin"
  TERMINAL_WORKSPACE_ROOT=$TMP/prep/home/workspace
  TERMINAL_USER=release-terminal
  prepare_terminal_workspace_acl
) >"$TMP/no-acl.out" 2>"$TMP/no-acl.err" && exit 1 || true
grep -q 'setfacl and getfacl are required to grant terminal workspace access' "$TMP/no-acl.err"

FAKE_SYSTEMCTL_FAIL=1 release_script --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" \
  --gateway-service pickleshell-test-gateway.service \
  --mcp-service pickleshell-test-tunnel.service \
  --terminal-service pickleshell-test-terminal.service --include-terminal \
  --systemctl "$BIN/fake-systemctl" --units-dir "$UNITS" >/dev/null 2>&1 && exit 1 || true
[[ $(readlink "$DEPLOY/active") == releases/$TWO ]]
[[ $(<"$UNITS/pickleshell-gateway.service") == 'old gateway unit' ]]
[[ $(<"$UNITS/pickleshell-tunnel.service") == 'old mcp unit' ]]
[[ $(<"$UNITS/pickleshell-terminal.service") == 'production terminal sentinel' ]]
[[ $(<"$UNITS/terminal-chatgpt.service") == 'separately managed terminal profile' ]]
[[ ! -e $UNITS/pickleshell-test-gateway.service ]]
[[ ! -e $UNITS/pickleshell-test-tunnel.service ]]
[[ ! -e $UNITS/pickleshell-test-terminal.service ]]
[[ $(<"$FAKE_SYSTEMCTL_LOG") == *'restart pickleshell-test-gateway.service'* ]]
[[ $(<"$FAKE_SYSTEMCTL_LOG") == *'restart pickleshell-test-tunnel.service'* ]]

mkdir -p "$TMP/first-units"
if FAKE_SYSTEMCTL_FAIL=1 release_script --source "$SOURCE" --root "$TMP/first-fail" --commit "$THREE" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" \
  --gateway-service pickleshell-test-gateway.service --mcp-service pickleshell-test-tunnel.service \
  --terminal-service pickleshell-test-terminal.service --include-terminal \
  --systemctl "$BIN/fake-systemctl" --units-dir "$TMP/first-units" >/dev/null 2>&1; then exit 1; fi
[[ ! -e $TMP/first-fail/active ]]
[[ ! -s $TMP/first-fail/state/current-target ]]
[[ ! -s $TMP/first-fail/state/previous-target ]]
[[ ! -e $TMP/first-units/pickleshell-test-gateway.service ]]
[[ ! -e $TMP/first-units/pickleshell-test-tunnel.service ]]
[[ ! -e $TMP/first-units/pickleshell-test-terminal.service ]]

mkdir -p "$TMP/first-rollback/releases/$THREE" "$TMP/first-rollback/state" "$TMP/first-rollback-units"
printf '%s\n' "$THREE" > "$TMP/first-rollback/releases/$THREE/.release-sha"
ln -s "releases/$THREE" "$TMP/first-rollback/active"
printf 'releases/%s\n' "$THREE" > "$TMP/first-rollback/state/current-target"
printf '' > "$TMP/first-rollback/state/previous-target"
if release_script --root "$TMP/first-rollback" --rollback --include-terminal \
  --gateway-group "$USER" --mcp-group "$USER" --terminal-group "$USER" \
  --gateway-service pickleshell-test-gateway.service --mcp-service pickleshell-test-tunnel.service \
  --terminal-service pickleshell-test-terminal.service \
  --systemctl "$BIN/fake-systemctl" --units-dir "$TMP/first-rollback-units" >"$TMP/first-rollback.err" 2>&1; then exit 1; fi
grep -q 'first activation rollback requires manual backup restore' "$TMP/first-rollback.err"
[[ $(readlink "$TMP/first-rollback/active") == releases/$THREE ]]

if release_script --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd \
  --gateway-service 'bad/name.service' >/dev/null 2>&1; then exit 1; fi
if release_script --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd \
  --mcp-service 'bad name.service' >/dev/null 2>&1; then exit 1; fi
if release_script --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd \
  --terminal-service terminal-chatgpt.service >/dev/null 2>&1; then exit 1; fi
if release_script --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd \
  --gateway-service duplicate.service --mcp-service duplicate.service >/dev/null 2>&1; then exit 1; fi
if release_script --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd \
  --config-root '/etc/pickle shell' >/dev/null 2>&1; then exit 1; fi
if release_script --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd \
  --config-root '/etc/@GATEWAY_USER@' >/dev/null 2>&1; then exit 1; fi
if release_script --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" --no-systemd \
  --node-executable '/tmp/node;systemd-directive' >/dev/null 2>&1; then exit 1; fi
if release_script --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" --no-systemd \
  --tunnel-profile '/etc/pickleshell/tunnel-client/../leak.yaml' >/dev/null 2>&1; then exit 1; fi
if release_script --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" --no-systemd \
  --mcp-bind-source /run/other-runtime >/dev/null 2>&1; then exit 1; fi
if release_script --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" --no-systemd \
  --mcp-bind-target /run/other-runtime >/dev/null 2>&1; then exit 1; fi
if release_script --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" --no-systemd \
  --mcp-temp-dir /tmp/pickleshell-mcp >/dev/null 2>&1; then exit 1; fi

UNTRUSTED_EXECUTABLE=$TMP/untrusted-executable
printf '#!/bin/sh\n' > "$UNTRUSTED_EXECUTABLE"
chmod 777 "$UNTRUSTED_EXECUTABLE"
if PATH="$BIN:$PATH" release_script --profile isolated --source "$SOURCE" --root /opt/pickleshell-test --commit "$THREE" \
  --node-executable "$UNTRUSTED_EXECUTABLE" --dry-run >/dev/null 2>&1; then exit 1; fi
ln -s "$UNTRUSTED_EXECUTABLE" "$TMP/unsafe-executable-link"
if PATH="$BIN:$PATH" release_script --profile isolated --source "$SOURCE" --root /opt/pickleshell-test --commit "$THREE" \
  --node-executable "$TMP/unsafe-executable-link" --dry-run >/dev/null 2>&1; then exit 1; fi
if release_script --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" \
  --units-dir "$TMP/units/../units" >/dev/null 2>&1; then exit 1; fi

rm "$ISOLATED_UNITS/pickleshell-test-gateway.service"
ln -s "$TMP/outside-unit" "$ISOLATED_UNITS/pickleshell-test-gateway.service"
if release_script --profile isolated --root "$ISOLATED_DEPLOY" --rollback \
  --systemctl "$BIN/fake-systemctl" --units-dir "$ISOLATED_UNITS" >/dev/null 2>&1; then exit 1; fi
rm "$ISOLATED_UNITS/pickleshell-test-gateway.service"

printf 'four\n' > "$SOURCE/gateway/version.txt"
git -C "$SOURCE" add gateway/version.txt
git -C "$SOURCE" commit -q -m four
FOUR=$(git -C "$SOURCE" rev-parse HEAD)
release_script --source "$SOURCE" --root "$ISOLATED_DEPLOY" --commit "$FOUR" \
  --gateway-group "$USER" --mcp-group "$USER" --terminal-group "$USER" \
  --gateway-service pickleshell-test-gateway.service \
  --mcp-service pickleshell-test-tunnel.service \
  --terminal-service pickleshell-test-terminal.service --include-terminal \
  --node-executable /usr/bin/node \
  --systemctl "$BIN/fake-systemctl" --units-dir "$ISOLATED_UNITS" >/dev/null
[[ $(readlink "$ISOLATED_DEPLOY/active") == releases/$FOUR ]]
[[ $(<"$ISOLATED_DEPLOY/state/current-target") == releases/$FOUR ]]
[[ $(<"$ISOLATED_DEPLOY/state/previous-target") == releases/$THREE ]]
release_script --root "$ISOLATED_DEPLOY" --rollback --include-terminal \
  --gateway-group "$USER" --mcp-group "$USER" --terminal-group "$USER" \
  --gateway-service pickleshell-test-gateway.service \
  --mcp-service pickleshell-test-tunnel.service \
  --terminal-service pickleshell-test-terminal.service \
  --systemctl "$BIN/fake-systemctl" --units-dir "$ISOLATED_UNITS" >/dev/null
[[ $(readlink "$ISOLATED_DEPLOY/active") == releases/$THREE ]]
[[ $(<"$ISOLATED_DEPLOY/state/current-target") == releases/$THREE ]]
[[ $(<"$ISOLATED_DEPLOY/state/previous-target") == releases/$FOUR ]]
THREE_GATEWAY_UNIT=$(<"$ISOLATED_UNITS/pickleshell-test-gateway.service")
grep -q 'restart pickleshell-test-gateway.service' "$FAKE_SYSTEMCTL_LOG"
grep -q 'is-active pickleshell-test-gateway.service' "$FAKE_SYSTEMCTL_LOG"
grep -q 'restart pickleshell-test-tunnel.service' "$FAKE_SYSTEMCTL_LOG"
grep -q 'is-active pickleshell-test-tunnel.service' "$FAKE_SYSTEMCTL_LOG"
grep -q 'restart pickleshell-test-terminal.service' "$FAKE_SYSTEMCTL_LOG"
grep -q 'is-active pickleshell-test-terminal.service' "$FAKE_SYSTEMCTL_LOG"

printf 'releases/invalid-target\n' > "$ISOLATED_DEPLOY/state/previous-target"
if release_script --root "$ISOLATED_DEPLOY" --rollback --include-terminal \
  --gateway-group "$USER" --mcp-group "$USER" --terminal-group "$USER" \
  --gateway-service pickleshell-test-gateway.service \
  --mcp-service pickleshell-test-tunnel.service \
  --terminal-service pickleshell-test-terminal.service \
  --systemctl "$BIN/fake-systemctl" --units-dir "$ISOLATED_UNITS" >/dev/null 2>&1; then exit 1; fi
[[ $(readlink "$ISOLATED_DEPLOY/active") == releases/$THREE ]]
[[ $(<"$ISOLATED_DEPLOY/state/current-target") == releases/$THREE ]]
[[ $(<"$ISOLATED_UNITS/pickleshell-test-gateway.service") == "$THREE_GATEWAY_UNIT" ]]

FAKE_NPM_FAIL=1 release_script --source "$SOURCE" --root "$DEPLOY" --commit "$FOUR" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd >/dev/null 2>&1 && exit 1 || true
[[ $(readlink "$DEPLOY/active") == releases/$TWO ]]
[[ ! -e $DEPLOY/releases/$FOUR ]]
! compgen -G "$DEPLOY/releases/.staging-*" >/dev/null

mkdir -p "$SOURCE/gateway/node_modules/npm-package/bin" "$SOURCE/gateway/node_modules/.bin"
printf '#!/bin/sh\n' > "$SOURCE/gateway/node_modules/npm-package/bin/tool"
chmod +x "$SOURCE/gateway/node_modules/npm-package/bin/tool"
ln -s ../npm-package/bin/tool "$SOURCE/gateway/node_modules/.bin/tool"
git -C "$SOURCE" add gateway/node_modules
git -C "$SOURCE" commit -q -m 'allow internal release symlinks'
SAFE_LINK=$(git -C "$SOURCE" rev-parse HEAD)
release_script --source "$SOURCE" --root "$DEPLOY" --commit "$SAFE_LINK" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd >/dev/null
[[ $(readlink "$DEPLOY/active") == releases/$SAFE_LINK ]]
[[ $(readlink "$DEPLOY/releases/$SAFE_LINK/gateway/node_modules/.bin/tool") == '../npm-package/bin/tool' ]]
[[ $(stat -c '%a' "$DEPLOY/releases/$SAFE_LINK/gateway/node_modules/npm-package/bin/tool") == 555 ]]

for link_case in external absolute traversal broken; do
  rm "$SOURCE/gateway/node_modules/.bin/tool"
  case "$link_case" in
    external) ln -s ../../../deploy/systemd/pickleshell-gateway.service.in "$SOURCE/gateway/node_modules/.bin/tool" ;;
    absolute) ln -s /tmp/outside-release-target "$SOURCE/gateway/node_modules/.bin/tool" ;;
    traversal) ln -s ../../../../outside-release-target "$SOURCE/gateway/node_modules/.bin/tool" ;;
    broken) ln -s ../npm-package/bin/missing "$SOURCE/gateway/node_modules/.bin/tool" ;;
  esac
  git -C "$SOURCE" add -A gateway/node_modules/.bin/tool
  git -C "$SOURCE" commit -q -m "reject $link_case release symlink"
  UNSAFE_LINK=$(git -C "$SOURCE" rev-parse HEAD)
  if release_script --source "$SOURCE" --root "$DEPLOY" --commit "$UNSAFE_LINK" \
    --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd >/dev/null 2>&1; then
    exit 1
  fi
  [[ $(readlink "$DEPLOY/active") == releases/$SAFE_LINK ]]
  [[ ! -e "$DEPLOY/releases/$UNSAFE_LINK" ]]
  ! compgen -G "$DEPLOY/releases/.staging-*" >/dev/null
done

printf 'dirty\n' > "$SOURCE/untracked-file"
if release_script --source "$SOURCE" --root "$DEPLOY" --commit "$FOUR" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd >/dev/null 2>&1; then exit 1; fi
rm "$SOURCE/untracked-file"

if release_script --source "$SOURCE" --root "$DEPLOY" --commit "0000000000000000000000000000000000000000" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd >/dev/null 2>&1; then exit 1; fi

ln -s "$DEPLOY" "$TMP/deploy-link"
if release_script --source "$SOURCE" --root "$TMP/deploy-link" --commit "$TWO" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd >/dev/null 2>&1; then exit 1; fi

if release_script --source "$SOURCE" --root "$TMP/unsafe/.." --commit "$TWO" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd >/dev/null 2>&1; then exit 1; fi

DRY_ROOT=$TMP/dry-run-root
release_script --source "$SOURCE" --root "$DRY_ROOT" --commit "$FOUR" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --dry-run >/dev/null
[[ ! -e "$DRY_ROOT" ]]

isolated_env_deploy=$TMP/isolated-env-deploy
NPM_ENV_LOG=$TMP/npm-env.log
export NPM_ENV_LOG
cat > "$BIN/npm" <<'FAKE_NPM_ENV_CHECK'
#!/usr/bin/env bash
set -Eeuo pipefail
prefix=''
while (($#)); do
  if [[ $1 == --prefix ]]; then prefix=$2; shift 2; else shift; fi
done
[[ -n $prefix ]]
[[ -w $prefix ]] || { printf 'env-check: prefix not writable: %s\n' "$prefix" >&2; exit 13; }
case "$prefix" in
  */gateway) expected_user=release-gateway ;;
  */mcp-server) expected_user=release-mcp ;;
  */terminal) expected_user=release-terminal ;;
  *) printf 'env-check: unexpected prefix: %s\n' "$prefix" >&2; exit 13 ;;
esac
release_root=${prefix%/*}
[[ ${FAKE_RUNUSER_USER:-} == "$expected_user" ]] || { printf 'env-check: wrong runuser target for %s: %s\n' "$prefix" "${FAKE_RUNUSER_USER:-}" >&2; exit 13; }
[[ ${HOME:-} == "$release_root/.build-env/$expected_user/home" ]] || { printf 'env-check: bad HOME: %s\n' "${HOME:-}" >&2; exit 13; }
[[ ${TMPDIR:-} == "$release_root/.build-env/$expected_user/tmp" ]] || { printf 'env-check: bad TMPDIR: %s\n' "${TMPDIR:-}" >&2; exit 13; }
[[ ${NPM_CONFIG_CACHE:-} == "$release_root/.build-env/$expected_user/npm-cache" ]] || { printf 'env-check: bad NPM_CONFIG_CACHE: %s\n' "${NPM_CONFIG_CACHE:-}" >&2; exit 13; }
[[ "$HOME" != /nonexistent ]] || { printf 'env-check: HOME still /nonexistent\n' >&2; exit 13; }
for dir in "$HOME" "$TMPDIR" "$NPM_CONFIG_CACHE"; do
  [[ -d $dir ]] || { printf 'env-check: missing dir: %s\n' "$dir" >&2; exit 13; }
  [[ -w $dir ]] || { printf 'env-check: dir not writable: %s\n' "$dir" >&2; exit 13; }
done
printf '%s %s %s %s\n' "$expected_user" "$HOME" "$TMPDIR" "$NPM_CONFIG_CACHE" >> "${NPM_ENV_LOG:?}"
if [[ $prefix == */mcp-server ]]; then mkdir -p "$prefix/dist"; printf '// test\n' > "$prefix/dist/index.js"
elif [[ $prefix == */terminal ]]; then mkdir -p "$prefix/bin"; printf '#!/bin/sh\n' > "$prefix/bin/cgroup-launcher"; chmod +x "$prefix/bin/cgroup-launcher"; fi
FAKE_NPM_ENV_CHECK
chmod +x "$BIN/npm"
PATH="$BIN:$PATH" release_script --source "$SOURCE" --root "$isolated_env_deploy" --commit "$FOUR" \
  --gateway-user release-gateway --mcp-user release-mcp --terminal-user release-terminal --no-systemd >/dev/null
[[ -L "$isolated_env_deploy/active" ]]
[[ $(readlink "$isolated_env_deploy/active") == "releases/$FOUR" ]]
! compgen -G "$isolated_env_deploy/releases/.staging-*" >/dev/null
[[ ! -e "$isolated_env_deploy/releases/$FOUR/.build-env" ]]
grep -q "^release-gateway $isolated_env_deploy/releases/.staging-$FOUR-" "$NPM_ENV_LOG"
grep -q "^release-mcp $isolated_env_deploy/releases/.staging-$FOUR-" "$NPM_ENV_LOG"
grep -q "^release-terminal $isolated_env_deploy/releases/.staging-$FOUR-" "$NPM_ENV_LOG"
grep -q "release-gateway $isolated_env_deploy/releases/.staging-$FOUR-.*/.build-env/release-gateway$" "$FAKE_CHOWN_LOG"
grep -q "release-mcp $isolated_env_deploy/releases/.staging-$FOUR-.*/.build-env/release-mcp$" "$FAKE_CHOWN_LOG"
grep -q "release-terminal $isolated_env_deploy/releases/.staging-$FOUR-.*/.build-env/release-terminal$" "$FAKE_CHOWN_LOG"

cat > "$BIN/npm" <<'FAKE_NPM'
#!/usr/bin/env bash
set -Eeuo pipefail
prefix=''
while (($#)); do
  if [[ $1 == --prefix ]]; then prefix=$2; shift 2; else shift; fi
done
[[ -n $prefix ]]
[[ -w $prefix ]] || { printf 'fake npm: prefix is not writable: %s\n' "$prefix" >&2; exit 13; }
if [[ ${FAKE_NPM_FAIL:-0} == 1 ]]; then exit 42; fi
if [[ $prefix == */mcp-server ]]; then mkdir -p "$prefix/dist"; printf '// test\n' > "$prefix/dist/index.js"
elif [[ $prefix == */terminal ]]; then mkdir -p "$prefix/bin"; printf '#!/bin/sh\n' > "$prefix/bin/cgroup-launcher"; chmod +x "$prefix/bin/cgroup-launcher"; fi
FAKE_NPM
chmod +x "$BIN/npm"

printf 'deployment release tests passed\n'
