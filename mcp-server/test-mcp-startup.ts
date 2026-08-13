import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const smokeDir = mkdtempSync(join(tmpdir(), "pickleshell-mcp-startup-"));
const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PICKLESHELL_GATEWAY_URL: "http://127.0.0.1:1",
    PICKLESHELL_API_KEY: "startup-smoke-dummy",
    PICKLESHELL_TIMEOUT_MS: "100",
    MCP_TEMP_DIR: smokeDir,
    PLAYWRIGHT_BROWSERS_PATH: join(smokeDir, "browsers"),
  },
  stdio: ["pipe", "pipe", "pipe"],
});

child.stdout.setEncoding("utf8");

let buffer = "";
const messages = new Map<number, Record<string, unknown>>();
child.stdout.on("data", (chunk: string) => {
  buffer += chunk;
  for (const line of buffer.split("\n").slice(0, -1)) {
    if (!line) continue;
    const message = JSON.parse(line) as Record<string, unknown>;
    if (typeof message.id === "number") messages.set(message.id, message);
  }
  buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
});

function send(id: number, method: string, params?: Record<string, unknown>) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
}

try {
  const deadline = Date.now() + 15000;
  send(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "startup-smoke", version: "1.0.0" } });
  while (!messages.has(1) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(messages.get(1)?.error, undefined, `initialize failed: ${JSON.stringify(messages.get(1))}`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  send(2, "tools/list", {});
  while (!messages.has(2) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(messages.get(2)?.error, undefined, `tools/list failed: ${JSON.stringify(messages.get(2))}`);
  const tools = (messages.get(2)?.result as { tools?: Array<{ name: string; inputSchema?: { type?: string } }> })?.tools ?? [];
  assert.equal(tools.filter((tool) => tool.name === "settings").length, 1, "startup exposes settings once");
  assert.equal(tools.find((tool) => tool.name === "settings")?.inputSchema?.type, "object", "startup exposes settings schema");
} finally {
  child.kill("SIGTERM");
  await once(child, "close").catch(() => undefined);
  rmSync(smokeDir, { recursive: true, force: true });
}

console.log("PASS: built MCP stdio startup smoke");
