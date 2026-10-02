import test from 'node:test';
import assert from 'node:assert/strict';
import { writeProjectToDirectory } from '../public/local-save.js';

function fakeFolder() {
  const folders = new Map();
  const files = new Map();
  return {
    folders,
    files,
    async getDirectoryHandle(name) {
      if (!folders.has(name)) folders.set(name, fakeFolder());
      return folders.get(name);
    },
    async getFileHandle(name) {
      return {
        async createWritable() {
          let pending;
          return {
            async write(blob) { pending = Buffer.from(await blob.arrayBuffer()); },
            async close() { files.set(name, pending); },
            async abort() { pending = undefined; }
          };
        }
      };
    }
  };
}

test('folder export writes nested and binary files and keeps empty folders', async () => {
  const destination = fakeFolder();
  destination.files.set('index.html', Buffer.from('old'));
  const tree = [
    { type: 'file', name: 'index.html', path: 'index.html' },
    { type: 'folder', name: 'assets', path: 'assets', children: [
      { type: 'file', name: 'icon.bin', path: 'assets/icon.bin' }
    ] },
    { type: 'folder', name: 'empty', path: 'empty', children: [] }
  ];
  const contents = new Map([
    ['index.html', new Blob(['new'])],
    ['assets/icon.bin', new Blob([Uint8Array.from([0, 255, 1])])]
  ]);
  await writeProjectToDirectory(tree, destination, name => contents.get(name));
  assert.equal(destination.files.get('index.html').toString(), 'new');
  assert.deepEqual(destination.folders.get('assets').files.get('icon.bin'), Buffer.from([0, 255, 1]));
  assert.ok(destination.folders.has('empty'));
});
