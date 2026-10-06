import assert from 'node:assert/strict';
import test from 'node:test';
import { respondWithTerminal, terminalTools } from '../assistant-terminal.mjs';

test('terminal function calls read and type into the shared session before the final response', async () => {
  const requests = [];
  const responses = [
    { id: 'r1', output: [{ type: 'function_call', name: 'terminal_read', call_id: 'c1', arguments: '{}' }] },
    { id: 'r2', output: [{ type: 'function_call', name: 'terminal_input', call_id: 'c2', arguments: '{"command":"pwd"}' }] },
    { id: 'r3', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"action":"answer","reply":"ok","files":[]}' }] }] }
  ];
  const requestResponse = async payload => { requests.push(payload); return responses.shift(); };
  const terminal = {
    readSession(id) { assert.equal(id, 'session-1'); return '/project\n'; },
    async inputSession(id, command) { assert.equal(id, 'session-1'); assert.equal(command, 'pwd'); return { output: '/project\n', status: 'idle' }; }
  };
  const result = await respondWithTerminal({ model: 'gpt-6-luna', tools: terminalTools }, requestResponse, terminal, 'session-1');
  assert.equal(result.response.id, 'r3');
  assert.equal(requests[1].previous_response_id, 'r1');
  assert.deepEqual(JSON.parse(requests[1].input[0].output), { output: '/project\n' });
  assert.equal(requests[2].previous_response_id, 'r2');
  assert.deepEqual(JSON.parse(requests[2].input[0].output), { output: '/project\n', status: 'idle' });
});

test('terminal tools are not called without a shared session', async () => {
  const result = await respondWithTerminal({ model: 'gpt-6-luna' }, async () => ({ id: 'r1', output: [] }), {
    readSession() { throw new Error('unexpected'); }
  }, null);
  assert.equal(result.responses.length, 1);
});
