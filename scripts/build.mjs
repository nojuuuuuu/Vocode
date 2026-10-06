import { build } from 'esbuild';

await Promise.all([
  ['editor-source.js', 'editor-bundle.js'],
  ['markdown-source.js', 'markdown-bundle.js'],
].map(([source, bundle]) => build({
  entryPoints: [`public/${source}`],
  outfile: `public/${bundle}`,
  bundle: true,
  minify: true,
  format: 'esm',
})));
