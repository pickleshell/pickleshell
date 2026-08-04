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
if [[ ${FAKE_NPM_FAIL:-0} == 1 ]]; then exit 42; fi
if [[ $prefix == */mcp-server ]]; then mkdir -p "$prefix/dist"; printf '// test\n' > "$prefix/dist/index.js"; fi
if [[ $prefix == */terminal ]]; then mkdir -p "$prefix/bin"; printf '#!/bin/sh\n' > "$prefix/bin/cgroup-launcher"; chmod +x "$prefix/bin/cgroup-launcher"; fi
FAKE_NPM
chmod +x "$BIN/npm"

USER=$(id -un)
export PATH="$BIN:$PATH"

"$SCRIPT" --source "$SOURCE" --root "$DEPLOY" --commit "$ONE" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd
[[ -L $DEPLOY/active ]]
[[ $(readlink "$DEPLOY/active") == releases/$ONE ]]
[[ $(<"$DEPLOY/releases/$ONE/.release-sha") == "$ONE" ]]
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
FAKE_SYSTEMCTL_FAIL=1 "$SCRIPT" --source "$SOURCE" --root "$DEPLOY" --commit "$THREE" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" \
  --gateway-service pickleshell-test-gateway.service \
  --mcp-service pickleshell-test-mcp.service \
  --terminal-service pickleshell-test-terminal.service --include-terminal \
  --systemctl "$BIN/fake-systemctl" --units-dir "$UNITS" >/dev/null 2>&1 && exit 1 || true
[[ $(readlink "$DEPLOY/active") == releases/$TWO ]]
[[ $(<"$UNITS/pickleshell-gateway.service") == 'old gateway unit' ]]
[[ $(<"$UNITS/pickleshell-tunnel.service") == 'old mcp unit' ]]
[[ $(<"$UNITS/pickleshell-terminal.service") == 'production terminal sentinel' ]]
[[ $(<"$UNITS/terminal-chatgpt.service") == 'separately managed terminal profile' ]]
[[ ! -e $UNITS/pickleshell-test-gateway.service ]]
[[ ! -e $UNITS/pickleshell-test-mcp.service ]]
[[ ! -e $UNITS/pickleshell-test-terminal.service ]]
[[ $(<"$FAKE_SYSTEMCTL_LOG") == *'restart pickleshell-test-gateway.service'* ]]
[[ $(<"$FAKE_SYSTEMCTL_LOG") == *'restart pickleshell-test-mcp.service'* ]]

mkdir -p "$TMP/first-units"
if FAKE_SYSTEMCTL_FAIL=1 "$SCRIPT" --source "$SOURCE" --root "$TMP/first-fail" --commit "$THREE" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" \
  --gateway-service pickleshell-test-gateway.service --mcp-service pickleshell-test-mcp.service \
  --terminal-service pickleshell-test-terminal.service --include-terminal \
  --systemctl "$BIN/fake-systemctl" --units-dir "$TMP/first-units" >/dev/null 2>&1; then exit 1; fi
[[ ! -e $TMP/first-fail/active ]]
[[ ! -e $TMP/first-units/pickleshell-test-gateway.service ]]
[[ ! -e $TMP/first-units/pickleshell-test-mcp.service ]]
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

printf 'four\n' > "$SOURCE/gateway/version.txt"
git -C "$SOURCE" add gateway/version.txt
git -C "$SOURCE" commit -q -m four
FOUR=$(git -C "$SOURCE" rev-parse HEAD)
FAKE_NPM_FAIL=1 "$SCRIPT" --source "$SOURCE" --root "$DEPLOY" --commit "$FOUR" \
  --gateway-user "$USER" --mcp-user "$USER" --terminal-user "$USER" --no-systemd >/dev/null 2>&1 && exit 1 || true
[[ $(readlink "$DEPLOY/active") == releases/$TWO ]]
[[ ! -e $DEPLOY/releases/$FOUR ]]

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

printf 'deployment release tests passed\n'
