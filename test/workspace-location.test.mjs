import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceLocation } from '../workspace-location.mjs';

test('selected local folder becomes the project and survives a restart', async t => {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vocode-location-'));
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  const initial = path.join(appRoot, 'workspace');
  const selected = path.join(appRoot, 'my-project');
  await fs.mkdir(selected);

  const location = new WorkspaceLocation(appRoot, initial, true);
  await location.load();
  assert.equal(location.project.root, await fs.realpath(initial));
  await location.switchTo(selected);
  await location.project.create('src', 'folder');
  await location.project.create('src/main.js', 'file');
  assert.equal((await fs.stat(path.join(selected, 'src/main.js'))).isFile(), true);
  await assert.rejects(fs.stat(path.join(initial, 'src/main.js')), { code: 'ENOENT' });

  const restarted = new WorkspaceLocation(appRoot, initial, true);
  await restarted.load();
  assert.equal(restarted.project.root, await fs.realpath(selected));
  await assert.rejects(restarted.switchTo(path.join(appRoot, 'missing')), { code: 'ENOENT' });
  assert.equal(restarted.project.root, await fs.realpath(selected));
});
