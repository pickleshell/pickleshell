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

ANCESTOR_CASE="$TMP/symlink-ancestor"
ANCESTOR_VICTIM="$TMP/symlink-ancestor-victim"
mkdir -p -- "$ANCESTOR_CASE" "$ANCESTOR_VICTIM"/{app,bin,config,log,logrotate,state,units,wrappers}
ln -s "$ANCESTOR_VICTIM" "$ANCESTOR_CASE/deploy"
cp -- "$(command -v node)" "$ANCESTOR_VICTIM/bin/node"
printf '#!/usr/bin/env bash\ntouch %q\nexit 1\n' "$ANCESTOR_VICTIM/systemctl-called" > "$ANCESTOR_VICTIM/bin/systemctl"
chmod 0755 "$ANCESTOR_VICTIM/bin/node" "$ANCESTOR_VICTIM/bin/systemctl"
printf 'victim-safe\n' > "$ANCESTOR_VICTIM/sentinel"
printf 'BACKEND_TEST=1\n' > "$ANCESTOR_VICTIM/config/backend.env"
printf '%s\n' \
  'PICKLESHELL_MEMORY_ROLE=agent' 'PICKLESHELL_MEMORY_ACTOR=fixture-agent' \
  'PICKLESHELL_MEMORY_SCOPE=fixture-scope' 'PICKLESHELL_MEMORY_BACKEND_URL=http://127.0.0.1:9' \
  "PICKLESHELL_MEMORY_AUDIT_LOG=$ANCESTOR_CASE/deploy/log/audit.jsonl" > "$ANCESTOR_VICTIM/config/mcp.env"
chmod 0640 "$ANCESTOR_VICTIM/config/backend.env" "$ANCESTOR_VICTIM/config/mcp.env"
if "$FIXTURE/deploy/memory-release.sh" \
  --profile isolated --root "$ANCESTOR_CASE/deploy/app" --config-root "$ANCESTOR_CASE/deploy/config" \
  --state-root "$ANCESTOR_CASE/deploy/state" --log-root "$ANCESTOR_CASE/deploy/log" \
  --units-dir "$ANCESTOR_CASE/deploy/units" --logrotate-dir "$ANCESTOR_CASE/deploy/logrotate" \
  --wrapper-dir "$ANCESTOR_CASE/deploy/wrappers" --backend-executable "$ANCESTOR_CASE/deploy/bin/node" \
  --node-executable "$ANCESTOR_CASE/deploy/bin/node" --systemctl "$ANCESTOR_CASE/deploy/bin/systemctl" \
  --service-user "$(id -un)" --service-group "$(id -gn)" \
  --service pickleshell-memory-symlink-ancestor.service --rollback > "$ANCESTOR_CASE/output" 2>&1; then
  echo 'symlinked deployment ancestor unexpectedly succeeded' >&2
  exit 1
fi
test "$(<"$ANCESTOR_VICTIM/sentinel")" = victim-safe
test ! -e "$ANCESTOR_VICTIM/log/audit.jsonl"
test ! -e "$ANCESTOR_VICTIM/systemctl-called"
grep -q 'configured deployment path has a symlink component' "$ANCESTOR_CASE/output"

WRITABLE_CONFIG_CASE="$TMP/writable-production-config"
mkdir -p -- "$WRITABLE_CONFIG_CASE/config"
printf 'BACKEND_TEST=1\n' > "$WRITABLE_CONFIG_CASE/config/backend.env"
printf '%s\n' \
  'PICKLESHELL_MEMORY_ROLE=agent' 'PICKLESHELL_MEMORY_ACTOR=fixture-agent' \
  'PICKLESHELL_MEMORY_SCOPE=fixture-scope' 'PICKLESHELL_MEMORY_BACKEND_URL=http://127.0.0.1:9' \
  "PICKLESHELL_MEMORY_AUDIT_LOG=$WRITABLE_CONFIG_CASE/log/audit.jsonl" > "$WRITABLE_CONFIG_CASE/config/mcp.env"
