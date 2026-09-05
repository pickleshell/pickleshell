export class BackendClient {
  constructor(config, fetchImpl = fetch) { this.config = config; this.fetch = fetchImpl; }

  async call(operation, scope, args) {
    const memoryId = args.memory_id === undefined ? null : encodeURIComponent(args.memory_id);
    const path = memoryId ? operation.path.replace("{memory_id}", memoryId) : operation.path;
    const url = new URL(this.config.backendUrl + path);
    const body = {};
    for (const key of operation.body || []) if (args[key] !== undefined) body[key] = args[key];
    if (operation.method === "POST" || operation.method === "PUT") body.user_id = scope;
    else url.searchParams.set("user_id", scope);
    for (const key of operation.query || []) if (args[key] !== undefined) url.searchParams.set(key, String(args[key]));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetch(url, {
        method: operation.method,
        headers: {
          "accept": "application/json", "content-type": "application/json",
          ...(this.config.backendToken ? { authorization: `Bearer ${this.config.backendToken}` } : {}),
        },
        ...(Object.keys(body).length ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload;
      try { payload = text ? JSON.parse(text) : {}; }
      catch { throw backendError("invalid_backend_response", 502, false); }
      if (!response.ok) throw backendError(mapStatus(response.status), response.status, response.status >= 500, payload);
      return payload;
    } catch (error) {
      if (error?.code) throw error;
      if (error?.name === "AbortError") throw backendError("backend_timeout", 504, true);
      throw backendError("backend_unavailable", 503, true);
    } finally { clearTimeout(timer); }
  }

  async discover() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetch(new URL(this.config.backendUrl + "/health"), {
        headers: { accept: "application/json", ...(this.config.backendToken ? { authorization: `Bearer ${this.config.backendToken}` } : {}) },
        signal: controller.signal,
      });
      if (!response.ok) throw backendError(mapStatus(response.status), response.status, response.status >= 500);
      try { return await response.json(); }
      catch { throw backendError("invalid_backend_response", 502, false); }
    } catch (error) {
      if (error?.code) throw error;
      if (error?.name === "AbortError") throw backendError("backend_timeout", 504, true);
      throw backendError("backend_unavailable", 503, true);
    } finally { clearTimeout(timer); }
  }
}

function mapStatus(status) {
  if (status === 401) return "backend_unauthorized";
  if (status === 403) return "backend_forbidden";
  if (status === 404) return "memory_not_found";
  if (status === 429) return "backend_rate_limited";
  return status >= 500 ? "backend_failure" : "backend_rejected";
}

function backendError(code, status, retryable, backend) {
  return Object.assign(new Error(code), { code, status, retryable, backend });
}
