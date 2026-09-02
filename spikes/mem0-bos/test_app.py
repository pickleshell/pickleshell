import unittest
import sys
from copy import deepcopy

from fastapi import HTTPException

sys.path.insert(0, "/app")

from app import (
    UpdateRequest, app, delete_memory, get_memory, list_memories, memory_history,
    update_memory,
)


class FakeMemory:
    def __init__(self):
        self.items = {
            "m1": {"id": "m1", "memory": "old fact", "user_id": "alice"},
            "m2": {"id": "m2", "memory": "other fact", "user_id": "bob"},
        }
        self.events = {"m1": [{"id": "h1", "memory_id": "m1", "event": "ADD"}]}

    def get(self, memory_id):
        item = self.items.get(memory_id)
        return deepcopy(item) if item else None

    def get_all(self, *, filters, top_k):
        found = [deepcopy(item) for item in self.items.values() if item["user_id"] == filters["user_id"]]
        return {"results": found[:top_k]}

    def update(self, memory_id, text):
        self.items[memory_id]["memory"] = text
        self.events.setdefault(memory_id, []).append({"id": "h2", "memory_id": memory_id, "event": "UPDATE"})
        return {"message": "Memory updated successfully!"}

    def delete(self, memory_id):
        del self.items[memory_id]
        return {"message": "Memory deleted successfully!"}

    def history(self, memory_id):
        return deepcopy(self.events.get(memory_id, []))


class CrudTests(unittest.TestCase):
    def setUp(self):
        app.state.memory = FakeMemory()

    def test_scoped_crud_and_history(self):
        self.assertEqual([item["id"] for item in list_memories("alice", 20)["results"]], ["m1"])
        self.assertEqual(get_memory("m1", "alice")["memory"], "old fact")
        with self.assertRaises(HTTPException) as hidden:
            get_memory("m2", "alice")
        self.assertEqual(hidden.exception.status_code, 404)

        updated = update_memory(UpdateRequest(user_id="alice", text="new fact"), "m1")
        self.assertEqual(updated["memory"]["memory"], "new fact")
        self.assertEqual(memory_history("m1", "alice")["results"][-1]["event"], "UPDATE")
        self.assertEqual(delete_memory("m1", "alice")["message"], "Memory deleted successfully!")
        with self.assertRaises(HTTPException) as gone:
            get_memory("m1", "alice")
        self.assertEqual(gone.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
