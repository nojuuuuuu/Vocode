import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApiSettings, checkOpenaiModel, openaiModels } from '../api-settings.mjs';

test('API settings stay server-side, persist with owner-only permissions, and can be removed', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocode-api-settings-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const settings = await new ApiSettings(dir, { key: 'environment-key', model: 'environment-model' }).load();
  assert.deepEqual(settings.publicStatus, { configured: true, model: 'environment-model', keySource: 'environment' });

  const saved = await settings.update({ apiKey: 'saved-secret-key', model: 'gpt-example' });
  assert.deepEqual(saved, { configured: true, model: 'gpt-example', keySource: 'saved' });
  assert.equal('apiKey' in saved, false);
  assert.equal((await fs.stat(settings.file)).mode & 0o777, 0o600);
  const reloaded = await new ApiSettings(dir, { key: 'environment-key' }).load();
  assert.equal(reloaded.key, 'saved-secret-key');
  assert.equal(reloaded.model, 'gpt-example');
  await reloaded.update({ clearKey: true, model: 'gpt-example' });
  assert.equal(reloaded.key, 'environment-key');
  assert.equal(reloaded.keySource, 'environment');
  await assert.rejects(reloaded.update({ apiKey: 'bad key', model: 'gpt-example' }), { status: 400 });
  await assert.rejects(reloaded.update({ model: 'bad model' }), { status: 400 });
});

test('model listing and connection checks use server-side bearer authentication', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, authorization: options.headers.Authorization });
    if (url.endsWith('/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'gpt-example' }, { id: 'gpt-example' }, { id: 'embedding-example' }] }) };
    return { ok: true, status: 200 };
  };
  assert.deepEqual(await openaiModels('test-secret', fetcher), ['gpt-example', 'embedding-example']);
  assert.deepEqual(await checkOpenaiModel('test-secret', 'gpt-example', fetcher), { ok: true, model: 'gpt-example' });
  assert.deepEqual(calls.map(call => call.authorization), ['Bearer test-secret', 'Bearer test-secret']);
  assert.equal(calls[1].url, 'https://api.openai.com/v1/models/gpt-example');
  await assert.rejects(checkOpenaiModel('test-secret', 'missing', async () => ({ ok: false, status: 404 })), { status: 404 });
});
