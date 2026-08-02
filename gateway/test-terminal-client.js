const assert = require('assert');
const { TerminalClient, TerminalUnavailableError } = require('./src/terminal-client');

function fakeSocket() {
  const handlers = {};
  return {
    writes: [],
    on(event, handler) { handlers[event] = handler; return this; },
    write(data) { this.writes.push(data); },
    destroy() {},
    emit(event, value) { if (handlers[event]) handlers[event](value); },
  };
}

(async () => {
  const socket = fakeSocket();
  const client = new TerminalClient({ connect: () => socket, authToken: 'secret', timeoutMs: 100 });
  const resultPromise = client.request('spawn', { chat_id: 'chat' }, 'scope');
  socket.emit('connect');
  assert.deepStrictEqual(JSON.parse(socket.writes[0]), { op: 'terminal-spawn', auth: 'secret', owner_scope: 'scope', chat_id: 'chat' });
  socket.emit('data', Buffer.from('{"ok":true,"terminal_id":"term_x"}\n'));
  assert.deepStrictEqual(await resultPromise, { ok: true, terminal_id: 'term_x' });

  const unavailable = new TerminalClient({ connect: () => { const s = fakeSocket(); setImmediate(() => s.emit('error')); return s; } });
  await assert.rejects(unavailable.request('output', {}, 'scope'), (error) => error instanceof TerminalUnavailableError);
  console.log('Terminal client tests passed');
})().catch((error) => { console.error(error); process.exit(1); });
