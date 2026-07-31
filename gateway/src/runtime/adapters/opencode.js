// OpenCode runtime adapter.
//
// Holds every OpenCode-specific detail of agent execution: the wrapper
// script, the child environment allowlist, the system instruction, the
// argv layout, and the JSONL stdout protocol. The process lifecycle itself
// lives in the runtime-neutral supervisor.
//
// The adapter translates the OpenCode JSONL protocol into canonical
// AgentEvents (see runtime/contract.js). onProgress callbacks receive only
// canonical events — raw OpenCode JSON never leaks past this adapter.

const path = require('path');
const { createAgentEvent } = require('../normalize');

const ALLOWED_ENV_KEYS = new Set([
  'PATH', 'HOME', 'LANG', 'LC_ALL',
  'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
  'NPM_CONFIG_CACHE', 'PLAYWRIGHT_BROWSERS_PATH',
  'TMPDIR', 'TMP', 'TEMP',
  'NODE_ENV',
  'TZ', 'USER', 'LOGNAME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
]);

function buildChildEnv(sourceEnv = process.env) {
  const childEnv = {};
  for (const key of ALLOWED_ENV_KEYS) {
    if (sourceEnv[key] !== undefined) {
      childEnv[key] = sourceEnv[key];
    }
  }
  return childEnv;
}

const SYSTEM_INSTRUCTION = `You are a PickleShell Gateway worker.

You receive high-level text instructions from an external architect.
You work only inside the workspace assigned to the current chat_id.
Do not read secrets, private keys, .env files, credentials, or unrelated directories.
Do not modify production services.
Do not run destructive actions unless the instruction contains the exact phrase APPROVE_DESTRUCTIVE_ACTION.

File handling:
- Files listed in the message as delivered to the workspace are already at their final destination.
- Do not move files from .inbox/ or any temporary directory.
- Do not modify the .inbox/ directory.

When creating or editing files, return:
- changed file paths
- short summary
- git diff if the workspace is a git repository
If you cannot safely complete the request, explain why.`;

const WRAPPER_SCRIPT =
  process.env.OPENCODE_WRAPPER_SCRIPT ||
  path.join(__dirname, '..', '..', '..', 'opencode-run.sh');

function buildPrompt(message, fileSummary) {
  const filePrompt = fileSummary
    ? require('../../file-transfer').buildFileSummaryPrompt(fileSummary)
    : '';
  return `${SYSTEM_INSTRUCTION}\n\nUser instruction: ${message}${filePrompt}`;
}

function buildArgs(prompt, workspace, sessionId, model) {
  return [
    WRAPPER_SCRIPT,
    prompt,
    workspace,
    sessionId || '',
    model || '',
  ];
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch (e) {
    return null;
  }
}

function parseJsonOutput(stdout) {
  const lines = stdout.split('\n').filter(line => line.trim());
  const textParts = [];
  let sessionId = null;

  for (const line of lines) {
    const event = parseLine(line);
    if (!event) continue;

    if (event.sessionID && !sessionId) {
      sessionId = event.sessionID;
    }

    if (event.type === 'text' && event.part && event.part.text) {
      textParts.push(event.part.text);
    }

    if (event.type === 'tool_use' && event.part && event.part.state && event.part.state.output) {
      const output = event.part.state.output.trim();
      if (output) {
        textParts.push(`[${event.part.state.title || 'tool'}]: ${output}`);
      }
    }
  }

  return { text: textParts.join('\n'), sessionId };
}

function normalizeEvent(event) {
  if (!event || typeof event !== 'object') return null;

  if (event.type === 'text' && event.part && event.part.text) {
    return createAgentEvent('text', { text: event.part.text });
  }

  if (event.type === 'tool_use') {
    const state = event.part?.state || {};
    const input = {
      ...(state.input?.filePath !== undefined ? { filePath: state.input.filePath } : {}),
      ...(state.input?.command !== undefined ? { command: state.input.command } : {}),
    };
    return createAgentEvent('tool', {
      tool: event.part?.tool || 'tool',
      status: state.status === 'completed' ? 'done' : 'running',
      title: state.title || '',
      input: Object.keys(input).length > 0 ? input : null,
      output: state.output || '',
    });
  }

  if (event.type === 'error') {
    return createAgentEvent('error', {
      details:
        event.error?.data?.message ||
        event.error?.message ||
        'OpenCode returned an error',
      error_class: 'agent_error',
    });
  }

  return null;
}

function createStreamHandler({ chatId, onProgress }) {
  let sessionIdFound = null;
  let agentError = null;
  const textParts = [];
  const events = [];

  return {
    handleLine(line) {
      const event = parseLine(line);
      if (!event) return;

      if (event.sessionID && !sessionIdFound) {
        sessionIdFound = event.sessionID;
      }

      if (event.type === 'text' && event.part?.text) {
        textParts.push(event.part.text);
      }

      if (event.type === 'tool_use' && event.part?.state?.output) {
        const output = event.part.state.output.trim();
        if (output) {
          textParts.push(`[${event.part.state.title || 'tool'}]: ${output}`);
        }
      }

      if (event.type === 'error') {
        agentError =
          event.error?.data?.message ||
          event.error?.message ||
          'OpenCode returned an error';
      }

      const normalized = normalizeEvent(event);
      if (normalized) {
        events.push(normalized);
        if (onProgress) {
          // Isolate the progress consumer: a failing onProgress callback is
          // logged, never rethrown, and never allowed to kill a healthy
          // agent process.
          try { onProgress(normalized); } catch (err) {
            console.error(`[OPENCODE] onProgress consumer failed: ${err.message}`);
          }
        }
      }
    },
    getSessionId() {
      return sessionIdFound;
    },
    getError() {
      return agentError;
    },
    getReply(fallback) {
      return textParts.join('\n') || fallback;
    },
    getEvents() {
      return events;
    },
  };
}

module.exports = {
  name: 'opencode',
  ALLOWED_ENV_KEYS,
  buildChildEnv,
  buildPrompt,
  buildArgs,
  parseLine,
  parseJsonOutput,
  normalizeEvent,
  createStreamHandler,
  SYSTEM_INSTRUCTION,
  WRAPPER_SCRIPT,
};
