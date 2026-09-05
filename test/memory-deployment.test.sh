#!/usr/bin/env bash
set -Eeuo pipefail

REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
TMP=$(mktemp -d)
trap 'find -P "$TMP" -type d -exec chmod u+w {} + 2>/dev/null || true; rm -rf -- "$TMP"' EXIT
FIXTURE="$TMP/source"
PREFIX="$TMP/isolated"
mkdir -p -- "$FIXTURE/deploy/systemd" "$FIXTURE/pickleshell-memory-mcp" "$PREFIX/bin" "$PREFIX/config" "$PREFIX/log" "$PREFIX/units" "$PREFIX/logrotate"
cp -a -- "$REPO/pickleshell-memory-mcp/." "$FIXTURE/pickleshell-memory-mcp/"
rm -rf -- "$FIXTURE/pickleshell-memory-mcp/node_modules"
cp -- "$REPO/deploy/memory-release.sh" "$FIXTURE/deploy/"
cp -- "$REPO/deploy/systemd/pickleshell-memory-backend.service.in" "$FIXTURE/deploy/systemd/"
cp -- "$REPO/deploy/systemd/pickleshell-memory-mcp.sh.in" "$FIXTURE/deploy/systemd/"
cp -- "$REPO/deploy/systemd/pickleshell-memory-backend.sh.in" "$FIXTURE/deploy/systemd/"
cp -- "$REPO/deploy/systemd/pickleshell-memory.logrotate.in" "$FIXTURE/deploy/systemd/"

if "$FIXTURE/deploy/memory-release.sh" --profile isolated >"$TMP/isolated-defaults.out" 2>&1; then
  echo 'isolated profile unexpectedly accepted production defaults' >&2
  exit 1
fi
grep -q 'isolated profile requires explicit dedicated deployment paths and service identity' "$TMP/isolated-defaults.out"
test ! -e "$TMP/systemctl-called"

PREFLIGHT="$TMP/preflight"
mkdir -p -- "$PREFLIGHT/bin"
cp -- "$(command -v node)" "$PREFLIGHT/bin/node"
cat > "$PREFLIGHT/bin/systemctl" <<EOF
#!/usr/bin/env bash
touch '$TMP/systemctl-called'
exit 1
EOF
chmod 0755 "$PREFLIGHT/bin/node" "$PREFLIGHT/bin/systemctl"
preflight_args=(
  --profile isolated --root "$PREFLIGHT/app" --config-root "$PREFLIGHT/config"
  --state-root "$PREFLIGHT/state" --log-root "$PREFLIGHT/log" --units-dir "$PREFLIGHT/units"
  --logrotate-dir "$PREFLIGHT/logrotate" --wrapper-dir "$PREFLIGHT/wrappers"
  --backend-executable "$PREFLIGHT/bin/node" --systemctl "$PREFLIGHT/bin/systemctl"
  --service-user isolated-memory --service-group isolated-memory
  --service pickleshell-memory-isolated.service --rollback
)
if "$FIXTURE/deploy/memory-release.sh" "${preflight_args[@]}" --config-root /etc/pickleshell-memory >"$TMP/isolated-production-path.out" 2>&1; then
  echo 'isolated profile unexpectedly accepted a production path' >&2
  exit 1
fi
grep -q 'isolated deployment paths must share the dedicated root prefix' "$TMP/isolated-production-path.out"
if "$FIXTURE/deploy/memory-release.sh" "${preflight_args[@]}" --service pickleshell-memory-backend.service >"$TMP/isolated-production-service.out" 2>&1; then
  echo 'isolated profile unexpectedly accepted the production service' >&2
  exit 1
fi
grep -q 'isolated profile rejects production service identity' "$TMP/isolated-production-service.out"
test ! -e "$PREFLIGHT/app"
test ! -e "$PREFLIGHT/state"
test ! -e "$PREFLIGHT/log"
test ! -e "$PREFLIGHT/units"
test ! -e "$TMP/systemctl-called"

