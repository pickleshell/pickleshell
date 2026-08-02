import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createConnection } from "@playwright/mcp";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { GatewayClient } from "./gateway-client.js";
import { registerSendChat } from "./tools/send-chat.js";
import { registerSessionStatus } from "./tools/session-status.js";
import { registerSessionOutput } from "./tools/session-output.js";
import { registerCancelRequest } from "./tools/cancel-request.js";
import { mkdirSync } from "fs";
import { registerTerminalSpawn } from "./tools/terminal-spawn.js";
import { registerTerminalWrite } from "./tools/terminal-write.js";
import { registerTerminalOutput } from "./tools/terminal-output.js";
import { registerTerminalResize } from "./tools/terminal-resize.js";
import { registerTerminalSignal } from "./tools/terminal-signal.js";
import { registerTerminalClose } from "./tools/terminal-close.js";

const config = loadConfig();
const client = new GatewayClient(config);
const mcp = new McpServer({
  name: "pickleshell",
  version: "0.1.0",
});

registerSendChat(mcp, client);
registerSessionStatus(mcp, client);
registerSessionOutput(mcp, client);
registerCancelRequest(mcp, client);
registerTerminalSpawn(mcp, client);
registerTerminalWrite(mcp, client);
registerTerminalOutput(mcp, client);
registerTerminalResize(mcp, client);
registerTerminalSignal(mcp, client);
registerTerminalClose(mcp, client);

function jsonSchemaToZodShape(schema: Record<string, unknown>): Record<string, z.ZodType> {
  if (!schema || typeof schema !== "object") return {};
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties) return {};
  const required = new Set<string>(
    (schema.required as string[]) ?? [],
  );

  const shape: Record<string, z.ZodType> = {};
  for (const [key, prop] of Object.entries(properties)) {
    const p = prop as Record<string, unknown>;
    let t: z.ZodType;

    switch (p.type) {
      case "string":
        t = z.string();
        break;
      case "number":
        t = z.number();
        break;
      case "boolean":
        t = z.boolean();
        break;
      case "integer":
        t = z.number().int();
        break;
      case "array":
        t = z.array(z.any());
        break;
      case "object":
        t = z.record(z.any());
        break;
      default:
        t = z.any();
    }

    if (p.description) t = t.describe(p.description as string);
    if (typeof p.enum !== "undefined") t = z.enum(p.enum as [string, ...string[]]);
    if (!required.has(key)) t = t.optional();
    if (typeof p.default !== "undefined") t = t.default(p.default);

    shape[key] = t;
  }
  return shape;
}

async function setupPlaywrightTools() {
  const outputDir = "/run/pickleshell-mcp/playwright-output";
  const userDataDir = "/run/pickleshell-mcp/playwright-data";

  try {
    mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  } catch {
    // runtime dir may already exist
  }

  try {
    const pwServer = await createConnection({
      browser: {
        browserName: "chromium",
        launchOptions: { headless: true, chromiumSandbox: false },

        userDataDir,
      },
      capabilities: ["core", "network", "pdf", "storage", "vision"],
      outputDir,
    });

    const [pwClientTransport, pwServerTransport] =
      InMemoryTransport.createLinkedPair();
    await pwServer.connect(pwServerTransport);

    const pwClient = new Client(
      { name: "pickleshell-playwright", version: "0.1.0" },
      { capabilities: {} },
    );
    await pwClient.connect(pwClientTransport);

    const { tools } = await pwClient.listTools();

    for (const tool of tools) {
      const inputSchema = (tool.inputSchema ?? {}) as Record<string, unknown>;
      const zodShape = jsonSchemaToZodShape(inputSchema);

      mcp.registerTool(
        tool.name,
        {
          description:
            tool.description ?? `Playwright browser automation: ${tool.name}`,
          inputSchema: zodShape,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (args: any): Promise<CallToolResult> => {
          const result = await pwClient.callTool({
            name: tool.name,
            arguments: args,
          });
          return result as unknown as CallToolResult;
        },
      );
    }

    console.error(
      `Playwright MCP integrated: ${tools.length} tools registered`,
    );
    return pwClient;
  } catch (err) {
    console.error("Failed to integrate Playwright MCP:", err);
    console.error("MCP server continues without Playwright tools.");
  }
}

async function main() {
  await setupPlaywrightTools();
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  console.error("PickleShell MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
