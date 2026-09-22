// Blind A/B compositor. Takes two PNGs, randomises which one lands on the left,
// draws them side by side with neutral "A" and "B" labels, and writes the key
// to a separate file the reviewer is not given. This is how a comparison stays
// honest: the judge cannot know which build they are praising.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const [, , leftPath, rightPath, outPath, keyPath] = process.argv;
if (!leftPath || !rightPath || !outPath) {
  console.error('usage: node tools/compare.mjs <img1> <img2> <out.png> [key.json]');
  process.exit(1);
}

const b64 = (p) => 'data:image/png;base64,' + readFileSync(p).toString('base64');
const flip = Math.random() < 0.5;
const A = flip ? rightPath : leftPath;
const B = flip ? leftPath : rightPath;

const html = `<!doctype html><html><body style="margin:0;background:#0b0b0e">
<div style="display:flex;gap:4px;padding:4px">
  <div style="position:relative;flex:1">
    <img src="${b64(A)}" style="width:100%;display:block">
    <div style="position:absolute;top:10px;left:14px;font:700 34px system-ui;color:#fff;
      background:rgba(0,0,0,.65);padding:2px 16px;border-radius:4px">A</div>
  </div>
  <div style="position:relative;flex:1">
    <img src="${b64(B)}" style="width:100%;display:block">
    <div style="position:absolute;top:10px;left:14px;font:700 34px system-ui;color:#fff;
      background:rgba(0,0,0,.65);padding:2px 16px;border-radius:4px">B</div>
  </div>
</div></body></html>`;

const br = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--hide-scrollbars']
});
const p = await br.newPage({ viewport: { width: 2400, height: 700 } });
await p.setContent(html);
await p.waitForTimeout(400);
const el = await p.$('div');
await el.screenshot({ path: outPath });
await br.close();

if (keyPath) writeFileSync(keyPath, JSON.stringify({ A, B }, null, 2));
console.log(`composite written to ${outPath}`);
if (keyPath) console.log(`key written to ${keyPath} (do not show this to the judge)`);
