import json
import os
import asyncio
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from pickleshell_memory_backend.server import create_app, load_config


TOKEN = "t" * 32


class PersistentFakeMemory:
    def __init__(self, config):
        self.path = config.data_dir / "fake-memory.json"
        self.memories = json.loads(self.path.read_text()) if self.path.exists() else {}

    def save(self):
        self.path.write_text(json.dumps(self.memories, sort_keys=True))

    def add(self, text, *, user_id, infer):
        memory_id = f"m{len(self.memories) + 1}"
        item = {"id": memory_id, "memory": text, "user_id": user_id,
                "metadata": {"infer": infer, "source": "fake"}}
        self.memories[memory_id] = item
        self.save()
        return {"results": [item], "relations": []}

    def search(self, query, *, filters, top_k):
        items = [item for item in self.memories.values()
                 if item["user_id"] == filters["user_id"] and query.lower() in item["memory"].lower()]
        return {"results": items[:top_k]}

    def get_all(self, *, filters, top_k):
        return {"results": [item for item in self.memories.values()
                            if item["user_id"] == filters["user_id"]][:top_k]}

    def get(self, memory_id):
        return self.memories.get(memory_id)

    def update(self, memory_id, *, text):
        self.memories[memory_id]["memory"] = text
        self.memories[memory_id].setdefault("history", []).append(text)
        self.save()
        return {"message": "Memory updated successfully"}

    def delete(self, memory_id):
        self.memories.pop(memory_id)
        self.save()
        return {"message": "Memory deleted successfully"}

    def history(self, memory_id):
        return [{"memory": value} for value in self.memories[memory_id].get("history", [])]


def config_env(data_dir, **overrides):
    env = {
        "PICKLESHELL_MEMORY_BACKEND_TOKEN": TOKEN,
        "MEM0_DATA_DIR": str(data_dir),
        "MEM0_LLM_PROVIDER": "ollama",
        "MEM0_LLM_MODEL": "fixture-llm",
        "MEM0_LLM_BASE_URL": "http://127.0.0.1:11434",
        "MEM0_EMBED_PROVIDER": "ollama",
        "MEM0_EMBED_MODEL": "fixture-embed",
        "MEM0_EMBED_BASE_URL": "http://127.0.0.1:11434",
    }
    env.update(overrides)
    return env


class ConfigTests(unittest.TestCase):
    def test_defaults_are_authenticated_loopback_8766_and_separate_state(self):
        with tempfile.TemporaryDirectory() as directory:
            config = load_config(config_env(Path(directory)))
            self.assertEqual((config.host, config.port), ("127.0.0.1", 8766))
            self.assertEqual(config.data_dir, Path(directory))

    def test_invalid_provider_token_port_url_and_non_loopback_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cases = [
                {"PICKLESHELL_MEMORY_BACKEND_TOKEN": "short"},
                {"PICKLESHELL_MEMORY_BACKEND_PORT": "8765"},
                {"PICKLESHELL_MEMORY_BACKEND_HOST": "0.0.0.0"},
                {"MEM0_LLM_PROVIDER": ""},
                {"MEM0_LLM_PROVIDER": "unknown"},
                {"MEM0_LLM_BASE_URL": "http://user:secret@localhost:1"},
                {"MEM0_LLM_BASE_URL": "http://localhost:11434"},
                {"MEM0_LLM_BASE_URL": "http://192.0.2.1:11434"},
                {"MEM0_EMBED_PROVIDER": "unknown"},
            ]
            for override in cases:
                with self.subTest(override=next(iter(override))):
                    with self.assertRaises(ValueError):
                        load_config(config_env(root, **override))
            remote = load_config(config_env(root, MEM0_LLM_BASE_URL="https://provider.example"))
            self.assertEqual(remote.llm_base_url, "https://provider.example")

    def test_data_path_rejects_symlinks_and_unsafe_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            unsafe = root / "unsafe"
            unsafe.mkdir(mode=0o777)
            unsafe.chmod(0o777)
            with self.assertRaises(ValueError):
                load_config(config_env(unsafe))
            target = root / "target"
            target.mkdir()
            link = root / "link"
            link.symlink_to(target, target_is_directory=True)
            with self.assertRaises(ValueError):
                load_config(config_env(link))


class HttpContractTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.config = load_config(config_env(Path(self.temporary.name)))
        self.client_context = TestClient(create_app(self.config, PersistentFakeMemory))
        self.client = self.client_context.__enter__()
        self.headers = {"authorization": f"Bearer {TOKEN}"}

    def tearDown(self):
        self.client_context.__exit__(None, None, None)
        self.temporary.cleanup()

    def test_all_operations_preserve_payload_metadata_and_scope(self):
        health = self.client.get("/health", headers=self.headers)
        self.assertEqual(health.json(), {"status": "ok", "provider": "mem0", "version": "0.1.0"})
        added = self.client.post("/memories", headers=self.headers,
                                 json={"text": "Durable fact", "user_id": "scope-a", "infer": False})
        self.assertEqual(added.status_code, 200)
        item = added.json()["results"][0]
        self.assertEqual(item["metadata"], {"infer": False, "source": "fake"})
        memory_id = item["id"]
        self.assertEqual(self.client.post("/search", headers=self.headers,
                         json={"query": "durable", "user_id": "scope-a", "limit": 5}).json()["results"][0]["id"], memory_id)
        self.assertEqual(self.client.get("/memories", headers=self.headers,
                         params={"user_id": "scope-a"}).json()["results"][0]["id"], memory_id)
        self.assertEqual(self.client.get(f"/memories/{memory_id}", headers=self.headers,
                         params={"user_id": "scope-a"}).json()["id"], memory_id)
        updated = self.client.put(f"/memories/{memory_id}", headers=self.headers,
                                  json={"text": "Updated fact", "user_id": "scope-a"})
        self.assertEqual(updated.json()["memory"]["memory"], "Updated fact")
        self.assertEqual(self.client.get(f"/memories/{memory_id}/history", headers=self.headers,
                         params={"user_id": "scope-a"}).json(), {"results": [{"memory": "Updated fact"}]})
        self.assertEqual(self.client.get(f"/memories/{memory_id}", headers=self.headers,
                         params={"user_id": "scope-b"}).status_code, 404)
        self.assertEqual(self.client.delete(f"/memories/{memory_id}", headers=self.headers,
                         params={"user_id": "scope-a"}).status_code, 200)
        self.assertEqual(self.client.get(f"/memories/{memory_id}", headers=self.headers,
                         params={"user_id": "scope-a"}).status_code, 404)

    def test_auth_validation_and_errors_are_bounded_and_secret_free(self):
        for header in ({}, {"authorization": "Bearer wrong"}):
            response = self.client.get("/health", headers=header)
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.json(), {"error": "backend_unauthorized", "status": 401})
            self.assertNotIn(TOKEN, response.text)
        invalid = self.client.post("/memories", headers=self.headers,
                                   json={"text": "secret request content", "user_id": "scope", "extra": True})
        self.assertEqual(invalid.json(), {"error": "invalid_request", "status": 422})
        self.assertNotIn("secret request content", invalid.text)

    def test_persistence_survives_engine_restart(self):
        added = self.client.post("/memories", headers=self.headers,
                                 json={"text": "Restart fact", "user_id": "scope", "infer": False}).json()
        memory_id = added["results"][0]["id"]
        second_context = TestClient(create_app(self.config, PersistentFakeMemory))
        with second_context as second:
            response = second.get(f"/memories/{memory_id}", headers=self.headers,
                                  params={"user_id": "scope"})
            self.assertEqual(response.json()["memory"], "Restart fact")

    def test_provider_exception_is_normalized_without_detail(self):
        class FailingMemory(PersistentFakeMemory):
            def search(self, query, *, filters, top_k):
                raise RuntimeError("provider secret diagnostic")

        context = TestClient(create_app(self.config, FailingMemory), raise_server_exceptions=False)
        with context as client:
            response = client.post("/search", headers=self.headers,
                                   json={"query": "query text", "user_id": "scope"})
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json(), {"error": "backend_failure", "status": 500})
        self.assertNotIn("provider secret diagnostic", response.text)
        self.assertNotIn("query text", response.text)

    def test_request_bounds_precede_body_parsing_and_unauthorized_consumption(self):
        async def invoke(headers, chunks, path=b"/memories"):
            sent = []
            consumed = 0
            messages = [
                {"type": "http.request", "body": chunk, "more_body": index < len(chunks) - 1}
                for index, chunk in enumerate(chunks)
            ]

            async def receive():
                nonlocal consumed
                consumed += 1
                return messages.pop(0)

            async def send(message):
                sent.append(message)

            scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
                     "method": "POST", "scheme": "http", "path": path.decode(), "raw_path": path,
                     "query_string": b"", "root_path": "", "headers": headers,
                     "client": ("127.0.0.1", 1), "server": ("127.0.0.1", 8766)}
            await create_app(self.config, PersistentFakeMemory)(scope, receive, send)
            status = next(message["status"] for message in sent if message["type"] == "http.response.start")
            body = b"".join(message.get("body", b"") for message in sent
                            if message["type"] == "http.response.body")
            return status, json.loads(body), consumed

        auth = (b"authorization", f"Bearer {TOKEN}".encode())
        oversized = b"x" * (64 * 1024 + 1)
        status, body, consumed = asyncio.run(invoke([], [oversized]))
        self.assertEqual((status, body, consumed), (401, {"error": "backend_unauthorized", "status": 401}, 0))
        status, body, _ = asyncio.run(invoke([auth], [oversized[:40000], oversized[40000:]]))
        self.assertEqual((status, body), (413, {"error": "request_too_large", "status": 413}))
        status, body, _ = asyncio.run(invoke([auth, (b"content-length", b"1")], [oversized]))
        self.assertEqual((status, body), (413, {"error": "request_too_large", "status": 413}))
        status, body, consumed = asyncio.run(invoke([auth, (b"content-length", str(len(oversized)).encode())],
                                                     [oversized]))
        self.assertEqual((status, body, consumed),
                         (413, {"error": "request_too_large", "status": 413}, 0))
        status, body, consumed = asyncio.run(invoke([auth, (b"x-padding", b"x" * (16 * 1024))], [b"ignored"]))
        self.assertEqual((status, body, consumed),
                         (431, {"error": "request_headers_too_large", "status": 431}, 0))

    def test_docs_and_openapi_are_not_exposed(self):
        for path in ("/docs", "/redoc", "/openapi.json"):
            self.assertEqual(self.client.get(path, headers=self.headers).status_code, 404)


if __name__ == "__main__":
    unittest.main()
