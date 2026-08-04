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

cat > "$BIN/chown" <<'FAKE_CHOWN'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ $1 == -h ]]; then shift; fi
[[ $1 == -- ]]
shift
owner=$1
shift
[[ $# -eq 1 ]]
path=$1
[[ $owner == root:root ]] && chmod a-w -- "$path" || chmod u+rwx -- "$path"
FAKE_CHOWN
chmod +x "$BIN/chown"

USER=$(id -un)
export PATH="$BIN:$PATH"

cat > "$BIN/id" <<'FAKE_ID'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ $1 == -u ]]; then printf '0\n'; exit 0; fi
case "$1" in
  pickleshell-test|pickleshell-test-tunnel|pickleshell-test-terminal) exit 0 ;;
  *) exec /usr/bin/id "$@" ;;
esac
FAKE_ID
chmod +x "$BIN/id"

cat > "$BIN/runuser" <<'FAKE_RUNUSER'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ $1 == -u && $3 == -- ]]
shift 3
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

"$SCRIPT" --source "$SOURCE" --root "$DEPLOY" --commit "$ONE" \
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
"$SCRIPT" --source "$SOURCE" --root "$DEPLOY" --commit "$TWO" \
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

PATH="$BIN:$PATH" "$SCRIPT" --profile isolated --source "$SOURCE" --root /opt/pickleshell-test --commit "$THREE" \
  --node-executable /usr/bin/node --tunnel-client-executable /usr/local/bin/tunnel-client --dry-run >/dev/null

ISOLATED_DEPLOY=$TMP/isolated-deploy
ISOLATED_UNITS=$TMP/isolated-units
mkdir -p "$ISOLATED_UNITS"
"$SCRIPT" --source "$SOURCE" --root "$ISOLATED_DEPLOY" --commit "$THREE" \
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
grep -q 'TasksMax=256' "$ISOLATED_UNITS/pickleshell-test-tunnel.service"
grep -q 'Environment=PICKLESHELL_TERMINAL_SOCKET=/run/pickleshell-test-terminal/service.sock' "$ISOLATED_UNITS/pickleshell-test-terminal.service"
[[ ! -e "$ISOLATED_UNITS/terminal-chatgpt.service" ]]

FAKE_SYSTEMCTL_FAIL=1 "$SCRIPT" --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" \
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
if FAKE_SYSTEMCTL_FAIL=1 "$SCRIPT" --source "$SOURCE" --root "$TMP/first-fail" --commit "$THREE" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" \
  --gateway-service pickleshell-test-gateway.service --mcp-service pickleshell-test-tunnel.service \
  --terminal-service pickleshell-test-terminal.service --include-terminal \
  --systemctl "$BIN/fake-systemctl" --units-dir "$TMP/first-units" >/dev/null 2>&1; then exit 1; fi
[[ ! -e $TMP/first-fail/active ]]
[[ ! -e $TMP/first-units/pickleshell-test-gateway.service ]]
[[ ! -e $TMP/first-units/pickleshell-test-tunnel.service ]]
[[ ! -e $TMP/first-units/pickleshell-test-terminal.service ]]

if "$SCRIPT" --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd \
  --gateway-service 'bad/name.service' >/dev/null 2>&1; then exit 1; fi
if "$SCRIPT" --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd \
  --mcp-service 'bad name.service' >/dev/null 2>&1; then exit 1; fi
if "$SCRIPT" --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd \
  --terminal-service terminal-chatgpt.service >/dev/null 2>&1; then exit 1; fi
if "$SCRIPT" --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd \
  --gateway-service duplicate.service --mcp-service duplicate.service >/dev/null 2>&1; then exit 1; fi
if "$SCRIPT" --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd \
  --config-root '/etc/pickle shell' >/dev/null 2>&1; then exit 1; fi
if "$SCRIPT" --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd \
  --config-root '/etc/@GATEWAY_USER@' >/dev/null 2>&1; then exit 1; fi
if "$SCRIPT" --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" --no-systemd \
  --node-executable '/tmp/node;systemd-directive' >/dev/null 2>&1; then exit 1; fi
