import { z } from "zod";
import type { GatewayClient } from "../gateway-client.js";

export const sessionOutputSchema = {
  request_id: z
    .string()
    .regex(/^req_[A-Za-z0-9_-]{1,64}$/, "request_id must start with req_ and be 1-64 chars")
    .optional()
    .describe("Tracking ID from send-chat response. Use this OR chat_id+session_id."),
  chat_id: z
    .string()
    .optional()
    .describe("Workspace chat ID (from config.json). Required if request_id is not provided."),
  session_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/, "session_id must be 1-128 chars: letters, numbers, _, -")
    .optional()
    .describe("OpenCode session ID whose output to read"),
};

export function registerSessionOutput(mcp: any, client: GatewayClient) {
  mcp.tool(
    "session-output",
    "Read the output of a completed PickleShell task. " +
      "Provide request_id (from send-chat) or chat_id + session_id. " +
      "Returns the agent's reply, trace, and any errors.",
    sessionOutputSchema,
    async (args: { request_id?: string; chat_id?: string; session_id?: string }) => {
      if (args.request_id) {
        const status = await client.sessionStatus("", undefined, args.request_id);
        return { content: [{ type: "text", text: JSON.stringify(status) }] };
      }
      if (!args.chat_id || !args.session_id) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ok: false, error: "invalid_request", details: "Either request_id or chat_id+session_id is required" }),
          }],
        };
      }
      const status = await client.sessionStatus(args.chat_id, args.session_id);
      return { content: [{ type: "text", text: JSON.stringify(status) }] };
    },
  );
}
