import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePath } from './project-files.mjs';
import { archiveProject } from './project-archive.mjs';
import { WorkspaceLocation, chooseWorkspaceFolder } from './workspace-location.mjs';
import { ApiSettings, validKey, openaiModels, checkOpenaiModel } from './api-settings.mjs';
import { normalizeAssistantResult } from './assistant-intent.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(root, 'public');
if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(path.join(root, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const host = '127.0.0.1';
const port = Number(process.env.PORT || 4173);
const apiSettings = await new ApiSettings(root, { key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL }).load();
const maxFileBytes = 256_000;
const workspaceLocation = new WorkspaceLocation(root, process.env.VOCODE_WORKSPACE ? path.resolve(process.env.VOCODE_WORKSPACE) : path.join(root, 'workspace'), !process.env.VOCODE_WORKSPACE);
let project = await workspaceLocation.load();
let choosingWorkspace = false;

function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') && !Buffer.isBuffer(data) ? JSON.stringify(data) : data);
}

function fail(res, error) {
  const status = error.status || 500;
  if (status >= 500 && status !== 502 && status !== 503) console.error(error);
  send(res, status, { error: status >= 500 && status !== 502 && status !== 503 ? 'サーバーでエラーが発生しました。' : error.message });
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, 'データが大きすぎます。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  try { return JSON.parse((await readBody(req)).toString('utf8')); }
  catch (error) { if (error.status) throw error; throw httpError(400, 'JSON が正しくありません。'); }
}

function outputText(response) {
  return (response.output || []).flatMap(item => item.type === 'message' ? (item.content || []) : [])
    .filter(item => item.type === 'output_text').map(item => item.text).join('');
}

async function openaiResponse(payload) {
  const key = apiSettings.key;
  if (!key) throw httpError(503, 'AI 設定から OpenAI APIキーを登録してください。');
  let response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000)
    });
  } catch { throw httpError(502, 'OpenAI API に接続できませんでした。'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw httpError(502, data.error?.message || 'AI の応答を取得できませんでした。');
  return data;
}

async function projectContext(activeFile) {
  const files = await project.files();
  let budget = 70_000;
  const selected = [...files].sort((a, b) => Number(b === activeFile) - Number(a === activeFile));
  const contents = [];
  for (const name of selected) {
    const { stat } = await project.existing(name, 'file');
    if (stat.size > 32_000 || stat.size > budget) continue;
    let content;
    try { content = (await project.read(name)).content; }
    catch (error) { if (error.status === 415) continue; throw error; }
    budget -= Buffer.byteLength(content);
    contents.push({ path: name, content });
  }
  return { files, contents };
}

async function assistant(req, res) {
  const body = await readJson(req);
  const message = String(body.message || '').trim().slice(0, 5000);
  if (!message) throw httpError(400, '質問か依頼を入力してください。');
  const activeFile = body.activeFile ? validatePath(body.activeFile) : '';
  const context = await projectContext(activeFile);
  if (activeFile && typeof body.activeContent === 'string') {
    if (Buffer.byteLength(body.activeContent) > 50_000) throw httpError(413, 'AI に渡すには編集中のファイルが大きすぎます。');
    const active = context.contents.find(file => file.path === activeFile);
    if (active) active.content = body.activeContent;
    else context.contents.unshift({ path: activeFile, content: body.activeContent });
  }
  let contextBytes = 0;
  context.contents = context.contents.filter(file => {
    const size = Buffer.byteLength(file.content);
    if (contextBytes + size > 70_000) return false;
    contextBytes += size;
    return true;
  });
  const history = Array.isArray(body.history) ? body.history.slice(-8).map(item => ({
    role: item.role === 'assistant' ? 'assistant' : 'user',
    content: String(item.content || '').slice(0, 2000)
  })) : [];
  const instructions = 'あなたは日本語で話す開発パートナーです。毎回、最新のユーザー発話を会話履歴と提供されたプロジェクトの実コードに照らして判断してください。説明、相談、質問、実装できるかどうかの確認なら action は answer にし、files は空配列にして具体的に回答します。ファイルを作る、修正する、機能を追加するなど、コード変更を明確に依頼された場合は action を edit にし、必要なファイルだけ完全な置換内容を files に返します。質問と実装依頼が混ざっていたら説明を reply に含めて edit にします。意図や変更内容が曖昧で安全に実装できない場合は action を answer にし、必要な点を質問します。変更案では既存機能を壊さず、reply に変更の要約と確認方法を簡潔に書いてください。file path は提供された一覧か作業フォルダ内の新しい相対パスにします。削除やコマンド実行はできません。変更案はユーザーの確認後に適用されます。';
  const payload = {
    model: apiSettings.model,
    instructions,
    input: [
      ...history,
      { role: 'user', content: JSON.stringify({ request: message, activeFile, project: context }) }
    ],
    text: {
      format: {
        type: 'json_schema', name: 'coding_assistant', strict: true,
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['answer', 'edit'] },
            reply: { type: 'string' },
            files: { type: 'array', items: { type: 'object', additionalProperties: false,
              properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }
          }, required: ['action', 'reply', 'files']
        }
      }
    },
    max_output_tokens: 12000
  };
  const response = await openaiResponse(payload);
  let result;
  try { result = JSON.parse(outputText(response)); }
  catch { throw httpError(502, 'AI の応答を読み取れませんでした。もう一度お試しください。'); }
  send(res, 200, normalizeAssistantResult(result, maxFileBytes));
}