for artifact in "$FIXTURE"/deploy/systemd/*.in; do
  printf '\n# release-marker: v1\n' >> "$artifact"
done

git -C "$FIXTURE" init -q
git -C "$FIXTURE" config user.email fixture@example.invalid
git -C "$FIXTURE" config user.name Fixture
git -C "$FIXTURE" add .
git -C "$FIXTURE" commit -qm v1
SHA1=$(git -C "$FIXTURE" rev-parse HEAD)

cat > "$PREFIX/bin/backend.js" <<'EOF'
#!/usr/bin/env node
const http = require('node:http');
const port = Number(process.env.FAKE_BACKEND_PORT);
http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/health') res.end(JSON.stringify({status:'ok', provider:'fixture'}));
  else { res.statusCode = 404; res.end(JSON.stringify({error:'not found'})); }
}).listen(port, '127.0.0.1');
EOF
chmod 0755 "$PREFIX/bin/backend.js"
PORT=$((20000 + RANDOM % 20000))
printf 'FAKE_BACKEND_PORT=%s\n' "$PORT" > "$PREFIX/config/backend.env"
printf '%s\n' \
  'PICKLESHELL_MEMORY_ROLE=agent' \
  'PICKLESHELL_MEMORY_ACTOR=fixture-agent' \
  'PICKLESHELL_MEMORY_SCOPE=fixture-scope' \
  "PICKLESHELL_MEMORY_BACKEND_URL=http://127.0.0.1:$PORT" \
  "PICKLESHELL_MEMORY_AUDIT_LOG=$PREFIX/log/audit.jsonl" > "$PREFIX/config/mcp.env"
chmod 0640 "$PREFIX/config/backend.env" "$PREFIX/config/mcp.env"

cat > "$PREFIX/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "${FAKE_SYSTEMD_ROOT:?}/systemctl.calls"
case "$1" in
  daemon-reload|is-active) exit 0 ;;
  stop)
    pidfile=${FAKE_SYSTEMD_ROOT:?}/backend.pid
    if [[ -f $pidfile ]]; then kill "$(<"$pidfile")" 2>/dev/null || true; wait "$(<"$pidfile")" 2>/dev/null || true; fi
    exit 0
    ;;
  restart)
    pidfile=${FAKE_SYSTEMD_ROOT:?}/backend.pid
    if [[ -f $pidfile ]]; then kill "$(<"$pidfile")" 2>/dev/null || true; wait "$(<"$pidfile")" 2>/dev/null || true; fi
    if [[ $2 == pickleshell-memory-isolated.service || $2 == pickleshell-memory-first-failure.service ]]; then
      set -a
      source "${FAKE_SYSTEMD_ROOT}/config/backend.env"
      set +a
      "${FAKE_SYSTEMD_ROOT}/bin/backend-wrapper" >/dev/null 2>&1 & echo $! > "$pidfile"
      for _ in {1..50}; do
        kill -0 "$!" 2>/dev/null || exit 1
        curl --fail --silent --max-time 0.2 "http://127.0.0.1:${FAKE_BACKEND_PORT}/health" >/dev/null && exit 0
        sleep 0.02
      done
      exit 1
    fi
    ;;
esac
EOF
chmod 0755 "$PREFIX/bin/systemctl"

cat > "$PREFIX/bin/logrotate" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
config=$1
log=$(awk 'NR == 1 { print $1 }' "$config")
read -r _ mode owner group < <(awk '$1 == "create" { print }' "$config")
mv -- "$log" "$log.1"
install -m "$mode" -o "$owner" -g "$group" /dev/null "$log"
EOF
chmod 0755 "$PREFIX/bin/logrotate"

install_release() {
  FAKE_SYSTEMD_ROOT="$PREFIX" "$FIXTURE/deploy/memory-release.sh" \
    --profile isolated --source "$FIXTURE" --root "$PREFIX/app" --commit "$1" \
    --config-root "$PREFIX/config" --state-root "$PREFIX/state" --log-root "$PREFIX/log" \
    --units-dir "$PREFIX/units" --logrotate-dir "$PREFIX/logrotate" \
    --backend-executable "$PREFIX/bin/backend.js" --node-executable "$(command -v node)" \
    --service-user "$(id -un)" --service-group "$(id -gn)" \
    --service pickleshell-memory-isolated.service \
    --systemctl "$PREFIX/bin/systemctl" --wrapper-dir "$PREFIX/bin"
}

FIRST_FAILURE="$TMP/first-failure"
mkdir -p -- "$FIRST_FAILURE"/{app,bin,config,log,logrotate,state,units}
cp -- "$PREFIX/bin/backend.js" "$PREFIX/bin/systemctl" "$FIRST_FAILURE/bin/"
chmod 0755 "$FIRST_FAILURE/bin/backend.js" "$FIRST_FAILURE/bin/systemctl"
FIRST_PORT=$((40001 + RANDOM % 10000))
printf 'FAKE_BACKEND_PORT=%s\n' "$FIRST_PORT" > "$FIRST_FAILURE/config/backend.env"
printf '%s\n' \
  'PICKLESHELL_MEMORY_ROLE=agent' \
  'PICKLESHELL_MEMORY_ACTOR=fixture-agent' \
  'PICKLESHELL_MEMORY_SCOPE=fixture-scope' \
  'PICKLESHELL_MEMORY_BACKEND_URL=http://127.0.0.1:1' \
  "PICKLESHELL_MEMORY_AUDIT_LOG=$FIRST_FAILURE/log/audit.jsonl" > "$FIRST_FAILURE/config/mcp.env"
chmod 0640 "$FIRST_FAILURE/config/backend.env" "$FIRST_FAILURE/config/mcp.env"
if FAKE_SYSTEMD_ROOT="$FIRST_FAILURE" "$FIXTURE/deploy/memory-release.sh" \
  --profile isolated --source "$FIXTURE" --root "$FIRST_FAILURE/app" --commit "$SHA1" \
  --config-root "$FIRST_FAILURE/config" --state-root "$FIRST_FAILURE/state" --log-root "$FIRST_FAILURE/log" \
  --units-dir "$FIRST_FAILURE/units" --logrotate-dir "$FIRST_FAILURE/logrotate" \
  --backend-executable "$FIRST_FAILURE/bin/backend.js" --node-executable "$(command -v node)" \
  --service-user "$(id -un)" --service-group "$(id -gn)" \
  --service pickleshell-memory-first-failure.service \
  --systemctl "$FIRST_FAILURE/bin/systemctl" --wrapper-dir "$FIRST_FAILURE/bin" \
  >"$TMP/first-failure.out" 2>&1; then
  echo 'failed first activation unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'activation readiness failed; first activation cleaned up' "$TMP/first-failure.out"
! grep -q 'memory-release: active release\|memory-release: rolled back' "$TMP/first-failure.out"
test -f "$FIRST_FAILURE/backend.pid" || { cat "$TMP/first-failure.out" >&2; exit 1; }
FIRST_FAILURE_PID=$(<"$FIRST_FAILURE/backend.pid")
! kill -0 "$FIRST_FAILURE_PID" 2>/dev/null
test ! -e "$FIRST_FAILURE/app/active"
test -z "$(<"$FIRST_FAILURE/app/state/current-target")"
test -z "$(<"$FIRST_FAILURE/app/state/previous-target")"
for artifact in \
  "$FIRST_FAILURE/units/pickleshell-memory-first-failure.service" \
  "$FIRST_FAILURE/bin/backend-wrapper" \
  "$FIRST_FAILURE/bin/pickleshell-memory-mcp" \
  "$FIRST_FAILURE/bin/pickleshell-memory-ready" \
  "$FIRST_FAILURE/logrotate/pickleshell-memory"; do
  test ! -e "$artifact"
done
test -f "$FIRST_FAILURE/config/backend.env"
test -f "$FIRST_FAILURE/config/mcp.env"
test -f "$FIRST_FAILURE/log/audit.jsonl"
test "$(grep -c '^daemon-reload$' "$FIRST_FAILURE/systemctl.calls")" -eq 2
grep -q '^stop pickleshell-memory-first-failure.service$' "$FIRST_FAILURE/systemctl.calls"

install_release "$SHA1"
test "$(readlink "$PREFIX/app/active")" = "releases/$SHA1"
test "$(stat -c %a "$PREFIX/config/backend.env")" = 640
test "$(stat -c %a "$PREFIX/config/mcp.env")" = 640
test "$(stat -c %a "$PREFIX/log/audit.jsonl")" = 660
test "$(stat -c %a "$PREFIX/log")" = 750
test -f "$PREFIX/units/pickleshell-memory-isolated.service"
test -x "$PREFIX/bin/pickleshell-memory-mcp"
test -x "$PREFIX/bin/pickleshell-memory-ready"
test -f "$PREFIX/logrotate/pickleshell-memory"
grep -q 'rotate 14' "$PREFIX/logrotate/pickleshell-memory"
grep -q 'create 0660 ' "$PREFIX/logrotate/pickleshell-memory"
grep -q "$PREFIX/config/backend.env" "$PREFIX/units/pickleshell-memory-isolated.service"
! find "$PREFIX/app" "$PREFIX/units" "$PREFIX/bin" -type f -exec grep -l 'pickleshell-gateway\|gateway/' {} + | grep -q .
audit_lines=$(wc -l < "$PREFIX/log/audit.jsonl")
"$PREFIX/bin/pickleshell-memory-ready"
test "$(wc -l < "$PREFIX/log/audit.jsonl")" -gt "$audit_lines"
grep -q '"tool":"memory_capabilities"' "$PREFIX/log/audit.jsonl"
"$PREFIX/bin/logrotate" "$PREFIX/logrotate/pickleshell-memory"
test "$(stat -c %a "$PREFIX/log/audit.jsonl")" = 660
test "$(stat -c %a "$PREFIX/log")" = 750

declare -A V1_HASHES
for artifact in \
  "$PREFIX/units/pickleshell-memory-isolated.service" \
  "$PREFIX/bin/backend-wrapper" \
  "$PREFIX/bin/pickleshell-memory-mcp" \
  "$PREFIX/bin/pickleshell-memory-ready" \
  "$PREFIX/logrotate/pickleshell-memory"; do
  V1_HASHES["$artifact"]=$(sha256sum "$artifact" | cut -d' ' -f1)
done
V1_PID=$(<"$PREFIX/backend.pid")

sed -i 's/release-marker: v1/release-marker: failed-upgrade/g' "$FIXTURE"/deploy/systemd/*.in
sed -i '1a process.exit(23); // deterministic failed-upgrade readiness' "$FIXTURE/pickleshell-memory-mcp/src/readiness.js"
git -C "$FIXTURE" add deploy/systemd pickleshell-memory-mcp/src/readiness.js
git -C "$FIXTURE" commit -qm failed-upgrade
FAILED_SHA=$(git -C "$FIXTURE" rev-parse HEAD)
if install_release "$FAILED_SHA" >"$TMP/failed-upgrade.out" 2>&1; then
  echo 'failed upgrade unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'activation readiness failed; previous deployment restored and verified' "$TMP/failed-upgrade.out"
test "$(readlink "$PREFIX/app/active")" = "releases/$SHA1"
test "$(<"$PREFIX/app/state/current-target")" = "releases/$SHA1"
test -z "$(<"$PREFIX/app/state/previous-target")"
for artifact in "${!V1_HASHES[@]}"; do
  test "$(sha256sum "$artifact" | cut -d' ' -f1)" = "${V1_HASHES[$artifact]}"
done
V1_RECOVERED_PID=$(<"$PREFIX/backend.pid")
test "$V1_RECOVERED_PID" != "$V1_PID"
kill -0 "$V1_RECOVERED_PID"
"$PREFIX/bin/pickleshell-memory-ready"

printf 'v2\n' > "$FIXTURE/VERSION"
sed -i '/deterministic failed-upgrade readiness/d' "$FIXTURE/pickleshell-memory-mcp/src/readiness.js"
sed -i 's/release-marker: failed-upgrade/release-marker: v2/g' "$FIXTURE"/deploy/systemd/*.in
git -C "$FIXTURE" add VERSION deploy/systemd pickleshell-memory-mcp/src/readiness.js
git -C "$FIXTURE" commit -qm v2
SHA2=$(git -C "$FIXTURE" rev-parse HEAD)
install_release "$SHA2"
test "$(readlink "$PREFIX/app/active")" = "releases/$SHA2"
FAKE_SYSTEMD_ROOT="$PREFIX" "$FIXTURE/deploy/memory-release.sh" \
  --profile isolated --root "$PREFIX/app" --config-root "$PREFIX/config" --state-root "$PREFIX/state" --log-root "$PREFIX/log" \
  --units-dir "$PREFIX/units" --logrotate-dir "$PREFIX/logrotate" \
  --backend-executable "$PREFIX/bin/backend.js" --node-executable "$(command -v node)" \
  --service-user "$(id -un)" --service-group "$(id -gn)" --service pickleshell-memory-isolated.service \
  --systemctl "$PREFIX/bin/systemctl" \
  --wrapper-dir "$PREFIX/bin" --rollback
test "$(readlink "$PREFIX/app/active")" = "releases/$SHA1"
kill "$(<"$PREFIX/backend.pid")" 2>/dev/null || true
printf 'memory deployment E2E: ok\n'
