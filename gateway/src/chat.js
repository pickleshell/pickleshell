const config = require('./config');
const agent = require('./agent');
const fileTransfer = require('./file-transfer');
const concurrency = require('./concurrency');
const { timeoutSec } = require('./timeout');
const crypto = require('crypto');

const chatHandler = async (req, res) => {
  let slotKey = null;
  try {
    const { chat_id, message, session_id, model, file_paths, destination_dir } = req.body;

    // Validate request
    if (!chat_id || typeof chat_id !== 'string' || chat_id.trim() === '') {
      return res.status(400).json({
        ok: false,
        error: 'invalid_request',
        details: 'chat_id is required and must be a non-empty string'
      });
    }

    if (!message || typeof message !== 'string' || message.trim() === '') {
      return res.status(400).json({
        ok: false,
        error: 'invalid_request',
        details: 'message is required and must be a non-empty string'
      });
    }

    if (
      session_id !== undefined &&
      (
        typeof session_id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(session_id)
      )
    ) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_request',
        details: 'session_id must contain only letters, numbers, underscores, or hyphens'
      });
    }

    // Check message length
    const maxChars = parseInt(process.env.MESSAGE_MAX_CHARS) || 300000;
    if (message.length > maxChars) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_request',
        details: `Message exceeds maximum length of ${maxChars} characters`
      });
    }

    // Resolve chat_id to workspace
    const chatConfig = config.getChatConfig(chat_id);
    if (!chatConfig) {
      return res.status(404).json({
        ok: false,
        error: 'unknown_chat_id',
        details: `No workspace configured for chat_id: ${chat_id}`
      });
    }

    // Validate model against allowlist
    const resolvedModel = config.resolveModel(model);
    if (model && !resolvedModel) {
      return res.status(403).json({
        ok: false,
        error: 'forbidden_model',
        details: 'Requested model is not allowed'
      });
    }

    // Validate destination_dir if provided
    if (destination_dir) {
      const resolved = fileTransfer.safeResolve(chatConfig.workspace, destination_dir);
      if (!resolved) {
        return res.status(400).json({
          ok: false,
          error: 'invalid_request',
          details: `destination_dir escapes workspace: ${destination_dir}`
        });
      }
    }

    // Unlimited across sessions; one active request per explicit session.
    const acquireResult = concurrency.acquire(chat_id, session_id);
    if (!acquireResult.ok) {
      const progress = concurrency.getProgressBySession(chat_id, session_id);
      return res.status(409).json({
        ok: false,
        chat_id,
        status: 'busy',
        error: acquireResult.error,
        notification: acquireResult.notification,
        current_task: acquireResult.current_task,
        elapsed_s: acquireResult.elapsed_s,
        progress: progress || undefined,
      });
    }
    slotKey = acquireResult.slotKey;

    // Handle file transfers
    let fileSummary = null;
    if (file_paths && Array.isArray(file_paths) && file_paths.length > 0) {
      try {
        const requestId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        fileSummary = fileTransfer.copyFilesToWorkspace(
          file_paths, chatConfig.workspace, destination_dir, requestId
        );
      } catch (err) {
        concurrency.release(slotKey);
        console.error('[FILE] Transfer error:', err.message);
        return res.status(400).json({
          ok: false,
          error: 'file_transfer_error',
          details: err.message
        });
      }
    }

    // Set task description for status reporting
    const taskSnippet = message.replace(/\s+/g, ' ').trim().substring(0, 80);
    concurrency.setTask(slotKey, taskSnippet);

    // Send to agent with streaming progress updates
    const agentResult = await agent.sendMessage(
      chat_id, message, chatConfig, timeoutSec, session_id, resolvedModel,
      fileSummary,
      (event) => concurrency.updateProgress(slotKey, event)
    );

    // Collect final progress trace
    const finalProgress = concurrency.getProgress(slotKey);
    concurrency.release(slotKey);
    slotKey = null;

    const result = {
      ok: true,
      chat_id,
      session_id: agentResult.sessionId || session_id || undefined,
      reply: agentResult.reply,
    };

    if (finalProgress && finalProgress.events.length > 0) {
      result.trace = finalProgress.events.map(e => {
        if (e.type === 'tool') {
          return `${e.status === 'running' ? '...' : '✓'} ${e.tool}: ${e.title}`;
        }
        if (e.type === 'text') {
          return `→ ${e.text}`;
        }
        return null;
      }).filter(Boolean);
    }

    return res.json(result);

  } catch (error) {
    if (slotKey) concurrency.release(slotKey);
    console.error('Chat error:', error.message);

    if (error.message.includes('timeout')) {
      return res.status(504).json({
        ok: false,
        chat_id: req.body.chat_id,
        error: 'agent_timeout',
        details: 'Agent response timeout'
      });
    }

    return res.status(502).json({
      ok: false,
      chat_id: req.body.chat_id,
      error: 'agent_error',
      details: 'Local agent failed or timed out'
    });
  }
};

module.exports = chatHandler;
