#!/usr/bin/env node
// Launch only from the installed immutable Memory release. The optional flag
// exposes schemas; only the credential-bound broker policy grants admin authority.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './index.js';
import { loadChatGPTConfig } from './chatgpt-config.js';

try {
  await createServer(loadChatGPTConfig(process.argv.slice(2))).connect(new StdioServerTransport());
} catch {
  console.error('ChatGPT Memory MCP startup failed: check trusted credential, audit configuration and mode');
  process.exitCode = 1;
}