if "$SCRIPT" --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" --no-systemd \
  --tunnel-profile '/etc/pickleshell/tunnel-client/../leak.yaml' >/dev/null 2>&1; then exit 1; fi
if "$SCRIPT" --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" --no-systemd \
  --mcp-bind-source /run/other-runtime >/dev/null 2>&1; then exit 1; fi
if "$SCRIPT" --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" --no-systemd \
  --mcp-bind-target /run/other-runtime >/dev/null 2>&1; then exit 1; fi
if "$SCRIPT" --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" --no-systemd \
  --mcp-temp-dir /tmp/pickleshell-mcp >/dev/null 2>&1; then exit 1; fi

UNTRUSTED_EXECUTABLE=$TMP/untrusted-executable
printf '#!/bin/sh\n' > "$UNTRUSTED_EXECUTABLE"
chmod 777 "$UNTRUSTED_EXECUTABLE"
if PATH="$BIN:$PATH" "$SCRIPT" --profile isolated --source "$SOURCE" --root /opt/pickleshell-test --commit "$THREE" \
  --node-executable "$UNTRUSTED_EXECUTABLE" --dry-run >/dev/null 2>&1; then exit 1; fi
ln -s "$UNTRUSTED_EXECUTABLE" "$TMP/unsafe-executable-link"
if PATH="$BIN:$PATH" "$SCRIPT" --profile isolated --source "$SOURCE" --root /opt/pickleshell-test --commit "$THREE" \
  --node-executable "$TMP/unsafe-executable-link" --dry-run >/dev/null 2>&1; then exit 1; fi
if "$SCRIPT" --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" \
  --units-dir "$TMP/units/../units" >/dev/null 2>&1; then exit 1; fi

rm "$ISOLATED_UNITS/pickleshell-test-gateway.service"
ln -s "$TMP/outside-unit" "$ISOLATED_UNITS/pickleshell-test-gateway.service"
if "$SCRIPT" --profile isolated --root "$ISOLATED_DEPLOY" --rollback \
  --systemctl "$BIN/fake-systemctl" --units-dir "$ISOLATED_UNITS" >/dev/null 2>&1; then exit 1; fi
rm "$ISOLATED_UNITS/pickleshell-test-gateway.service"

printf 'four\n' > "$SOURCE/gateway/version.txt"
git -C "$SOURCE" add gateway/version.txt
git -C "$SOURCE" commit -q -m four
FOUR=$(git -C "$SOURCE" rev-parse HEAD)
"$SCRIPT" --source "$SOURCE" --root "$ISOLATED_DEPLOY" --commit "$FOUR" \
  --gateway-group "$USER" --mcp-group "$USER" --terminal-group "$USER" \
  --gateway-service pickleshell-test-gateway.service \
  --mcp-service pickleshell-test-tunnel.service \
  --terminal-service pickleshell-test-terminal.service --include-terminal \
  --node-executable /usr/bin/node \
  --systemctl "$BIN/fake-systemctl" --units-dir "$ISOLATED_UNITS" >/dev/null
[[ $(readlink "$ISOLATED_DEPLOY/active") == releases/$FOUR ]]
[[ $(<"$ISOLATED_DEPLOY/state/current-target") == releases/$FOUR ]]
[[ $(<"$ISOLATED_DEPLOY/state/previous-target") == releases/$THREE ]]
FOUR_GATEWAY_UNIT=$(<"$ISOLATED_UNITS/pickleshell-test-gateway.service")
"$SCRIPT" --root "$ISOLATED_DEPLOY" --rollback --include-terminal \
  --gateway-group "$USER" --mcp-group "$USER" --terminal-group "$USER" \
  --gateway-service pickleshell-test-gateway.service \
  --mcp-service pickleshell-test-tunnel.service \
  --terminal-service pickleshell-test-terminal.service \
  --systemctl "$BIN/fake-systemctl" --units-dir "$ISOLATED_UNITS" >/dev/null
