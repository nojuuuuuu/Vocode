import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAssistantResult } from '../assistant-intent.mjs';

test('questions cannot expose file changes, while implementation requests retain reviewable proposals', () => {
  const answer = normalizeAssistantResult({ action: 'answer', reply: '説明します。', files: [{ path: 'index.html', content: 'unexpected' }] }, 1000);
  assert.deepEqual(answer, { action: 'answer', reply: '説明します。', files: [] });

  const edit = normalizeAssistantResult({ action: 'edit', reply: '変更案です。', files: [{ path: 'src/app.js', content: 'new code' }] }, 1000);
  assert.deepEqual(edit, { action: 'edit', reply: '変更案です。', files: [{ path: 'src/app.js', content: 'new code' }] });
  const protectedOnly = normalizeAssistantResult({ action: 'edit', reply: '設定します。', files: [{ path: '.env', content: 'SECRET=example' }] }, 1000);
  assert.equal(protectedOnly.action, 'answer');
  assert.deepEqual(protectedOnly.files, []);
  assert.match(protectedOnly.reply, /保護された場所/);
  const partial = normalizeAssistantResult({ action: 'edit', reply: '設定します。', files: [
    { path: '../outside', content: 'bad' }, { path: 'src/db.js', content: 'safe' }
  ] }, 1000);
  assert.deepEqual(partial.files, [{ path: 'src/db.js', content: 'safe' }]);
  assert.throws(() => normalizeAssistantResult({ action: 'edit', reply: '', files: [{ path: 'app.js', content: 'too large' }] }, 5), { status: 413 });
  assert.throws(() => normalizeAssistantResult({ action: 'unknown', reply: '', files: [] }, 1000), { status: 502 });
});
