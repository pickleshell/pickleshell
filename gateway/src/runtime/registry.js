// In-process registry of runtime adapters.
//
// Adapters register themselves here; the gateway resolves an adapter by
// runtime name. Only 'opencode' is registered by this build. Codex, Terminal,
// and any public runtime selection are intentionally not part of this change.
//
// This registry is the single source of truth for runtime availability:
// config.js consults isRuntimeAvailable()/availableRuntimes() instead of
// maintaining its own copy of the list.

const adapters = new Map();

function registerRuntime(name, adapter) {
  if (typeof name !== 'string' || !name) {
    throw new Error(`Invalid runtime name: ${name}`);
  }
  if (!adapter || typeof adapter !== 'object') {
    throw new Error(`Invalid adapter for runtime: ${name}`);
  }
  adapters.set(name, adapter);
  return adapter;
}

function getRuntime(name) {
  return adapters.get(name) || null;
}

function isRuntimeRegistered(name) {
  return adapters.has(name);
}

function isRuntimeAvailable(name) {
  return adapters.has(name);
}

function availableRuntimes() {
  return Array.from(adapters.keys());
}

module.exports = {
  registerRuntime,
  getRuntime,
  isRuntimeRegistered,
  isRuntimeAvailable,
  availableRuntimes,
};
