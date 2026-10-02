import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectFiles, validatePath } from '../project-files.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocode-files-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, project: await ProjectFiles.open(path.join(dir, 'workspace'), true) };
}

test('folders and files keep their hierarchy through edit, move, trash and restore', async t => {
  const { project } = await fixture(t);
  await project.create('src', 'folder');
  await project.create('src/components', 'folder');
  await project.create('src/components/button.js', 'file');
  assert.deepEqual((await project.tree())[0].children.map(item => item.name), ['components']);
  const original = await project.read('src/components/button.js');
  const saved = await project.write('src/components/button.js', 'export const Button = 1;', original.version);
  assert.notEqual(saved.version, original.version);
  await assert.rejects(project.write('src/components/button.js', 'stale', original.version), { status: 409 });
  await project.move('src/components', 'src/ui');
  assert.equal((await project.read('src/ui/button.js')).content, 'export const Button = 1;');
  const trashed = await project.trash('src/ui');
  assert.equal((await project.listTrash())[0].id, trashed.id);
  assert.deepEqual((await project.tree())[0].children, []);
  await project.restore(trashed.id);
  assert.equal((await project.read('src/ui/button.js')).content, 'export const Button = 1;');
  assert.deepEqual(await project.listTrash(), []);
});

test('create never overwrites and move rejects collisions or self nesting', async t => {
  const { project } = await fixture(t);
  await project.create('a', 'folder');
  await project.create('a/empty', 'folder');
  await project.create('b', 'folder');
  await assert.rejects(project.create('a', 'folder'), { status: 409 });
  await assert.rejects(project.move('a', 'a/empty/a'), { status: 400 });
  await assert.rejects(project.move('a', 'b'), { status: 409 });
});

test('paths and symlinks cannot escape the project', async t => {
  const { dir, project } = await fixture(t);
  for (const name of ['../escape', '/tmp/escape', 'a//b', '.git/config', '.env', 'a\\b']) {
    assert.throws(() => validatePath(name), { status: 400 });
  }
  await fs.mkdir(path.join(dir, 'outside'));
  await fs.writeFile(path.join(dir, 'outside', 'secret.txt'), 'secret');
  await fs.symlink(path.join(dir, 'outside'), path.join(project.root, 'link'));
  await assert.rejects(project.read('link/secret.txt'), { status: 400 });
  await assert.rejects(project.create('link/new.txt', 'file'), { status: 400 });
  assert.deepEqual(await project.tree(), []);
});
