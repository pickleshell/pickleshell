import os
import re
import secrets
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Path as ApiPath, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from . import __version__


EXTRACTION_PROMPT = """Extract durable facts and preferences stated in the new messages.
Return JSON only, using this exact shape:
{"memory":[{"text":"a concise self-contained fact","attributed_to":null}]}
Use an empty memory list when there is no durable fact. Do not invent details.
"""


@dataclass(frozen=True)
class Config:
    host: str
    port: int
    token: str
    data_dir: Path
    collection: str
    embedding_dims: int
    llm_provider: str
    llm_model: str
    llm_base_url: str
    llm_api_key: str | None
    embed_provider: str
    embed_model: str
    embed_base_url: str


def load_config(env: dict[str, str] | os._Environ[str] = os.environ) -> Config:
    host = env.get("PICKLESHELL_MEMORY_BACKEND_HOST", "127.0.0.1")
    if host not in {"127.0.0.1", "::1"} and env.get("PICKLESHELL_MEMORY_ALLOW_NON_LOOPBACK") != "true":
        raise ValueError("non-loopback bind requires explicit operator approval")
    port = bounded_int(env.get("PICKLESHELL_MEMORY_BACKEND_PORT", "8766"), "backend port", 1, 65535)
    if port == 8765:
        raise ValueError("backend port 8765 is reserved for the BOS spike")
    token = env.get("PICKLESHELL_MEMORY_BACKEND_TOKEN", "")
    if not 32 <= len(token) <= 4096:
        raise ValueError("backend bearer token is required (32-4096 characters)")
    data_dir = Path(env.get("MEM0_DATA_DIR", "/var/lib/pickleshell-memory/backend"))
    validate_data_dir(data_dir)
    collection = env.get("MEM0_COLLECTION", "pickleshell_memory_v1")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,62}", collection):
        raise ValueError("MEM0_COLLECTION is invalid")
    embedding_dims = bounded_int(env.get("MEM0_EMBEDDING_DIMS", "768"), "embedding dimensions", 1, 65536)
    llm_provider = required(env, "MEM0_LLM_PROVIDER")
    if llm_provider not in {"ollama", "openai-compatible"}:
        raise ValueError("MEM0_LLM_PROVIDER is unsupported")
    llm_model = required(env, "MEM0_LLM_MODEL")
    llm_base_url = safe_http_url(required(env, "MEM0_LLM_BASE_URL"), "MEM0_LLM_BASE_URL")
    llm_api_key = env.get("MEM0_LLM_API_KEY") or None
    if llm_provider == "openai-compatible" and not llm_api_key:
        raise ValueError("MEM0_LLM_API_KEY is required for openai-compatible")
    embed_provider = required(env, "MEM0_EMBED_PROVIDER")
    if embed_provider != "ollama":
        raise ValueError("MEM0_EMBED_PROVIDER is unsupported")
    embed_model = required(env, "MEM0_EMBED_MODEL")
    embed_base_url = safe_http_url(required(env, "MEM0_EMBED_BASE_URL"), "MEM0_EMBED_BASE_URL")
    return Config(host, port, token, data_dir, collection, embedding_dims, llm_provider, llm_model,
                  llm_base_url, llm_api_key, embed_provider, embed_model, embed_base_url)


def required(env, name: str) -> str:
    value = env.get(name, "")
    if not value or len(value) > 1024:
        raise ValueError(f"{name} is required")
    return value


def bounded_int(value: str, label: str, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} is invalid") from exc
    if not minimum <= parsed <= maximum:
        raise ValueError(f"{label} is invalid")
    return parsed


def safe_http_url(value: str, name: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError(f"{name} must be a credential-free HTTP(S) URL")
    if parsed.query or parsed.fragment:
        raise ValueError(f"{name} must not contain a query or fragment")
    return value.rstrip("/")


def validate_data_dir(path: Path) -> None:
    if not path.is_absolute():
        raise ValueError("MEM0_DATA_DIR must be absolute")
    current = Path(path.root)
    for component in path.parts[1:]:
        current /= component
        if current.is_symlink():
            raise ValueError("MEM0_DATA_DIR has a symlink component")
        if not current.exists():
            raise ValueError("MEM0_DATA_DIR must already exist")
        if not current.is_dir():
            raise ValueError("MEM0_DATA_DIR must be a directory")
    metadata = path.stat()
    if metadata.st_uid != os.geteuid():
        raise ValueError("MEM0_DATA_DIR must be owned by the service identity")
    if metadata.st_mode & 0o022:
        raise ValueError("MEM0_DATA_DIR must not be group/other writable")


def create_mem0(config: Config):
    from mem0 import Memory
    from mem0.memory import main as mem0_memory_main

    os.environ["MEM0_TELEMETRY"] = "false"
    os.environ["ANONYMIZED_TELEMETRY"] = "false"
    mem0_memory_main.ADDITIVE_EXTRACTION_PROMPT = EXTRACTION_PROMPT
    if config.llm_provider == "ollama":
        llm = {"provider": "ollama", "config": {"model": config.llm_model, "temperature": 0,
               "max_tokens": 1000, "ollama_base_url": config.llm_base_url}}
    else:
        llm = {"provider": "openai", "config": {"model": config.llm_model, "temperature": 0,
               "max_tokens": 1000, "openai_base_url": config.llm_base_url, "api_key": config.llm_api_key}}
    return Memory.from_config({
        "vector_store": {"provider": "qdrant", "config": {"collection_name": config.collection,
                         "path": str(config.data_dir / "qdrant"), "embedding_model_dims": config.embedding_dims}},
        "llm": llm,
        "embedder": {"provider": "ollama", "config": {"model": config.embed_model,
                     "ollama_base_url": config.embed_base_url}},
        "history_db_path": str(config.data_dir / "history.db"),
        "version": "v1.1",
    })


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AddRequest(StrictModel):
    text: str = Field(min_length=1, max_length=32000)
    user_id: str = Field(min_length=1, max_length=200)
    infer: bool = True


class SearchRequest(StrictModel):
    query: str = Field(min_length=1, max_length=8000)
    user_id: str = Field(min_length=1, max_length=200)
    limit: int = Field(default=5, ge=1, le=100)


class UpdateRequest(StrictModel):
    user_id: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=1, max_length=32000)


