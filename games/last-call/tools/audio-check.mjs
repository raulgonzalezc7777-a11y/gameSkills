// Numerical verification for the audio system. Every sound is rendered through
// an OfflineAudioContext in a headless page, the resulting Float32Array is
// measured, and the measurements are asserted here. You cannot listen to a CI
// run, so the only honest test is the waveform itself.
//
// Usage: node tools/audio-check.mjs [http://localhost:5217]
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:5217';

// Design intent, in seconds. A sound that runs outside its window is either
// clipped short or smearing into the next one.
const DESIGN = {
  jab:         { dur: [0.07, 0.22], peak: [0.05, 0.99] },
  cross:       { dur: [0.10, 0.30], peak: [0.05, 0.99] },
  hook:        { dur: [0.13, 0.40], peak: [0.05, 0.99] },
  uppercut:    { dur: [0.18, 0.58], peak: [0.05, 0.99] },
  kick:        { dur: [0.14, 0.46], peak: [0.05, 0.99] },
  block:       { dur: [0.07, 0.30], peak: [0.03, 0.99] },
  parry:       { dur: [0.22, 0.95], peak: [0.03, 0.99] },
  whiff:       { dur: [0.10, 0.42], peak: [0.01, 0.99] },
  bodyfall:    { dur: [0.28, 1.00], peak: [0.05, 0.99] },
  headhit:     { dur: [0.20, 0.70], peak: [0.04, 0.99] },
  glassbreak:  { dur: [0.15, 0.70], peak: [0.04, 0.99] },
  bottleclink: { dur: [0.06, 0.50], peak: [0.02, 0.99] },
  footstep:    { dur: [0.03, 0.28], peak: [0.01, 0.99] },
  grunt:       { dur: [0.12, 0.62], peak: [0.02, 0.99] },
  exhale:      { dur: [0.15, 0.70], peak: [0.005, 0.99] },
  gulp:        { dur: [0.25, 0.90], peak: [0.02, 0.99] },
  crowdshout:  { dur: [0.35, 1.50], peak: [0.02, 0.99] },
  bell:        { dur: [0.60, 2.30], peak: [0.03, 0.99] }
};

const RENDER_SECONDS = 3.2;

