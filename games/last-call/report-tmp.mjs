import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage();
const errs = [];
p.on('pageerror', e => errs.push('[pageerror] ' + e.message));
p.on('console', m => { if (m.type()==='error') errs.push('[console] '+m.text()); });
await p.goto('http://localhost:5218/combat-preview.html?sim=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__report, null, { timeout: 60000 });
const ev = await p.evaluate(() => window.__report());
let phase = null;
for (const e of ev) { if (e.phase !== phase) { phase = e.phase; console.log('\n=== ' + phase); } console.log(`  ${e.t.toFixed(2)} ${e.name.padEnd(7)} ${e.text}`); }
console.log('\nerrors=' + errs.length); errs.slice(0,10).forEach(e=>console.log(e));
await b.close();
