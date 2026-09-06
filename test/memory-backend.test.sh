#!/usr/bin/env bash
set -Eeuo pipefail

REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
PACKAGE="$REPO/pickleshell-memory-backend"
python3 -m venv "$PACKAGE/.venv"
"$PACKAGE/.venv/bin/pip" install --disable-pip-version-check --require-hashes --no-deps -r "$PACKAGE/requirements.lock"
"$PACKAGE/.venv/bin/pip" install --disable-pip-version-check --no-build-isolation --no-deps "$PACKAGE"
"$PACKAGE/.venv/bin/pip" check
"$PACKAGE/.venv/bin/python" -m unittest discover -s "$PACKAGE/test" -v

LOCK_TEST=$(mktemp -d)
trap 'rm -rf -- "$LOCK_TEST"' EXIT
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
