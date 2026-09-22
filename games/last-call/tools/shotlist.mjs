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
  { id: '01-wide-stance', wait: 3500, setup: null,
    note: 'Neutral stance at fighting distance. The establishing shot.' },
  { id: '02-closeup-face', wait: 900,
    setup: `(()=>{const g=window.__game; g.match.tpcam.dist=1.5; g.match.tpcam.pitch=0.02;})()`,
    note: 'Camera pushed in on the fighters: material and face detail.' },
  { id: '03-impact', wait: 1200,
    setup: `(()=>{const g=window.__game,m=g.match;g.match.tpcam.dist=3.2;
      m.player.position.set(-0.6,0,0);m.cpu.position.set(0.55,0,0);
      m.player.attack('hook');})()`,
    note: 'The frame of contact: hit feedback, VFX, camera reaction.' },
  { id: '04-drunk-high', wait: 1400,
    setup: `(()=>{const g=window.__game,m=g.match;m.player.drunk=100;m.cpu.drunk=88;
      g.match.tpcam.dist=4.2;})()`,
    note: 'Maximum drunkenness: the signature post FX and the sway.' },
  { id: '05-knockdown', wait: 1800,
    setup: `(()=>{const g=window.__game,m=g.match;m.cpu.takeHit(m.player,{dmg:34,push:5,reach:2,part:'head',stam:0},'head');})()`,
    note: 'Knockdown: ragdoll, slow motion, crowd reaction.' },
  { id: '06-venue-wide', wait: 1200,
    setup: `(()=>{const g=window.__game;g.match.tpcam.dist=9.5;g.match.tpcam.pitch=0.34;})()`,
    note: 'The venue as a whole: architecture, lighting design, crowd, depth.' },
  { id: '07-floor-reflection', wait: 1000,
    setup: `(()=>{const g=window.__game;g.match.tpcam.dist=4.0;g.match.tpcam.pitch=-0.24;})()`,
    note: 'Low angle across the floor: reflections and contact shadows.' },
  { id: '08-ko-moment', wait: 2200,
    setup: `(()=>{const g=window.__game,m=g.match;m.cpu.health=1;
      m.cpu.takeHit(m.player,{dmg:50,push:7,reach:2,part:'head',stam:0},'head');
      g.match.tpcam.dist=3.4;})()`,
    note: 'The knockout: the money shot.' }
];

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox',
         '--disable-dev-shm-usage', '--hide-scrollbars']
});
const p = await b.newPage({ viewport: { width: W, height: H } });
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

await p.goto(`http://localhost:${PORT}/?auto`, { waitUntil: 'networkidle', timeout: 90000 });
await p.waitForTimeout(6000);

const manifest = [];
for (const beat of BEATS) {
  if (beat.setup) { try { await p.evaluate(beat.setup); } catch (e) { errors.push(`[setup ${beat.id}] ${e.message}`); } }
  await p.waitForTimeout(beat.wait);
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
process.exit(errors.length ? 0 : 0);
