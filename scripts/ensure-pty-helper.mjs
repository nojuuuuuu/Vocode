import fs from 'node:fs/promises';
import path from 'node:path';

if (process.platform !== 'win32') {
  const helper = path.resolve('node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  try {
    const stat = await fs.stat(helper);
    if (!(stat.mode & 0o111)) await fs.chmod(helper, stat.mode | 0o111);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