async function transcribe(req, res) {
  const key = apiSettings.key;
  if (!key) throw httpError(503, 'AI 設定から OpenAI APIキーを登録してください。');
  const audio = await readBody(req, 12_000_000);
  if (!audio.length) throw httpError(400, '録音データがありません。');
  const mime = String(req.headers['content-type'] || 'audio/webm').split(';')[0];
  const extension = mime.includes('wav') ? 'wav' : mime.includes('mp4') ? 'mp4' : mime.includes('ogg') ? 'ogg' : 'webm';
  const form = new FormData();
  form.append('model', 'gpt-transcribe');
  form.append('file', new Blob([audio], { type: mime }), `voice.${extension}`);
  let response;
  try {
    response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(120_000)
    });
  } catch { throw httpError(502, '音声認識に接続できませんでした。'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw httpError(502, data.error?.message || '音声を文字にできませんでした。');
  send(res, 200, { text: String(data.text || '') });
}

const mimeTypes = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain' };

async function serveFile(res, file) {
  const data = await fs.readFile(file);
  send(res, 200, data, `${mimeTypes[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== `${host}:${port}`) throw httpError(403, 'このホストからはアクセスできません。');
    if (req.headers.origin && req.headers.origin !== `http://${host}:${port}`) throw httpError(403, 'このページからはアクセスできません。');
    const url = new URL(req.url, `http://${host}:${port}`);
    if (url.pathname === '/api/status' && req.method === 'GET') return send(res, 200, { ...apiSettings.publicStatus, projectName: path.basename(project.root), projectPath: project.root });
    if (url.pathname === '/api/settings' && req.method === 'GET') return send(res, 200, apiSettings.publicStatus);
    if (url.pathname === '/api/settings' && req.method === 'PUT') {
      if (req.headers.origin !== `http://${host}:${port}`) throw httpError(403, 'このページから操作してください。');
      return send(res, 200, await apiSettings.update(await readJson(req)));
    }
    if (url.pathname === '/api/models' && req.method === 'POST') {
      if (req.headers.origin !== `http://${host}:${port}`) throw httpError(403, 'このページから操作してください。');
      const body = await readJson(req);
      const candidate = body.apiKey ? validKey(body.apiKey) : apiSettings.key;
      return send(res, 200, { models: await openaiModels(candidate) });
    }
    if (url.pathname === '/api/settings/check' && req.method === 'POST') {
      if (req.headers.origin !== `http://${host}:${port}`) throw httpError(403, 'このページから操作してください。');
      const body = await readJson(req);
      const candidate = body.apiKey ? validKey(body.apiKey) : apiSettings.key;
      return send(res, 200, await checkOpenaiModel(candidate, body.model || apiSettings.model));
    }
    if (url.pathname === '/api/workspace/choose' && req.method === 'POST') {
      if (choosingWorkspace) throw httpError(409, '保存先の選択画面はすでに開いています。');
      choosingWorkspace = true;
      try {
        const selected = await chooseWorkspaceFolder();
        if (!selected) return send(res, 200, { cancelled: true });
        project = await workspaceLocation.switchTo(selected);
        return send(res, 200, { projectName: path.basename(project.root), projectPath: project.root });
      } finally { choosingWorkspace = false; }
    }
    if (url.pathname === '/api/workspace/open' && req.method === 'POST') {
      if (choosingWorkspace) throw httpError(409, '保存先の選択が完了するまでお待ちください。');
      const body = await readJson(req);
      if (typeof body.path !== 'string' || !path.isAbsolute(body.path.trim())) throw httpError(400, '保存先の絶対パスを入力してください。');
      project = await workspaceLocation.switchTo(body.path.trim());
      return send(res, 200, { projectName: path.basename(project.root), projectPath: project.root });
    }
    if (url.pathname === '/api/tree' && req.method === 'GET') return send(res, 200, { tree: await project.tree(), trash: await project.listTrash() });
    if (url.pathname === '/api/files' && req.method === 'GET') return send(res, 200, { files: await project.files() });
    if (url.pathname === '/api/export' && req.method === 'GET') {
      const archive = await archiveProject(project);
      const filename = `${path.basename(project.root).replaceAll('"', '_')}.zip`;
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${filename}"`, 'Content-Length': archive.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(archive);
    }
    if (url.pathname === '/api/raw' && req.method === 'GET') {
      const name = validatePath(url.searchParams.get('path'));
      return await serveFile(res, (await project.existing(name, 'file')).target);
    }
    if (url.pathname === '/api/file' && req.method === 'GET') {
      return send(res, 200, await project.read(url.searchParams.get('path')));
    }
    if (url.pathname === '/api/file' && req.method === 'PUT') {
      const body = await readJson(req);
      return send(res, 200, await project.write(body.path, body.content, body.expectedVersion, body.create === true));
    }
    if (url.pathname === '/api/entries' && req.method === 'POST') {
      const body = await readJson(req);
      return send(res, 201, await project.create(body.path, body.type));
    }
    if (url.pathname === '/api/entries/move' && req.method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, await project.move(body.source, body.destination));
    }
    if (url.pathname === '/api/entries/trash' && req.method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, await project.trash(body.path));
    }
    if (url.pathname === '/api/entries/restore' && req.method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, await project.restore(body.id));
    }
    if (url.pathname === '/api/assistant' && req.method === 'POST') return await assistant(req, res);
    if (url.pathname === '/api/transcribe' && req.method === 'POST') return await transcribe(req, res);
    if (req.method === 'GET' && url.pathname.startsWith('/preview/')) {
      const name = validatePath(decodeURIComponent(url.pathname.slice('/preview/'.length)));
      return await serveFile(res, (await project.existing(name, 'file')).target);
    }
    if (req.method === 'GET') {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (['index.html', 'app.js', 'editor-bundle.js', 'local-save.js', 'voice-activity.js', 'voice-capture-processor.js', 'styles.css'].includes(file)) return await serveFile(res, path.join(publicRoot, file));
    }
    throw httpError(404, '見つかりません。');
  } catch (error) {
    if (error.code === 'ENOENT') error = httpError(404, 'ファイルが見つかりません。');
    if (error.code === 'EEXIST') error = httpError(409, '同じ名前の項目がすでにあります。');
    fail(res, error);
  }
});

server.listen(port, host, () => console.log(`Vocode is running at http://${host}:${port}`));
