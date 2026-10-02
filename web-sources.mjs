function sourceLink(url, title) {
  if (typeof url !== 'string' || url.length > 2048) return null;
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return { url: parsed.href, title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 160) : parsed.hostname };
  } catch { return null; }
}

export function webSearchReferences(response, limit = 6) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const calls = output.filter(item => item.type === 'web_search_call');
  const sources = [];
  const seen = new Set();
  const add = (url, title) => {
    const source = sourceLink(url, title);
    if (!source || seen.has(source.url) || sources.length >= limit) return;
    seen.add(source.url);
    sources.push(source);
  };
  for (const item of output) {
    if (item.type !== 'message') continue;
    for (const content of item.content || []) {
      for (const annotation of content.annotations || []) {
        if (annotation.type === 'url_citation') add(annotation.url, annotation.title);
      }
    }
  }
  if (!sources.length) {
    for (const call of calls) {
      for (const source of call.action?.sources || []) add(source.url, source.title);
    }
  }
  return { webSearchUsed: calls.length > 0, sources };
}
