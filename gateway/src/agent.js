const { spawn } = require('child_process');
const path = require('path');

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

const sendMessage = async (chatId, message, chatConfig, timeoutSec, sessionId, model, fileSummary, onProgress) => {
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

  return new Promise((resolve, reject) => {
    const proc = spawn('bash', args, {
      cwd: chatConfig.workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let buffer = '';
    let sessionIdFound = null;
    const textParts = [];

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

    let settled = false;

    const timer = setTimeout(() => {
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
          if (onProgress) {
            try { onProgress(event); } catch (_) {}
          }
        } catch (e) {}
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
      console.error(`[OPENCODE] Spawn error for ${chatId}:`, err.message);
      reject(err);
    });
  });
};

module.exports = {
  parseJsonOutput,
  sendMessage,
};
