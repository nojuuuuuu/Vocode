import { validatePath } from './project-files.mjs';

function responseError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function normalizeAssistantResult(result, maxFileBytes) {
  if (!result || !['answer', 'edit'].includes(result.action) || typeof result.reply !== 'string') {
    throw responseError(502, 'AI の応答を読み取れませんでした。もう一度お試しください。');
  }
  const files = [];
  let skippedProtectedPath = false;
  if (result.action === 'edit') {
    if (!Array.isArray(result.files)) throw responseError(502, 'AI の変更案を読み取れませんでした。');
    for (const file of result.files.slice(0, 15)) {
      if (typeof file?.path !== 'string' || typeof file?.content !== 'string') {
        throw responseError(502, 'AI の変更案を読み取れませんでした。');
      }
      let path;
      try { path = validatePath(file.path); }
      catch (error) {
        if (error.status !== 400) throw error;
        skippedProtectedPath = true;
        continue;
      }
      if (Buffer.byteLength(file.content) > maxFileBytes) {
        throw responseError(413, 'AI の変更案に大きすぎるファイルがあります。');
      }
      files.push({ path, content: file.content });
    }
  }
  const notice = skippedProtectedPath
    ? '\n\n一部の変更案は保護された場所を指定していたため除外しました。`.env` などの秘密情報を含むファイルはターミナルで設定してください。'
    : '';
  return { action: files.length ? result.action : 'answer', reply: result.reply + notice, files };
}
