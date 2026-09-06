import hashlib


class OfflineEmbedding:
    def __init__(self, config):
        self.config = config

    def embed(self, text, memory_action=None):
        digest = hashlib.sha256(text.lower().encode()).digest()
        return [digest[index % len(digest)] / 255 for index in range(self.config.embedding_dims)]

    def embed_batch(self, texts, memory_action="add"):
        return [self.embed(text, memory_action) for text in texts]


class OfflineLlm:
    def __init__(self, config):
        self.config = config

    def generate_response(self, *args, **kwargs):
        raise AssertionError("offline LLM must not be called when infer is false")


def install_offline_providers():
    from mem0.memory import main as memory_main

    def create_embedder(_provider, config, _vector_config):
        from mem0.configs.embeddings.base import BaseEmbedderConfig
        return OfflineEmbedding(BaseEmbedderConfig(**config))

    def create_llm(_provider, config, **_kwargs):
        return OfflineLlm(config)

    memory_main.EmbedderFactory.create = create_embedder
    memory_main.LlmFactory.create = create_llm
