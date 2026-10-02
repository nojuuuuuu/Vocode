import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const ignored = new Set(['.git', 'node_modules', '.vocode-trash', '.vocode-settings.json', '.vocode-api-settings.json', '.DS_Store']);
const maxFileBytes = 256_000;

export function fileError(status, message) {
  return Object.assign(new Error(message), { status });
}

function inaccessible(part) {
  return ignored.has(part) || /^\.env(?:\.|$)/.test(part);
}

export function validatePath(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || value.includes('\\') || value.includes('\0') || value.startsWith('/')) {
    throw fileError(400, 'パスが正しくありません。');
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || inaccessible(part))) {
    throw fileError(400, 'この場所にはアクセスできません。');
  }
  return value;
}

function version(content) {
  return createHash('sha256').update(content).digest('hex');
}

export class ProjectFiles {
  constructor(root) { this.root = root; }

  static async open(root, create = false) {
    if (create) await fs.mkdir(root, { recursive: true });
    const real = await fs.realpath(root);
    if (!(await fs.stat(real)).isDirectory()) throw fileError(400, 'プロジェクトはフォルダを指定してください。');
    return new ProjectFiles(real);
  }

  target(name) { return path.join(this.root, validatePath(name)); }

  async parent(name, create = false) {
    const parts = validatePath(name).split('/').slice(0, -1);
    let current = this.root;
    for (const part of parts) {
      current = path.join(current, part);
      let stat;
      try { stat = await fs.lstat(current); }
      catch (error) {
        if (error.code !== 'ENOENT' || !create) throw error;
        await fs.mkdir(current);
        stat = await fs.lstat(current);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fileError(400, '通常のフォルダだけ使用できます。');
    }
    return current;
  }

  async existing(name, type) {
    await this.parent(name);
    const target = this.target(name);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || (type === 'file' && !stat.isFile()) || (type === 'folder' && !stat.isDirectory()) || (!stat.isFile() && !stat.isDirectory())) {
      throw fileError(400, 'この種類の項目は操作できません。');
    }
    return { target, stat, type: stat.isDirectory() ? 'folder' : 'file' };
  }

  async tree() {
    let count = 0;
    const walk = async (dir, prefix, depth) => {
      if (depth > 20) return [];
      const entries = await fs.readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'ja'));
      const result = [];
      for (const entry of entries) {
        if (count >= 1000) break;
        if (inaccessible(entry.name) || entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        count++;
        if (entry.isDirectory()) result.push({ path: name, name: entry.name, type: 'folder', children: await walk(path.join(dir, entry.name), name, depth + 1) });
        else result.push({ path: name, name: entry.name, type: 'file' });
      }
      return result;
    };
    return walk(this.root, '', 0);
  }

  async files() {
    const flatten = nodes => nodes.flatMap(node => node.type === 'file' ? [node.path] : flatten(node.children));
    return flatten(await this.tree());
  }

  async read(name) {
    const { target, stat } = await this.existing(name, 'file');
    if (stat.size > maxFileBytes) throw fileError(413, 'このファイルはエディタで開くには大きすぎます。');
    const bytes = await fs.readFile(target);
    if (bytes.includes(0)) throw fileError(415, 'このファイルはテキストではありません。');
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw fileError(415, 'UTF-8 のテキストファイルだけ編集できます。'); }
    return { path: name, content, version: version(bytes) };
  }

  async write(name, content, expectedVersion, create = false) {
    validatePath(name);
    if (typeof content !== 'string' || Buffer.byteLength(content) > maxFileBytes) throw fileError(413, 'ファイルが大きすぎます。');
    const target = this.target(name);
    if (create) {
      await this.parent(name, true);
      try { await fs.writeFile(target, content, { flag: 'wx' }); }
      catch (error) { if (error.code === 'EEXIST') throw fileError(409, '同じ名前の項目がすでにあります。'); throw error; }
    } else {
      await this.existing(name, 'file');
      if (expectedVersion && version(await fs.readFile(target)) !== expectedVersion) {
        throw fileError(409, '保存後に別の場所で変更されています。再読み込みして確認してください。');
      }
      await fs.writeFile(target, content, 'utf8');
    }
    return { path: name, version: version(content) };
  }

  async create(name, type) {
    if (type === 'file') return this.write(name, '', undefined, true);
    if (type !== 'folder') throw fileError(400, '種類が正しくありません。');
    await this.parent(name, true);
    try { await fs.mkdir(this.target(name)); }
    catch (error) { if (error.code === 'EEXIST') throw fileError(409, '同じ名前の項目がすでにあります。'); throw error; }
    return { path: name, type };
  }

  async move(source, destination) {
    validatePath(destination);
    const from = await this.existing(source);
    if (source === destination) return { path: destination, type: from.type };
    if (from.type === 'folder' && destination.startsWith(source + '/')) throw fileError(400, 'フォルダを自分自身の中へ移動できません。');
    await this.parent(destination);
    const target = this.target(destination);
    try { await fs.lstat(target); throw fileError(409, '移動先に同じ名前の項目があります。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(from.target, target);
    return { path: destination, type: from.type };
  }

  async trashDirectory() {
    const dir = path.join(this.root, '.vocode-trash');
    try {
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fileError(400, 'ゴミ箱を使用できません。');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.mkdir(dir);
    }
    return dir;
  }

  async trash(name) {
    const entry = await this.existing(name);
    const id = randomUUID();
    const dir = path.join(await this.trashDirectory(), id);
    await fs.mkdir(dir);
    const metadata = { id, path: name, type: entry.type, deletedAt: new Date().toISOString() };
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(metadata));
    await fs.rename(entry.target, path.join(dir, 'item'));
    return metadata;
  }

  async listTrash() {
    const dir = path.join(this.root, '.vocode-trash');
    try {
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fileError(400, 'ゴミ箱を使用できません。');
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const items = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
      try { items.push(JSON.parse(await fs.readFile(path.join(dir, entry.name, 'meta.json'), 'utf8'))); }
      catch { /* Incomplete trash entries are hidden. */ }
    }
    return items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  async restore(id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw fileError(400, '復元する項目が正しくありません。');
    const dir = path.join(await this.trashDirectory(), id);
    const metadata = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
    validatePath(metadata.path);
    await this.parent(metadata.path, true);
    const target = this.target(metadata.path);
    try { await fs.lstat(target); throw fileError(409, '元の場所に同じ名前の項目があります。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(path.join(dir, 'item'), target);
    await fs.rm(dir, { recursive: true, force: true });
    return { path: metadata.path, type: metadata.type };
  }
}
