// Capture one frame of the running game. Waits on rendered frames rather than
// wall-clock time, because this environment renders through SwiftShader and a
// heavy scene can take seconds per frame: a fixed timeout would photograph a
// half-composited page and blame the art for it.
import { chromium } from 'playwright';

const [, , url, out, w = '1600', h = '900', budgetMs = '30000', wantFrames = '40'] = process.argv;

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox',
         '--disable-dev-shm-usage', '--hide-scrollbars']
});
const p = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
const logs = [];
p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

const t0 = Date.now();
let frames = 0;
while (Date.now() - t0 < +budgetMs) {
  frames = await p.evaluate(() => window.__frameCount || 0).catch(() => 0);
  if (frames >= +wantFrames) break;
  await p.waitForTimeout(400);
}
const elapsed = (Date.now() - t0) / 1000;

await p.screenshot({ path: out });
console.log(JSON.stringify({ frames, elapsed: +elapsed.toFixed(1), fps: +(frames / elapsed).toFixed(2) }));
const uniq = [...new Set(logs)];
console.log(uniq.slice(0, 20).join('\n'));
console.log(`errors=${uniq.filter((l) => l.startsWith('[pageerror]')).length}`);
await b.close();
