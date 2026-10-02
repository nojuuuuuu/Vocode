import test from 'node:test';
import assert from 'node:assert/strict';
import { webSearchReferences } from '../web-sources.mjs';

test('web search citations are limited to unique clickable HTTP sources', () => {
  const response = { output: [
    { type: 'web_search_call', action: { type: 'search', sources: [
      { url: 'https://docs.example.com/guide', title: 'Official guide' },
      { url: 'javascript:alert(1)', title: 'Unsafe' },
      { url: 'https://example.com/other', title: 'Another page' }
    ] } },
    { type: 'message', content: [{ type: 'output_text', annotations: [
      { type: 'url_citation', url: 'https://docs.example.com/guide', title: 'Official guide' }
    ] }] }
  ] };
  assert.deepEqual(webSearchReferences(response), {
    webSearchUsed: true,
    sources: [
      { url: 'https://docs.example.com/guide', title: 'Official guide' }
    ]
  });
  assert.deepEqual(webSearchReferences({ output: response.output.slice(0, 1) }).sources, [
    { url: 'https://docs.example.com/guide', title: 'Official guide' },
    { url: 'https://example.com/other', title: 'Another page' }
  ]);
  assert.deepEqual(webSearchReferences({ output: [{ type: 'message', content: [] }] }), { webSearchUsed: false, sources: [] });
});
