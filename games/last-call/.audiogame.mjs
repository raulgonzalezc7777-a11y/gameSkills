// Integration probe: wires the audio engine into the running game exactly the
// way main.js would, then watches the bus meters while a real match plays.
import { chromium } from 'playwright';
const [, , url, out] = process.argv;
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
         '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--enable-webgl', '--hide-scrollbars']
});
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
p.on('console', (m) => { if (m.type() === 'error') logs.push(`[console.error] ${m.text()} @ ${m.location()?.url || ''}`); });
p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForFunction(() => window.__game && window.__game.match, { timeout: 60000 });

// These are the integration lines, verbatim.
await p.evaluate(async () => {
  const { AudioEngine, installAudioListeners } = await import('/src/audio/index.js');
  const audio = new AudioEngine();
  window.__audio = audio;
  installAudioListeners(audio);
  await audio.init();
  audio.setListener(window.__game.camera);
  audio.music.start();
  const g = window.__game;
  const dir = g.match.director;
  window.__audioHook = setInterval(() => {
    audio.setDrunk(g.match.player.drunk01 * 0.9);
    if (dir) {
      audio.setHype(dir.hype / 100);
      audio.music.setIntensity(0.55 + (dir.hype / 100) * 0.45);
    }
  }, 100);
  window.__beats = 0;
  audio.onBeat(() => { window.__beats++; });
});

const samples = [];
for (let i = 0; i < 14; i++) {
  await p.waitForTimeout(1200);
  samples.push(await p.evaluate(() => {
    const a = window.__audio, g = window.__game;
    return {
      t: +(a.ctx.currentTime).toFixed(1), state: a.ctx.state,
      master: +a.meter('master').toFixed(3), music: +a.meter('music').toFixed(3),
      sfx: +a.meter('sfx').toFixed(3), crowd: +a.meter('crowd').toFixed(3),
      voice: +a.meter('voice').toFixed(3),
      beats: window.__beats, hype: Math.round(g.match.director?.hype ?? 0),
      drunk: +(g.match.player.drunk01).toFixed(2), frames: window.__frameCount
    };
  }));
}
console.log(JSON.stringify(samples, null, 0).replace(/},/g, '},\n'));
const peakSeen = samples.reduce((m, s) => ({
  master: Math.max(m.master, s.master), sfx: Math.max(m.sfx, s.sfx),
  crowd: Math.max(m.crowd, s.crowd), voice: Math.max(m.voice, s.voice), music: Math.max(m.music, s.music)
}), { master: 0, sfx: 0, crowd: 0, voice: 0, music: 0 });
console.log('peaks over the run:', JSON.stringify(peakSeen));
console.log('beats fired:', samples[samples.length - 1].beats, 'over', samples[samples.length - 1].t, 's');
if (out) await p.screenshot({ path: out });
const uniq = [...new Set(logs)].filter((l) => !/favicon/.test(l));
console.log(uniq.slice(0, 15).join('\n'));
console.log(`pageerrors=${uniq.filter((l) => l.startsWith('[pageerror]')).length}`);
await b.close();
