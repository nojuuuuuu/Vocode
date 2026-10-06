import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { attachTerminalServer } from '../terminal-server.mjs';

test('terminal WebSocket uses the workspace, forwards input and resize, and rejects other origins', async t => {
  const server = http.createServer();
  const processes = [];
  const terminalServer = attachTerminalServer(server, () => '/tmp/vocode-terminal-project', '127.0.0.1', (shell, args, options) => {
    const listeners = { data: [], exit: [] };
    let resolveKilled;
    const killedPromise = new Promise(resolve => { resolveKilled = resolve; });
    const process = {
      shell, args, options, input: [], sizes: [], killed: false, killedPromise,
      onData(listener) { listeners.data.push(listener); },
      onExit(listener) { listeners.exit.push(listener); },
      write(data) { this.input.push(data); listeners.data.forEach(listener => listener(`echo:${data}`)); },
      resize(cols, rows) { this.sizes.push([cols, rows]); },
      kill() { this.killed = true; resolveKilled(); listeners.exit.forEach(listener => listener({ exitCode: 0 })); }
    };
    processes.push(process);
    return process;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { terminalServer.closeAll(); await new Promise(resolve => server.close(resolve)); });

  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = `ws://127.0.0.1:${server.address().port}/api/terminal`;
  const rejected = new WebSocket(url, { origin: 'http://other.example' });
  const rejection = await new Promise((resolve, reject) => {
    rejected.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); });
    rejected.once('error', reject);
  });
  assert.equal(rejection, 403);
  assert.equal(processes.length, 0);

  const connection = new WebSocket(url, { origin });
  const messages = [];
  connection.on('message', raw => messages.push(JSON.parse(raw.toString())));
  const waitForMessage = type => new Promise((resolve, reject) => {
    const existing = messages.find(message => message.type === type);
    if (existing) return resolve(existing);
    const timeout = setTimeout(() => { connection.off('message', onMessage); reject(new Error(`Timed out waiting for ${type}`)); }, 2000);
    function onMessage(raw) {
      const message = JSON.parse(raw.toString());
      if (message.type !== type) return;
      clearTimeout(timeout);
      connection.off('message', onMessage);
      resolve(message);
    }
    connection.on('message', onMessage);
  });
  await once(connection, 'open');
  const ready = await waitForMessage('ready');
  assert.equal(ready.cwd, '/tmp/vocode-terminal-project');
  assert.match(ready.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(processes[0].options.cwd, '/tmp/vocode-terminal-project');

  connection.send(JSON.stringify({ type: 'input', data: 'pwd\r' }));
  connection.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  await waitForMessage('output');
  assert.deepEqual(processes[0].input, ['pwd\r']);
  assert.deepEqual(processes[0].sizes, [[100, 30]]);
  assert.ok(messages.some(message => message.type === 'output' && message.data === 'echo:pwd\r'));

  assert.equal(terminalServer.readSession(ready.sessionId), null);
  assert.match((await terminalServer.inputSession(ready.sessionId, 'ls')).error, /接続/);
  connection.send(JSON.stringify({ type: 'sharing', enabled: true, requestId: 'enable' }));
  assert.deepEqual(await waitForMessage('sharing'), { type: 'sharing', enabled: true, requestId: 'enable' });
  const result = await terminalServer.inputSession(ready.sessionId, 'ls');
  assert.deepEqual(processes[0].input, ['pwd\r', 'ls\r']);
  assert.match(result.output, /echo:ls/);
  assert.match(terminalServer.readSession(ready.sessionId), /echo:ls/);
  assert.match((await terminalServer.inputSession(ready.sessionId, 'bad\ncommand')).error, /1行/);
  const disabled = new Promise(resolve => connection.on('message', function onMessage(raw) {
    const message = JSON.parse(raw.toString());
    if (message.type !== 'sharing' || message.enabled !== false) return;
    connection.off('message', onMessage);
    resolve(message);
  }));
  connection.send(JSON.stringify({ type: 'sharing', enabled: false, requestId: 'disable' }));
  assert.deepEqual(await disabled, { type: 'sharing', enabled: false, requestId: 'disable' });
  assert.equal(terminalServer.readSession(ready.sessionId), null);

  connection.close();
  await once(connection, 'close');
  await processes[0].killedPromise;
  assert.equal(processes[0].killed, true);
  assert.equal(terminalServer.readSession(ready.sessionId), null);
});
