#!/usr/bin/env bash
set -Eeuo pipefail

REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
PACKAGE="$REPO/pickleshell-memory-backend"
TEST_TMP=$(mktemp -d)
trap 'rm -rf -- "$TEST_TMP"' EXIT

FRESH_VENV="$TEST_TMP/fresh-venv"
python3 -m venv "$FRESH_VENV"
"$FRESH_VENV/bin/pip" install --disable-pip-version-check --require-hashes --no-deps -r "$PACKAGE/requirements.lock"
"$FRESH_VENV/bin/pip" install --disable-pip-version-check --no-build-isolation --no-deps "$PACKAGE"
"$FRESH_VENV/bin/pip" check
"$FRESH_VENV/bin/python" -c 'import importlib.metadata; assert importlib.metadata.version("packaging") == "26.3"'
"$FRESH_VENV/bin/python" -m unittest discover -s "$PACKAGE/test" -v

python3 -m venv "$PACKAGE/.venv"
"$PACKAGE/.venv/bin/pip" install --disable-pip-version-check --require-hashes --no-deps -r "$PACKAGE/requirements.lock"
"$PACKAGE/.venv/bin/pip" install --disable-pip-version-check --no-build-isolation --no-deps "$PACKAGE"
"$PACKAGE/.venv/bin/pip" check

LOCK_TEST="$TEST_TMP/lock"
mkdir "$LOCK_TEST"
sed '0,/--hash=sha256:/s/--hash=sha256:[0-9a-f]*/--hash=sha256:0000000000000000000000000000000000000000000000000000000000000000/' \
  "$PACKAGE/requirements.lock" > "$LOCK_TEST/tampered.lock"
if "$PACKAGE/.venv/bin/pip" install --disable-pip-version-check --dry-run --ignore-installed \
  --require-hashes --no-deps -r "$LOCK_TEST/tampered.lock" >"$LOCK_TEST/tampered.out" 2>&1; then
  echo 'tampered dependency hash unexpectedly accepted' >&2
  exit 1
fi
sed '1s/ \\$$//; 2d' "$PACKAGE/requirements.lock" > "$LOCK_TEST/missing.lock"
if "$PACKAGE/.venv/bin/pip" install --disable-pip-version-check --dry-run --ignore-installed \
  --require-hashes --no-deps -r "$LOCK_TEST/missing.lock" >"$LOCK_TEST/missing.out" 2>&1; then
  echo 'missing dependency hash unexpectedly accepted' >&2
  exit 1
fi

sed '/^packaging==26\.3 \\/,+1d' "$PACKAGE/requirements.lock" > "$LOCK_TEST/missing-packaging.lock"
MISSING_PACKAGING_VENV="$TEST_TMP/missing-packaging-venv"
python3 -m venv "$MISSING_PACKAGING_VENV"
"$MISSING_PACKAGING_VENV/bin/pip" install --disable-pip-version-check --require-hashes --no-deps \
  -r "$LOCK_TEST/missing-packaging.lock"
if "$MISSING_PACKAGING_VENV/bin/pip" check >"$LOCK_TEST/missing-packaging.out" 2>&1; then
  echo 'dependency-incomplete lock unexpectedly passed pip check' >&2
  exit 1
fi
grep -Fxq 'wheel 0.48.0 requires packaging, which is not installed.' "$LOCK_TEST/missing-packaging.out"
