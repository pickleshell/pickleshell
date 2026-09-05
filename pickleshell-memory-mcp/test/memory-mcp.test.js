import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { once } from "node:events";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { loadConfig } from "../src/config.js";
import { BackendClient } from "../src/backend.js";
import { MemoryService } from "../src/service.js";
import { createServer } from "../src/index.js";

const baseEnv = {
  PICKLESHELL_MEMORY_ROLE: "agent",
  PICKLESHELL_MEMORY_ACTOR: "codex",
  PICKLESHELL_MEMORY_SCOPE: "agent-codex",
  PICKLESHELL_MEMORY_AUDIT_LOG: "/tmp/memory-audit.jsonl",
};

test("configuration makes admin global scope explicit and agents fixed-scope", () => {
  assert.equal(loadConfig(baseEnv).scope, "agent-codex");
  assert.throws(() => loadConfig({ ...baseEnv, PICKLESHELL_MEMORY_ROLE: "admin" }), /must be unset/);
  const admin = loadConfig({ ...baseEnv, PICKLESHELL_MEMORY_ROLE: "admin", PICKLESHELL_MEMORY_SCOPE: undefined });
  assert.equal(admin.scope, null);
  assert.throws(() => loadConfig({ ...baseEnv, PICKLESHELL_MEMORY_SCOPE: undefined }), /required for agent/);
  assert.throws(() => loadConfig({ ...baseEnv, PICKLESHELL_MEMORY_BACKEND_URL: "http://secret@example.test" }), /credential-free/);
});

test("configuration rejects backend URL queries and fragments", () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, PICKLESHELL_MEMORY_BACKEND_URL: "https://example.test/memory?tenant=one" }),
    /must not include a query or fragment/,
  );
  assert.throws(
    () => loadConfig({ ...baseEnv, PICKLESHELL_MEMORY_BACKEND_URL: "https://example.test/memory#backend" }),
    /must not include a query or fragment/,
  );

  assert.equal(
    loadConfig({ ...baseEnv, PICKLESHELL_MEMORY_BACKEND_URL: "https://example.test/memory/" }).backendUrl,
    "https://example.test/memory",
  );
});

test("agent policy injects its scope, preserves Mem0 metadata, audits, and denies widening", async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, authorization: req.headers.authorization, body: body && JSON.parse(body) });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ results: [{ id: "m1", memory: "fact", metadata: { source: "test" }, score: 0.91 }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const config = loadConfig({ ...baseEnv,
    PICKLESHELL_MEMORY_BACKEND_URL: `http://127.0.0.1:${server.address().port}`,
    PICKLESHELL_MEMORY_BACKEND_TOKEN: "backend-secret",
  });
  const events = [];
  const service = new MemoryService(config, new BackendClient(config), { record: (event) => events.push(event) });
  const ok = await service.call("memory_search", { query: "fact", limit: 3 });
  assert.deepEqual(JSON.parse(ok.content[0].text).results[0].metadata, { source: "test" });
  assert.deepEqual(requests[0], {
    url: "/search", authorization: "Bearer backend-secret",
    body: { query: "fact", limit: 3, user_id: "agent-codex" },
  });
  assert.equal(events[0].scope, "agent-codex");
  assert.equal("query" in events[0], false, "audit must not contain memory content or queries");
  const denied = await service.call("memory_search", { query: "fact", user_id: "global" });
  assert.equal(JSON.parse(denied.content[0].text).error, "scope_override_denied");
  assert.equal(requests.length, 1, "denied calls must not reach the backend");
});

test("admin schemas require explicit user_id while agent schemas cannot accept it", async () => {
  for (const role of ["agent", "admin"]) {
    const config = loadConfig({ ...baseEnv, PICKLESHELL_MEMORY_ROLE: role,
      PICKLESHELL_MEMORY_SCOPE: role === "agent" ? "agent-codex" : undefined });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const backend = { call: async () => ({}), discover: async () => ({ status: "ok", provider: "mem0" }) };
    const server = createServer(config, backend, { record() {} });
    const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = (await client.listTools()).tools;
    const search = tools.find((tool) => tool.name === "memory_search");
    const props = search.inputSchema.properties;
    assert.equal(Object.hasOwn(props, "user_id"), role === "admin");
    assert.equal(search.inputSchema.required.includes("user_id"), role === "admin");
    assert.ok(tools.some((tool) => tool.name === "memory_capabilities"));
    await client.close();
    await server.close();
  }
});

test("agent MCP calls that supply user_id are denied and audited before backend access", async () => {
  const config = loadConfig(baseEnv);
  const backendCalls = [];
  const auditEvents = [];
  const backend = {
    call: async (...args) => { backendCalls.push(args); return {}; },
    discover: async () => ({ status: "ok", provider: "mem0" }),
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(config, backend, { record: (event) => auditEvents.push(event) });
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.callTool({
      name: "memory_search",
      arguments: { query: "fact", user_id: "global" },
    });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, "scope_override_denied");
    assert.equal(backendCalls.length, 0, "denied calls must not reach the backend");
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].decision, "denied");
    assert.equal(auditEvents[0].outcome, "error");
    assert.equal(auditEvents[0].error, "scope_override_denied");
  } finally {
    await client.close();
    await server.close();
  }
});

test("backend failures become bounded structured errors", async () => {
  const config = loadConfig(baseEnv);
  const service = new MemoryService(config, new BackendClient(config, async () => new Response(
    JSON.stringify({ detail: "private backend detail" }), { status: 503, headers: { "content-type": "application/json" } }
  )), { record() {} });
  const result = await service.call("memory_get", { memory_id: "m1" });
  assert.deepEqual(JSON.parse(result.content[0].text), { error: "backend_failure", status: 503, retryable: true });
});

test("audit failure after a successful mutation returns a non-retryable uncertain outcome", async () => {
  const config = loadConfig(baseEnv);
  let backendCalls = 0;
  let auditAttempts = 0;
  const backend = {
    call: async () => { backendCalls += 1; return { id: "m1" }; },
    discover: async () => ({ status: "ok", provider: "mem0" }),
  };
  const auditor = { record: () => { auditAttempts += 1; throw new Error("audit unavailable"); } };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(config, backend, auditor);
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.callTool({ name: "memory_add", arguments: { text: "fact" } });
    assert.equal(result.isError, true, "the audit failure must remain a structured MCP tool error");
    assert.deepEqual(JSON.parse(result.content[0].text), {
      error: "audit_failure_after_mutation",
      status: 500,
      retryable: false,
      mutation_outcome: "uncertain",
    });
    assert.equal(backendCalls, 1, "the mutation must execute only once");
    assert.equal(auditAttempts, 1, "an audit failure must not trigger a second audit attempt");
  } finally {
    await client.close();
    await server.close();
  }
});

test("discovery reports effective policy and transparent backend health", async () => {
  const config = loadConfig(baseEnv);
  const events = [];
  const service = new MemoryService(config, {
    discover: async () => ({ status: "ok", llm_provider: "ollama", custom_metadata: { version: "2.0.19" } }),
  }, { record: (event) => events.push(event) });
  const result = await service.capabilities();
  const capabilities = JSON.parse(result.content[0].text);
  assert.equal(capabilities.role, "agent");
  assert.equal(capabilities.scope, "agent-codex");
  assert.equal(capabilities.semantics, "transparent");
  assert.deepEqual(capabilities.backend.custom_metadata, { version: "2.0.19" });
  assert.equal(events[0].tool, "memory_capabilities");
});
