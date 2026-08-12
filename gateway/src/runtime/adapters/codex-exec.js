// Native Codex CLI exec transport adapter.

const path = require('path');
const { spawnSync } = require('child_process');
const { createAgentEvent } = require('../normalize');

const CODEX_COMMAND = process.env.CODEX_COMMAND || 'codex';

const ALLOWED_ENV_KEYS = new Set([
  'PATH', 'HOME', 'LANG', 'LC_ALL',
  'TMPDIR', 'TMP', 'TEMP',
  'TZ', 'USER', 'LOGNAME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);

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

function buildChildEnv(sourceEnv = process.env) {
  const childEnv = {};
  for (const key of ALLOWED_ENV_KEYS) {
    if (sourceEnv[key] !== undefined) childEnv[key] = sourceEnv[key];
  }
  childEnv.CODEX_HOME = sourceEnv.CODEX_HOME || path.join(sourceEnv.HOME || '/tmp', '.codex');
  return childEnv;
}

function isAvailable() {
  try {
    const result = spawnSync(CODEX_COMMAND, ['--version'], {
      env: buildChildEnv(),
      stdio: 'ignore',
    });
    return result.status === 0;
  } catch (_) {
    return false;
  }
}

function buildPrompt(message, fileSummary) {
  const filePrompt = fileSummary
    ? require('../../file-transfer').buildFileSummaryPrompt(fileSummary)
    : '';
  return `${SYSTEM_INSTRUCTION}\n\nUser instruction: ${message}${filePrompt}`;
}

function buildArgs(prompt, workspace, sessionId, model) {
  const args = [
    'exec',
    '--json',
    '--cd', workspace,
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
  ];
  if (model) args.push('--model', model);

  if (sessionId) {
    args.push('resume', sessionId, prompt);
  } else {
    args.push(prompt);
  }
  return args;
}

function validateModel(model) {
  if (model && model.includes('/')) {
    return {
      class: 'unsupported_model',
      message: 'Codex model must be an unqualified Codex CLI model id, without a provider namespace',
    };
  }
  return null;
}

function parseLine(line) {
  return JSON.parse(line);
}

function commandText(value) {
  if (Array.isArray(value)) return value.join(' ');
  return typeof value === 'string' ? value : '';
}

function errorMessage(event) {
  return event.message || event.error?.message || event.item?.message || 'Codex returned an error';
}

function normalizeEvent(event) {
  if (!event || typeof event !== 'object') return [];

  if (event.type === 'error' || event.type === 'turn.failed') {
    return [createAgentEvent('error', {
      details: errorMessage(event),
      error_class: 'agent_error',
    })];
  }

  if (event.type !== 'item.started' && event.type !== 'item.completed') return [];

  const item = event.item || {};
  const status = event.type === 'item.completed' ? 'done' : 'running';

  if (item.type === 'agent_message') {
    return item.text
      ? [createAgentEvent('text', { text: item.text })]
      : [];
  }

  if (item.type === 'command_execution') {
    const command = commandText(item.command);
    return [createAgentEvent('tool', {
      tool: 'bash',
      status,
      title: command,
      input: command ? { command } : null,
      output: item.aggregated_output || item.output || '',
    })];
  }

  if (item.type === 'file_change') {
    return (item.changes || []).map((change) => createAgentEvent('tool', {
      tool: 'file_edit',
      status,
      title: change.path || 'file change',
      input: change.path ? { filePath: change.path } : null,
      output: change.diff || change.kind || '',
    }));
  }

  if (item.type === 'error') {
    return [createAgentEvent('error', {
      details: errorMessage(event),
      error_class: 'agent_error',
    })];
  }

  return [];
}

function parseJsonOutput(stdout) {
  const events = stdout.split('\n').filter((line) => line.trim()).map(parseLine);
  const text = events
    .flatMap((event) => normalizeEvent(event))
    .filter((event) => event.type === 'text')
    .map((event) => event.text)
    .join('\n');
  const thread = events.find((event) => event.type === 'thread.started');
  return { text, sessionId: thread?.thread_id || null };
}

function createStreamHandler({ onProgress }) {
  let sessionIdFound = null;
  let agentError = null;
  const textParts = [];
  const events = [];

  return {
    handleLine(line) {
      const event = parseLine(line);
      if (event.type === 'thread.started' && event.thread_id && !sessionIdFound) {
        sessionIdFound = event.thread_id;
      }

      if (event.type === 'error' || event.type === 'turn.failed' || event.item?.type === 'error') {
        agentError = errorMessage(event);
      }

      for (const normalized of normalizeEvent(event)) {
        events.push(normalized);
        if (normalized.type === 'text' && normalized.text) textParts.push(normalized.text);
        if (onProgress) {
          try { onProgress(normalized); } catch (err) {
            console.error(`[CODEX] onProgress consumer failed: ${err.message}`);
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
  name: 'codex',
  transport: 'exec',
  command: CODEX_COMMAND,
  ALLOWED_ENV_KEYS,
  SYSTEM_INSTRUCTION,
  buildChildEnv,
  isAvailable,
  buildPrompt,
  buildArgs,
  validateModel,
  parseLine,
  parseJsonOutput,
  normalizeEvent,
  createStreamHandler,
};
