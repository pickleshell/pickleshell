# PickleShell production Memory backend

This package is the repository-owned self-hosted `mem0ai` HTTP backend used by
the optional PickleShell Memory MCP. It is independent of Gateway startup and
never derives or authorizes MCP agent scope; the MCP remains the authorization
boundary.

Runtime and build dependencies are pinned with artifact hashes in
`requirements.lock` for CPython 3.12 on Linux x86-64. Initial release staging
requires access to the configured Python package index unless every locked
artifact is already cached. Rollback only switches and verifies an already
staged immutable release, so it performs no package download. The deterministic
launcher expects a package-local `.venv` and starts Uvicorn without access logs.
The default bind is `127.0.0.1:8766`; only literal loopback binds are accepted,
and port 8765 is rejected because it is reserved for the BOS spike. Plain HTTP
provider URLs are accepted only for literal loopback addresses. Remote provider
URLs must use HTTPS; hostnames over HTTP are rejected to avoid DNS ambiguity.

Required configuration names:

- `PICKLESHELL_MEMORY_BACKEND_TOKEN` (32–4096 characters; never logged)
- `MEM0_LLM_PROVIDER` (`ollama` or `openai-compatible`)
- `MEM0_LLM_MODEL`
- `MEM0_LLM_BASE_URL` (credential-free HTTP(S))
- `MEM0_LLM_API_KEY` for `openai-compatible`
- `MEM0_EMBED_PROVIDER` (currently `ollama`)
- `MEM0_EMBED_MODEL`
- `MEM0_EMBED_BASE_URL` (credential-free HTTP(S))

Optional configuration names:

- `PICKLESHELL_MEMORY_BACKEND_HOST` (default `127.0.0.1`)
- `PICKLESHELL_MEMORY_BACKEND_PORT` (default `8766`)
- `MEM0_DATA_DIR` (default `/var/lib/pickleshell-memory/backend`)
- `MEM0_COLLECTION` (default `pickleshell_memory_v1`)
- `MEM0_EMBEDDING_DIMS` (default `768`)

The data directory must already exist, have no symlink components, be owned by
the running service identity, and not be group/other writable. Requests are
limited to a 64 KiB body, 16 KiB of headers, and a 4 KiB request target before
application parsing. Never point it at the BOS spike data directory. `/health` returns only `status`, `provider`,
and `version`. All endpoints require the bearer token and return bounded error
objects without provider details or request content. The backend forces Mem0
telemetry off before importing Mem0 and refuses startup if the effective Mem0
telemetry client is active; operator environment settings cannot re-enable it.
