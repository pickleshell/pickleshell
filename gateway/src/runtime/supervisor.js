// Shared process supervision for runtime adapters.
//
// Spawns an argv-based child process, streams stdout line by line through
// onLine(), enforces a timeout, and supports cooperative cancellation.
//
// The returned promise always resolves with an outcome object (never
// rejects):
//   {
//     code,        // exit code, or null if the child did not exit normally
//     stdout,      // full raw stdout captured so far
//     stderr,      // full raw stderr
//     cancelled,   // true when cancel() was called before the child exited
//     timedOut,    // true when the timeout fired (child is SIGKILLed)
//     spawnError,  // spawn error (e.g. ENOENT) if the child could not start
//   }
//
// onLine(line) receives every non-empty trimmed stdout line, including a
// trailing partial line flushed when the child exits.

const { spawn } = require('child_process');

function supervise({ command, args, cwd, env, timeoutMs, onLine }) {
  let proc = null;
  let settled = false;
  let cancelled = false;
  let timedOut = false;
  let timer = null;
  let stdout = '';
  let stderr = '';
  let buffer = '';
  let spawnError = null;

  const promise = new Promise((resolve) => {
    proc = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env,
    });

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) onLine(trimmed);
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      timedOut = true;
      proc.kill('SIGKILL');
      resolve({ code: null, stdout, stderr, cancelled, timedOut, spawnError });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (buffer.trim()) onLine(buffer.trim());
      resolve({ code, stdout, stderr, cancelled, timedOut, spawnError });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      spawnError = err;
      if (settled) return;
      settled = true;
      resolve({ code: null, stdout, stderr, cancelled, timedOut, spawnError });
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
}

module.exports = {
  supervise,
};