[[ $(readlink "$ISOLATED_DEPLOY/active") == releases/$THREE ]]
[[ $(<"$ISOLATED_DEPLOY/state/current-target") == releases/$THREE ]]
[[ $(<"$ISOLATED_DEPLOY/state/previous-target") == releases/$FOUR ]]
[[ $(<"$ISOLATED_UNITS/pickleshell-test-gateway.service") != "$FOUR_GATEWAY_UNIT" ]]
THREE_GATEWAY_UNIT=$(<"$ISOLATED_UNITS/pickleshell-test-gateway.service")
grep -q 'restart pickleshell-test-gateway.service' "$FAKE_SYSTEMCTL_LOG"
grep -q 'is-active pickleshell-test-gateway.service' "$FAKE_SYSTEMCTL_LOG"
grep -q 'restart pickleshell-test-tunnel.service' "$FAKE_SYSTEMCTL_LOG"
grep -q 'is-active pickleshell-test-tunnel.service' "$FAKE_SYSTEMCTL_LOG"
grep -q 'restart pickleshell-test-terminal.service' "$FAKE_SYSTEMCTL_LOG"
grep -q 'is-active pickleshell-test-terminal.service' "$FAKE_SYSTEMCTL_LOG"

printf 'releases/invalid-target\n' > "$ISOLATED_DEPLOY/state/previous-target"
if "$SCRIPT" --root "$ISOLATED_DEPLOY" --rollback --include-terminal \
  --gateway-group "$USER" --mcp-group "$USER" --terminal-group "$USER" \
  --gateway-service pickleshell-test-gateway.service \
  --mcp-service pickleshell-test-tunnel.service \
  --terminal-service pickleshell-test-terminal.service \
  --systemctl "$BIN/fake-systemctl" --units-dir "$ISOLATED_UNITS" >/dev/null 2>&1; then exit 1; fi
[[ $(readlink "$ISOLATED_DEPLOY/active") == releases/$THREE ]]
[[ $(<"$ISOLATED_DEPLOY/state/current-target") == releases/$THREE ]]
[[ $(<"$ISOLATED_UNITS/pickleshell-test-gateway.service") == "$THREE_GATEWAY_UNIT" ]]

FAKE_NPM_FAIL=1 "$SCRIPT" --source "$SOURCE" --root "$DEPLOY" --commit "$FOUR" \
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
"$SCRIPT" --source "$SOURCE" --root "$DEPLOY" --commit "$SAFE_LINK" \
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
  if "$SCRIPT" --source "$SOURCE" --root "$DEPLOY" --commit "$UNSAFE_LINK" \
    --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd >/dev/null 2>&1; then
    exit 1
  fi
  [[ $(readlink "$DEPLOY/active") == releases/$SAFE_LINK ]]
  [[ ! -e "$DEPLOY/releases/$UNSAFE_LINK" ]]
  ! compgen -G "$DEPLOY/releases/.staging-*" >/dev/null
done

printf 'dirty\n' > "$SOURCE/untracked-file"
if "$SCRIPT" --source "$SOURCE" --root "$DEPLOY" --commit "$FOUR" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd >/dev/null 2>&1; then exit 1; fi
rm "$SOURCE/untracked-file"

if "$SCRIPT" --source "$SOURCE" --root "$DEPLOY" --commit "0000000000000000000000000000000000000000" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd >/dev/null 2>&1; then exit 1; fi

ln -s "$DEPLOY" "$TMP/deploy-link"
if "$SCRIPT" --source "$SOURCE" --root "$TMP/deploy-link" --commit "$TWO" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd >/dev/null 2>&1; then exit 1; fi

if "$SCRIPT" --source "$SOURCE" --root "$TMP/unsafe/.." --commit "$TWO" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd >/dev/null 2>&1; then exit 1; fi

DRY_ROOT=$TMP/dry-run-root
"$SCRIPT" --source "$SOURCE" --root "$DRY_ROOT" --commit "$FOUR" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --dry-run >/dev/null
[[ ! -e "$DRY_ROOT" ]]

printf 'deployment release tests passed\n'
