"""Real Mem0/Qdrant with a deterministic semantic embedding double (no network)."""
import re
from pickleshell_memory_backend.server import create_app, create_mem0, load_config
from real_engine import install_offline_providers


class SemanticEmbedding:
    concepts = [
        {'broker', 'endpoint', 'service', 'gateway'},
        {'principal', 'principals', 'agent', 'agents', 'runtimes', 'runtime'},
        {'shared', 'share', 'project', 'knowledge', 'collaborate'},
        {'authenticate', 'authenticated', 'credential', 'credentials', 'digest', 'digests', 'identity'},
        {'garden', 'soil', 'plants', 'water'},
        {'private', 'secret', 'personal'},
    ]
    def __init__(self, config): self.config = config
    def embed(self, text, memory_action=None):
        words = re.findall(r'[a-z]+', text.lower())
        return [float(sum(w in concept for w in words)) for concept in self.concepts] + [0.01] * (self.config.embedding_dims - len(self.concepts))
    def embed_batch(self, texts, memory_action='add'): return [self.embed(t) for t in texts]


install_offline_providers()
from mem0.memory import main as memory_main
from mem0.configs.embeddings.base import BaseEmbedderConfig
memory_main.EmbedderFactory.create = lambda _p, config, _v: SemanticEmbedding(BaseEmbedderConfig(**config))
app = create_app(load_config(), create_mem0)
