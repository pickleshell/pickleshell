const { spawn } = require('child_process');
const path = require('path');

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

const WRAPPER_SCRIPT = process.env.OPENCODE_WRAPPER_SCRIPT || path.join(__dirname, '..', 'opencode-run.sh');

const parseJsonOutput = (stdout) => {
  const lines = stdout.split('\n').filter(line => line.trim());
  const textParts = [];
  let sessionId = null;

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

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
    } catch (e) {
      // Skip non-JSON lines (ANSI escape codes from PTY wrapper, etc)
    }
  }

  return { text: textParts.join('\n'), sessionId };
};

const sendMessage = (chatId, message, chatConfig, timeoutSec, sessionId, model, fileSummary, onProgress) => {
  const filePrompt = fileSummary
    ? require('./file-transfer').buildFileSummaryPrompt(fileSummary)
    : '';

  console.log(
    `[OPENCODE] request chat=${chatId}` +
    ` session=${sessionId ? 'existing' : 'new'}` +
    ` model=${model || 'default'}` +
    ` files=${fileSummary?.length || 0}` +
    ` message_len=${message.length}`
  );

  const prompt = `${SYSTEM_INSTRUCTION}\n\nUser instruction: ${message}${filePrompt}`;
  const args = [
    WRAPPER_SCRIPT,
    prompt,
    chatConfig.workspace,
    sessionId || '',
    model || '',
  ];

  let proc = null;
  let settled = false;
  let cancelled = false;
  let timer = null;

  const promise = new Promise((resolve, reject) => {
    proc = spawn('bash', args, {
      cwd: chatConfig.workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: buildChildEnv(),
    });

    let stdout = '';
    let stderr = '';
    let buffer = '';
    let sessionIdFound = null;
    const textParts = [];
    let agentError = null;

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const event = JSON.parse(trimmed);

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
            agentError = event.error?.data?.message || event.error?.message || 'OpenCode returned an error';
          }

          if (onProgress) {
            try { onProgress(event); } catch (_) {}
          }
        } catch (e) {
          // Non-JSON line (ANSI codes from PTY wrapper, etc)
        }

        stdout += line + '\n';
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error('timeout'));
    }, timeoutSec * 1000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim());
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
            agentError = event.error?.data?.message || event.error?.message || 'OpenCode returned an error';
          }
          if (onProgress) {
            try { onProgress(event); } catch (_) {}
          }
        } catch (e) {}
      }

      if (cancelled) {
        console.log(`[OPENCODE] Cancelled for ${chatId} session=${sessionIdFound || '(none)'} code=${code}`);
        resolve({ reply: null, sessionId: sessionIdFound, cancelled: true });
        return;
      }

      if (agentError) {
        reject(new Error(agentError));
        return;
      }

      let reply = textParts.join('\n');
      if (!reply) {
        reply = `Message received and processed for ${chatId}. No output generated.`;
      }

      console.log(`[OPENCODE] Completed for ${chatId} session=${sessionIdFound || '(none)'} code=${code}`);
      resolve({ reply, sessionId: sessionIdFound });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (cancelled) {
        console.error(`[OPENCODE] Spawn error after cancel for ${chatId}:`, err.message);
        resolve({ reply: null, sessionId: null, cancelled: true });
        return;
      }
      console.error(`[OPENCODE] Spawn error for ${chatId}:`, err.message);
      reject(err);
    });
  });

  const cancel = () => {
    if (settled || cancelled) return false;
    cancelled = true;
    if (timer) clearTimeout(timer);
    if (proc && !proc.killed) {
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (proc && !proc.killed) proc.kill('SIGKILL');
      }, 2000);
    }
    return true;
  };

  return { promise, cancel };
};

module.exports = {
  buildChildEnv,
  parseJsonOutput,
  sendMessage,
};
