import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectFiles } from '../project-files.mjs';
import { archiveProject } from '../project-archive.mjs';

function inspectZip(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const crc = bytes.readUInt32LE(offset + 16);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const local = bytes.readUInt32LE(offset + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const contentStart = local + 30 + bytes.readUInt16LE(local + 26);
    const content = bytes.subarray(contentStart, contentStart + size);
    let check = 0xffffffff;
    for (const byte of content) {
      check ^= byte;
      for (let bit = 0; bit < 8; bit++) check = check & 1 ? (check >>> 1) ^ 0xedb88320 : check >>> 1;
    }
    assert.equal((check ^ 0xffffffff) >>> 0, crc);
    files.set(name, content);
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return files;
}

test('ZIP export includes nested files, binary data and empty folders', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocode-zip-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const project = await ProjectFiles.open(path.join(dir, 'my-project'), true);
  await project.create('src', 'folder');
  await project.create('empty', 'folder');
  await project.write('src/main.js', 'console.log("ok");\n', undefined, true);
  const binary = Buffer.from([0, 1, 2, 255]);
  await fs.writeFile(path.join(project.root, 'asset.bin'), binary);
  const entries = inspectZip(await archiveProject(project));
  assert.equal(entries.get('my-project/src/main.js').toString(), 'console.log("ok");\n');
  assert.deepEqual(entries.get('my-project/asset.bin'), binary);
  assert.ok(entries.has('my-project/empty/'));
});
