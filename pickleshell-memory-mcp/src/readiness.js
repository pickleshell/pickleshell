#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const command = process.argv[2];
if (!command) throw new Error("MCP wrapper path is required");
const client = new Client({ name: "pickleshell-memory-readiness", version: "1" }, { capabilities: {} });
const transport = new StdioClientTransport({ command, args: [], stderr: "inherit" });
const timer = setTimeout(() => {
  console.error("memory readiness: timed out");
  process.exit(1);
}, 15000);
try {
  await client.connect(transport);
  const listed = await client.listTools();
  if (!listed.tools.some((tool) => tool.name === "memory_capabilities")) throw new Error("memory_capabilities tool is missing");
  let healthy = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await client.callTool({ name: "memory_capabilities", arguments: {} });
    if (!result.isError) { healthy = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!healthy) throw new Error("backend health discovery failed");
  console.log(`memory readiness: ok (${listed.tools.length} tools)`);
} catch (error) {
  console.error(`memory readiness: ${error.message}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await client.close();
}
