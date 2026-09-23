// Drive the real game with real key presses and report what happened. A
// scripted takeHit() proves the art; this proves the game is playable.
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:5199/?q=low';
const seconds = +(process.argv[3] || 90);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 800, height: 450 } });
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });
await p.goto(url, { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 120; i++) { if ((await p.evaluate(() => window.__frameCount || 0)) > 3) break; await p.waitForTimeout(500); }
await p.click('#title');                       // a real click starts the fight
const snap = () => p.evaluate(() => {
  const m = window.__game.match;
  const d = m.director;
  return { t: +window.__game.time.elapsed.toFixed(1), round: d.round, phase: d.phase, clock: +d.clock.toFixed(1),
    pHP: +m.player.health.toFixed(1), cHP: +m.cpu.health.toFixed(1), buzz: +m.player.drunk.toFixed(0),
    hype: +d.hype.toFixed(0), wins: d.wins.join('-'), dist: +m.player.position.distanceTo(m.cpu.position).toFixed(2) };
});
console.log('start', JSON.stringify(await snap()));
const keys = ['KeyJ', 'KeyK', 'KeyJ', 'KeyU', 'KeyI', 'KeyL'];
const t0 = Date.now();
let k = 0;
while ((Date.now() - t0) / 1000 < seconds) {
  // Close the distance, then throw a string. Sprinkle a drink in.
  const s = await snap();
  if (s.dist > 1.4) { await p.keyboard.down('KeyW'); await p.waitForTimeout(900); await p.keyboard.up('KeyW'); }
  await p.keyboard.press(keys[k++ % keys.length]);
  if (k % 9 === 0) await p.keyboard.press('KeyE');
  await p.waitForTimeout(700);
  if (k % 6 === 0) console.log('  ', JSON.stringify(await snap()));
}
console.log('end', JSON.stringify(await snap()));
console.log('errors', errors.length, [...new Set(errors)].slice(0, 5).join(' | '));
await b.close();
