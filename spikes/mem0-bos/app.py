import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from mem0 import Memory
from mem0.memory import main as mem0_memory_main
from pydantic import BaseModel


DATA_DIR = os.environ.get("MEM0_DATA_DIR", "/data")
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
LLM_PROVIDER = os.environ.get("MEM0_LLM_PROVIDER", "ollama")
LLM_MODEL = os.environ.get("MEM0_LLM_MODEL", "qwen2.5:1.5b")
LLM_BASE_URL = os.environ.get("MEM0_LLM_BASE_URL", OLLAMA_BASE_URL)
LLM_API_KEY = os.environ.get("MEM0_LLM_API_KEY")
EMBED_MODEL = os.environ.get("MEM0_EMBED_MODEL", "nomic-embed-text:latest")
EXTRACTION_PROMPT = """Extract durable facts and preferences stated in the new messages.
Return JSON only, using this exact shape:
{"memory":[{"text":"a concise self-contained fact","attributed_to":null}]}
Use an empty memory list when there is no durable fact. Do not invent details.
"""


def make_memory() -> Memory:
    os.makedirs(DATA_DIR, exist_ok=True)
    mem0_memory_main.ADDITIVE_EXTRACTION_PROMPT = EXTRACTION_PROMPT
    if LLM_PROVIDER == "ollama":
        llm = {
            "provider": "ollama",
            "config": {
                "model": LLM_MODEL,
                "temperature": 0,
                "max_tokens": 1000,
                "ollama_base_url": LLM_BASE_URL,
            },
        }
    elif LLM_PROVIDER == "openai-compatible":
        llm = {
            "provider": "openai",
            "config": {
                "model": LLM_MODEL,
                "temperature": 0,
                "max_tokens": 1000,
                "openai_base_url": LLM_BASE_URL,
                "api_key": LLM_API_KEY or "not-required",
            },
        }
    else:
        raise ValueError(f"Unsupported MEM0_LLM_PROVIDER: {LLM_PROVIDER}")
    memory = Memory.from_config(
        {
            "vector_store": {
                "provider": "qdrant",
                "config": {
                    "collection_name": "pickleshell_mem0_spike",
                    "path": os.path.join(DATA_DIR, "qdrant"),
                    "embedding_model_dims": 768,
                },
            },
            "llm": llm,
            "embedder": {
                "provider": "ollama",
                "config": {
                    "model": EMBED_MODEL,
                    "ollama_base_url": OLLAMA_BASE_URL,
                },
            },
            "history_db_path": os.path.join(DATA_DIR, "history.db"),
            "version": "v1.1",
        }
    )
    if LLM_PROVIDER == "openai-compatible" and not LLM_API_KEY:
        def omit_placeholder_authorization(request):
            request.headers.pop("authorization", None)

        memory.llm.client._client.event_hooks["request"].append(
            omit_placeholder_authorization
        )
    if LLM_PROVIDER == "ollama":
        ollama_chat = memory.llm.client.chat

        def chat_without_thinking(*args, **kwargs):
            kwargs["think"] = False
            kwargs["options"] = {**(kwargs.get("options") or {}), "num_ctx": 8192}
            return ollama_chat(*args, **kwargs)

        memory.llm.client.chat = chat_without_thinking
    return memory


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.memory = make_memory()
    yield


app = FastAPI(title="PickleShell Mem0 BOS spike", lifespan=lifespan)


class AddRequest(BaseModel):
    text: str
    user_id: str
    infer: bool = True


class SearchRequest(BaseModel):
    query: str
    user_id: str
    limit: int = 5


@app.get("/health")
def health():
    return {
        "status": "ok",
        "llm_provider": LLM_PROVIDER,
        "llm": LLM_MODEL,
        "embedder": EMBED_MODEL,
        "persistence": DATA_DIR,
    }


@app.post("/memories")
def add_memory(request: AddRequest):
    try:
        return app.state.memory.add(
            request.text,
            user_id=request.user_id,
            infer=request.infer,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/search")
def search_memory(request: SearchRequest):
    try:
        return app.state.memory.search(
            request.query,
            filters={"user_id": request.user_id},
            limit=request.limit,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