chmod 0640 "$WRITABLE_CONFIG_CASE/config/backend.env" "$WRITABLE_CONFIG_CASE/config/mcp.env"
if "$FIXTURE/deploy/memory-release.sh" \
  --profile production --root "$WRITABLE_CONFIG_CASE/app" --config-root "$WRITABLE_CONFIG_CASE/config" \
  --state-root "$WRITABLE_CONFIG_CASE/state" --log-root "$WRITABLE_CONFIG_CASE/log" \
  --units-dir "$WRITABLE_CONFIG_CASE/units" --logrotate-dir "$WRITABLE_CONFIG_CASE/logrotate" \
  --wrapper-dir "$WRITABLE_CONFIG_CASE/wrappers" --backend-executable "$PREFLIGHT/bin/node" \
  --node-executable "$PREFLIGHT/bin/node" --systemctl "$PREFLIGHT/bin/systemctl" \
  --service-user "$(id -un)" --service-group "$(id -gn)" \
  --service pickleshell-memory-writable-config.service --rollback > "$WRITABLE_CONFIG_CASE/output" 2>&1; then
  echo 'writable production config root unexpectedly succeeded' >&2
  exit 1
fi
test ! -e "$WRITABLE_CONFIG_CASE/app"
test ! -e "$WRITABLE_CONFIG_CASE/state"
test ! -e "$WRITABLE_CONFIG_CASE/log"
test ! -e "$WRITABLE_CONFIG_CASE/units"
test ! -e "$WRITABLE_CONFIG_CASE/logrotate"
test ! -e "$WRITABLE_CONFIG_CASE/wrappers"
grep -q 'operator config path is writable by the service identity' "$WRITABLE_CONFIG_CASE/output"

