import { z } from "zod";
import type { GatewayClient } from "../gateway-client.js";

export const cancelRequestSchema = {
  request_id: z
    .string()
    .regex(/^req_[A-Za-z0-9_-]{1,64}$/, "request_id must start with req_ and be 1-64 chars")
    .describe("Tracking ID from send-chat response"),
};

export function registerCancelRequest(mcp: any, client: GatewayClient) {
  mcp.tool(
    "cancel-request",
    "Cancel an in-flight PickleShell task by its request_id. " +
      "Use this when: the agent went in the wrong direction, " +
      "the user changed their mind, execution is stuck, " +
      "or an incorrect command was sent by accident. " +
      "Returns status: cancelled, already_completed, or not_found.",
    cancelRequestSchema,
    async (args: { request_id: string }) => {
      console.error("[cancel-request] args:", JSON.stringify({ request_id: args.request_id }));

      const result = await client.cancelRequest(args.request_id);

      let notification: string;
      if (result.status === "cancelling") {
        notification = `Задача ${args.request_id} отменяется. Используй session-status для отслеживания.`;
      } else if (result.status === "already_cancelling") {
        notification = `Задача ${args.request_id} уже отменяется.`;
      } else if (result.status === "already_completed") {
        notification = `Задача ${args.request_id} уже завершена.`;
      } else {
        notification = `Задача ${args.request_id} не найдена.`;
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: result.ok,
            request_id: result.request_id,
            status: result.status,
            notification,
          }),
        }],
      };
    },
  );
}