def create_app(config: Config, engine_factory: Callable[[Config], object] = create_mem0) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.memory = engine_factory(config)
        yield

    app = FastAPI(title="PickleShell Memory Backend", docs_url=None, redoc_url=None, openapi_url=None,
                  lifespan=lifespan)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request, _error):
        return JSONResponse(status_code=422, content={"error": "invalid_request", "status": 422})

    @app.exception_handler(HTTPException)
    async def http_error(_request, error):
        codes = {401: "backend_unauthorized", 404: "memory_not_found"}
        status = error.status_code if error.status_code in codes else 400
        return JSONResponse(status_code=status, content={"error": codes.get(status, "backend_rejected"),
                                                         "status": status})

    @app.exception_handler(Exception)
    async def internal_error(_request, _error):
        return JSONResponse(status_code=500, content={"error": "backend_failure", "status": 500})

    def authorize(request: Request):
        supplied = request.headers.get("authorization", "")
        expected = f"Bearer {config.token}"
        if not secrets.compare_digest(supplied, expected):
            raise HTTPException(status_code=401, detail="backend_unauthorized")

    def scoped(memory_id: str, user_id: str):
        memory = app.state.memory.get(memory_id)
        if not memory or memory.get("user_id") != user_id:
            raise HTTPException(status_code=404, detail="memory_not_found")
        return memory

    @app.get("/health", dependencies=[Depends(authorize)])
    def health():
        return {"status": "ok", "provider": "mem0", "version": __version__}

    @app.post("/memories", dependencies=[Depends(authorize)])
    def add(request: AddRequest):
        return app.state.memory.add(request.text, user_id=request.user_id, infer=request.infer)

    @app.post("/search", dependencies=[Depends(authorize)])
    def search(request: SearchRequest):
        return app.state.memory.search(request.query, filters={"user_id": request.user_id}, limit=request.limit)

    @app.get("/memories", dependencies=[Depends(authorize)])
    def list_memories(user_id: str = Query(min_length=1, max_length=200),
                      limit: int = Query(default=20, ge=1, le=100)):
        return app.state.memory.get_all(filters={"user_id": user_id}, top_k=limit)

    @app.get("/memories/{memory_id}", dependencies=[Depends(authorize)])
    def get_memory(memory_id: str = ApiPath(min_length=1, max_length=200),
                   user_id: str = Query(min_length=1, max_length=200)):
        return scoped(memory_id, user_id)

    @app.put("/memories/{memory_id}", dependencies=[Depends(authorize)])
    def update(request: UpdateRequest, memory_id: str = ApiPath(min_length=1, max_length=200)):
        scoped(memory_id, request.user_id)
        result = app.state.memory.update(memory_id, text=request.text)
        return {**result, "memory": scoped(memory_id, request.user_id)}

    @app.delete("/memories/{memory_id}", dependencies=[Depends(authorize)])
    def delete(memory_id: str = ApiPath(min_length=1, max_length=200),
               user_id: str = Query(min_length=1, max_length=200)):
        scoped(memory_id, user_id)
        return app.state.memory.delete(memory_id)

    @app.get("/memories/{memory_id}/history", dependencies=[Depends(authorize)])
    def history(memory_id: str = ApiPath(min_length=1, max_length=200),
                user_id: str = Query(min_length=1, max_length=200)):
        scoped(memory_id, user_id)
        return {"results": app.state.memory.history(memory_id)}

    return app


def main() -> None:
    try:
        config = load_config()
        app = create_app(config)
    except ValueError as error:
        raise SystemExit(f"pickleshell-memory-backend: configuration error: {error}") from None
    uvicorn.run(app, host=config.host, port=config.port, access_log=False, log_level="warning",
                server_header=False, date_header=False)


if __name__ == "__main__":
    main()
