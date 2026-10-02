import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ProjectFiles, fileError } from './project-files.mjs';

const execFileAsync = promisify(execFile);

export class WorkspaceLocation {
  constructor(appRoot, defaultRoot, createDefault = false) {
    this.settingsFile = path.join(appRoot, '.vocode-settings.json');
    this.defaultRoot = defaultRoot;
    this.createDefault = createDefault;
    this.project = null;
  }

  async load() {
    let savedRoot;
    try {
      const settings = JSON.parse(await fs.readFile(this.settingsFile, 'utf8'));
      if (typeof settings.workspace === 'string') savedRoot = settings.workspace;
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('保存先の設定を読み込めませんでした。', error);
    }
    if (savedRoot) {
      try { this.project = await ProjectFiles.open(savedRoot); }
      catch (error) { console.warn('以前の保存先を開けませんでした。既定のフォルダを使います。', error); }
    }
    if (!this.project) this.project = await ProjectFiles.open(this.defaultRoot, this.createDefault);
    return this.project;
  }

  async switchTo(root) {
    const next = await ProjectFiles.open(root);
    const pending = `${this.settingsFile}.tmp`;
    await fs.writeFile(pending, JSON.stringify({ workspace: next.root }, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(pending, this.settingsFile);
    this.project = next;
    return next;
  }
}

export async function chooseWorkspaceFolder() {
  if (process.platform !== 'darwin') throw fileError(501, 'この環境では標準のフォルダ選択画面に対応していません。フォルダの絶対パスを入力してください。');
  try {
    const { stdout } = await execFileAsync('/usr/bin/osascript', [
      '-e', 'POSIX path of (choose folder with prompt "Vocode の作業フォルダを選択してください")'
    ], { timeout: 180_000 });
    return stdout.trim();
  } catch (error) {
    if (String(error.stderr || '').includes('(-128)')) return null;
    if (error.killed) throw fileError(408, 'フォルダの選択が時間切れになりました。');
    throw fileError(500, 'フォルダ選択画面を開けませんでした。');
  }
}
