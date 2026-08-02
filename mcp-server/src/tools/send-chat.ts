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
  runtime: z
    .enum(["opencode", "codex"])
    .optional()
    .describe(
      "Optional runtime for this request. If omitted, use chat runtime, then default_runtime from config."
    ),
  agent: z
    .enum(["opencode", "codex"])
    .optional()
    .describe(
      "Deprecated compatibility alias for runtime. Use runtime instead."
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Optional model override from the operator-controlled gateway allowlist. " +
        "Examples: opencode/big-pickle, opencode-go/gpt-5.6-luna, opencode-go/qwen3.7-plus"
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
  idempotency_key: z
    .string()
    .max(128)
    .optional()
    .describe(
      "Optional idempotency key for retry protection. " +
        "If provided and the same key is sent again within 24h, the gateway returns the cached result instead of re-executing. " +
        "If omitted, every send-chat is a new execution."
    ),
};

export function registerSendChat(mcp: any, client: GatewayClient) {
  mcp.tool(
    "send-chat",
    "Submit a command to a local project workspace via PickleShell. " +
      "The command executes asynchronously — the response returns immediately with request_id and state 'busy'. " +
      "For a new conversation, session_id may be null until execution completes. " +
      "After completion, the real OpenCode session_id appears in the session-output response. " +
      "Use the optional runtime field to choose opencode or codex for this request; when omitted, runtime is resolved from config. " +
      "Use session-status with request_id to poll progress, " +
      "then use session-output to read the final reply and trace. " +
      "Optionally include small files (base64-encoded, max 20 files, 2 MiB each, 10 MiB total) " +
      "to transfer them into the workspace. " +
      "Use destination_dir to place all files in a specific subdirectory, " +
      "or per-file dest_dir to override for individual files.",
    sendChatSchema,
    async (args: {
      chat_id: string;
      message: string;
      session_id?: string;
      runtime?: "opencode" | "codex";
      agent?: "opencode" | "codex";
      model?: string;
      destination_dir?: string;
      files?: Array<{
        name: string;
        content: string;
        mime_type?: string;
        dest_dir?: string;
        overwrite?: boolean;
      }>;
      idempotency_key?: string;
    }) => {
      console.error(
        "[send-chat] args:",
        JSON.stringify({
          chat_id: args.chat_id,
          message_len: args.message?.length,
          session_id: args.session_id,
          runtime: args.runtime,
          agent: args.agent,
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
            runtime: args.runtime ?? args.agent,
            model: args.model,
            destination_dir: args.destination_dir,
            file_paths: fileTransfers,
            idempotency_key: args.idempotency_key,
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
                    state: "rejected",
                    error: "session_busy",
                    notification: `Сессия занята: ${task}${suffix}.`,
                    current_task: task,
                    elapsed_s: elapsed,
                    progress: error.payload.progress,
                    next_action: "session-status",
                    retry_after_ms: 2000,
                  }),
                },
              ],
            };
          }
          throw error;
        }

        // Async mode: agent runs in background
        if (response.state === "busy") {
          const idempotentNote = (response as any).idempotent
            ? " (повторный запрос — та же команда)"
            : "";
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                ok: true,
                chat_id: response.chat_id,
                request_id: response.request_id,
                session_id: response.session_id,
                state: "busy",
                idempotent: (response as any).idempotent || false,
                next_action: response.next_action,
                retry_after_ms: response.retry_after_ms,
                notification: `Команда принята${idempotentNote}. request_id: ${response.request_id}. Используй session-status с этим request_id для отслеживания.`,
              }),
            }],
          };
        }

        // Idempotent completed: same request was already executed
        if ((response as any).idempotent && response.state === "completed") {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                ok: true,
                idempotent: true,
                chat_id: response.chat_id,
                request_id: response.request_id,
                session_id: response.session_id,
                state: "completed",
                next_action: "session-output",
                notification: `Задача уже выполнена ранее. Используй session-output с request_id: ${response.request_id} для чтения результата.`,
                created_at: response.created_at,
                completed_at: (response as any).completed_at,
                execution_ms: (response as any).execution_ms,
              }),
            }],
          };
        }

        // Sync fallback: agent completed inline (legacy)
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
