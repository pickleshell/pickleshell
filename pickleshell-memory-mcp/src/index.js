#!/usr/bin/env node
import { z } from "zod";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { BackendClient } from "./backend.js";
import { Auditor } from "./audit.js";
import { MemoryService } from "./service.js";

export function createServer(config, backend = new BackendClient(config), auditor = new Auditor(config.auditLog)) {
  const service = new MemoryService(config, backend, auditor);
  const server = new McpServer({ name: "pickleshell-memory-mcp", version: "0.1.0" });
  const scope = config.role === "admin" ? { user_id: z.string().min(1).max(200).describe("Explicit Mem0 user_id scope") } : {};
  const id = { memory_id: z.string().min(1).max(200) };
  const tools = {
    memory_add: { text: z.string().min(1).max(32000), infer: z.boolean().default(true), ...scope },
    memory_search: { query: z.string().min(1).max(8000), limit: z.number().int().min(1).max(100).default(5), ...scope },
    memory_list: { limit: z.number().int().min(1).max(100).default(20), ...scope },
    memory_get: { ...id, ...scope }, memory_update: { ...id, text: z.string().min(1).max(32000), ...scope },
    memory_delete: { ...id, ...scope }, memory_history: { ...id, ...scope },
  };
  for (const [name, inputSchema] of Object.entries(tools)) {
    const transportSchema = config.role === "agent" ? z.object(inputSchema).passthrough() : inputSchema;
    server.registerTool(name, { description: `Mem0 ${name.slice(7)} with PickleShell policy enforcement`, inputSchema: transportSchema }, (args) => service.call(name, args));
  }
  server.registerTool("memory_capabilities", { description: "Discover memory backend and effective policy without exposing credentials", inputSchema: {} },
    async () => service.capabilities());
  return server;
}

async function main() {
  const config = loadConfig();
  await createServer(config).connect(new StdioServerTransport());
  console.error("PickleShell Memory MCP running on stdio");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => { console.error(`Fatal: ${error.message}`); process.exit(1); });
}
