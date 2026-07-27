import { z } from "zod";
import { GatewayError, type GatewayClient } from "../gateway-client.js";
import type { FileTransfer } from "../types.js";
import {
  validateFiles,
  validateDestinationDir,
  decodeFilesToTemp,
  cleanupTempDir,
} from "../file-utils.js";

const fileItemSchema = z.object({
  name: z
    .string()
    .describe(
      "Safe relative filename only (no paths, no absolute paths, no ../)"
    ),
  content: z.string().describe("Base64-encoded file content"),
  mime_type: z.string().optional().describe("Optional MIME type"),
  dest_dir: z
    .string()
    .optional()
    .describe(
      "Per-file destination subdirectory within workspace (relative path). " +
        "Overrides destination_dir. If neither is set, file goes to .inbox/<request-id>/."
    ),
  overwrite: z
    .boolean()
    .optional()
    .default(false)
    .describe("Allow overwriting an existing file at the destination (default: false)"),
});

export const sendChatSchema = {
  chat_id: z.string().describe("Workspace chat ID (from config.json)"),
  message: z.string().describe("Message to send to the local agent"),
  session_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/, "session_id must be 1-128 chars: letters, numbers, _, -")
    .optional()
    .describe("Optional session ID to continue a previous conversation"),
  model: z
    .string()
    .optional()
    .describe(
      "Optional model override (opencode/big-pickle, anthropic/claude-sonnet-4-20250514, qwen/qwen3-coder)"
    ),
  destination_dir: z
    .string()
    .optional()
    .describe(
      "Shared destination subdirectory for all files in this request (relative to workspace root). " +
        "Per-file dest_dir overrides this. If neither is set, files go to .inbox/<request-id>/."
    ),
  files: z
    .array(fileItemSchema)
    .max(20)
    .optional()
    .describe(
      "Optional array of up to 20 small files to send with the message. " +
        "Each file has a safe relative name and base64-encoded content. " +
        "Max 2 MiB per file, 10 MiB total."
    ),
};

export function registerSendChat(mcp: any, client: GatewayClient) {
  mcp.tool(
    "send-chat",
    "Send a message to a local project workspace via the PickleShell Gateway. " +
      "Returns the agent's reply. Use session_id to continue a previous conversation. " +
      "Optionally include small files (base64-encoded, max 20 files, 2 MiB each, 10 MiB total) " +
      "to transfer them into the workspace. " +
      "Use destination_dir to place all files in a specific subdirectory, " +
      "or per-file dest_dir to override for individual files.",
    sendChatSchema,
    async (args: {
      chat_id: string;
      message: string;
      session_id?: string;
      model?: string;
      destination_dir?: string;
      files?: Array<{
        name: string;
        content: string;
        mime_type?: string;
        dest_dir?: string;
        overwrite?: boolean;
      }>;
    }) => {
      console.error(
        "[send-chat] args:",
        JSON.stringify({
          chat_id: args.chat_id,
          message_len: args.message?.length,
          session_id: args.session_id,
          model: args.model,
          destination_dir: args.destination_dir,
          files_count: args.files?.length ?? 0,
        })
      );

      validateDestinationDir(args.destination_dir);

      let tempDir: string | undefined;

      try {
        let fileTransfers: FileTransfer[] | undefined;

        if (args.files && args.files.length > 0) {
          validateFiles(args.files);
          tempDir = await decodeFilesToTemp(args.files);
          fileTransfers = args.files.map((f) => ({
            name: f.name,
            path: `${tempDir}/${f.name}`,
            mime_type: f.mime_type,
            dest_dir: f.dest_dir,
            overwrite: f.overwrite,
          }));
        }

        let response: Awaited<ReturnType<GatewayClient["chat"]>>;
        try {
          response = await client.chat({
            chat_id: args.chat_id,
            message: args.message,
            session_id: args.session_id,
            model: args.model,
            destination_dir: args.destination_dir,
            file_paths: fileTransfers,
          });
        } catch (error) {
          if (
            error instanceof GatewayError &&
            error.status === 409 &&
            error.payload.error === "session_busy"
          ) {
            const task = error.payload.current_task || "задача выполняется";
            const elapsed = error.payload.elapsed_s;
            const suffix =
              typeof elapsed === "number" ? ` (${elapsed} с)` : "";
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ok: false,
                    chat_id: args.chat_id,
                    state: "busy",
                    error: "session_busy",
                    notification: `Сессия занята: ${task}${suffix}.`,
                    current_task: task,
                    elapsed_s: elapsed,
                    progress: error.payload.progress,
                  }),
                },
              ],
            };
          }
          throw error;
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: response.ok,
              chat_id: response.chat_id,
              session_id: response.session_id,
              state: "completed",
              output: response.reply,
              trace: response.trace || [],
            }),
          }],
        };
      } finally {
        if (tempDir) {
          await cleanupTempDir(tempDir);
        }
      }
    }
  );
}
