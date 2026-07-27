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
  model?: string;
  destination_dir?: string;
  files?: FileItem[];
  file_paths?: FileTransfer[];
}

export interface ChatResponse {
  ok: boolean;
  chat_id: string;
  session_id: string;
  reply: string;
}

export interface SessionStatusResponse {
  ok: boolean;
  chat_id: string;
  session_id: string | null;
  ready: boolean;
  state: "ready" | "busy" | "new_session";
  error?: string;
  notification?: string;
  current_task?: string;
  elapsed_s?: number;
  progress?: unknown;
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