for artifact in "$FIXTURE"/deploy/systemd/*.in; do
  printf '\n# release-marker: v1\n' >> "$artifact"
done

git -C "$FIXTURE" init -q
git -C "$FIXTURE" config user.email fixture@example.invalid
git -C "$FIXTURE" config user.name Fixture
git -C "$FIXTURE" add .
git -C "$FIXTURE" commit -qm v1
SHA1=$(git -C "$FIXTURE" rev-parse HEAD)
LINKED_FIXTURE="$TMP/linked-source"
git -C "$FIXTURE" worktree add -q --detach "$LINKED_FIXTURE" "$SHA1"
test -f "$LINKED_FIXTURE/.git"

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
  is-enabled)
    [[ -f ${FAKE_SYSTEMD_ROOT:?}/enabled/$2 ]]
    ;;
  enable)
    mkdir -p -- "${FAKE_SYSTEMD_ROOT:?}/enabled"
    touch "${FAKE_SYSTEMD_ROOT}/enabled/$2"
    [[ ! -f ${FAKE_SYSTEMD_ROOT}/fail-enable ]]
    ;;
  disable)
    rm -f -- "${FAKE_SYSTEMD_ROOT:?}/enabled/$2"
    ;;
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
        if curl --fail --silent --max-time 0.2 "http://127.0.0.1:${FAKE_BACKEND_PORT}/health" >/dev/null; then
          if [[ -f ${FAKE_SYSTEMD_ROOT}/fail-active-target ]] &&
             [[ $(readlink "${FAKE_SYSTEMD_ROOT}/app/active") == "$(<"${FAKE_SYSTEMD_ROOT}/fail-active-target")" ]]; then
            exit 1
          fi
          exit 0
        fi
        sleep 0.02
      done
      exit 1
    fi
    ;;
esac
EOF
chmod 0755 "$PREFIX/bin/systemctl"

REAL_MV=$(command -v mv)
cat > "$PREFIX/bin/mv" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
for argument in "\$@"; do target=\$argument; done
if [[ -f \${FAKE_SYSTEMD_ROOT:-}/fail-artifact-mv && \$target == \${FAKE_SYSTEMD_ROOT}/bin/pickleshell-memory-mcp ]]; then
  rm -f -- "\${FAKE_SYSTEMD_ROOT}/fail-artifact-mv"
  exit 1
fi
if [[ -f \${FAKE_SYSTEMD_ROOT:-}/fail-current-state-mv && \$target == \${FAKE_SYSTEMD_ROOT}/app/state/current-target ]]; then
  rm -f -- "\${FAKE_SYSTEMD_ROOT}/fail-current-state-mv"
  exit 1
fi
if [[ -f \${FAKE_SYSTEMD_ROOT:-}/fail-active-mv && \$target == \${FAKE_SYSTEMD_ROOT}/app/active ]]; then
  rm -f -- "\${FAKE_SYSTEMD_ROOT}/fail-active-mv"
  exit 1
fi
exec '$REAL_MV' "\$@"
EOF
chmod 0755 "$PREFIX/bin/mv"

REAL_RM=$(command -v rm)
cat > "$PREFIX/bin/rm" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
for argument in "\$@"; do target=\$argument; done
if [[ -f \${FAKE_SYSTEMD_ROOT:-}/fail-release-rm && \$target == \${FAKE_SYSTEMD_ROOT}/app/releases/* ]]; then
  '$REAL_RM' -f -- "\${FAKE_SYSTEMD_ROOT}/fail-release-rm"
  exit 1
fi
exec '$REAL_RM' "\$@"
EOF
chmod 0755 "$PREFIX/bin/rm"

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
  local source=${2:-$FIXTURE}
  PATH="$PREFIX/bin:$PATH" FAKE_SYSTEMD_ROOT="$PREFIX" "$FIXTURE/deploy/memory-release.sh" \
    --profile isolated --source "$source" --root "$PREFIX/app" --commit "$1" \
    --config-root "$PREFIX/config" --state-root "$PREFIX/state" --log-root "$PREFIX/log" \
    --units-dir "$PREFIX/units" --logrotate-dir "$PREFIX/logrotate" \
    --backend-executable "$PREFIX/bin/backend.js" --node-executable "$(command -v node)" \
    --service-user "$(id -un)" --service-group "$(id -gn)" \
    --service pickleshell-memory-isolated.service \
    --systemctl "$PREFIX/bin/systemctl" --wrapper-dir "$PREFIX/bin"
}

run_unsafe_internal_path_case() {
  local name=$1 path_kind=$2 case_root victim expected_entries=1
  case_root="$TMP/unsafe-$name"; victim="$TMP/unsafe-$name-victim"
  mkdir -p -- "$case_root"/{app,bin,config,log,logrotate,state-root,units,wrappers} "$victim"
  cp -- "$(command -v node)" "$case_root/bin/node"
  printf '#!/usr/bin/env bash\ntouch %q\nexit 1\n' "$case_root/systemctl-called" > "$case_root/bin/systemctl"
  chmod 0755 "$case_root/bin/node" "$case_root/bin/systemctl"
  printf 'victim-safe\n' > "$victim/sentinel"
  printf 'BACKEND_TEST=1\n' > "$case_root/config/backend.env"
  printf '%s\n' \
    'PICKLESHELL_MEMORY_ROLE=agent' 'PICKLESHELL_MEMORY_ACTOR=fixture-agent' \
    'PICKLESHELL_MEMORY_SCOPE=fixture-scope' 'PICKLESHELL_MEMORY_BACKEND_URL=http://127.0.0.1:9' \
    "PICKLESHELL_MEMORY_AUDIT_LOG=$case_root/log/audit.jsonl" > "$case_root/config/mcp.env"
  chmod 0640 "$case_root/config/backend.env" "$case_root/config/mcp.env"
  case $path_kind in
    releases) ln -s "$victim" "$case_root/app/releases" ;;
    state) ln -s "$victim" "$case_root/app/state" ;;
    current-target|previous-target)
      mkdir -- "$case_root/app/state"; printf 'victim-state-safe\n' > "$victim/record"
      ln -s "$victim/record" "$case_root/app/state/$path_kind"; expected_entries=2 ;;
  esac
  if "$FIXTURE/deploy/memory-release.sh" \
    --profile isolated --source "$LINKED_FIXTURE" --root "$case_root/app" --commit "$SHA1" \
    --config-root "$case_root/config" --state-root "$case_root/state-root" --log-root "$case_root/log" \
    --units-dir "$case_root/units" --logrotate-dir "$case_root/logrotate" \
    --backend-executable "$case_root/bin/node" --node-executable "$case_root/bin/node" \
    --service-user "$(id -un)" --service-group "$(id -gn)" --service pickleshell-memory-unsafe-$name.service \
    --systemctl "$case_root/bin/systemctl" --wrapper-dir "$case_root/wrappers" > "$case_root/output" 2>&1; then
    echo "unsafe $name path unexpectedly succeeded" >&2; exit 1
  fi
  if ! grep -q "unsafe internal deployment path: $path_kind" "$case_root/output"; then
    [[ ! -e $case_root/systemctl-called ]] || echo "unsafe $name path reached service action before rejection" >&2
    [[ -e $case_root/systemctl-called ]] || echo "unsafe $name path was not rejected by internal-path preflight" >&2
    exit 1
  fi
  test ! -e "$case_root/systemctl-called"; test ! -e "$case_root/log/audit.jsonl"
  test "$(<"$victim/sentinel")" = victim-safe
  test "$(find -P "$victim" -mindepth 1 -maxdepth 1 | wc -l)" -eq "$expected_entries"
  if [[ $path_kind == current-target || $path_kind == previous-target ]]; then
    test "$(<"$victim/record")" = victim-state-safe; test -L "$case_root/app/state/$path_kind"
  fi
}

run_unsafe_internal_path_case releases releases
run_unsafe_internal_path_case state state
run_unsafe_internal_path_case current-state current-target
run_unsafe_internal_path_case previous-state previous-target

FIRST_FAILURE="$TMP/first-failure"
mkdir -p -- "$FIRST_FAILURE"/{app,bin,config,log,logrotate,state,units}
mkdir -p -- "$FIRST_FAILURE/app/state"
cp -- "$PREFIX/bin/backend.js" "$PREFIX/bin/systemctl" "$FIRST_FAILURE/bin/"
chmod 0755 "$FIRST_FAILURE/bin/backend.js" "$FIRST_FAILURE/bin/systemctl"
declare -A FIRST_FAILURE_PRIOR_MODES
for artifact in \
  "$FIRST_FAILURE/units/pickleshell-memory-first-failure.service" \
  "$FIRST_FAILURE/bin/backend-wrapper" \
  "$FIRST_FAILURE/bin/pickleshell-memory-mcp" \
  "$FIRST_FAILURE/bin/pickleshell-memory-ready" \
  "$FIRST_FAILURE/logrotate/pickleshell-memory"; do
  printf 'pre-existing:%s\n' "$(basename -- "$artifact")" > "$artifact"
  chmod 0600 "$artifact"
  FIRST_FAILURE_PRIOR_MODES["$artifact"]=$(stat -c %a "$artifact")
done
printf 'pre-existing-current\n' > "$FIRST_FAILURE/app/state/current-target"
printf 'pre-existing-previous\n' > "$FIRST_FAILURE/app/state/previous-target"
FIRST_FAILURE_PRIOR_HASHES=$(sha256sum \
  "$FIRST_FAILURE/units/pickleshell-memory-first-failure.service" \
  "$FIRST_FAILURE/bin/backend-wrapper" \
  "$FIRST_FAILURE/bin/pickleshell-memory-mcp" \
  "$FIRST_FAILURE/bin/pickleshell-memory-ready" \
  "$FIRST_FAILURE/logrotate/pickleshell-memory" \
  "$FIRST_FAILURE/app/state/current-target" \
  "$FIRST_FAILURE/app/state/previous-target")
FIRST_PORT=$((40001 + RANDOM % 10000))
printf 'FAKE_BACKEND_PORT=%s\n' "$FIRST_PORT" > "$FIRST_FAILURE/config/backend.env"
printf '%s\n' \
  'PICKLESHELL_MEMORY_ROLE=agent' \
  'PICKLESHELL_MEMORY_ACTOR=fixture-agent' \
  'PICKLESHELL_MEMORY_SCOPE=fixture-scope' \
  "PICKLESHELL_MEMORY_BACKEND_URL=http://127.0.0.1:$FIRST_PORT" \
  "PICKLESHELL_MEMORY_AUDIT_LOG=$FIRST_FAILURE/log/audit.jsonl" > "$FIRST_FAILURE/config/mcp.env"
chmod 0640 "$FIRST_FAILURE/config/backend.env" "$FIRST_FAILURE/config/mcp.env"
touch "$FIRST_FAILURE/fail-enable"
if PATH="$PREFIX/bin:$PATH" FAKE_SYSTEMD_ROOT="$FIRST_FAILURE" "$FIXTURE/deploy/memory-release.sh" \
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
grep -q 'activation enablement failed; first-activation state restored' "$TMP/first-failure.out"
! grep -q 'memory-release: active release\|memory-release: rolled back' "$TMP/first-failure.out"
test -f "$FIRST_FAILURE/backend.pid" || { cat "$TMP/first-failure.out" >&2; exit 1; }
FIRST_FAILURE_PID=$(<"$FIRST_FAILURE/backend.pid")
! kill -0 "$FIRST_FAILURE_PID" 2>/dev/null
test ! -e "$FIRST_FAILURE/app/active"
test "$(<"$FIRST_FAILURE/app/state/current-target")" = pre-existing-current
test "$(<"$FIRST_FAILURE/app/state/previous-target")" = pre-existing-previous
for artifact in \
  "$FIRST_FAILURE/units/pickleshell-memory-first-failure.service" \
  "$FIRST_FAILURE/bin/backend-wrapper" \
  "$FIRST_FAILURE/bin/pickleshell-memory-mcp" \
  "$FIRST_FAILURE/bin/pickleshell-memory-ready" \
  "$FIRST_FAILURE/logrotate/pickleshell-memory"; do
  test -f "$artifact"
  test "$(stat -c %a "$artifact")" = "${FIRST_FAILURE_PRIOR_MODES[$artifact]}"
done
test "$(sha256sum \
  "$FIRST_FAILURE/units/pickleshell-memory-first-failure.service" \
  "$FIRST_FAILURE/bin/backend-wrapper" \
  "$FIRST_FAILURE/bin/pickleshell-memory-mcp" \
  "$FIRST_FAILURE/bin/pickleshell-memory-ready" \
  "$FIRST_FAILURE/logrotate/pickleshell-memory" \
  "$FIRST_FAILURE/app/state/current-target" \
  "$FIRST_FAILURE/app/state/previous-target")" = "$FIRST_FAILURE_PRIOR_HASHES"
test -f "$FIRST_FAILURE/config/backend.env"
test -f "$FIRST_FAILURE/config/mcp.env"
test -f "$FIRST_FAILURE/log/audit.jsonl"
test "$(grep -c '^daemon-reload$' "$FIRST_FAILURE/systemctl.calls")" -eq 2
grep -q '^stop pickleshell-memory-first-failure.service$' "$FIRST_FAILURE/systemctl.calls"
test ! -e "$FIRST_FAILURE/enabled/pickleshell-memory-first-failure.service"
grep -q '^disable pickleshell-memory-first-failure.service$' "$FIRST_FAILURE/systemctl.calls"
test ! -e "$FIRST_FAILURE/app/releases/$SHA1"

rm -- "$FIRST_FAILURE/fail-enable"
PATH="$PREFIX/bin:$PATH" FAKE_SYSTEMD_ROOT="$FIRST_FAILURE" "$FIXTURE/deploy/memory-release.sh" \
  --profile isolated --source "$FIXTURE" --root "$FIRST_FAILURE/app" --commit "$SHA1" \
  --config-root "$FIRST_FAILURE/config" --state-root "$FIRST_FAILURE/state" --log-root "$FIRST_FAILURE/log" \
  --units-dir "$FIRST_FAILURE/units" --logrotate-dir "$FIRST_FAILURE/logrotate" \
  --backend-executable "$FIRST_FAILURE/bin/backend.js" --node-executable "$(command -v node)" \
  --service-user "$(id -un)" --service-group "$(id -gn)" \
  --service pickleshell-memory-first-failure.service \
  --systemctl "$FIRST_FAILURE/bin/systemctl" --wrapper-dir "$FIRST_FAILURE/bin"
test -d "$FIRST_FAILURE/app/releases/$SHA1"
test "$(readlink "$FIRST_FAILURE/app/active")" = "releases/$SHA1"
test "$(<"$FIRST_FAILURE/app/state/current-target")" = "releases/$SHA1"
test -f "$FIRST_FAILURE/enabled/pickleshell-memory-first-failure.service"
"$FIRST_FAILURE/bin/pickleshell-memory-ready"
kill "$(<"$FIRST_FAILURE/backend.pid")" 2>/dev/null || true

NON_GIT_SOURCE="$TMP/non-git-source"
mkdir -- "$NON_GIT_SOURCE"
if install_release "$SHA1" "$NON_GIT_SOURCE" >"$TMP/non-git-source.out" 2>&1; then
  echo 'non-Git source unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'source must be a different Git worktree' "$TMP/non-git-source.out"

printf 'dirty\n' > "$LINKED_FIXTURE/untracked"
if install_release "$SHA1" "$LINKED_FIXTURE" >"$TMP/dirty-linked-source.out" 2>&1; then
  echo 'dirty linked worktree unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'source worktree is dirty' "$TMP/dirty-linked-source.out"
rm -- "$LINKED_FIXTURE/untracked"

install_release "$SHA1" "$LINKED_FIXTURE"
test "$(readlink "$PREFIX/app/active")" = "releases/$SHA1"
test -f "$PREFIX/enabled/pickleshell-memory-isolated.service"
test "$(grep -c '^enable pickleshell-memory-isolated.service$' "$PREFIX/systemctl.calls")" -eq 1
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

assert_v1_preserved() {
  test "$(readlink "$PREFIX/app/active")" = "releases/$SHA1"
  test "$(<"$PREFIX/app/state/current-target")" = "releases/$SHA1"
  test -z "$(<"$PREFIX/app/state/previous-target")"
  for artifact in "${!V1_HASHES[@]}"; do
    test "$(sha256sum "$artifact" | cut -d' ' -f1)" = "${V1_HASHES[$artifact]}"
  done
  test "$(<"$PREFIX/backend.pid")" = "$V1_PID"
  kill -0 "$V1_PID"
  "$PREFIX/bin/pickleshell-memory-ready"
  ! find "$PREFIX/app" "$PREFIX/units" "$PREFIX/bin" "$PREFIX/logrotate" -type f \( -name '.*.render.*' -o -name '.*.backup.*' -o -name '.*.switch.*' \) | grep -q .
}

for failure in current-state active; do
  git -C "$FIXTURE" checkout -q "$SHA1" -- deploy/systemd
  sed -i "s/release-marker: v1/release-marker: switch-$failure-failure/g" "$FIXTURE"/deploy/systemd/*.in
  git -C "$FIXTURE" add deploy/systemd
  git -C "$FIXTURE" commit -qm "switch-$failure-failure"
  SWITCH_FAILURE_SHA=$(git -C "$FIXTURE" rev-parse HEAD)
  touch "$PREFIX/fail-$failure-mv"
  if [[ $failure == current-state ]]; then touch "$PREFIX/fail-release-rm"; fi
  if install_release "$SWITCH_FAILURE_SHA" >"$TMP/switch-$failure-failure.out" 2>&1; then
    echo "switch-$failure failure upgrade unexpectedly succeeded" >&2
    exit 1
  fi
  test ! -e "$PREFIX/fail-$failure-mv"
  grep -q 'deployment switch failed; previous deployment restored' "$TMP/switch-$failure-failure.out"
  ! grep -q 'memory-release: active release\|memory-release: rolled back' "$TMP/switch-$failure-failure.out"
  if [[ $failure == current-state ]]; then
    grep -q 'failed to remove unsuccessful release' "$TMP/switch-$failure-failure.out"
    test -d "$PREFIX/app/releases/$SWITCH_FAILURE_SHA"
    "$REAL_RM" -rf -- "$PREFIX/app/releases/$SWITCH_FAILURE_SHA"
  else
    test ! -e "$PREFIX/app/releases/$SWITCH_FAILURE_SHA"
  fi
  assert_v1_preserved
done

sed -i 's/release-marker: v1/release-marker: render-failure/g' "$FIXTURE"/deploy/systemd/*.in
printf '\n@UNRESOLVED_RENDER_FAILURE@\n' >> "$FIXTURE/deploy/systemd/pickleshell-memory.logrotate.in"
git -C "$FIXTURE" add deploy/systemd
git -C "$FIXTURE" commit -qm render-failure
RENDER_FAILURE_SHA=$(git -C "$FIXTURE" rev-parse HEAD)
if install_release "$RENDER_FAILURE_SHA" >"$TMP/render-failure.out" 2>&1; then
  echo 'render-failure upgrade unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'unresolved deployment placeholder' "$TMP/render-failure.out"
test "$(readlink "$PREFIX/app/active")" = "releases/$SHA1"
test "$(<"$PREFIX/app/state/current-target")" = "releases/$SHA1"
test -z "$(<"$PREFIX/app/state/previous-target")"
for artifact in "${!V1_HASHES[@]}"; do
  test "$(sha256sum "$artifact" | cut -d' ' -f1)" = "${V1_HASHES[$artifact]}"
done
test "$(<"$PREFIX/backend.pid")" = "$V1_PID"
kill -0 "$V1_PID"
! find "$PREFIX/units" "$PREFIX/bin" "$PREFIX/logrotate" -maxdepth 1 -type f \( -name '.*.render.*' -o -name '.*.backup.*' \) | grep -q .

git -C "$FIXTURE" checkout -q "$SHA1" -- deploy/systemd
sed -i 's/release-marker: v1/release-marker: commit-failure/g' "$FIXTURE"/deploy/systemd/*.in
git -C "$FIXTURE" add deploy/systemd
git -C "$FIXTURE" commit -qm commit-failure
COMMIT_FAILURE_SHA=$(git -C "$FIXTURE" rev-parse HEAD)
touch "$PREFIX/fail-artifact-mv"
if install_release "$COMMIT_FAILURE_SHA" >"$TMP/commit-failure.out" 2>&1; then
  echo 'commit-failure upgrade unexpectedly succeeded' >&2
  exit 1
fi
test ! -e "$PREFIX/fail-artifact-mv"
test "$(readlink "$PREFIX/app/active")" = "releases/$SHA1"
test "$(<"$PREFIX/app/state/current-target")" = "releases/$SHA1"
test -z "$(<"$PREFIX/app/state/previous-target")"
for artifact in "${!V1_HASHES[@]}"; do
  test "$(sha256sum "$artifact" | cut -d' ' -f1)" = "${V1_HASHES[$artifact]}"
done
test "$(<"$PREFIX/backend.pid")" = "$V1_PID"
kill -0 "$V1_PID"
! find "$PREFIX/units" "$PREFIX/bin" "$PREFIX/logrotate" -maxdepth 1 -type f \( -name '.*.render.*' -o -name '.*.backup.*' \) | grep -q .

git -C "$FIXTURE" checkout -q "$SHA1" -- deploy/systemd

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
test -f "$PREFIX/enabled/pickleshell-memory-isolated.service"
test "$(grep -c '^enable pickleshell-memory-isolated.service$' "$PREFIX/systemctl.calls")" -eq 1
declare -A V2_HASHES
for artifact in \
  "$PREFIX/units/pickleshell-memory-isolated.service" \
  "$PREFIX/bin/backend-wrapper" \
  "$PREFIX/bin/pickleshell-memory-mcp" \
  "$PREFIX/bin/pickleshell-memory-ready" \
  "$PREFIX/logrotate/pickleshell-memory"; do
  V2_HASHES["$artifact"]=$(sha256sum "$artifact" | cut -d' ' -f1)
done
V2_PID=$(<"$PREFIX/backend.pid")
RESTARTS_BEFORE=$(grep -c '^restart pickleshell-memory-isolated.service$' "$PREFIX/systemctl.calls")

assert_unsafe_previous_target_rejected() {
  local name=$1 target=$2 setup=${3:-none} fake_sha fake_path calls_before artifact
  fake_sha=${target#releases/}; fake_path="$PREFIX/app/$target"
  case $setup in
    symlink-release)
      mkdir -p -- "$PREFIX/rollback-victim"
      ln -s "$PREFIX/rollback-victim" "$fake_path"
      ;;
    missing-marker) mkdir -- "$fake_path" ;;
    mismatched-marker)
      mkdir -- "$fake_path"; printf '%040d\n' 9 > "$fake_path/.release-sha"
      ;;
    symlink-marker)
      mkdir -- "$fake_path"; printf '%s\n' "$fake_sha" > "$PREFIX/rollback-marker-victim"
      ln -s "$PREFIX/rollback-marker-victim" "$fake_path/.release-sha"
      ;;
  esac
  printf '%s\n' "$target" > "$PREFIX/app/state/previous-target"
  calls_before=$(wc -l < "$PREFIX/systemctl.calls")
  if FAKE_SYSTEMD_ROOT="$PREFIX" "$FIXTURE/deploy/memory-release.sh" \
    --profile isolated --root "$PREFIX/app" --config-root "$PREFIX/config" --state-root "$PREFIX/state" --log-root "$PREFIX/log" \
    --units-dir "$PREFIX/units" --logrotate-dir "$PREFIX/logrotate" \
    --backend-executable "$PREFIX/bin/backend.js" --node-executable "$(command -v node)" \
    --service-user "$(id -un)" --service-group "$(id -gn)" --service pickleshell-memory-isolated.service \
    --systemctl "$PREFIX/bin/systemctl" --wrapper-dir "$PREFIX/bin" --rollback > "$TMP/unsafe-rollback-$name.out" 2>&1; then
    echo "unsafe rollback target $name unexpectedly succeeded" >&2
    exit 1
  fi
  if ! grep -q 'managed release target is unsafe: previous' "$TMP/unsafe-rollback-$name.out"; then
    echo "unsafe rollback target $name was not rejected by managed-release validation" >&2
    exit 1
  fi
  test "$(wc -l < "$PREFIX/systemctl.calls")" -eq "$calls_before"
  test "$(readlink "$PREFIX/app/active")" = "releases/$SHA2"
  test "$(<"$PREFIX/app/state/current-target")" = "releases/$SHA2"
  test "$(<"$PREFIX/app/state/previous-target")" = "$target"
  test "$(<"$PREFIX/backend.pid")" = "$V2_PID"; kill -0 "$V2_PID"
  for artifact in "${!V2_HASHES[@]}"; do
    test "$(sha256sum "$artifact" | cut -d' ' -f1)" = "${V2_HASHES[$artifact]}"
  done
  case $setup in
    symlink-release|missing-marker|mismatched-marker|symlink-marker) rm -rf -- "$fake_path" ;;
  esac
  printf 'releases/%s\n' "$SHA1" > "$PREFIX/app/state/previous-target"
}

FAKE_RELEASE_SHA=0000000000000000000000000000000000000001
assert_unsafe_previous_target_rejected traversal 'releases/../rollback-victim'
assert_unsafe_previous_target_rejected nested "releases/$SHA1/nested"
assert_unsafe_previous_target_rejected invalid-sha 'releases/not-a-full-sha'
assert_unsafe_previous_target_rejected symlink-release "releases/$FAKE_RELEASE_SHA" symlink-release
assert_unsafe_previous_target_rejected missing-marker "releases/$FAKE_RELEASE_SHA" missing-marker
assert_unsafe_previous_target_rejected mismatched-marker "releases/$FAKE_RELEASE_SHA" mismatched-marker
assert_unsafe_previous_target_rejected symlink-marker "releases/$FAKE_RELEASE_SHA" symlink-marker

printf 'releases/%s\n' "$SHA1" > "$PREFIX/fail-active-target"
if FAKE_SYSTEMD_ROOT="$PREFIX" "$FIXTURE/deploy/memory-release.sh" \
  --profile isolated --root "$PREFIX/app" --config-root "$PREFIX/config" --state-root "$PREFIX/state" --log-root "$PREFIX/log" \
  --units-dir "$PREFIX/units" --logrotate-dir "$PREFIX/logrotate" \
  --backend-executable "$PREFIX/bin/backend.js" --node-executable "$(command -v node)" \
  --service-user "$(id -un)" --service-group "$(id -gn)" --service pickleshell-memory-isolated.service \
  --systemctl "$PREFIX/bin/systemctl" \
  --wrapper-dir "$PREFIX/bin" --rollback >"$TMP/failed-rollback.out" 2>&1; then
  echo 'failed rollback unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'rollback readiness failed; current deployment restored and verified' "$TMP/failed-rollback.out"
! grep -q 'memory-release: active release\|memory-release: rolled back' "$TMP/failed-rollback.out"
test "$(readlink "$PREFIX/app/active")" = "releases/$SHA2"
test "$(<"$PREFIX/app/state/current-target")" = "releases/$SHA2"
test "$(<"$PREFIX/app/state/previous-target")" = "releases/$SHA1"
for artifact in "${!V2_HASHES[@]}"; do
  test "$(sha256sum "$artifact" | cut -d' ' -f1)" = "${V2_HASHES[$artifact]}"
done
test "$(grep -c '^restart pickleshell-memory-isolated.service$' "$PREFIX/systemctl.calls")" -eq "$((RESTARTS_BEFORE + 2))"
V2_RECOVERED_PID=$(<"$PREFIX/backend.pid")
test "$V2_RECOVERED_PID" != "$V2_PID"
kill -0 "$V2_RECOVERED_PID"
"$PREFIX/bin/pickleshell-memory-ready"
test -f "$PREFIX/enabled/pickleshell-memory-isolated.service"
! grep -q '^disable pickleshell-memory-isolated.service$' "$PREFIX/systemctl.calls"
! find "$PREFIX/units" "$PREFIX/bin" "$PREFIX/logrotate" -maxdepth 1 -type f \( -name '.*.render.*' -o -name '.*.backup.*' \) | grep -q .
rm -f -- "$PREFIX/fail-active-target"
FAKE_SYSTEMD_ROOT="$PREFIX" "$FIXTURE/deploy/memory-release.sh" \
  --profile isolated --root "$PREFIX/app" --config-root "$PREFIX/config" --state-root "$PREFIX/state" --log-root "$PREFIX/log" \
  --units-dir "$PREFIX/units" --logrotate-dir "$PREFIX/logrotate" \
  --backend-executable "$PREFIX/bin/backend.js" --node-executable "$(command -v node)" \
  --service-user "$(id -un)" --service-group "$(id -gn)" --service pickleshell-memory-isolated.service \
  --systemctl "$PREFIX/bin/systemctl" --wrapper-dir "$PREFIX/bin" --rollback
test "$(readlink "$PREFIX/app/active")" = "releases/$SHA1"
test "$(<"$PREFIX/app/state/current-target")" = "releases/$SHA1"
test "$(<"$PREFIX/app/state/previous-target")" = "releases/$SHA2"
for artifact in "${!V1_HASHES[@]}"; do
  test "$(sha256sum "$artifact" | cut -d' ' -f1)" = "${V1_HASHES[$artifact]}"
done
ROLLBACK_PID=$(<"$PREFIX/backend.pid")
test "$ROLLBACK_PID" != "$V2_RECOVERED_PID"
kill -0 "$ROLLBACK_PID"
"$PREFIX/bin/pickleshell-memory-ready"
! find "$PREFIX/app" "$PREFIX/units" "$PREFIX/bin" "$PREFIX/logrotate" -type f \( -name '.*.render.*' -o -name '.*.backup.*' -o -name '.*.switch.*' \) | grep -q .
kill "$(<"$PREFIX/backend.pid")" 2>/dev/null || true
printf 'memory deployment E2E: ok\n'
