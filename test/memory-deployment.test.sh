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
cp -a -- "$REPO/pickleshell-memory-backend" "$FIXTURE/"
rm -rf -- "$FIXTURE/pickleshell-memory-backend/.venv"
cp -- "$REPO/deploy/memory-release.sh" "$FIXTURE/deploy/"
cp -- "$REPO/deploy/systemd/pickleshell-memory-backend.service.in" "$FIXTURE/deploy/systemd/"
cp -- "$REPO/deploy/systemd/pickleshell-memory-mcp.sh.in" "$FIXTURE/deploy/systemd/"
cp -- "$REPO/deploy/systemd/pickleshell-memory-backend.sh.in" "$FIXTURE/deploy/systemd/"
cp -- "$REPO/deploy/systemd/pickleshell-memory-backend-bin.sh.in" "$FIXTURE/deploy/systemd/"
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

command -v getfacl >/dev/null || { echo 'getfacl is required for deployment tests' >&2; exit 1; }
command -v setfacl >/dev/null || { echo 'setfacl is required for deployment tests' >&2; exit 1; }
id usbmux >/dev/null 2>&1 || { echo 'usbmux test identity is required for deployment tests' >&2; exit 1; }
getent group plugdev >/dev/null || { echo 'plugdev test group is required for deployment tests' >&2; exit 1; }
ACL_TMP="$TMP/production-acl"
ACL_BIN="$TMP/acl-bin"
mkdir -p -- "$ACL_TMP" "$ACL_BIN"
REAL_STAT=$(command -v stat)
REAL_GETFACL=$(command -v getfacl)
cat > "$ACL_BIN/stat" <<EOF
#!/usr/bin/env bash
if [[ \${*: -1} == /tmp && \$* == *'%u %g %a'* ]]; then
  printf '0 0 755\n'
  exit 0
