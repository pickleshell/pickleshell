import gc
import os
import sys
import tempfile
from pathlib import Path

import posthog
import requests
from posthog.client import Client as PosthogClient


class TelemetryAttempt(RuntimeError):
    pass


attempts = {name: 0 for name in ("capture", "identify", "flush", "shutdown", "network")}


def trap(name):
    def trapped(*_args, **_kwargs):
        attempts[name] += 1
        raise TelemetryAttempt(name)
    return trapped


def trap_capture(*args, **kwargs):
    event = kwargs.get("event")
    name = "identify" if event == "$identify" else "capture"
    attempts[name] += 1
    raise TelemetryAttempt(name)


PosthogClient.capture = trap_capture
PosthogClient.flush = trap("flush")
PosthogClient.shutdown = trap("shutdown")
posthog.Posthog.capture = PosthogClient.capture
posthog.Posthog.flush = PosthogClient.flush
posthog.Posthog.shutdown = PosthogClient.shutdown
requests.sessions.Session.request = trap("network")

# Prove every trap is live without constructing a client or sending a request.
sentinels = (
    ("capture", lambda: PosthogClient.capture(None)),
    ("identify", lambda: PosthogClient.capture(None, event="$identify")),
    ("flush", lambda: PosthogClient.flush(None)),
    ("shutdown", lambda: PosthogClient.shutdown(None)),
    ("network", lambda: requests.sessions.Session.request(None)),
)
for name, sentinel in sentinels:
    try:
        sentinel()
    except TelemetryAttempt as error:
        if str(error) != name or attempts[name] != 1:
            raise AssertionError("telemetry trap sentinel mismatch") from None
    else:
        raise AssertionError("telemetry trap sentinel did not fire")
for name in attempts:
    attempts[name] = 0

# Production import happens only after all traps are installed.
runtime = tempfile.TemporaryDirectory()
os.environ["MEM0_DIR"] = str(Path(runtime.name) / "mem0-runtime")
from pickleshell_memory_backend.server import create_mem0, load_config
from real_engine import install_offline_providers
from test_server import config_env


with tempfile.TemporaryDirectory() as directory:
    config = load_config(config_env(Path(directory), MEM0_EMBEDDING_DIMS="32"))
    install_offline_providers()
    memory = create_mem0(config)
    memory_id = memory.add("telemetry regression fact", user_id="scope", infer=False)["results"][0]["id"]
    memory.search("regression", filters={"user_id": "scope"}, top_k=1)
    memory.get_all(filters={"user_id": "scope"}, top_k=10)
    memory.get(memory_id)
    memory.update(memory_id, text="updated telemetry regression fact")
    memory.history(memory_id)
    memory.delete(memory_id)
    memory.vector_store.client.close()
    del memory
    gc.collect()

if any(attempts.values()):
    raise AssertionError("telemetry emission was attempted")
if os.environ.get("MEM0_TELEMETRY") != "false":
    raise AssertionError("production backend did not force telemetry off")
runtime.cleanup()
sys.stdout.write("telemetry subprocess regression: ok\n")
