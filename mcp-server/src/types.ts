export interface FileItem {
  name: string;
  content: string;
  mime_type?: string;
  dest_dir?: string;
  overwrite?: boolean;
}

export interface FileTransfer {
  name: string;
  path: string;
  mime_type?: string;
  dest_dir?: string;
  overwrite?: boolean;
}

export interface ChatRequest {
  chat_id: string;
  message: string;
  session_id?: string;
  runtime?: "opencode" | "codex";
  /** @deprecated Use runtime. */
  agent?: "opencode" | "codex";
  model?: string;
  agent_timeout_sec?: number;
  codex_transport?: "exec" | "mcp";
  destination_dir?: string;
  files?: FileItem[];
  file_paths?: FileTransfer[];
  idempotency_key?: string;
}

export interface ChatResponse {
  ok: boolean;
  chat_id: string;
  request_id: string;
  session_id: string | null;
  state: "busy" | "completed" | "rejected";
  next_action: string | null;
  retry_after_ms: number;
  created_at?: string;
  started_at?: string;
  reply?: string;
  trace?: string[];
}

export interface SessionStatusResponse {
  ok: boolean;
  chat_id?: string;
  session_id: string | null;
  request_id?: string;
  ready: boolean;
  state: "ready" | "busy" | "new_session" | "completed" | "unknown";
  next_action: string | null;
  retry_after_ms: number;
  error?: string;
  notification?: string;
  current_task?: string;
  elapsed_s?: number;
  progress?: unknown;
  created_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  queue_ms?: number | null;
  execution_ms?: number | null;
  output?: {
    reply?: string;
    trace?: string[];
    session_id?: string | null;
    error?: string | null;
    metadata?: {
      files_modified?: string[];
      tools_used?: string[];
      test_result?: { passed: number | null; failed: number | null; total: number | null } | null;
      git_commit?: string | null;
      error_class?: string | null;
    } | null;
  };
}

export interface HealthResponse {
  ok: boolean;
  service: string;
  version: string;
  agent: string;
  active_sessions: number;
  uptime_s: number;
}

export interface GatewayConfig {
  url: string;
  api_key: string;
  timeout_ms: number;
}

export type MutableSettingName = "runtime" | "model" | "agent_timeout_sec" | "codex_transport";
export interface GatewaySettings {
  runtime?: "opencode" | "codex";
  model?: string | null;
  agent_timeout_sec?: number;
  codex_transport?: "exec" | "mcp";
}
export interface SettingDefinition {
  value: unknown;
  label: string;
  description: string;
  source: "chat_setting" | "static_config" | "default";
  allowed?: string[];
  nullable?: boolean;
  minimum?: number;
  maximum?: number;
}
export interface SettingsResponse {
  ok: boolean;
  revision: number;
  persisted: GatewaySettings;
  effective: Partial<Required<GatewaySettings>>;
  sources: Record<MutableSettingName, "global_setting" | "static_config" | "default" | "mixed_static_config">;
  baseline?: Partial<Record<MutableSettingName, { global_static: unknown; chat_static_values: unknown[] }>>;
  definitions: Record<MutableSettingName, SettingDefinition>;
  settings: Record<MutableSettingName, SettingDefinition>;
}

export interface TerminalSpawnRequest {
  chat_id: string;
  executable?: string;
  argv?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  idempotency_key?: string;
}

export interface TerminalWriteRequest {
  chat_id: string;
  terminal_id: string;
  data: string;
  idempotency_key?: string;
}

export interface TerminalOutputRequest {
  chat_id: string;
  terminal_id: string;
  cursor?: number;
  max_bytes?: number;
  wait_ms?: number;
}

export interface TerminalResizeRequest { chat_id: string; terminal_id: string; cols: number; rows: number; }
export interface TerminalSignalRequest { chat_id: string; terminal_id: string; signal: string; }
export interface TerminalCloseRequest { chat_id: string; terminal_id: string; reason?: string; }
