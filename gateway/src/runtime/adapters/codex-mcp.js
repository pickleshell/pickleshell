// Codex MCP stdio transport adapter.

const { spawn, spawnSync } = require('child_process');
const { createAgentEvent } = require('../normalize');
const execAdapter = require('./codex-exec');

const CODEX_COMMAND = process.env.CODEX_COMMAND || 'codex';
const STDERR_LIMIT = 32 * 1024;
const CANCEL_GRACE_MS = 1500;
const DEFAULT_APPROVAL_POLICY = 'never';
const DEFAULT_SANDBOX = 'danger-full-access';
const TOOL_INITIAL = 'codex';
const TOOL_REPLY = 'codex-reply';
const REQUIRED_TOOLS = new Set([TOOL_INITIAL, TOOL_REPLY]);

let workerSeq = 0;
let activeWorkers = new Set();
let idleWorkers = new Set();

class TransportError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.code = code;
    this.metadata = metadata;
  }
}

function isAvailable() {
  try {
    const result = spawnSync(CODEX_COMMAND, ['mcp-server', '--help'], {
      env: execAdapter.buildChildEnv(),
      stdio: 'ignore',
    });
    return result.status === 0;
  } catch (_) {
    return false;
  }
}

function appendBounded(current, chunk) {
  const next = current + chunk;
  return next.length > STDERR_LIMIT ? next.slice(next.length - STDERR_LIMIT) : next;
}

function normalizeContentText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.content === 'string') return part.content;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractThreadId(result) {
  if (typeof result?.structuredContent?.threadId === 'string') {
    return result.structuredContent.threadId;
  }
  if (typeof result?.structuredContent?.thread_id === 'string') {
    return result.structuredContent.thread_id;
  }
  const text = normalizeContentText(result?.content);
  const match = text.match(/\b(?:threadId|thread_id|session_id)\s*[:=]\s*([A-Za-z0-9_-]{1,128})\b/);
  return match ? match[1] : null;
}

function extractReply(result) {
  if (typeof result?.structuredContent?.reply === 'string') return result.structuredContent.reply;
  if (typeof result?.structuredContent?.content === 'string') return result.structuredContent.content;
  if (typeof result?.structuredContent?.text === 'string') return result.structuredContent.text;
  if (typeof result?.structuredContent?.message === 'string') return result.structuredContent.message;
  return normalizeContentText(result?.content);
}

function normalizeToolResult(result) {
  const reply = extractReply(result);
  const events = reply ? [createAgentEvent('text', { text: reply })] : [];
  return {
    reply,
    sessionId: extractThreadId(result),
    events,
    agentError: result?.isError ? (reply || 'Codex MCP tool returned an error') : null,
  };
}

class JsonRpcWorker {
  constructor({ command = CODEX_COMMAND, env = execAdapter.buildChildEnv(), requestTimeoutMs }) {
    this.id = ++workerSeq;
    this.command = command;
    this.env = env;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.buffer = '';
    this.proc = null;
    this.ready = false;
    this.closed = false;
    this.busy = false;
    this.inFlightId = null;
    this.killTimer = null;
  }

  start() {
    if (this.proc) return;
    this.proc = spawn(this.command, ['mcp-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
      shell: false,
      detached: true,
    });
    activeWorkers.add(this);

    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.stderr.on('data', (chunk) => {
      this.stderr = appendBounded(this.stderr, chunk.toString());
    });
    this.proc.on('error', (err) => this._close(err));
    this.proc.on('close', (code, signal) => {
      this._close(new TransportError('transport_exit', 'Codex MCP server exited', {
        worker_id: this.id,
        exit_code: code,
        signal: signal || null,
        stderr_tail: this.stderr,
      }));
    });
  }

