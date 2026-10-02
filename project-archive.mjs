import fs from 'node:fs/promises';
import path from 'node:path';
import { fileError } from './project-files.mjs';

const maxArchiveBytes = 64 * 1024 * 1024;
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

function dosTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

export function makeZip(entries) {
  if (entries.length > 65535) throw fileError(413, '書き出すファイルが多すぎます。');
  const local = [];
  const central = [];
  const stamp = dosTime(new Date());
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = entry.directory ? Buffer.alloc(0) : Buffer.from(entry.content);
    if (name.length > 65535 || offset + content.length > maxArchiveBytes) throw fileError(413, 'プロジェクトが大きすぎます。');
    const checksum = crc32(content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(stamp.time, 10);
    header.writeUInt16LE(stamp.date, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(content.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, content);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(stamp.time, 12);
    record.writeUInt16LE(stamp.date, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(content.length, 20);
    record.writeUInt32LE(content.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(entry.directory ? 0x10 << 16 : 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + content.length;
  }
  const centralLength = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

export async function archiveProject(project) {
  const name = path.basename(project.root).replaceAll('/', '_').replaceAll('\\', '_');
  const entries = [{ name: `${name}/`, directory: true }];
  let total = 0;
  const walk = async nodes => {
    for (const node of nodes) {
      if (node.type === 'folder') {
        entries.push({ name: `${name}/${node.path}/`, directory: true });
        await walk(node.children);
      } else {
        const target = (await project.existing(node.path, 'file')).target;
        const content = await fs.readFile(target);
        total += content.length;
        if (total > maxArchiveBytes) throw fileError(413, 'プロジェクトが大きすぎます。');
        entries.push({ name: `${name}/${node.path}`, content });
      }
    }
  };
  await walk(await project.tree());
  return makeZip(entries);
}
