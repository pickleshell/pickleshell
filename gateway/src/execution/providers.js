// Boundary providers own process creation. Declarations never create containment.
const { ExecutionProfileError, PROFILES } = require('../execution-profile');
const known = ['host', 'container', 'vm'];
const invalid = () => { throw new ExecutionProfileError('execution_policy_invalid', 'Invalid boundary provider configuration'); };
function name(value) {
  if (!known.includes(value)) throw new ExecutionProfileError('boundary_provider_invalid', 'Unknown boundary provider');
  return value;
}
function validate(config) {
  if (config === undefined) return;
  if (!config || typeof config !== 'object' || Array.isArray(config)) invalid();
  for (const [key, value] of Object.entries(config)) {
    name(key);
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(key => key !== 'enabled') || typeof value.enabled !== 'boolean') invalid();
  }
}
function forContext(context) {
  if (!context || (context.execution_profile !== undefined && !PROFILES.includes(context.execution_profile))) {
    throw new ExecutionProfileError('execution_authority_unavailable', 'Unsupported execution authority', 403);
  }
  const provider = name(context.boundary_provider);
  if (provider !== context.boundary) {
    throw new ExecutionProfileError('execution_authority_unavailable', 'Provider cannot enforce the requested boundary', 403);
  }
  if (provider !== 'host') {
    throw new ExecutionProfileError('boundary_provider_unavailable', 'Requested boundary provider is not implemented', 503);
  }
  return host;
}
function resolve(config, context) {
  validate(config.boundary_providers);
  const provider = name(config.execution_surface?.boundary_provider ?? context.boundary);
  // Explicit null must not be treated as the compatibility default.
  if (config.execution_surface?.boundary_provider === null) invalid();
  if (config.boundary_providers !== undefined && config.boundary_providers[provider]?.enabled !== true) {
    throw new ExecutionProfileError('boundary_provider_unavailable', 'Requested boundary provider is not enabled', 503);
  }
  const resolved = Object.freeze({ ...context, boundary_provider: provider });
  forContext(resolved);
  return resolved;
}
const host = Object.freeze({
  name: 'host',
  supervise(options) { return require('../runtime/supervisor').supervise(options); },
  spawn(command, args, options) { return require('child_process').spawn(command, args, options); },
});
module.exports = { resolve, forContext, validate };
