import gc
import os
import tempfile
import unittest
from pathlib import Path

from pickleshell_memory_backend.server import create_mem0, load_config
from real_engine import install_offline_providers
from test_server import config_env


class RealMem0Tests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.config = load_config(config_env(Path(self.temporary.name), MEM0_EMBEDDING_DIMS="32"))
        install_offline_providers()

    def tearDown(self):
        self.temporary.cleanup()

    @staticmethod
    def close(memory):
        memory.vector_store.client.close()
        del memory
        gc.collect()

    def test_real_qdrant_operations_limits_and_restart(self):
        memory = create_mem0(self.config)
        ids = []
        for text in ("alpha durable fact", "beta durable fact", "gamma durable fact"):
            ids.append(memory.add(text, user_id="scope", infer=False)["results"][0]["id"])
        self.assertEqual(len(memory.search("durable fact", filters={"user_id": "scope"}, top_k=1)["results"]), 1)
        self.assertEqual(len(memory.search("durable fact", filters={"user_id": "scope"}, top_k=2)["results"]), 2)
        self.assertEqual(len(memory.get_all(filters={"user_id": "scope"}, top_k=20)["results"]), 3)
        self.assertEqual(memory.get(ids[0])["user_id"], "scope")
        memory.update(ids[0], text="updated alpha fact")
        self.assertTrue(memory.history(ids[0]))
        self.close(memory)

        reopened = create_mem0(self.config)
        self.assertEqual(reopened.get(ids[0])["memory"], "updated alpha fact")
        reopened.delete(ids[0])
        self.assertIsNone(reopened.get(ids[0]))
        self.close(reopened)

    def test_real_construction_has_matching_dimensions_and_disabled_telemetry(self):
        memory = create_mem0(self.config)
        self.assertEqual(memory.config.vector_store.config.embedding_model_dims, 32)
        self.assertEqual(memory.embedding_model.config.embedding_dims, 32)
        from mem0.memory import main as memory_main
        from mem0.memory import telemetry
        self.assertFalse(memory_main.MEM0_TELEMETRY)
        self.assertFalse(telemetry.MEM0_TELEMETRY)
        self.assertIsNone(telemetry.client_telemetry.posthog)
        self.assertIsNone(telemetry._oss_telemetry_instance)
        self.assertEqual(os.environ["MEM0_TELEMETRY"], "false")
        self.close(memory)


if __name__ == "__main__":
    unittest.main()
