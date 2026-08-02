import type { ChatRequest, ChatResponse, GatewayConfig, SessionStatusResponse } from "./types.js";

export interface GatewayErrorPayload {
  error?: string;
  notification?: string;
  current_task?: string;
  elapsed_s?: number;
  progress?: unknown;
  details?: string;
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

  async terminal<T>(operation: string, request: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeout_ms);
    try {
      const response = await fetch(`${this.config.url}/terminal/${operation}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.api_key}`,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new GatewayError(response.status, payload);
      return payload as T;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(503, { error: "terminal_unavailable", details: "Terminal service is unavailable" });
    } finally {
      clearTimeout(timeout);
    }
  }

  async getStatus(chatId: string, sessionId?: string, requestId?: string): Promise<SessionStatusResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeout_ms);
    const params = new URLSearchParams();
    if (requestId) {
      params.set("request_id", requestId);
    } else {
      if (!chatId) throw new Error("chat_id is required when request_id is not provided");
      params.set("chat_id", chatId);
      if (sessionId !== undefined) params.set("session_id", sessionId);
    }

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

  async getOutput(chatId: string, sessionId?: string, requestId?: string): Promise<SessionStatusResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeout_ms);
    const params = new URLSearchParams();
    if (requestId) {
      params.set("request_id", requestId);
    } else {
      if (!chatId) throw new Error("chat_id is required when request_id is not provided");
      params.set("chat_id", chatId);
      if (sessionId !== undefined) params.set("session_id", sessionId);
    }

    try {
      const response = await fetch(`${this.config.url}/output?${params}`, {
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

  async cancelRequest(requestId: string): Promise<{ ok: boolean; status: string; request_id: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeout_ms);

    try {
      const response = await fetch(`${this.config.url}/cancel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.api_key}`,
        },
        body: JSON.stringify({ request_id: requestId }),
        signal: controller.signal,
      });
      const data = await response.json();
      return data as { ok: boolean; status: string; request_id: string };
    } finally {
      clearTimeout(timeout);
    }
  }
}
