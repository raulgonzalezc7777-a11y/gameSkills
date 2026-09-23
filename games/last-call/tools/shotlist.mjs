// Scripted capture run. Drives the live game through a fixed set of dramatic
// moments and writes one PNG per beat, so a reviewer judges the game the way a
// player sees it rather than judging one arbitrary frame.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = process.env.PORT || '5199';
const OUT = process.argv[2] || './REVIEW/shots/run';
const PREFIX = process.argv[3] || 'shot';
const W = +(process.argv[4] || 1600), H = +(process.argv[5] || 900);

mkdirSync(OUT, { recursive: true });

const BEATS = [
  { id: '01-wide-stance', frames: 10, setup: `(()=>{window.__game.match.tpcam.override=null;})()`,
    note: 'Neutral stance at fighting distance. The establishing shot.' },
  { id: '02-closeup-face', frames: 6,
    setup: `(()=>{const g=window.__game; g.match.tpcam.override={dist:3.0,pitch:0.03,fov:32};})()`,
    note: 'Camera pushed in on the fighters: material and face detail.' },
  { id: '03-impact', frames: 2, freezeAfter: true,
    setup: `(()=>{const g=window.__game,m=g.match;g.match.tpcam.override={dist:3.0,pitch:0.05,fov:44};
      m.player.position.set(-0.6,0,0);m.cpu.position.set(0.55,0,0);
      m.player.attack('hook', m.cpu);})()`,
    note: 'The frame of contact: hit feedback, VFX, camera reaction.' },
  { id: '04-drunk-high', frames: 6,
    setup: `(()=>{const g=window.__game,m=g.match;m.player.drunk=100;m.cpu.drunk=88;
      g.match.tpcam.override={dist:4.0,pitch:0.08,fov:50};})()`,
    note: 'Maximum drunkenness: the signature post FX and the sway.' },
  { id: '05-knockdown', frames: 2, freezeAfter: true,
    setup: `(()=>{const g=window.__game,m=g.match;m.cpu.forceDown('knockdown', m.player);})()`,
    note: 'Knockdown: ragdoll, slow motion, crowd reaction.' },
  { id: '06-venue-wide', frames: 6,
    setup: `(()=>{const g=window.__game;g.match.tpcam.override={dist:11.0,pitch:0.40,fov:56};})()`,
    note: 'The venue as a whole: architecture, lighting design, crowd, depth.' },
  { id: '07-floor-reflection', frames: 6,
    setup: `(()=>{const g=window.__game;g.match.tpcam.override={dist:4.2,pitch:-0.26,fov:48};})()`,
    note: 'Low angle across the floor: reflections and contact shadows.' },
  { id: '08-ko-moment', frames: 2, freezeAfter: true,
    setup: `(()=>{const g=window.__game,m=g.match;m.cpu.forceDown('ko', m.player);
      g.match.tpcam.override={dist:3.4,pitch:0.02,fov:42};})()`,
    note: 'The knockout: the money shot.' }
];

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox',
         '--disable-dev-shm-usage', '--hide-scrollbars']
});
const p = await b.newPage({ viewport: { width: W, height: H } });
const errors = [];
p.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

const Q = process.env.QUALITY || 'high';
await p.goto(`http://localhost:${PORT}/?auto&q=${Q}`, { waitUntil: 'domcontentloaded', timeout: 90000 });

// Software rendering runs at about one frame a second here, so every wait in
// this script counts rendered frames instead of milliseconds. A wall-clock
// wait photographs a half-composited page and then blames the art for it.
const frames = () => p.evaluate(() => window.__frameCount || 0).catch(() => 0);
async function waitFrames(n, budgetMs = 120000) {
  const start = await frames();
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    if ((await frames()) >= start + n) return;
    await p.waitForTimeout(350);
  }
}
await waitFrames(18);
// The capture is a screenshot of the game, not of the tutorial.
await p.evaluate(`(()=>{document.body.classList.add('capture');})()`).catch(() => {});

const manifest = [];
for (const beat of BEATS) {
  // Every beat starts from a known state. Without this reset beat 04's
  // maximum drunk leaked into 05, 07 and 08, and the three frames that should
  // be the cleanest in the packet were the dirtiest.
  try {
    await p.evaluate(`(()=>{const g=window.__game;if(!g)return;
      g.match.player.drunk=35;g.match.cpu.drunk=35;
      g.match.tpcam.override=null;g.time.scale=1;g.time.hitstop=0;g.time.slowmo=0;
      document.body.classList.remove('capture-clean');})()`);
  } catch { /* the page owns its state, a failed reset is not fatal */ }
  if (beat.setup) { try { await p.evaluate(beat.setup); } catch (e) { errors.push(`[setup ${beat.id}] ${e.message}`); } }
  await waitFrames(beat.frames ?? 8);
  if (beat.freezeAfter) {
    // Stop the clock on the dramatic instant instead of racing it.
    await p.evaluate(`(()=>{window.__game.time.scale=0;})()`).catch(() => {});
    await waitFrames(1);
  }
  const file = join(OUT, `${PREFIX}-${beat.id}.png`);
  await p.screenshot({ path: file });
  manifest.push({ id: beat.id, file, note: beat.note });
  process.stdout.write(`captured ${file}\n`);
}

console.log('\n--- ERRORS (' + errors.length + ') ---');
console.log([...new Set(errors)].slice(0, 25).join('\n'));
console.log('\n--- MANIFEST ---');
console.log(JSON.stringify(manifest, null, 2));
await b.close();
// A capture with errors is not a capture: fail loudly so nobody reviews it.
process.exit(errors.length ? 1 : 0);