function page_measure() {
  // --- analysis helpers, all running inside the page -------------------
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
  }

  function metrics(sig, sr) {
    let peak = 0, sum = 0;
    for (let i = 0; i < sig.length; i++) {
      const a = Math.abs(sig[i]);
      if (a > peak) peak = a;
      sum += sig[i] * sig[i];
    }
    const rms = Math.sqrt(sum / sig.length);
    // Duration: first sample above 1% of peak to the last one, which is what
    // the ear calls the length of the sound.
    const thr = peak * 0.01;
    let first = -1, last = -1;
    for (let i = 0; i < sig.length; i++) if (Math.abs(sig[i]) > thr) { first = i; break; }
    for (let i = sig.length - 1; i >= 0; i--) if (Math.abs(sig[i]) > thr) { last = i; break; }
    const dur = first < 0 ? 0 : (last - first) / sr;

    // Decay: energy in the last third of the sound against the first third.
    let e0 = 0, e1 = 0, n0 = 0, n1 = 0;
    if (first >= 0 && last > first) {
      const len = last - first;
      const a1 = Math.floor(first + len / 3);
      const b0 = Math.ceil(last - len / 3);
      for (let i = first; i <= a1; i++) { e0 += sig[i] * sig[i]; n0++; }
      for (let i = b0; i <= last; i++) { e1 += sig[i] * sig[i]; n1++; }
    }
    const decayRatio = n0 && n1 && e0 > 0 ? Math.sqrt((e1 / n1) / (e0 / n0)) : 1;

    // Energy weighted spectral centroid over overlapping frames.
    const N = 2048;
    const re = new Float32Array(N), im = new Float32Array(N);
    let cSum = 0, eSum = 0, hfSum = 0;
    const start = Math.max(0, first);
    const end = Math.min(sig.length, last + 1);
    for (let o = start; o + N < end; o += N / 2) {
      re.fill(0); im.fill(0);
      for (let i = 0; i < N; i++) {
        const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
        re[i] = sig[o + i] * w;
      }
      fft(re, im);
      for (let k = 1; k < N / 2; k++) {
        const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        const f = k * sr / N;
        cSum += f * mag * mag;
        eSum += mag * mag;
        if (f > 3000) hfSum += mag * mag;
      }
    }
    // Very short sounds fit in fewer than one frame; measure the one frame we
    // can place rather than reporting nothing.
    if (eSum === 0 && end - start > 64) {
      re.fill(0); im.fill(0);
      const n = Math.min(N, end - start);
      for (let i = 0; i < n; i++) {
        const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
        re[i] = sig[start + i] * w;
      }
      fft(re, im);
      for (let k = 1; k < N / 2; k++) {
        const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        cSum += (k * sr / N) * mag * mag;
        eSum += mag * mag;
      }
    }
    const centroid = eSum > 0 ? cSum / eSum : 0;
    const hfRatio = eSum > 0 ? hfSum / eSum : 0;

    // Coarse envelope for the report, 48 buckets of peak amplitude.
    const env = [];
    const bucket = Math.max(1, Math.floor(sig.length / 48));
    for (let b = 0; b < 48; b++) {
      let m = 0;
      for (let i = b * bucket; i < Math.min(sig.length, (b + 1) * bucket); i++) {
        const a = Math.abs(sig[i]); if (a > m) m = a;
      }
      env.push(+m.toFixed(4));
    }
    return { peak, rms, dur, decayRatio, centroid, hfRatio, env, onset: first / sr };
  }

  function highpassed(sig, sr, fc) {
    const a = 1 - Math.exp(-2 * Math.PI * fc / sr);
    const out = new Float32Array(sig.length);
    let y = 0;
    for (let i = 0; i < sig.length; i++) { y += a * (sig[i] - y); out[i] = sig[i] - y; }
    return out;
  }

  function lowpassed(sig, sr, fc) {
    const a = 1 - Math.exp(-2 * Math.PI * fc / sr);
    const out = new Float32Array(sig.length);
    let y = 0;
    for (let i = 0; i < sig.length; i++) { y += a * (sig[i] - y); out[i] = y; }
    return out;
  }

  // Counts transients rather than energy. A doubled pattern that pumps harder
  // can be quieter in RMS while being obviously busier, which is the whole
  // point of a sidechained club track.
  function onsets(sig, sr) {
    const hop = Math.floor(sr * 0.01);
    const n = Math.floor(sig.length / hop);
    const e = new Float32Array(n);
    let mx = 1e-9;
    for (let f = 0; f < n; f++) {
      let s2 = 0;
      for (let i = f * hop; i < (f + 1) * hop; i++) s2 += sig[i] * sig[i];
      e[f] = Math.sqrt(s2 / hop);
      if (e[f] > mx) mx = e[f];
    }
    let count = 0;
    for (let f = 2; f < n - 1; f++) {
      if (e[f] > e[f - 1] * 1.35 && e[f] >= e[f + 1] && e[f] > mx * 0.12) count++;
    }
    return count;
  }

  return { fft, metrics, lowpassed, highpassed, onsets };
}

