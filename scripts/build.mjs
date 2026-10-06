import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';

await Promise.all([
  ['editor-source.js', 'editor-bundle.js'],
  ['markdown-source.js', 'markdown-bundle.js'],
  ['terminal-source.js', 'terminal-bundle.js'],
].map(([source, bundle]) => build({
  entryPoints: [`public/${source}`],
  outfile: `public/${bundle}`,
  bundle: true,
  minify: true,
  format: 'esm',
})));

await copyFile('node_modules/@xterm/xterm/css/xterm.css', 'public/terminal.css');
