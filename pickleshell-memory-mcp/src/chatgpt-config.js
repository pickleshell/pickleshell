import { loadConfig } from './config.js';

export function loadChatGPTConfig(args, env = process.env) {
  const [credential, audit, mode = 'normal'] = args;
  if (args.length < 2 || args.length > 3 || !['normal', 'admin'].includes(mode) || env.PICKLESHELL_MEMORY_BACKEND_TOKEN) {
    throw new Error('Invalid ChatGPT Memory launch configuration');
  }
  const config = loadConfig({
    PICKLESHELL_MEMORY_ROLE: 'agent',
    PICKLESHELL_MEMORY_ACTOR: 'chatgpt-memory',
    PICKLESHELL_MEMORY_PRINCIPAL_CREDENTIAL_FILE: credential,
    PICKLESHELL_MEMORY_AUDIT_LOG: audit,
    PICKLESHELL_MEMORY_BACKEND_URL: 'http://127.0.0.1:8767',
  });
  if (!config.brokerMode) throw new Error('ChatGPT requires a trusted principal credential');
  return Object.freeze({...config, exposeAdmin: mode === 'admin'});
}
