import { validatePath } from './project-files.mjs';

function responseError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function normalizeAssistantResult(result, maxFileBytes) {
  if (!result || !['answer', 'edit'].includes(result.action) || typeof result.reply !== 'string') {
    throw responseError(502, 'AI の応答を読み取れませんでした。もう一度お試しください。');
  }
  const files = [];
  if (result.action === 'edit') {
    if (!Array.isArray(result.files)) throw responseError(502, 'AI の変更案を読み取れませんでした。');
    for (const file of result.files.slice(0, 15)) {
      if (typeof file?.path !== 'string' || typeof file?.content !== 'string') {
        throw responseError(502, 'AI の変更案を読み取れませんでした。');
      }
      const path = validatePath(file.path);
      if (Buffer.byteLength(file.content) > maxFileBytes) {
        throw responseError(413, 'AI の変更案に大きすぎるファイルがあります。');
      }
      files.push({ path, content: file.content });
    }
  }
  return { action: result.action, reply: result.reply, files };
}
