import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from '../public/markdown-source.js';

test('assistant answers render headings, lists, emphasis, code, and links', () => {
  const html = renderMarkdown('### 役割\n\n- `main.tsx`：**起動**\n- `App.tsx`：画面\n\n```tsx\nconst App = () => <main />;\n```\n\n[資料](https://example.com/docs)');
  assert.match(html, /<h3>役割<\/h3>/);
  assert.match(html, /<ul>\s*<li><code>main\.tsx<\/code>：<strong>起動<\/strong><\/li>/);
  assert.match(html, /<pre><code class="language-tsx">const App = \(\) =&gt; &lt;main \/&gt;;/);
  assert.match(html, /<a href="https:\/\/example\.com\/docs" target="_blank" rel="noopener noreferrer">資料<\/a>/);
});

test('model supplied HTML and unsafe links cannot create active elements', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n[実行](javascript:alert(1)) [認証情報](https://u:p@example.com) ![画像](https://example.com/track.png)');
  assert.doesNotMatch(html, /<script|<img|<a\b/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /画像/);
});
