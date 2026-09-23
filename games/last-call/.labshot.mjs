import { chromium } from 'playwright';
const [, , url, out, w = '1500', h = '1500', wait = '9000'] = process.argv;
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
         '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars']
});
const p = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
const logs = [];
p.on('console', (m) => { if (m.type() === 'error') logs.push(`[console.error] ${m.text()} @ ${m.location()?.url || ''}`); });
p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForFunction(() => window.__labReady === true, { timeout: 60000 }).catch(() => logs.push('[warn] labReady timeout'));
await p.waitForTimeout(+wait);
await p.screenshot({ path: out, fullPage: true });
const uniq = [...new Set(logs)];
console.log(uniq.join('\n'));
console.log(`pageerrors=${uniq.filter((l) => l.startsWith('[pageerror]')).length}`);
await b.close();
