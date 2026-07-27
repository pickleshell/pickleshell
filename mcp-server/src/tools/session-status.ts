import { z } from "zod";
import type { GatewayClient } from "../gateway-client.js";

export const sessionStatusSchema = {
  chat_id: z.string().describe("Workspace chat ID (from config.json)"),
  session_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/, "session_id must be 1-128 chars: letters, numbers, _, -")
    .optional()
    .describe("Optional OpenCode session ID to check"),
};

export function registerSessionStatus(mcp: any, client: GatewayClient) {
  mcp.tool(
    "session-status",
    "Check whether a PickleShell session is ready before sending a command. " +
      "Without session_id, reports that the next command will create a new OpenCode session.",
    sessionStatusSchema,
    async (args: { chat_id: string; session_id?: string }) => {
      const status = await client.sessionStatus(args.chat_id, args.session_id);
      return { content: [{ type: "text", text: JSON.stringify(status) }] };
    },
  );
}