async function run() {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
           '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/favicon/i.test(m.location()?.url || '') || /favicon/i.test(m.text())) return;   // the lab has no icon, and needs none
    errors.push(`[console.error] ${m.text()}`);
  });

  await page.goto(`${BASE}/audio-preview.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.addScriptTag({ content: `window.__an = (${page_measure.toString()})();` });

  const names = Object.keys(DESIGN);
  const result = await page.evaluate(async ({ base, names, seconds }) => {
    const mod = await import(`${base}/src/audio/index.js`);
    const { Mixer, SfxKit, CrowdBed, MusicEngine } = mod;
    const SR = 44100;
    const out = { sounds: {}, music: null, crowd: null };

    async function render(build, secs) {
      const ctx = new OfflineAudioContext(2, Math.floor(SR * secs), SR);
      const mixer = new Mixer(ctx);
      const kit = new SfxKit(mixer);
      await build(ctx, mixer, kit);
      const buf = await ctx.startRendering();
      const L = buf.getChannelData(0), R = buf.getChannelData(1);
      const mono = new Float32Array(L.length);
      for (let i = 0; i < L.length; i++) mono[i] = (L[i] + R[i]) * 0.5;
      return { mono, L, R, sr: SR };
    }

    for (const name of names) {
      // Wet pass: the shipping chain, reverb and limiter included. This is the
      // one that may not clip.
      const wet = await render(async (ctx, mixer, kit) => {
        kit.play(name, { when: 0.02 });
      }, seconds);
      // Dry pass: sends muted, so duration and centroid describe the sound and
      // not the room it is played in.
      const dry = await render(async (ctx, mixer, kit) => {
        for (const k in mixer.buses) {
          mixer.buses[k]._revSend.gain.value = 0;
          mixer.buses[k]._slapSend.gain.value = 0;
        }
        kit.play(name, { when: 0.02 });
      }, seconds);
      const w = window.__an.metrics(wet.mono, wet.sr);
      const d = window.__an.metrics(dry.mono, dry.sr);
      // Stereo width, as a sanity check that panning is wired at all.
      let diff = 0;
      for (let i = 0; i < wet.L.length; i += 7) diff += Math.abs(wet.L[i] - wet.R[i]);
      out.sounds[name] = {
        peak: w.peak, rms: w.rms, dur: d.dur, decayRatio: d.decayRatio,
        centroid: d.centroid, env: d.env, onset: d.onset, stereoDiff: diff / (wet.L.length / 7)
      };
    }

    // Panning: the same sound to the left and to the right of the listener.
    const panned = await render(async (ctx, mixer, kit) => {
      mixer._lp[0] = 0; mixer._lp[1] = 1.6; mixer._lp[2] = 0;
      mixer._lr[0] = 1; mixer._lr[1] = 0; mixer._lr[2] = 0;
      mixer.syncListener = () => {};
      kit.play('jab', { when: 0.02, position: { x: -4, y: 1.5, z: 0 } });
      kit.play('jab', { when: 1.02, position: { x: 4, y: 1.5, z: 0 } });
      kit.play('jab', { when: 2.02, position: { x: 0, y: 1.5, z: 16 } });
    }, seconds);
    const seg = (buf, a, b) => { let p = 0; for (let i = Math.floor(a * SR); i < Math.floor(b * SR); i++) { const v = Math.abs(buf[i]); if (v > p) p = v; } return p; };
    out.pan = {
      leftL: seg(panned.L, 0.02, 0.6), leftR: seg(panned.R, 0.02, 0.6),
      rightL: seg(panned.L, 1.02, 1.6), rightR: seg(panned.R, 1.02, 1.6),
      near: seg(panned.mono, 0.02, 0.6), far: seg(panned.mono, 2.02, 2.6)
    };

    // Drunk filter: the same punch sober and legless. High end must collapse.
    const sober = await render(async (ctx, mixer, kit) => { mixer.setDrunk(0); kit.play('jab', { when: 1.6 }); }, 2.6);
    const legless = await render(async (ctx, mixer, kit) => { mixer.setDrunk(1); kit.play('jab', { when: 1.6 }); }, 2.6);
    out.drunk = {
      soberCentroid: window.__an.metrics(sober.mono, SR).centroid,
      drunkCentroid: window.__an.metrics(legless.mono, SR).centroid,
      soberPeak: window.__an.metrics(sober.mono, SR).peak,
      drunkPeak: window.__an.metrics(legless.mono, SR).peak,
      soberHf: window.__an.metrics(sober.mono, SR).hfRatio,
      drunkHf: window.__an.metrics(legless.mono, SR).hfRatio
    };

    // Damage scaling: the same attack at a jab's damage and at a Last Call
    // haymaker's. Different energy, still the same family.
    const soft = await render(async (ctx, mixer, kit) => { kit.play('hook', { when: 0.02, damage: 6 }); }, 1.5);
    const hard = await render(async (ctx, mixer, kit) => { kit.play('hook', { when: 0.02, damage: 28 }); }, 1.5);
    out.damage = {
      softRms: window.__an.metrics(soft.mono, SR).rms,
      hardRms: window.__an.metrics(hard.mono, SR).rms
    };

    // Two consecutive jabs must not be bit identical: procedural means varied.
    const twice = await render(async (ctx, mixer, kit) => {
      kit.play('jab', { when: 0.02 }); kit.play('jab', { when: 1.02 });
    }, 2.2);
    let same = 0, n = 0;
    const off = Math.floor(SR);
    for (let i = Math.floor(0.02 * SR); i < Math.floor(0.5 * SR); i++) {
      if (Math.abs(twice.mono[i] - twice.mono[i + off]) < 1e-6) same++;
      n++;
    }
    out.variation = { identicalFraction: same / n };

    // Crowd: bed plus a roar. Must rise, peak, then decay raggedly.
    const crowd = await render(async (ctx, mixer, kit) => {
      const bed = new CrowdBed(mixer, kit);
      bed.start(0);
      bed.setHype(0.85);
      bed.hype = 0.85;
      bed.schedule(0, 3.0);
      bed.surge('peak', 1.2);
    }, 4.0);
    out.crowd = window.__an.metrics(crowd.mono, SR);

    // Music: four bars, offline, no timer.
    const music = await render(async (ctx, mixer, kit) => {
      const m = new MusicEngine(mixer, { offline: true });
      m.setIntensity(0.9);
      m.start(0.02);
      m.scheduleUntil(8.2);
    }, 8.2);
    const mm = window.__an.metrics(music.mono, SR);
    // Onset grid: peak energy per 20 ms window, then check the four-on-the-
    // floor kick actually lands on the 126 BPM beat.
    const beat = 60 / 126;
    const low = window.__an.lowpassed(music.mono, SR, 95);
    const at = (t) => { let p = 0; for (let i = Math.floor(t * SR); i < Math.floor((t + 0.045) * SR); i++) { const v = Math.abs(low[i]); if (v > p) p = v; } return p; };
    const onBeat = [], offBeat = [];
    for (let b = 1; b < 16; b++) { onBeat.push(at(0.02 + b * beat)); offBeat.push(at(0.02 + (b + 0.5) * beat)); }
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    out.music = { peak: mm.peak, rms: mm.rms, centroid: mm.centroid, env: mm.env, onBeat: avg(onBeat), offBeat: avg(offBeat) };

    // Last Call variation must be busier than the normal bar.
    const lc = await render(async (ctx, mixer, kit) => {
      const m = new MusicEngine(mixer, { offline: true });
      m.setIntensity(1); m.lastCall(true); m.start(0.02); m.scheduleUntil(4.2);
    }, 4.2);
    const norm = await render(async (ctx, mixer, kit) => {
      const m = new MusicEngine(mixer, { offline: true });
      m.setIntensity(0.7); m.start(0.02); m.scheduleUntil(4.2);
    }, 4.2);
    out.lastCall = {
      lcOnsets: window.__an.onsets(window.__an.highpassed(lc.mono, SR, 3500), SR),
      normOnsets: window.__an.onsets(window.__an.highpassed(norm.mono, SR, 3500), SR),
      lcRms: window.__an.metrics(lc.mono, SR).rms,
      normRms: window.__an.metrics(norm.mono, SR).rms
    };
    return out;
  }, { base: BASE, names, seconds: RENDER_SECONDS });

  // --- assertions -------------------------------------------------------
  const rows = [];
  let failures = 0;
  const check = (label, ok, detail) => {
    rows.push({ label, ok, detail });
    if (!ok) failures++;
    return ok;
  };

  for (const name of names) {
    const m = result.sounds[name];
    const d = DESIGN[name];
    const notes = [];
    let ok = true;
    if (!(m.peak > d.peak[0])) { ok = false; notes.push('too quiet'); }
    if (!(m.peak < 1.0)) { ok = false; notes.push('CLIPS'); }
    if (!(m.rms > 1e-5)) { ok = false; notes.push('silent'); }
    if (!(m.dur >= d.dur[0] && m.dur <= d.dur[1])) { ok = false; notes.push(`dur ${m.dur.toFixed(3)} outside ${d.dur[0]}..${d.dur[1]}`); }
    if (!(m.decayRatio < 0.75)) { ok = false; notes.push(`no decay (${m.decayRatio.toFixed(2)})`); }
    if (!(m.centroid > 40)) { ok = false; notes.push('no spectrum'); }
    rows.push({
      label: name, ok,
      detail: `peak ${m.peak.toFixed(3)}  rms ${m.rms.toFixed(4)}  dur ${m.dur.toFixed(3)}s  decay ${m.decayRatio.toFixed(2)}  centroid ${Math.round(m.centroid)}Hz${notes.length ? '  <- ' + notes.join(', ') : ''}`
    });
    if (!ok) failures++;
  }

  const S = result.sounds;
  check('jab vs uppercut are different sounds',
    S.jab.centroid > S.uppercut.centroid * 1.25,
    `jab ${Math.round(S.jab.centroid)}Hz vs uppercut ${Math.round(S.uppercut.centroid)}Hz (need 1.25x)`);
  check('jab is shorter than uppercut',
    S.jab.dur < S.uppercut.dur,
    `${S.jab.dur.toFixed(3)}s vs ${S.uppercut.dur.toFixed(3)}s`);
  check('attack brightness ranks jab > cross > hook > uppercut',
    S.jab.centroid > S.cross.centroid && S.cross.centroid > S.hook.centroid && S.hook.centroid > S.uppercut.centroid,
    [S.jab, S.cross, S.hook, S.uppercut].map((x) => Math.round(x.centroid)).join(' > '));
  check('parry rings brighter than a hook',
    S.parry.centroid > S.hook.centroid,
    `${Math.round(S.parry.centroid)}Hz vs ${Math.round(S.hook.centroid)}Hz`);
  check('bodyfall is darker than a jab',
    S.bodyfall.centroid < S.jab.centroid,
    `${Math.round(S.bodyfall.centroid)}Hz vs ${Math.round(S.jab.centroid)}Hz`);
  check('glass break is the brightest impact',
    S.glassbreak.centroid > S.kick.centroid,
    `${Math.round(S.glassbreak.centroid)}Hz vs ${Math.round(S.kick.centroid)}Hz`);
  check('grunt and exhale differ (voiced vs unvoiced)',
    Math.abs(S.grunt.centroid - S.exhale.centroid) > 100,
    `${Math.round(S.grunt.centroid)}Hz vs ${Math.round(S.exhale.centroid)}Hz`);

  const p = result.pan;
  check('pan: source on the left is louder in L',
    p.leftL > p.leftR * 1.4, `L ${p.leftL.toFixed(3)} vs R ${p.leftR.toFixed(3)}`);
  check('pan: source on the right is louder in R',
    p.rightR > p.rightL * 1.4, `L ${p.rightL.toFixed(3)} vs R ${p.rightR.toFixed(3)}`);
  check('distance attenuation: 16 m is quieter than 4 m',
    p.far < p.near * 0.6, `near ${p.near.toFixed(3)} vs far ${p.far.toFixed(3)}`);

  check('drunk filter kills the top end',
    result.drunk.drunkHf < result.drunk.soberHf * 0.4,
    `energy above 3 kHz: ${(result.drunk.soberHf * 100).toFixed(2)}% sober vs ${(result.drunk.drunkHf * 100).toFixed(2)}% legless`);
  check('drunk mix is louder, not just darker',
    result.drunk.drunkPeak > result.drunk.soberPeak,
    `sober peak ${result.drunk.soberPeak.toFixed(3)} vs drunk ${result.drunk.drunkPeak.toFixed(3)}`);

  check('damage scales the impact',
    result.damage.hardRms > result.damage.softRms * 1.2,
    `rms ${result.damage.softRms.toFixed(4)} at 6 dmg vs ${result.damage.hardRms.toFixed(4)} at 28`);

  check('two jabs are not the same sound',
    result.variation.identicalFraction < 0.5,
    `${(result.variation.identicalFraction * 100).toFixed(1)}% identical samples`);

  const c = result.crowd;
  check('crowd bed plus roar is audible and decays',
    c.peak > 0.02 && c.peak < 1.0 && c.decayRatio < 0.95,
    `peak ${c.peak.toFixed(3)}  decay ${c.decayRatio.toFixed(2)}  centroid ${Math.round(c.centroid)}Hz`);

  const mu = result.music;
  check('music renders, does not clip',
    mu.peak > 0.05 && mu.peak < 1.0, `peak ${mu.peak.toFixed(3)}  rms ${mu.rms.toFixed(4)}`);
  check('kick lands on the 126 BPM grid',
    mu.onBeat > mu.offBeat * 1.15,
    `on-beat ${mu.onBeat.toFixed(3)} vs off-beat ${mu.offBeat.toFixed(3)}`);
  check('Last Call is busier than the normal bar',
    result.lastCall.lcOnsets > result.lastCall.normOnsets * 1.2,
    `${result.lastCall.normOnsets} onsets normally vs ${result.lastCall.lcOnsets} at Last Call`);

  // --- report -----------------------------------------------------------
  const w = Math.max(...rows.map((r) => r.label.length)) + 2;
  console.log('\nLAST CALL audio check');
  console.log('='.repeat(96));
  for (const r of rows) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(w)} ${r.detail}`);
  }
  console.log('='.repeat(96));
  console.log(`${rows.length - failures}/${rows.length} passed, ${failures} failed`);
  if (errors.length) {
    console.log('\nPage errors:');
    for (const e of [...new Set(errors)].slice(0, 20)) console.log('  ' + e);
  }
  console.log(`pageerrors=${errors.filter((e) => e.startsWith('[pageerror]')).length}`);

  if (process.env.AUDIO_CHECK_JSON) {
    const fs = await import('node:fs');
    fs.writeFileSync(process.env.AUDIO_CHECK_JSON, JSON.stringify(result, null, 1));
  }

  await browser.close();
  process.exit(failures > 0 || errors.length > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