fi
exec '$REAL_STAT' "\$@"
EOF
chmod 0755 "$ACL_BIN/stat"
run_production_acl_case() {
  local name=$1 acl=$2 expected=$3 case_root
  local -a action_args=(--rollback)
  case_root="$ACL_TMP/$name"
  mkdir -p -- "$case_root/config"
  printf 'BACKEND_TEST=1\n' > "$case_root/config/backend.env"
  printf '%s\n' \
    'PICKLESHELL_MEMORY_ROLE=agent' 'PICKLESHELL_MEMORY_ACTOR=fixture-agent' \
    'PICKLESHELL_MEMORY_SCOPE=fixture-scope' 'PICKLESHELL_MEMORY_BACKEND_URL=http://127.0.0.1:9' \
    "PICKLESHELL_MEMORY_AUDIT_LOG=$case_root/log/audit.jsonl" > "$case_root/config/mcp.env"
  chgrp plugdev "$case_root/config/backend.env" "$case_root/config/mcp.env"
  chmod 0640 "$case_root/config/backend.env" "$case_root/config/mcp.env"
  setfacl -m "$acl" "$case_root/config"
  [[ $expected != allow ]] || action_args=()
  if PATH="$ACL_BIN:$PATH" "$FIXTURE/deploy/memory-release.sh" \
    --profile production --root "$case_root/app" --config-root "$case_root/config" \
    --state-root "$case_root/state" --log-root "$case_root/log" \
    --units-dir "$case_root/units" --logrotate-dir "$case_root/logrotate" \
    --wrapper-dir "$case_root/wrappers" --backend-executable "$PREFLIGHT/bin/node" \
    --node-executable "$PREFLIGHT/bin/node" --systemctl "$PREFLIGHT/bin/systemctl" \
    --service-user usbmux --service-group plugdev \
    --service pickleshell-memory-acl.service "${action_args[@]}" > "$case_root/output" 2>&1; then
    echo "production ACL case $name unexpectedly succeeded" >&2
    exit 1
  fi
  if [[ $expected == unavailable ]]; then
    if [[ -e $case_root/app || -e $case_root/state || -e $case_root/log ]] ||
       ! grep -q 'cannot inspect operator config ACLs' "$case_root/output"; then
      echo "production ACL case $name did not fail closed before mutation" >&2
      exit 1
    fi
  elif [[ $expected == reject ]]; then
    if [[ -e $case_root/app || -e $case_root/state || -e $case_root/log ]] ||
       ! grep -q 'operator config path is writable by the service identity' "$case_root/output"; then
      echo "production ACL case $name was not rejected before mutation" >&2
      exit 1
    fi
  else
    ! grep -q 'operator config path is writable by the service identity' "$case_root/output"
    test ! -e "$case_root/app"
  fi
}
cat > "$ACL_BIN/getfacl" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod 0755 "$ACL_BIN/getfacl"
run_production_acl_case unavailable 'u:usbmux:r-x' unavailable
cat > "$ACL_BIN/getfacl" <<EOF
#!/usr/bin/env bash
case "\${*: -1}" in
  "$ACL_TMP"/*/config) exec '$REAL_GETFACL' "\$@" ;;
  *) printf 'user::rwx\ngroup::r-x\nother::r-x\n' ;;
esac
EOF
chmod 0755 "$ACL_BIN/getfacl"
run_production_acl_case named-user 'u:usbmux:rwx' reject
run_production_acl_case named-group 'g:plugdev:rwx' reject
run_production_acl_case other 'o:rwx' reject
run_production_acl_case default-named-user 'd:u:usbmux:rwx' reject
run_production_acl_case default-named-group 'd:g:plugdev:rwx' reject
run_production_acl_case default-other 'd:o:rwx' reject
run_production_acl_case safe 'u:usbmux:r-x,d:u:usbmux:r-x' allow
grep -q 'source and full commit are required' "$ACL_TMP/safe/output"

# Recreate the prior safe-ACL fallthrough: without the explicit successful
# return, production mode under errexit exits 1 without reaching the next gate
# or emitting an error.
BROKEN_ACL_SCRIPT="$TMP/memory-release-broken-acl-return.sh"
sed '/^  return 0$/d' "$FIXTURE/deploy/memory-release.sh" > "$BROKEN_ACL_SCRIPT"
chmod 0755 "$BROKEN_ACL_SCRIPT"
BROKEN_ACL_CASE="$ACL_TMP/broken-safe"
mkdir -p -- "$BROKEN_ACL_CASE/config"
printf 'BACKEND_TEST=1\n' > "$BROKEN_ACL_CASE/config/backend.env"
printf '%s\n' \
  'PICKLESHELL_MEMORY_ROLE=agent' 'PICKLESHELL_MEMORY_ACTOR=fixture-agent' \
  'PICKLESHELL_MEMORY_SCOPE=fixture-scope' 'PICKLESHELL_MEMORY_BACKEND_URL=http://127.0.0.1:9' \
  "PICKLESHELL_MEMORY_AUDIT_LOG=$BROKEN_ACL_CASE/log/audit.jsonl" > "$BROKEN_ACL_CASE/config/mcp.env"
chgrp plugdev "$BROKEN_ACL_CASE/config/backend.env" "$BROKEN_ACL_CASE/config/mcp.env"
chmod 0640 "$BROKEN_ACL_CASE/config/backend.env" "$BROKEN_ACL_CASE/config/mcp.env"
setfacl -m 'u:usbmux:r-x,d:u:usbmux:r-x' "$BROKEN_ACL_CASE/config"
if PATH="$ACL_BIN:$PATH" "$BROKEN_ACL_SCRIPT" \
  --profile production --root "$BROKEN_ACL_CASE/app" --config-root "$BROKEN_ACL_CASE/config" \
  --state-root "$BROKEN_ACL_CASE/state" --log-root "$BROKEN_ACL_CASE/log" \
  --units-dir "$BROKEN_ACL_CASE/units" --logrotate-dir "$BROKEN_ACL_CASE/logrotate" \
  --wrapper-dir "$BROKEN_ACL_CASE/wrappers" --backend-executable "$PREFLIGHT/bin/node" \
  --node-executable "$PREFLIGHT/bin/node" --systemctl "$PREFLIGHT/bin/systemctl" \
  --service-user usbmux --service-group plugdev \
  --service pickleshell-memory-acl.service > "$BROKEN_ACL_CASE/output" 2>&1; then
  echo 'broken safe ACL validator unexpectedly succeeded' >&2
  exit 1
fi
test ! -s "$BROKEN_ACL_CASE/output"
test ! -e "$BROKEN_ACL_CASE/app"

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

LOCK_CASE="$TMP/deployment-lock"
mkdir -p -- "$LOCK_CASE"/{app/releases,app/state,bin,config,log,logrotate,state,units}
cp -- "$(command -v node)" "$LOCK_CASE/bin/node"
printf '#!/usr/bin/env bash\ntouch %q\nexit 1\n' "$LOCK_CASE/systemctl-called" > "$LOCK_CASE/bin/systemctl"
chmod 0755 "$LOCK_CASE/bin/node" "$LOCK_CASE/bin/systemctl"
printf 'BACKEND_TEST=1\n' > "$LOCK_CASE/config/backend.env"
printf '%s\n' 'PICKLESHELL_MEMORY_ROLE=agent' 'PICKLESHELL_MEMORY_ACTOR=lock-fixture' \
  'PICKLESHELL_MEMORY_SCOPE=lock-scope' 'PICKLESHELL_MEMORY_BACKEND_URL=http://127.0.0.1:9' \
  "PICKLESHELL_MEMORY_AUDIT_LOG=$LOCK_CASE/log/audit.jsonl" > "$LOCK_CASE/config/mcp.env"
chmod 0640 "$LOCK_CASE/config/backend.env" "$LOCK_CASE/config/mcp.env"
prior_sha=1111111111111111111111111111111111111111
mkdir -- "$LOCK_CASE/app/releases/$prior_sha"
printf '%s\n' "$prior_sha" > "$LOCK_CASE/app/releases/$prior_sha/.release-sha"
printf 'prior-safe\n' > "$LOCK_CASE/app/releases/$prior_sha/sentinel"
ln -s "releases/$prior_sha" "$LOCK_CASE/app/active"
printf 'releases/%s\n' "$prior_sha" > "$LOCK_CASE/app/state/current-target"
: > "$LOCK_CASE/app/state/previous-target"
LOCK_PATH="$LOCK_CASE/app.deploy.lock"; : > "$LOCK_PATH"; chmod 0600 "$LOCK_PATH"
exec {HELD_LOCK_FD}<>"$LOCK_PATH"; flock -n "$HELD_LOCK_FD"
lock_before=$(find -P "$LOCK_CASE/app" -printf '%P|%y|%s|%m\n' | sort | sha256sum)
for action in deploy rollback; do
  args=(--profile isolated --root "$LOCK_CASE/app" --config-root "$LOCK_CASE/config" --state-root "$LOCK_CASE/state"
    --log-root "$LOCK_CASE/log" --units-dir "$LOCK_CASE/units" --logrotate-dir "$LOCK_CASE/logrotate"
    --wrapper-dir "$LOCK_CASE/bin" --backend-executable "$LOCK_CASE/bin/node" --node-executable "$LOCK_CASE/bin/node"
    --service-user "$(id -un)" --service-group "$(id -gn)" --service pickleshell-memory-lock.service
    --systemctl "$LOCK_CASE/bin/systemctl")
  [[ $action == deploy ]] && args+=(--source "$FIXTURE" --commit "$SHA1") || args+=(--rollback)
  if "$FIXTURE/deploy/memory-release.sh" "${args[@]}" >"$LOCK_CASE/$action.out" 2>&1; then
    echo "contending $action unexpectedly acquired deployment lock" >&2; exit 1
  fi
  grep -q 'another memory deployment is already running' "$LOCK_CASE/$action.out"
done
exec {HELD_LOCK_FD}>&-
test "$(find -P "$LOCK_CASE/app" -printf '%P|%y|%s|%m\n' | sort | sha256sum)" = "$lock_before"
test "$(<"$LOCK_CASE/app/releases/$prior_sha/sentinel")" = prior-safe
test ! -e "$LOCK_CASE/systemctl-called"

for kind in symlink directory mode owner; do
  unsafe="$TMP/unsafe-lock-$kind"; mkdir -p -- "$unsafe"/{bin,config,log,logrotate,state,units}
  cp -- "$(command -v node)" "$unsafe/bin/node"; cp -- "$LOCK_CASE/bin/systemctl" "$unsafe/bin/systemctl"
  chmod 0755 "$unsafe/bin/node" "$unsafe/bin/systemctl"
  cp -- "$LOCK_CASE/config/backend.env" "$unsafe/config/backend.env"
  sed "s|$LOCK_CASE/log|$unsafe/log|" "$LOCK_CASE/config/mcp.env" > "$unsafe/config/mcp.env"
  chmod 0640 "$unsafe/config/"*.env
  case $kind in
    symlink) ln -s "$unsafe/config" "$unsafe/app.deploy.lock" ;;
    directory) mkdir "$unsafe/app.deploy.lock" ;;
    mode) : > "$unsafe/app.deploy.lock"; chmod 0666 "$unsafe/app.deploy.lock" ;;
    owner)
      : > "$unsafe/app.deploy.lock"; chmod 0600 "$unsafe/app.deploy.lock"
      cat > "$unsafe/bin/stat" <<EOF
#!/usr/bin/env bash
if [[ \${*: -1} == '$unsafe/app.deploy.lock' && \$* == *"%u %a"* ]]; then printf '99999 600\\n'; exit 0; fi
exec '$(command -v stat)' "\$@"
EOF
      chmod 0755 "$unsafe/bin/stat"
      ;;
  esac
  if PATH="$unsafe/bin:$PATH" "$FIXTURE/deploy/memory-release.sh" --profile isolated --source "$FIXTURE" --root "$unsafe/app" --commit "$SHA1" \
    --config-root "$unsafe/config" --state-root "$unsafe/state" --log-root "$unsafe/log" --units-dir "$unsafe/units" \
    --logrotate-dir "$unsafe/logrotate" --wrapper-dir "$unsafe/bin" --backend-executable "$unsafe/bin/node" \
    --node-executable "$unsafe/bin/node" --service-user "$(id -un)" --service-group "$(id -gn)" \
    --service pickleshell-memory-unsafe-lock.service --systemctl "$unsafe/bin/systemctl" >"$unsafe/output" 2>&1; then
    echo "unsafe lock $kind unexpectedly accepted" >&2; exit 1
  fi
  grep -Eq 'deployment lock path is unsafe|deployment lock owner/mode is unsafe' "$unsafe/output"
  test ! -e "$unsafe/app"; test ! -e "$unsafe/systemctl-called"
done

# Atomically claiming the final release directory must not replace a file,
# directory, or symlink that appears at the destination at claim time.
COLLISION="$TMP/final-path-collision"
COLLISION_VICTIM="$TMP/final-path-collision-victim"
mkdir -p -- "$COLLISION"/{app,bin,config,log,logrotate,state,units} "$COLLISION_VICTIM"
cp -- "$(command -v node)" "$COLLISION/bin/node"
printf 'victim-safe\n' > "$COLLISION_VICTIM/sentinel"
printf 'BACKEND_TEST=1\n' > "$COLLISION/config/backend.env"
printf '%s\n' \
  'PICKLESHELL_MEMORY_ROLE=agent' 'PICKLESHELL_MEMORY_ACTOR=collision-fixture' \
  'PICKLESHELL_MEMORY_SCOPE=collision-scope' 'PICKLESHELL_MEMORY_BACKEND_URL=http://127.0.0.1:9' \
  "PICKLESHELL_MEMORY_AUDIT_LOG=$COLLISION/log/audit.jsonl" > "$COLLISION/config/mcp.env"
chmod 0640 "$COLLISION/config/backend.env" "$COLLISION/config/mcp.env"
REAL_MKDIR=$(command -v mkdir)
cat > "$COLLISION/bin/mkdir" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
target=\${*: -1}
if [[ \$target == '$COLLISION/app/releases/$SHA1' ]]; then
  ln -s '$COLLISION_VICTIM' "\$target"
fi
exec '$REAL_MKDIR' "\$@"
EOF
printf '#!/usr/bin/env bash\ntouch %q\nexit 1\n' "$COLLISION/systemctl-called" > "$COLLISION/bin/systemctl"
chmod 0755 "$COLLISION/bin/node" "$COLLISION/bin/mkdir" "$COLLISION/bin/systemctl"
if PATH="$COLLISION/bin:$PATH" "$FIXTURE/deploy/memory-release.sh" \
  --profile isolated --source "$FIXTURE" --root "$COLLISION/app" --commit "$SHA1" \
  --config-root "$COLLISION/config" --state-root "$COLLISION/state" --log-root "$COLLISION/log" \
  --units-dir "$COLLISION/units" --logrotate-dir "$COLLISION/logrotate" --wrapper-dir "$COLLISION/bin" \
  --backend-executable "$COLLISION/bin/node" --node-executable "$COLLISION/bin/node" \
  --service-user "$(id -un)" --service-group "$(id -gn)" --service pickleshell-memory-collision.service \
  --systemctl "$COLLISION/bin/systemctl" >"$COLLISION/output" 2>&1; then
  echo 'atomic final release collision unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'cannot atomically claim final release path without overwrite' "$COLLISION/output"
test -L "$COLLISION/app/releases/$SHA1"
test "$(readlink "$COLLISION/app/releases/$SHA1")" = "$COLLISION_VICTIM"
test "$(<"$COLLISION_VICTIM/sentinel")" = victim-safe
test ! -e "$COLLISION/app/active"
test ! -e "$COLLISION/app/state/current-target"
test ! -e "$COLLISION/app/state/previous-target"
test ! -e "$COLLISION/systemctl-called"

REPLACEMENT="$TMP/final-path-replacement"
REPLACEMENT_VICTIM="$TMP/final-path-replacement-victim"
mkdir -p -- "$REPLACEMENT"/{bin,config,log,logrotate,state,units} "$REPLACEMENT_VICTIM"
cp -- "$(command -v node)" "$REPLACEMENT/bin/node"
printf 'victim-safe\n' > "$REPLACEMENT_VICTIM/sentinel"
printf 'BACKEND_TEST=1\n' > "$REPLACEMENT/config/backend.env"
printf '%s\n' 'PICKLESHELL_MEMORY_ROLE=agent' 'PICKLESHELL_MEMORY_ACTOR=replacement-fixture' \
  'PICKLESHELL_MEMORY_SCOPE=replacement-scope' 'PICKLESHELL_MEMORY_BACKEND_URL=http://127.0.0.1:9' \
  "PICKLESHELL_MEMORY_AUDIT_LOG=$REPLACEMENT/log/audit.jsonl" > "$REPLACEMENT/config/mcp.env"
chmod 0640 "$REPLACEMENT/config/"*.env
REAL_NPM=$(command -v npm)
cat > "$REPLACEMENT/bin/npm" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
'$REAL_NPM' "\$@"
mv -- '$REPLACEMENT/app/releases/$SHA1' '$REPLACEMENT/preserved-claimed-release'
ln -s '$REPLACEMENT_VICTIM' '$REPLACEMENT/app/releases/$SHA1'
EOF
printf '#!/usr/bin/env bash\ntouch %q\nexit 1\n' "$REPLACEMENT/systemctl-called" > "$REPLACEMENT/bin/systemctl"
chmod 0755 "$REPLACEMENT/bin/npm" "$REPLACEMENT/bin/node" "$REPLACEMENT/bin/systemctl"
if PATH="$REPLACEMENT/bin:$PATH" "$FIXTURE/deploy/memory-release.sh" --profile isolated --source "$FIXTURE" \
  --root "$REPLACEMENT/app" --commit "$SHA1" --config-root "$REPLACEMENT/config" --state-root "$REPLACEMENT/state" \
  --log-root "$REPLACEMENT/log" --units-dir "$REPLACEMENT/units" --logrotate-dir "$REPLACEMENT/logrotate" \
  --wrapper-dir "$REPLACEMENT/bin" --backend-executable "$REPLACEMENT/bin/node" --node-executable "$REPLACEMENT/bin/node" \
  --service-user "$(id -un)" --service-group "$(id -gn)" --service pickleshell-memory-replacement.service \
  --systemctl "$REPLACEMENT/bin/systemctl" >"$REPLACEMENT/output" 2>&1; then
  echo 'post-claim release replacement unexpectedly succeeded' >&2; exit 1
fi
grep -q 'final release path identity changed' "$REPLACEMENT/output"
grep -q 'preserving unsuccessful release because its identity changed' "$REPLACEMENT/output"
test -L "$REPLACEMENT/app/releases/$SHA1"
test "$(<"$REPLACEMENT_VICTIM/sentinel")" = victim-safe
test -d "$REPLACEMENT/preserved-claimed-release"
test ! -e "$REPLACEMENT/systemctl-called"

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
    if [[ $2 == pickleshell-memory-isolated.service || $2 == pickleshell-memory-first-failure.service ||
          $2 == pickleshell-memory-managed.service || $2 == pickleshell-memory-real.service ||
          $2 == pickleshell-memory-parent-real.service ]]; then
      set -a
      source "${FAKE_SYSTEMD_ROOT}/config/backend.env"
      set +a
      for inherited_fd in {10..64}; do eval "exec ${inherited_fd}>&-" 2>/dev/null || true; done
      "${FAKE_BACKEND_COMMAND:-${FAKE_SYSTEMD_ROOT}/bin/backend-wrapper}" >/dev/null 2>&1 & echo $! > "$pidfile"
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

run_normal_preflight_no_mutation_case() {
  local name=$1 source=$2 commit=$3 existing_release=${4:-0} case_root before after
  case_root="$TMP/normal-preflight-$name"
  mkdir -p -- "$case_root"/{app,config,log,logrotate,state,units,wrappers}
  printf 'BACKEND_TEST=1\n' > "$case_root/config/backend.env"
  printf '%s\n' \
    'PICKLESHELL_MEMORY_ROLE=agent' 'PICKLESHELL_MEMORY_ACTOR=fixture-agent' \
    'PICKLESHELL_MEMORY_SCOPE=fixture-scope' 'PICKLESHELL_MEMORY_BACKEND_URL=http://127.0.0.1:9' \
    "PICKLESHELL_MEMORY_AUDIT_LOG=$case_root/log/audit.jsonl" > "$case_root/config/mcp.env"
  chmod 0640 "$case_root/config/backend.env" "$case_root/config/mcp.env"
  printf 'unchanged\n' > "$case_root/state/sentinel"
  cp -- "$(command -v node)" "$case_root/wrappers/node"
  cp -- "$(command -v node)" "$case_root/wrappers/backend"
  printf '#!/usr/bin/env bash\ntouch %q\nexit 1\n' "$case_root/service-called" > "$case_root/wrappers/systemctl"
  chmod 0755 "$case_root/wrappers/node" "$case_root/wrappers/backend" "$case_root/wrappers/systemctl"
  chmod 0711 "$case_root/app" "$case_root/state" "$case_root/log"
  if ((existing_release)); then
    mkdir -p -- "$case_root/app/releases/$commit"
    printf '%s\n' "$commit" > "$case_root/app/releases/$commit/.release-sha"
  fi
  before=$(find -P "$case_root" -printf '%P|%y|%s|%T@|%m|%u|%g\n' | sort | sha256sum | cut -d' ' -f1)
  if PATH="$PREFIX/bin:$PATH" FAKE_SYSTEMD_ROOT="$PREFIX" "$FIXTURE/deploy/memory-release.sh" \
    --profile isolated --source "$source" --root "$case_root/app" --commit "$commit" \
    --config-root "$case_root/config" --state-root "$case_root/state" --log-root "$case_root/log" \
    --units-dir "$case_root/units" --logrotate-dir "$case_root/logrotate" \
    --backend-executable "$case_root/wrappers/backend" --node-executable "$case_root/wrappers/node" \
    --service-user "$(id -un)" --service-group "$(id -gn)" \
    --service pickleshell-memory-preflight.service --systemctl "$case_root/wrappers/systemctl" \
    --wrapper-dir "$case_root/wrappers" >"$TMP/normal-preflight-$name.out" 2>&1; then
    echo "normal preflight $name unexpectedly succeeded" >&2
    exit 1
  fi
  after=$(find -P "$case_root" -printf '%P|%y|%s|%T@|%m|%u|%g\n' | sort | sha256sum | cut -d' ' -f1)
  test "$after" = "$before"
  test "$(<"$case_root/state/sentinel")" = unchanged
}

DIRTY_SOURCE="$TMP/dirty-normal-source"
git clone -q --no-local "$FIXTURE" "$DIRTY_SOURCE"
printf 'dirty\n' > "$DIRTY_SOURCE/untracked"
run_normal_preflight_no_mutation_case missing-source "$TMP/does-not-exist" "$SHA1"
run_normal_preflight_no_mutation_case dirty-source "$DIRTY_SOURCE" "$SHA1"
run_normal_preflight_no_mutation_case invalid-commit "$FIXTURE" 0000000000000000000000000000000000000000
run_normal_preflight_no_mutation_case existing-release "$FIXTURE" "$SHA1" 1

MANAGED="$TMP/managed"
mkdir -p -- "$MANAGED"/{bin,config,log,logrotate,state,units}
cp -- "$PREFIX/bin/backend.js" "$PREFIX/bin/systemctl" "$MANAGED/bin/"
chmod 0755 "$MANAGED/bin/backend.js" "$MANAGED/bin/systemctl"
MANAGED_PORT=$((30001 + RANDOM % 9000))
printf 'FAKE_BACKEND_PORT=%s\nMEM0_DATA_DIR=%s\n' "$MANAGED_PORT" "$MANAGED/state/backend" > "$MANAGED/config/backend.env"
printf '%s\n' \
  'PICKLESHELL_MEMORY_ROLE=agent' 'PICKLESHELL_MEMORY_ACTOR=managed-fixture' \
  'PICKLESHELL_MEMORY_SCOPE=managed-fixture-scope' "PICKLESHELL_MEMORY_BACKEND_URL=http://127.0.0.1:$MANAGED_PORT" \
  "PICKLESHELL_MEMORY_AUDIT_LOG=$MANAGED/log/audit.jsonl" > "$MANAGED/config/mcp.env"
chmod 0640 "$MANAGED/config/backend.env" "$MANAGED/config/mcp.env"
cat > "$MANAGED/bin/python-fixture" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ ${1:-} == -c ]]; then
  exit 0
fi
if [[ ${1:-} == -m && ${2:-} == pip ]]; then
  shift 2
  exec "$(dirname -- "$0")/pip" "$@"
fi
if [[ ${1:-} == -m && ${2:-} == venv ]]; then
  target=${*: -1}
  mkdir -p -- "$target/bin"
  cp -- "$0" "$target/bin/python"
  cat > "$target/bin/pip" <<'PIP'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ " $* " == *' -r '* && " $* " != *' --require-hashes '* ]]; then exit 99; fi
if [[ ${1:-} == install ]]; then
  lock=''
  while (($#)); do
    if [[ $1 == -r ]]; then lock=${2:-}; break; fi
    shift
  done
  if [[ -n $lock ]] && ! grep -q '^packaging==' "$lock"; then
    touch "$(dirname -- "$0")/../dependency-incomplete"
  fi
fi
if [[ ${1:-} == check && -f $(dirname -- "$0")/../dependency-incomplete ]]; then
  exit 1
fi
exit 0
PIP
  chmod 0755 "$target/bin/python" "$target/bin/pip"
  exit 0
fi
if [[ ${1:-} == -m && ${2:-} == pickleshell_memory_backend ]]; then
  exec "${FAKE_SYSTEMD_ROOT:?}/bin/backend.js"
fi
exit 2
EOF
chmod 0755 "$MANAGED/bin/python-fixture"

INCOMPLETE_SOURCE="$TMP/incomplete-managed-source"
git clone -q --no-local "$FIXTURE" "$INCOMPLETE_SOURCE"
sed -i '/^packaging==/,+1d' "$INCOMPLETE_SOURCE/pickleshell-memory-backend/requirements.lock"
git -C "$INCOMPLETE_SOURCE" add pickleshell-memory-backend/requirements.lock
git -C "$INCOMPLETE_SOURCE" commit -qm 'fixture: incomplete backend lock'
INCOMPLETE_SHA=$(git -C "$INCOMPLETE_SOURCE" rev-parse HEAD)
INCOMPLETE="$TMP/incomplete-managed"
mkdir -p -- "$INCOMPLETE"/{bin,config,log,logrotate,state,units}
cp -- "$MANAGED/bin/python-fixture" "$INCOMPLETE/bin/"
printf '#!/usr/bin/env bash\ntouch %q\nexit 1\n' "$INCOMPLETE/systemctl-called" > "$INCOMPLETE/bin/systemctl"
chmod 0755 "$INCOMPLETE/bin/python-fixture" "$INCOMPLETE/bin/systemctl"
printf 'MEM0_DATA_DIR=%s\n' "$INCOMPLETE/state/backend" > "$INCOMPLETE/config/backend.env"
printf '%s\n' \
  'PICKLESHELL_MEMORY_ROLE=agent' 'PICKLESHELL_MEMORY_ACTOR=incomplete-fixture' \
  'PICKLESHELL_MEMORY_SCOPE=incomplete-fixture-scope' 'PICKLESHELL_MEMORY_BACKEND_URL=http://127.0.0.1:9' \
  "PICKLESHELL_MEMORY_AUDIT_LOG=$INCOMPLETE/log/audit.jsonl" > "$INCOMPLETE/config/mcp.env"
chmod 0640 "$INCOMPLETE/config/backend.env" "$INCOMPLETE/config/mcp.env"
if "$FIXTURE/deploy/memory-release.sh" \
  --profile isolated --source "$INCOMPLETE_SOURCE" --root "$INCOMPLETE/app" --commit "$INCOMPLETE_SHA" \
  --config-root "$INCOMPLETE/config" --state-root "$INCOMPLETE/state" --log-root "$INCOMPLETE/log" \
  --units-dir "$INCOMPLETE/units" --logrotate-dir "$INCOMPLETE/logrotate" --wrapper-dir "$INCOMPLETE/bin" \
  --managed-backend-executable "$INCOMPLETE/bin/pickleshell-memory-backend" \
  --python-executable "$INCOMPLETE/bin/python-fixture" --node-executable "$(command -v node)" \
  --service-user "$(id -un)" --service-group "$(id -gn)" --service pickleshell-memory-incomplete.service \
  --systemctl "$INCOMPLETE/bin/systemctl" > "$INCOMPLETE/output" 2>&1; then
  echo 'dependency-incomplete managed release unexpectedly succeeded' >&2
  exit 1
fi
if [[ -e $INCOMPLETE/systemctl-called ]]; then
  echo 'dependency-incomplete managed release reached service activation' >&2
  exit 1
fi
test ! -e "$INCOMPLETE/app/active"
test ! -e "$INCOMPLETE/app/state/current-target"
test ! -e "$INCOMPLETE/app/state/previous-target"
test ! -e "$INCOMPLETE/bin/pickleshell-memory-backend"
test ! -e "$INCOMPLETE/units/pickleshell-memory-incomplete.service"
test -z "$(find "$INCOMPLETE/app/releases" -mindepth 1 -maxdepth 1 -print -quit)"

FAKE_SYSTEMD_ROOT="$MANAGED" "$FIXTURE/deploy/memory-release.sh" \
  --profile isolated --source "$FIXTURE" --root "$MANAGED/app" --commit "$SHA1" \
  --config-root "$MANAGED/config" --state-root "$MANAGED/state" --log-root "$MANAGED/log" \
  --units-dir "$MANAGED/units" --logrotate-dir "$MANAGED/logrotate" --wrapper-dir "$MANAGED/bin" \
  --managed-backend-executable "$MANAGED/bin/pickleshell-memory-backend" \
  --python-executable "$MANAGED/bin/python-fixture" --node-executable "$(command -v node)" \
  --service-user "$(id -un)" --service-group "$(id -gn)" --service pickleshell-memory-managed.service \
  --systemctl "$MANAGED/bin/systemctl"
test -x "$MANAGED/bin/pickleshell-memory-backend"
test -x "$MANAGED/app/active/pickleshell-memory-backend/.venv/bin/python"
test -f "$MANAGED/app/active/pickleshell-memory-backend/requirements.lock"
test -d "$MANAGED/state/backend"
test "$(stat -c %a "$MANAGED/state/backend")" = 750
"$MANAGED/bin/pickleshell-memory-ready"
kill "$(<"$MANAGED/backend.pid")" 2>/dev/null || true

REAL_PYTHON=/usr/bin/python3.12
[[ -f $REAL_PYTHON && -x $REAL_PYTHON && ! -L $REAL_PYTHON ]] || {
  echo 'real CPython 3.12 is required for managed deployment relocation coverage' >&2
  exit 1
}
run_real_managed_install() {
  local script=$1 case_root=$2 service=$3 port
  port=$((39001 + RANDOM % 5000))
  mkdir -p -- "$case_root"/{bin,config,log,logrotate,state,units}
  cp -- "$PREFIX/bin/backend.js" "$PREFIX/bin/systemctl" "$case_root/bin/"
  chmod 0755 "$case_root/bin/backend.js" "$case_root/bin/systemctl"
  printf 'FAKE_BACKEND_PORT=%s\nMEM0_DATA_DIR=%s\n' "$port" "$case_root/state/backend" > "$case_root/config/backend.env"
  printf '%s\n' \
    'PICKLESHELL_MEMORY_ROLE=agent' 'PICKLESHELL_MEMORY_ACTOR=real-managed-fixture' \
    'PICKLESHELL_MEMORY_SCOPE=real-managed-fixture-scope' "PICKLESHELL_MEMORY_BACKEND_URL=http://127.0.0.1:$port" \
    "PICKLESHELL_MEMORY_AUDIT_LOG=$case_root/log/audit.jsonl" > "$case_root/config/mcp.env"
  chmod 0640 "$case_root/config/backend.env" "$case_root/config/mcp.env"
  PATH="$PREFIX/bin:$PATH" FAKE_SYSTEMD_ROOT="$case_root" FAKE_BACKEND_COMMAND="$case_root/bin/backend.js" "$script" \
    --profile isolated --source "$FIXTURE" --root "$case_root/app" --commit "$SHA1" \
    --config-root "$case_root/config" --state-root "$case_root/state" --log-root "$case_root/log" \
    --units-dir "$case_root/units" --logrotate-dir "$case_root/logrotate" --wrapper-dir "$case_root/bin" \
    --managed-backend-executable "$case_root/bin/pickleshell-memory-backend" \
    --python-executable "$REAL_PYTHON" --node-executable "$(command -v node)" \
    --service-user "$(id -un)" --service-group "$(id -gn)" --service "$service" \
    --systemctl "$case_root/bin/systemctl"
}

# Prove the parent installer creates console entrypoints that retain the
# deleted staging path after its final release rename.
PARENT_INSTALLER="$TMP/memory-release-parent.sh"
git -C "$REPO" show 4956dec93ab06fc033c75e8c4afbb97f69e62f90:deploy/memory-release.sh > "$PARENT_INSTALLER"
chmod 0755 "$PARENT_INSTALLER"
PARENT_REAL="$TMP/parent-real-managed"
run_real_managed_install "$PARENT_INSTALLER" "$PARENT_REAL" pickleshell-memory-parent-real.service
PARENT_VENV="$PARENT_REAL/app/releases/$SHA1/pickleshell-memory-backend/.venv"
if "$PARENT_VENV/bin/pip" check >"$PARENT_REAL/stale-pip.out" 2>&1; then
  echo 'parent relocated pip unexpectedly succeeded' >&2
  exit 1
fi
grep -F '/releases/.staging-' "$PARENT_VENV/bin/pip" >/dev/null
! compgen -G "$PARENT_REAL/app/releases/.staging-*" >/dev/null
"$PARENT_VENV/bin/python" -m pip check
kill "$(<"$PARENT_REAL/backend.pid")" 2>/dev/null || true

REAL_MANAGED="$TMP/real-managed"
run_real_managed_install "$FIXTURE/deploy/memory-release.sh" "$REAL_MANAGED" pickleshell-memory-real.service
REAL_VENV="$REAL_MANAGED/app/releases/$SHA1/pickleshell-memory-backend/.venv"
"$REAL_VENV/bin/pip" check
"$REAL_VENV/bin/pip3" --version >/dev/null
"$REAL_VENV/bin/uvicorn" --version >/dev/null
if env -i PATH=/usr/bin:/bin "$REAL_VENV/bin/pickleshell-memory-backend" >"$REAL_MANAGED/backend-entrypoint.out" 2>&1; then
  echo 'backend console entrypoint unexpectedly started without configuration' >&2
  exit 1
fi
grep -q 'configuration error: backend bearer token is required' "$REAL_MANAGED/backend-entrypoint.out"
"$REAL_VENV/bin/python" -m pip check
if grep -R -F -l -- '.staging-' "$REAL_VENV/bin" >"$REAL_MANAGED/staging-references.out"; then
  echo 'final virtual environment contains a staging-path reference' >&2
  exit 1
fi
test ! -s "$REAL_MANAGED/staging-references.out"
! compgen -G "$REAL_MANAGED/app/releases/.staging-*" >/dev/null
kill "$(<"$REAL_MANAGED/backend.pid")" 2>/dev/null || true

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
printf 'releases/%040d\n' 2 > "$FIRST_FAILURE/app/state/current-target"
printf 'releases/%040d\n' 3 > "$FIRST_FAILURE/app/state/previous-target"
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
test "$(<"$FIRST_FAILURE/app/state/current-target")" = "releases/$(printf '%040d' 2)"
test "$(<"$FIRST_FAILURE/app/state/previous-target")" = "releases/$(printf '%040d' 3)"
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

# Model partial transaction recovery that leaves each managed reference on the
# unsuccessful release. EXIT cleanup must preserve every referenced release.
run_referenced_cleanup_case() {
  local reference=$1 case_root="$TMP/referenced-cleanup-$1" prior_sha injection script
  prior_sha=1111111111111111111111111111111111111111
  mkdir -p -- "$case_root"/{app/releases/$prior_sha,app/state,bin,config,log,logrotate,state,units}
  printf '%s\n' "$prior_sha" > "$case_root/app/releases/$prior_sha/.release-sha"
  printf 'prior-safe\n' > "$case_root/app/releases/$prior_sha/sentinel"
  ln -s "releases/$prior_sha" "$case_root/app/active"
  printf 'releases/%s\n' "$prior_sha" > "$case_root/app/state/current-target"
  : > "$case_root/app/state/previous-target"
  cp -- "$(command -v node)" "$case_root/bin/node"
  printf '#!/usr/bin/env bash\ntouch %q\nexit 1\n' "$case_root/systemctl-called" > "$case_root/bin/systemctl"
  chmod 0755 "$case_root/bin/node" "$case_root/bin/systemctl"
  printf 'BACKEND_TEST=1\n' > "$case_root/config/backend.env"
  printf '%s\n' \
    'PICKLESHELL_MEMORY_ROLE=agent' 'PICKLESHELL_MEMORY_ACTOR=reference-fixture' \
    'PICKLESHELL_MEMORY_SCOPE=reference-scope' 'PICKLESHELL_MEMORY_BACKEND_URL=http://127.0.0.1:9' \
    "PICKLESHELL_MEMORY_AUDIT_LOG=$case_root/log/audit.jsonl" > "$case_root/config/mcp.env"
  chmod 0640 "$case_root/config/backend.env" "$case_root/config/mcp.env"
  case $reference in
    active) injection="rm -f -- '$case_root/app/active'; ln -s 'releases/$SHA1' '$case_root/app/active'; false" ;;
    current) injection="printf 'releases/%s\\n' '$SHA1' > '$case_root/app/state/current-target'; false" ;;
    previous) injection="printf 'releases/%s\\n' '$SHA1' > '$case_root/app/state/previous-target'; false" ;;
  esac
  script="$case_root/memory-release-$reference.sh"
  sed "/^previous=''/i $injection" "$FIXTURE/deploy/memory-release.sh" > "$script"
  chmod 0755 "$script"
  if "$script" \
    --profile isolated --source "$FIXTURE" --root "$case_root/app" --commit "$SHA1" \
    --config-root "$case_root/config" --state-root "$case_root/state" --log-root "$case_root/log" \
    --units-dir "$case_root/units" --logrotate-dir "$case_root/logrotate" --wrapper-dir "$case_root/bin" \
    --backend-executable "$case_root/bin/node" --node-executable "$case_root/bin/node" \
    --service-user "$(id -un)" --service-group "$(id -gn)" --service pickleshell-memory-reference.service \
    --systemctl "$case_root/bin/systemctl" >"$case_root/output" 2>&1; then
    echo "referenced cleanup case $reference unexpectedly succeeded" >&2
    exit 1
  fi
  grep -q 'preserving unsuccessful release because deployment state references it' "$case_root/output"
  test -d "$case_root/app/releases/$SHA1"
  test "$(<"$case_root/app/releases/$SHA1/.release-sha")" = "$SHA1"
  test "$(<"$case_root/app/releases/$prior_sha/sentinel")" = prior-safe
  test ! -e "$case_root/systemctl-called"
  ! compgen -G "$case_root/app/releases/.staging-*" >/dev/null
  if [[ $reference != active ]]; then
    test "$(readlink "$case_root/app/active")" = "releases/$prior_sha"
  fi
}
run_referenced_cleanup_case active
run_referenced_cleanup_case current
run_referenced_cleanup_case previous

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

assert_unsafe_rollback_target_rejected() {
  local name=$1 subject=$2 target=$3 setup=${4:-none} fake_sha fake_path calls_before artifact
  local root_before releases_before deploy_state_before state_root_before log_root_before audit_before
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
  case $subject in
    active) ln -sfn "$target" "$PREFIX/app/active" ;;
    current) printf '%s\n' "$target" > "$PREFIX/app/state/current-target" ;;
    previous) printf '%s\n' "$target" > "$PREFIX/app/state/previous-target" ;;
  esac
  chmod 0711 "$PREFIX/app" "$PREFIX/app/releases" "$PREFIX/app/state" "$PREFIX/state" "$PREFIX/log"
  chmod 0600 "$PREFIX/log/audit.jsonl"
  root_before=$(stat -c '%F:%a:%u:%g' "$PREFIX/app")
  releases_before=$(stat -c '%F:%a:%u:%g' "$PREFIX/app/releases")
  deploy_state_before=$(stat -c '%F:%a:%u:%g' "$PREFIX/app/state")
  state_root_before=$(stat -c '%F:%a:%u:%g' "$PREFIX/state")
  log_root_before=$(stat -c '%F:%a:%u:%g' "$PREFIX/log")
  audit_before=$(stat -c '%F:%a:%u:%g:%s' "$PREFIX/log/audit.jsonl"):$(sha256sum "$PREFIX/log/audit.jsonl" | cut -d' ' -f1)
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
  if ! grep -q "managed release target is unsafe: $subject" "$TMP/unsafe-rollback-$name.out"; then
    echo "unsafe rollback target $name was not rejected by managed-release validation" >&2
    exit 1
  fi
  if [[ $(stat -c '%F:%a:%u:%g' "$PREFIX/app") != "$root_before" ||
        $(stat -c '%F:%a:%u:%g' "$PREFIX/app/releases") != "$releases_before" ||
        $(stat -c '%F:%a:%u:%g' "$PREFIX/app/state") != "$deploy_state_before" ||
        $(stat -c '%F:%a:%u:%g' "$PREFIX/state") != "$state_root_before" ||
        $(stat -c '%F:%a:%u:%g' "$PREFIX/log") != "$log_root_before" ||
        $(stat -c '%F:%a:%u:%g:%s' "$PREFIX/log/audit.jsonl"):$(sha256sum "$PREFIX/log/audit.jsonl" | cut -d' ' -f1) != "$audit_before" ]]; then
    echo "unsafe rollback target $name mutated deployment state before rejection" >&2
    exit 1
  fi
  test "$(wc -l < "$PREFIX/systemctl.calls")" -eq "$calls_before"
  case $subject in
    active) test "$(readlink "$PREFIX/app/active")" = "$target" ;;
    current) test "$(<"$PREFIX/app/state/current-target")" = "$target" ;;
    previous) test "$(<"$PREFIX/app/state/previous-target")" = "$target" ;;
  esac
  test "$(<"$PREFIX/backend.pid")" = "$V2_PID"; kill -0 "$V2_PID"
  for artifact in "${!V2_HASHES[@]}"; do
    test "$(sha256sum "$artifact" | cut -d' ' -f1)" = "${V2_HASHES[$artifact]}"
  done
  case $setup in
    symlink-release|missing-marker|mismatched-marker|symlink-marker) rm -rf -- "$fake_path" ;;
  esac
  ln -sfn "releases/$SHA2" "$PREFIX/app/active"
  printf 'releases/%s\n' "$SHA2" > "$PREFIX/app/state/current-target"
  printf 'releases/%s\n' "$SHA1" > "$PREFIX/app/state/previous-target"
  chmod 0750 "$PREFIX/app" "$PREFIX/app/releases" "$PREFIX/app/state" "$PREFIX/state" "$PREFIX/log"
  chmod 0660 "$PREFIX/log/audit.jsonl"
}

FAKE_RELEASE_SHA=0000000000000000000000000000000000000001
assert_unsafe_rollback_target_rejected traversal previous 'releases/../rollback-victim'
assert_unsafe_rollback_target_rejected nested previous "releases/$SHA1/nested"
assert_unsafe_rollback_target_rejected invalid-sha previous 'releases/not-a-full-sha'
assert_unsafe_rollback_target_rejected invalid-current current 'releases/not-a-full-sha'
assert_unsafe_rollback_target_rejected invalid-active active 'releases/not-a-full-sha'
assert_unsafe_rollback_target_rejected symlink-release previous "releases/$FAKE_RELEASE_SHA" symlink-release
assert_unsafe_rollback_target_rejected missing-marker previous "releases/$FAKE_RELEASE_SHA" missing-marker
assert_unsafe_rollback_target_rejected mismatched-marker previous "releases/$FAKE_RELEASE_SHA" mismatched-marker
assert_unsafe_rollback_target_rejected symlink-marker previous "releases/$FAKE_RELEASE_SHA" symlink-marker

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
