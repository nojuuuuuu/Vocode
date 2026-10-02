import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const defaultModel = 'gpt-6.1-sol';

function settingError(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export function validModel(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) {
    throw settingError('モデル名を正しく入力してください。');
  }
  return value;
}

export function validKey(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 512 || /[\s\0]/.test(value)) {
    throw settingError('APIキーを正しく入力してください。');
  }
  return value;
}

export class ApiSettings {
  constructor(appRoot, environment = {}) {
    this.file = path.join(appRoot, '.vocode-api-settings.json');
    this.environment = environment;
    this.savedKey = '';
    this.savedModel = '';
  }

  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (typeof data.apiKey === 'string' && data.apiKey) this.savedKey = validKey(data.apiKey);
      if (typeof data.model === 'string' && data.model) this.savedModel = validModel(data.model);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this;
  }

  get key() { return this.savedKey || this.environment.key || ''; }
  get model() { return this.savedModel || this.environment.model || defaultModel; }
  get keySource() { return this.savedKey ? 'saved' : this.environment.key ? 'environment' : 'none'; }
  get publicStatus() { return { configured: Boolean(this.key), model: this.model, keySource: this.keySource }; }

  async update(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw settingError('設定が正しくありません。');
    const model = validModel(input.model);
    let apiKey = this.savedKey;
    if (input.clearKey === true) apiKey = '';
    else if (input.apiKey !== undefined && input.apiKey !== '') apiKey = validKey(input.apiKey);
    const pending = `${this.file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(pending, JSON.stringify({ apiKey, model }) + '\n', { mode: 0o600, flag: 'wx' });
      await fs.rename(pending, this.file);
      await fs.chmod(this.file, 0o600);
    } catch (error) {
      await fs.rm(pending, { force: true }).catch(() => {});
      throw error;
    }
    this.savedKey = apiKey;
    this.savedModel = model;
    return this.publicStatus;
  }
}

export async function openaiModels(apiKey, fetcher = fetch) {
  if (!apiKey) throw Object.assign(new Error('APIキーを入力してください。'), { status: 400 });
  let response;
  try {
    response = await fetcher('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000)
    });
  } catch { throw Object.assign(new Error('OpenAI に接続できませんでした。'), { status: 502 }); }
  if (response.status === 401) throw Object.assign(new Error('APIキーが認証されませんでした。'), { status: 401 });
  if (!response.ok) throw Object.assign(new Error('モデル一覧を取得できませんでした。'), { status: 502 });
  const data = await response.json().catch(() => ({}));
  return [...new Set((Array.isArray(data.data) ? data.data : []).map(item => item?.id).filter(id => typeof id === 'string'))]
    .sort((a, b) => Number(/^(gpt-|o[1-9])/.test(b)) - Number(/^(gpt-|o[1-9])/.test(a)) || a.localeCompare(b));
}

export async function checkOpenaiModel(apiKey, model, fetcher = fetch) {
  if (!apiKey) throw Object.assign(new Error('APIキーを入力してください。'), { status: 400 });
  const id = validModel(model);
  let response;
  try {
    response = await fetcher(`https://api.openai.com/v1/models/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000)
    });
  } catch { throw Object.assign(new Error('OpenAI に接続できませんでした。'), { status: 502 }); }
  if (response.status === 401) throw Object.assign(new Error('APIキーが認証されませんでした。'), { status: 401 });
  if (response.status === 404) throw Object.assign(new Error('このキーでモデルを確認できませんでした。別のモデルを選んでください。'), { status: 404 });
  if (!response.ok) throw Object.assign(new Error('接続を確認できませんでした。'), { status: 502 });
  return { ok: true, model: id };
}
