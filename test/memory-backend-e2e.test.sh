#!/usr/bin/env bash
set -Eeuo pipefail

REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
TMP=$(mktemp -d)
BACKEND_PID=''
cleanup() {
  [[ -z $BACKEND_PID ]] || kill "$BACKEND_PID" 2>/dev/null || true
  [[ -z $BACKEND_PID ]] || wait "$BACKEND_PID" 2>/dev/null || true
  rm -rf -- "$TMP"
}
trap cleanup EXIT
PORT=$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)
[[ $PORT != 8765 ]]
TOKEN='backend-e2e-token-value-0000000000000000'
mkdir -m 0700 "$TMP/data"
SPIKE_DATA="$REPO/../pickleshell-mem0-spike/spikes/mem0-bos/data"
if [[ -d $SPIKE_DATA && ! -L $SPIKE_DATA ]]; then
  spike_data_before=$(find -P "$SPIKE_DATA" -xdev -printf '%P|%y|%s|%T@|%m|%u|%g\n' | sort | sha256sum | cut -d' ' -f1)
else
  spike_data_before=absent
fi
if spike_health=$(curl -fsS --max-time 2 http://127.0.0.1:8765/health 2>/dev/null); then
  spike_before=$(printf '%s' "$spike_health" | sha256sum | cut -d' ' -f1)
else
  spike_before=absent
fi
export PICKLESHELL_MEMORY_BACKEND_HOST=127.0.0.1
export PICKLESHELL_MEMORY_BACKEND_PORT=$PORT
export PICKLESHELL_MEMORY_BACKEND_TOKEN=$TOKEN
export MEM0_DATA_DIR="$TMP/data"
export MEM0_LLM_PROVIDER=ollama
export MEM0_LLM_MODEL=fixture-llm
export MEM0_LLM_BASE_URL=http://127.0.0.1:9
export MEM0_EMBED_PROVIDER=ollama
export MEM0_EMBED_MODEL=fixture-embed
export MEM0_EMBED_BASE_URL=http://127.0.0.1:9
start_backend() {
  PYTHONPATH="$REPO/pickleshell-memory-backend/test:$REPO/pickleshell-memory-backend" \
    "$REPO/pickleshell-memory-backend/.venv/bin/python" -m uvicorn real_server:app \
    --app-dir "$REPO/pickleshell-memory-backend/test" --host 127.0.0.1 --port "$PORT" \
    --no-access-log --log-level warning >"$TMP/backend.out" 2>&1 &
  BACKEND_PID=$!
  for _ in {1..100}; do
    kill -0 "$BACKEND_PID" 2>/dev/null || { echo 'backend E2E process exited' >&2; exit 1; }
    curl -fsS --max-time 0.2 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && return
    sleep 0.02
  done
  return 1
}
start_backend
printf '%s\n' \
  'PICKLESHELL_MEMORY_ROLE=agent' \
  'PICKLESHELL_MEMORY_ACTOR=backend-e2e' \
  'PICKLESHELL_MEMORY_SCOPE=backend-e2e-scope' \
  "PICKLESHELL_MEMORY_AUDIT_LOG=$TMP/audit.jsonl" \
  "PICKLESHELL_MEMORY_BACKEND_URL=http://127.0.0.1:$PORT" \
  "PICKLESHELL_MEMORY_BACKEND_TOKEN=$TOKEN" > "$TMP/mcp.env"
chmod 0600 "$TMP/mcp.env"
printf '#!/usr/bin/env bash\nexec %q --env-file=%q %q\n' \
  "$(command -v node)" "$TMP/mcp.env" "$REPO/pickleshell-memory-mcp/src/index.js" > "$TMP/mcp-wrapper"
chmod 0700 "$TMP/mcp-wrapper"
MEMORY_MCP_WRAPPER="$TMP/mcp-wrapper" MEMORY_E2E_PHASE=seed MEMORY_E2E_STATE="$TMP/memory-id" \
  node "$REPO/test/memory-backend-mcp-e2e.mjs"
kill "$BACKEND_PID"; wait "$BACKEND_PID" || true; BACKEND_PID=''
start_backend
MEMORY_MCP_WRAPPER="$TMP/mcp-wrapper" MEMORY_E2E_PHASE=resume MEMORY_E2E_STATE="$TMP/memory-id" \
  node "$REPO/test/memory-backend-mcp-e2e.mjs"
test "$(wc -l < "$TMP/audit.jsonl")" -eq 12
if [[ $spike_before == absent ]]; then
  ! curl -fsS --max-time 2 http://127.0.0.1:8765/health >/dev/null 2>&1
else
  spike_after=$(curl -fsS --max-time 2 http://127.0.0.1:8765/health | sha256sum | cut -d' ' -f1)
  test "$spike_after" = "$spike_before"
fi
if [[ $spike_data_before != absent ]]; then
  spike_data_after=$(find -P "$SPIKE_DATA" -xdev -printf '%P|%y|%s|%T@|%m|%u|%g\n' | sort | sha256sum | cut -d' ' -f1)
  test "$spike_data_after" = "$spike_data_before"
fi
printf 'memory backend isolated E2E: ok\n'
