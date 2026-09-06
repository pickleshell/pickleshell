from pickleshell_memory_backend.server import create_app, create_mem0, load_config
from real_engine import install_offline_providers

install_offline_providers()
config = load_config()
app = create_app(config, create_mem0)
