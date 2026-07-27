import { z } from "zod";
import type { GatewayClient } from "../gateway-client.js";

export const sessionOutputSchema = {
  chat_id: z.string().describe("Workspace chat ID (from config.json)"),
  session_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/, "session_id must be 1-128 chars: letters, numbers, _, -")
    .describe("Explicit OpenCode session ID whose output buffer should be read"),
};

export function registerSessionOutput(mcp: any, client: GatewayClient) {
  mcp.tool(
    "session-output",
    "Read the current progress or the last completed output for an OpenCode session. " +
      "Read this before sending the next command, because a new command clears the buffer.",
    sessionOutputSchema,
    async (args: { chat_id: string; session_id: string }) => {
      const status = await client.sessionStatus(args.chat_id, args.session_id);
      return { content: [{ type: "text", text: JSON.stringify(status) }] };
    },
  );
}
