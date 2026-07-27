import type { ChatRequest, ChatResponse, GatewayConfig, SessionStatusResponse } from "./types.js";

export interface GatewayErrorPayload {
  error?: string;
  notification?: string;
  current_task?: string;
  elapsed_s?: number;
  progress?: unknown;
}

export class GatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly payload: GatewayErrorPayload
  ) {
    super(`Gateway error ${status}: ${payload.error || "request_failed"}`);
    this.name = "GatewayError";
  }
}

export class GatewayClient {
  private config: GatewayConfig;

  constructor(config: GatewayConfig) {
    this.config = config;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeout_ms
    );

    try {
      const response = await fetch(`${this.config.url}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.api_key}`,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        console.error(
          `[gateway] error ${response.status}:`,
          JSON.stringify(error)
        );
        throw new GatewayError(response.status, error);
      }

      return (await response.json()) as ChatResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  async sessionStatus(chatId: string, sessionId?: string): Promise<SessionStatusResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeout_ms);
    const params = new URLSearchParams({ chat_id: chatId });
    if (sessionId !== undefined) params.set("session_id", sessionId);

    try {
      const response = await fetch(`${this.config.url}/status?${params}`, {
        headers: { Authorization: `Bearer ${this.config.api_key}` },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        console.error(`[gateway] error ${response.status}:`, JSON.stringify(error));
        throw new GatewayError(response.status, error);
      }
      return (await response.json()) as SessionStatusResponse;
    } finally {
      clearTimeout(timeout);
    }
  }
}