  async initialize() {
    this.start();
    const init = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'pickleshell-gateway', version: '0.1.2' },
    }, { retryableStartup: true });
    if (!init?.capabilities?.tools) {
      throw new TransportError('mcp_incompatible', 'Codex MCP server does not advertise tools capability', {
        worker_id: this.id,
      });
    }
    this.notify('notifications/initialized', {});
    const tools = await this.request('tools/list', {}, { retryableStartup: true });
    const names = Array.isArray(tools?.tools) ? tools.tools.map((tool) => tool.name).sort() : [];
    const compatible = names.length === REQUIRED_TOOLS.size && names.every((name) => REQUIRED_TOOLS.has(name));
    if (!compatible) {
      throw new TransportError('mcp_incompatible', 'Codex MCP server exposed unexpected tools', {
        worker_id: this.id,
        tools: names,
      });
    }
    this.ready = true;
  }

  callTool(name, args) {
    this.busy = true;
    return this.request('tools/call', { name, arguments: args })
      .finally(() => {
        this.busy = false;
        this.inFlightId = null;
      });
  }

  request(method, params, options = {}) {
    if (this.closed) {
      return Promise.reject(new TransportError('transport_unavailable', 'Codex MCP worker is closed', {
        worker_id: this.id,
        retryable_startup: !!options.retryableStartup,
      }));
    }
    this.start();
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method };
    if (params !== undefined) payload.params = params;
    const timeoutMs = this.requestTimeoutMs;

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TransportError('transport_timeout', 'Codex MCP request timed out', {
          worker_id: this.id,
          request_id: id,
          method,
          stderr_tail: this.stderr,
        }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, retryableStartup: !!options.retryableStartup });
      if (method === 'tools/call') this.inFlightId = id;
    });

    const handleWriteError = (err) => {
      if (!err) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new TransportError('transport_write_failed', err.message, {
        worker_id: this.id,
        method,
        retryable_startup: !!options.retryableStartup,
      }));
    };
    try {
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`, handleWriteError);
    } catch (err) {
      handleWriteError(err);
    }
    return promise;
  }

  notify(method, params) {
    if (this.closed) return false;
    this.start();
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    return true;
  }

  cancel(reason = 'cancelled by client') {
    if (this.inFlightId !== null) {
      this.notify('notifications/cancelled', { requestId: this.inFlightId, reason });
    }
    this.stop(new TransportError('transport_cancelled', 'Codex MCP worker was cancelled', {
      worker_id: this.id,
      stderr_tail: this.stderr,
    }));
    return true;
  }

  terminate(signal = 'SIGTERM') {
    if (!this.proc?.pid) return false;
    try {
      process.kill(-this.proc.pid, signal);
      return true;
    } catch (err) {
      if (err.code === 'ESRCH') return false;
      try { return this.proc.kill(signal); } catch (_) { return false; }
    }
  }

  stop(error = null) {
    if (error) this._close(error);
    const sent = this.terminate('SIGTERM');
    clearTimeout(this.killTimer);
    this.killTimer = setTimeout(() => {
      this.terminate('SIGKILL');
    }, CANCEL_GRACE_MS);
    this.killTimer.unref?.();
    return sent;
  }

  _onStdout(chunk) {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      this._handleLine(line);
    }
  }

  _handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (err) {
      this._close(new TransportError('mcp_malformed_json', 'Codex MCP server emitted malformed JSON', {
        worker_id: this.id,
        line,
        stderr_tail: this.stderr,
      }));
      this.terminate('SIGKILL');
      return;
    }

    if (message.id !== undefined && message.method) {
      this._respondToServerRequest(message);
      return;
    }

    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) {
      this._close(new TransportError('mcp_unexpected_response', 'Codex MCP server emitted an unexpected response id', {
        worker_id: this.id,
        response_id: message.id,
      }));
      this.terminate('SIGKILL');
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new TransportError('mcp_error', message.error.message || 'Codex MCP request failed', {
        worker_id: this.id,
        request_id: message.id,
        method: pending.method,
        error: message.error,
      }));
    } else {
      pending.resolve(message.result);
    }
  }

  _respondToServerRequest(message) {
    const response = {
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32000,
        message: 'Codex MCP client-side requests are not approved by PickleShell',
      },
    };
    try { this.proc.stdin.write(`${JSON.stringify(response)}\n`); } catch (_) {}
    this._close(new TransportError('approval_request_rejected', 'Codex MCP requested client approval or elicitation', {
      worker_id: this.id,
      method: message.method || null,
    }));
    this.terminate('SIGKILL');
  }

  _close(error) {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    clearTimeout(this.killTimer);
    activeWorkers.delete(this);
    idleWorkers.delete(this);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error instanceof TransportError ? error : new TransportError('transport_exit', error.message, {
        worker_id: this.id,
        request_id: id,
        method: pending.method,
        stderr_tail: this.stderr,
      }));
    }
    this.pending.clear();
  }
}

async function createReadyWorker(timeoutMs, onWorker) {
  for (const worker of [...idleWorkers]) {
    idleWorkers.delete(worker);
    if (worker.ready && !worker.closed) {
      worker.requestTimeoutMs = timeoutMs;
      onWorker?.(worker);
      return worker;
    }
  }

  const worker = new JsonRpcWorker({ requestTimeoutMs: timeoutMs });
  onWorker?.(worker);
  try {
    await worker.initialize();
    return worker;
  } catch (error) {
    worker.stop(new TransportError('transport_startup_failed', 'Codex MCP worker startup failed', {
      worker_id: worker.id,
      cause: error?.code || error?.message || String(error),
      stderr_tail: worker.stderr,
    }));
    throw error;
  }
}

function releaseReadyWorker(worker) {
  if (!worker || worker.closed || !worker.ready) return false;
  idleWorkers.add(worker);
  return true;
}

function buildInitialToolArgs({ prompt, workspace, model }) {
  return {
    prompt,
    cwd: workspace,
    ...(model ? { model } : {}),
    'approval-policy': DEFAULT_APPROVAL_POLICY,
    sandbox: DEFAULT_SANDBOX,
  };
}

function buildReplyToolArgs({ prompt, sessionId }) {
  return {
    prompt,
    threadId: sessionId,
  };
}

function resultFromError({ error, runtime, requestId, sessionId, events, startedAt, startedMs, cancelled = false, timedOut = false }) {
  const errorClass = cancelled ? 'cancelled' : (timedOut ? 'timeout' : (error.code || 'transport_error'));
  return {
    ok: false,
    runtime,
    request_id: requestId,
    session_id: sessionId || null,
    state: cancelled ? 'cancelled' : (timedOut ? 'timeout' : 'error'),
    reply: null,
    events,
    metadata: require('../normalize').buildMetadata(events, errorClass),
    error: {
      class: errorClass,
      message: error.message,
      exit_code: error.metadata?.exit_code ?? null,
      signal: error.metadata?.signal ?? null,
      metadata: error.metadata || {},
    },
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - startedMs,
    sessionId: sessionId || null,
    cancelled,
  };
}

function runRequest({ runtime, request_id, message, workspace, timeoutSec, session_id, model, fileSummary, onProgress }) {
  const requestId = request_id;
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const events = [];
  const timeoutMs = Math.max(1, timeoutSec * 1000);
  let cancelled = false;
  let timedOut = false;
  let worker = null;
  let timer = null;
  let recycleWorker = true;

  const promise = (async () => {
    try {
      const prompt = execAdapter.buildPrompt(message, fileSummary);
      worker = await createReadyWorker(timeoutMs, (readyWorker) => {
        worker = readyWorker;
        if (timedOut) readyWorker.cancel('PickleShell request timeout');
      });
      if (timedOut) {
        throw new TransportError('transport_timeout', 'Codex MCP request timed out', {
          worker_id: worker.id,
          stderr_tail: worker.stderr,
        });
      }
      if (cancelled) throw new TransportError('cancelled', 'Cancelled');
      const toolName = session_id ? TOOL_REPLY : TOOL_INITIAL;
      const toolArgs = session_id
        ? buildReplyToolArgs({ prompt, sessionId: session_id })
        : buildInitialToolArgs({ prompt, workspace, model });
      const raw = await worker.callTool(toolName, toolArgs);
      const normalized = normalizeToolResult(raw);
      for (const event of normalized.events) {
        events.push(event);
        if (onProgress) {
          try { onProgress(event); } catch (err) {
            console.error(`[CODEX:MCP] onProgress consumer failed: ${err.message}`);
          }
        }
      }
      if (normalized.agentError) {
        throw new TransportError('agent_error', normalized.agentError, { worker_id: worker.id });
      }
      const finalSessionId = normalized.sessionId || session_id || null;
      recycleWorker = false;
      return {
        ok: true,
        runtime,
        request_id: requestId,
        session_id: finalSessionId,
        state: 'completed',
        reply: normalized.reply || `Message received and processed. No output generated.`,
        events,
        metadata: require('../normalize').buildMetadata(events, null),
        error: null,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startedMs,
        sessionId: finalSessionId,
        cancelled: false,
      };
    } catch (error) {
      return resultFromError({
        error: error instanceof Error ? error : new Error(String(error)),
        runtime,
        requestId,
        sessionId: session_id,
        events,
        startedAt,
        startedMs,
        cancelled,
        timedOut: timedOut || error?.code === 'transport_timeout',
      });
    } finally {
      clearTimeout(timer);
      if (worker && recycleWorker) {
        worker.stop(new TransportError('transport_shutdown', 'Codex MCP worker was shut down', {
          worker_id: worker.id,
          stderr_tail: worker.stderr,
        }));
      } else if (worker) {
        releaseReadyWorker(worker);
      }
    }
  })();

  timer = setTimeout(() => {
    timedOut = true;
    if (!worker || worker.closed) return;
    worker.cancel('PickleShell request timeout');
  }, timeoutMs);

  return {
    promise,
    cancel() {
      if (cancelled) return false;
      cancelled = true;
      clearTimeout(timer);
      if (worker) worker.cancel('PickleShell cancellation');
      return true;
    },
  };
}

function shutdownAll() {
  for (const worker of [...activeWorkers]) {
    worker.stop(new TransportError('transport_shutdown', 'Codex MCP worker was shut down', {
      worker_id: worker.id,
      stderr_tail: worker.stderr,
    }));
  }
  activeWorkers.clear();
  idleWorkers.clear();
}

function resetForTests() {
  shutdownAll();
  workerSeq = 0;
  activeWorkers = new Set();
  idleWorkers = new Set();
}

module.exports = {
  name: 'codex',
  transport: 'mcp',
  command: CODEX_COMMAND,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_SANDBOX,
  buildChildEnv: execAdapter.buildChildEnv,
  buildPrompt: execAdapter.buildPrompt,
  validateModel: execAdapter.validateModel,
  isAvailable,
  runRequest,
  JsonRpcWorker,
  TransportError,
  normalizeToolResult,
  extractThreadId,
  buildInitialToolArgs,
  buildReplyToolArgs,
  shutdownAll,
  resetForTests,
};
