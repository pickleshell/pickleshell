import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { Client } from "../pickleshell-memory-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../pickleshell-memory-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const transport = new StdioClientTransport({ command: process.env.MEMORY_MCP_WRAPPER });
const client = new Client({ name: "memory-backend-e2e", version: "1" });
await client.connect(transport);
try {
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    "memory_add", "memory_capabilities", "memory_delete", "memory_get", "memory_history",
    "memory_list", "memory_search", "memory_update",
  ]);
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(response.isError, undefined, `${name} failed`);
    return JSON.parse(response.content[0].text);
  };
  const capabilities = await call("memory_capabilities");
  assert.deepEqual(capabilities.backend, { status: "ok", provider: "mem0", version: "0.1.0" });
  assert.equal(capabilities.scope, "backend-e2e-scope");
  if (process.env.MEMORY_E2E_PHASE === "seed") {
    const added = await call("memory_add", { text: "Disposable backend E2E fact", infer: false });
    const memoryId = added.results[0].id;
    assert.equal(added.results[0].memory, "Disposable backend E2E fact");
    await call("memory_add", { text: "Second disposable fact", infer: false });
    await call("memory_add", { text: "Third disposable fact", infer: false });
    assert.equal((await call("memory_search", { query: "disposable fact", limit: 1 })).results.length, 1);
    assert.equal((await call("memory_search", { query: "disposable fact", limit: 2 })).results.length, 2);
    assert.equal((await call("memory_list", { limit: 20 })).results.length, 3);
    await writeFile(process.env.MEMORY_E2E_STATE, memoryId, { mode: 0o600 });
  } else {
    const memoryId = await readFile(process.env.MEMORY_E2E_STATE, "utf8");
  assert.equal((await call("memory_get", { memory_id: memoryId })).id, memoryId);
  assert.equal((await call("memory_update", { memory_id: memoryId, text: "Updated disposable fact" })).memory.memory,
               "Updated disposable fact");
  const history = (await call("memory_history", { memory_id: memoryId })).results;
  assert.equal(history.at(-1).event, "UPDATE");
  assert.equal(history.at(-1).new_memory, "Updated disposable fact");
  assert.equal((await call("memory_delete", { memory_id: memoryId })).message, "Memory deleted successfully!");
  }
} finally {
  await client.close();
}
console.log("memory backend MCP E2E: ok");
