import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { GatewayClient } from "./gateway-client.js";
import { registerSendChat } from "./tools/send-chat.js";
import { registerSessionStatus } from "./tools/session-status.js";
import { registerSessionOutput } from "./tools/session-output.js";
import { registerCancelRequest } from "./tools/cancel-request.js";

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

async function main() {
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  console.error("PickleShell MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
