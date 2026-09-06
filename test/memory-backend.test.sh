#!/usr/bin/env bash
set -Eeuo pipefail

REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
PACKAGE="$REPO/pickleshell-memory-backend"
python3 -m venv "$PACKAGE/.venv"
"$PACKAGE/.venv/bin/pip" install --disable-pip-version-check --no-deps -r "$PACKAGE/requirements.lock"
"$PACKAGE/.venv/bin/pip" install --disable-pip-version-check --no-build-isolation --no-deps "$PACKAGE"
"$PACKAGE/.venv/bin/pip" check
"$PACKAGE/.venv/bin/python" -m unittest discover -s "$PACKAGE/test" -v
