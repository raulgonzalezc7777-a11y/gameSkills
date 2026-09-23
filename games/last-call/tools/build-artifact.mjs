// Build a single self-contained page of the game for publishing.
//
//   node tools/build-artifact.mjs <distDir> <out.html>
//
// Run `npx vite build` first. The artifact host wraps its own doctype, head
// and body around the page and only admits scripts from a short CDN list, so
// the bundle, the stylesheet and the fonts are all inlined: nothing is left to
// resolve at runtime, and nothing can silently fall back.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [, , distDir = join(root, 'dist'), out = join(root, 'dist', 'last-call.html')] = process.argv;

const assets = readdirSync(join(distDir, 'assets'));
const css = readFileSync(join(distDir, 'assets', assets.find((f) => f.endsWith('.css'))), 'utf8');
const js = readFileSync(join(distDir, 'assets', assets.find((f) => f.endsWith('.js'))), 'utf8');
if (js.includes('</script')) throw new Error('bundle contains a closing script tag, it cannot be inlined');

const FACES = [
  ['Anton', 400, 'anton-400'],
  ['Barlow Condensed', 400, 'barlow-condensed-400'],
  ['Barlow Condensed', 600, 'barlow-condensed-600'],
  ['Barlow Condensed', 700, 'barlow-condensed-700'],
  ['Rajdhani', 600, 'rajdhani-600'],
  ['Rajdhani', 700, 'rajdhani-700']
];
const fonts = FACES.map(([family, weight, file]) => {
  const b64 = readFileSync(join(root, 'public', 'fonts', `${file}.woff2`)).toString('base64');
  return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
}).join('\n');

const page = `<title>LAST CALL</title>
<meta name="description" content="A third-person drunken bar brawl that runs entirely in the browser." />
<style>
${fonts}
:root{color-scheme:dark;background:#05060a}
${css}
#app{position:fixed;inset:0}
.bars{top:calc(18px + env(safe-area-inset-top, 0px))}
</style>
<div id="app">
  <canvas id="stage"></canvas>
  <div id="ui-root"></div>
</div>
<script type="module">
${js}
</script>
`;
writeFileSync(out, page);
console.log(`wrote ${out} (${(page.length / 1048576).toFixed(2)} MB)`);
