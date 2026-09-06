from pathlib import Path

from pickleshell_memory_backend.server import create_app, load_config
from test_server import PersistentFakeMemory

config = load_config()
app = create_app(config, PersistentFakeMemory)
