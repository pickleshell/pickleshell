# BOS-local Mem0 OSS spike

This spike runs `mem0ai` behind a loopback-only FastAPI service. Embeddings
always use the host's Ollama `nomic-embed-text:latest`; embedded Qdrant vectors
and Mem0's SQLite history remain in the ignored local `data/` directory. Only
the extraction LLM is selectable.

The container uses host networking to reach Ollama at `127.0.0.1:11434` and
binds Uvicorn only to `127.0.0.1:8765`.

## Default local profile

The default extraction model is `qwen3:4b`, forced into non-thinking mode with
an 8192-token context. No cloud credential is required.

```bash
ollama pull qwen3:4b
ollama pull nomic-embed-text:latest
cd /home/gpt/pickleshell-mem0-spike/spikes/mem0-bos
mkdir -p data
docker compose up -d --build
curl --fail http://127.0.0.1:8765/health
```

## Direct OpenAI-compatible cloud profile

This profile sends only Mem0 extraction calls to the configured cloud model.
Embeddings, Qdrant, and SQLite stay local. The tested free endpoint and model
worked without authentication:

```bash
MEM0_LLM_PROVIDER=openai-compatible \
MEM0_LLM_MODEL=mimo-v2.5-free \
MEM0_LLM_BASE_URL=https://opencode.ai/inference/openai/v1 \
docker compose up -d --build --force-recreate
```

For an endpoint that requires authentication, export its key outside the
repository before recreating the container:

```bash
export MEM0_LLM_API_KEY='provider-supplied value'
MEM0_LLM_PROVIDER=openai-compatible \
MEM0_LLM_MODEL='provider/model' \
MEM0_LLM_BASE_URL='https://provider.example/v1' \
docker compose up -d --build --force-recreate
```

Do not store provider keys in this directory. `MEM0_LLM_PROVIDER` defaults to
`ollama`; `MEM0_LLM_MODEL`, `MEM0_LLM_BASE_URL`, and `MEM0_LLM_API_KEY` are
passed from the external environment when needed.

## Functional smoke and persistence

`smoke.sh` uses a fresh user ID and runs normal `infer:true` extraction by
default. This is the meaningful end-to-end check of extraction, embedding,
storage, and retrieval:

```bash
./smoke.sh
```

Set an explicit user ID to repeat its search after restarting only Mem0:

```bash
MEM0_SMOKE_USER_ID=mem0-restart-check-001 ./smoke.sh
docker compose restart mem0
until curl --fail --silent http://127.0.0.1:8765/health >/dev/null; do sleep 1; done
curl --fail --silent --show-error \
  -H 'Content-Type: application/json' \
  -d '{"query":"Where is archive token mem0-restart-check-001 stored?","user_id":"mem0-restart-check-001","limit":5}' \
  http://127.0.0.1:8765/search | jq .
```

`MEM0_SMOKE_INFER=false ./smoke.sh` remains available to test direct insertion,
embedding, and retrieval independently of LLM extraction. It does not by itself
prove that the selected LLM can extract a fact faithfully.

## Measured BOS results

Measurements below are single observed runs, not availability guarantees:

| Extraction model | Add (`infer:true`) | Identifier fidelity | Semantic search | Restart persistence |
| --- | ---: | --- | ---: | --- |
| Local `qwen3:4b` | 4.047 s | Failed: changed day `02` to `01` | 36–37 ms | Retrieved the altered memory |
| Cloud `mimo-v2.5-free` | 3.724 s | Exact identifier | 35.6–38.6 ms | Same memory returned after restart |
| Cloud `nemotron-3.5-lightning-free` | 37.617 s | No memory extracted | Empty | Nothing to restore |

The successful Mimo run preserved
`MIM-7391-VERBATIM-2846-20260902T024627Z` exactly. Its extracted sentence
paraphrased “locked” as “located” without changing the durable meaning.

Stop without deleting persisted data:

```bash
docker compose stop
```

The `data/` directory and local `.env*` files are excluded from Git and the
Docker build context. Do not use `docker compose down --volumes` as a substitute
for the documented stop.
