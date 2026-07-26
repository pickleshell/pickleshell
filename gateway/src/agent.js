const { execFile } = require('child_process');
const path = require('path');
const util = require('util');
const execFileAsync = util.promisify(execFile);

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
  path.join(__dirname, '..', 'opencode-run.sh');

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

const sendMessage = async (chatId, message, chatConfig, timeoutSec, sessionId, model, fileSummary) => {
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

  try {
    const { stdout } = await execFileAsync('/bin/bash', args, {
      timeout: timeoutSec * 1000,
      maxBuffer: 10 * 1024 * 1024,
      cwd: chatConfig.workspace,
      windowsHide: true,
    });

    let { text: reply, sessionId } = parseJsonOutput(stdout);

    if (!reply) {
      reply = `Message received and processed for ${chatId}. No output generated.`;
    }

    return { reply, sessionId };

  } catch (error) {
    console.error(`[OPENCODE] Error for ${chatId}:`, error.message);

    if (error.killed) {
      throw new Error('timeout');
    }

    throw error;
  }
};

module.exports = {
  parseJsonOutput,
  sendMessage,
};
