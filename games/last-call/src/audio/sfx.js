import { clamp, clamp01, lerp } from '../core/math.js';
import { makeRng, hashString } from '../core/rng.js';

// Every sound in LAST CALL is synthesized here. There are no samples, for the
// same reason there are no textures on disk: a generated impact can vary on
// every hit, and four bundled punch samples cannot. A punch is built from four
// layers that a real punch actually has, and each layer is scaled separately
// by the damage in the event, so a jab and an uppercut are different sounds
// rather than one sound at two volumes.
//
//   1. transient  a few milliseconds of bright noise, the knuckle contact
//   2. thump      a sine dropping fast in pitch, the mass behind it
//   3. slap       a filtered noise burst, skin and cloth
//   4. sub        a long low sine, the weight you feel more than hear
//
// The kit owns a deterministic rng so a seeded replay sounds identical, and it
// never allocates a buffer per voice: noise comes from the mixer's shared bed.

const SFX_SEED = 0xb4b1e5;
const MIN = 0.0001;   // exponentialRamp cannot reach zero

// Vowel formant tables, in Hz. Three bandpass filters in parallel over a
// buzzy source is the cheapest thing that reads as a human voice.
const VOWELS = {
  ah: [730, 1090, 2440],
  uh: [520, 1190, 2390],
  oh: [570, 840, 2410],
  eh: [530, 1840, 2480],
  ee: [270, 2290, 3010]
};
const FORMANT_GAIN = [1, 0.52, 0.26];

// Attack-decay on a gain param. Exponential, because loudness is.
function adsr(param, t, peak, a, d, hold = 0) {
  const p = Math.max(MIN * 2, peak);
  param.setValueAtTime(MIN, t);
  param.exponentialRampToValueAtTime(p, t + Math.max(0.0005, a));
  if (hold > 0) param.setValueAtTime(p, t + a + hold);
  param.exponentialRampToValueAtTime(MIN, t + a + hold + Math.max(0.005, d));
  param.setValueAtTime(0, t + a + hold + d + 0.002);
  return a + hold + d + 0.002;
}

export class SfxKit {
  constructor(mixer, seed = SFX_SEED) {
    this.mixer = mixer;
    this.ctx = mixer.ctx;
    this.r = makeRng(seed);
    this._pan = { pan: 0, gain: 1, dist: 0 };
    // Voices retired lazily on the next play instead of on a timer, so a busy
    // combo never queues dozens of setTimeouts.
    this._live = [];
    this._voiceCap = 42;
  }

  // Builds the per-voice tail of the graph: gain, stereo pan, bus. Returns the
  // node every layer connects into.
  _head(busName, t, opts, baseGain) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const p = ctx.createStereoPanner();
    let vol = baseGain * (opts.volume ?? 1);
    if (opts.position) {
      const s = this.mixer.panFor(opts.position, this._pan);
      p.pan.setValueAtTime(s.pan, t);
      vol *= s.gain;
    } else {
      p.pan.setValueAtTime(clamp(opts.pan ?? 0, -1, 1), t);
    }
    g.gain.value = Math.max(0, vol);
    g.connect(p);
    p.connect(this.mixer.bus(busName));
    return g;
  }

  _retire(now) {
    const live = this._live;
    for (let i = live.length - 1; i >= 0; i--) {
      if (live[i].t <= now) {
        try { live[i].g.disconnect(); live[i].p.disconnect(); } catch (e) { /* already gone */ }
        live[i] = live[live.length - 1];
        live.pop();
      }
    }
  }

  // --- primitives -------------------------------------------------------

  tone(dest, t, o) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    const f0 = Math.max(8, o.f0);
    osc.frequency.setValueAtTime(f0, t);
    if (o.f1 && o.f1 !== f0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(8, o.f1), t + (o.fTime ?? o.d * 0.55));
    }
    if (o.detune) osc.detune.value = o.detune;
    const g = ctx.createGain();
    const len = adsr(g.gain, t, o.peak, o.a ?? 0.0015, o.d, o.hold ?? 0);
    osc.connect(g);
    if (o.filter) { g.connect(o.filter); } else { g.connect(dest); }
    osc.start(t);
    osc.stop(t + len + 0.02);
    osc.onended = () => { osc.disconnect(); g.disconnect(); };
    return len;
  }

  noise(dest, t, o) {
    const ctx = this.ctx;
    const src = this.mixer.noiseSource(o.rate ?? 1);
    const g = ctx.createGain();
    let node = g;
    let filt = null;
    if (o.type !== 'none') {
      filt = ctx.createBiquadFilter();
      filt.type = o.type || 'bandpass';
      filt.frequency.setValueAtTime(Math.max(20, o.f0), t);
      if (o.f1 && o.f1 !== o.f0) filt.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + (o.fTime ?? o.d));
      if (o.f2) filt.frequency.exponentialRampToValueAtTime(Math.max(20, o.f2), t + (o.fTime ?? o.d) * 2);
      filt.Q.value = o.Q ?? 1;
      src.connect(filt);
      filt.connect(g);
    } else {
      src.connect(g);
    }
    const len = adsr(g.gain, t, o.peak, o.a ?? 0.0008, o.d, o.hold ?? 0);
    node.connect(o.dest || dest);
    // A random window of the shared bed, so no two bursts are the same noise.
    const off = this.r() * (this.mixer.noise.duration - len - 0.05);
    src.start(t, Math.max(0, off), len + 0.03);
    src.onended = () => { src.disconnect(); if (filt) filt.disconnect(); g.disconnect(); };
    return len;
  }

  // Inharmonic partials: what makes metal read as metal rather than as a note.
  metal(dest, t, o) {
    const ratios = o.ratios || [1, 1.71, 2.43, 3.61, 5.12];
    let len = 0;
    for (let i = 0; i < ratios.length; i++) {
      const f = o.base * ratios[i] * (1 + (this.r() - 0.5) * 0.02);
      const d = o.d * Math.pow(0.72, i) * (0.85 + this.r() * 0.3);
      const peak = o.peak * Math.pow(0.66, i);
      len = Math.max(len, this.tone(dest, t, { type: 'sine', f0: f, f1: f * 0.994, d, peak, a: 0.001 }));
    }
    return len;
  }

  // Three parallel bandpasses over a buzzy source. Shifting the formants and
  // the pitch together is what gives each fighter a recognisable voice.
  formants(dest, t, o) {
    const ctx = this.ctx;
    const table = VOWELS[o.vowel] || VOWELS.ah;
    const shift = o.shift ?? 1;
    const sum = ctx.createGain();
    sum.gain.value = 1;
    sum.connect(dest);
    const filters = [];
    for (let i = 0; i < 3; i++) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(table[i] * shift, t);
      if (o.shiftEnd && o.shiftEnd !== shift) {
        bp.frequency.exponentialRampToValueAtTime(table[i] * o.shiftEnd, t + o.d);
      }
      bp.Q.value = o.Q ?? 9;
      const fg = ctx.createGain();
      fg.gain.value = FORMANT_GAIN[i] * (o.tilt ? Math.pow(o.tilt, i) : 1);
      bp.connect(fg);
      fg.connect(sum);
      filters.push(bp, fg);
    }
    let len = 0;
    if (o.src !== 'noise') {
      const osc = ctx.createOscillator();
      osc.type = o.wave || 'sawtooth';
      osc.frequency.setValueAtTime(o.f0, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(30, o.f1 ?? o.f0 * 0.8), t + o.d);
      const g = ctx.createGain();
      len = adsr(g.gain, t, o.peak, o.a ?? 0.02, o.d, o.hold ?? 0);
      osc.connect(g);
      for (const f of filters) if (f.type === 'bandpass') g.connect(f);
      osc.start(t);
      osc.stop(t + len + 0.03);
      osc.onended = () => { osc.disconnect(); g.disconnect(); };
    }
    // Breath. Even a shout is half air, and without it a formant voice sounds
    // like a synthesizer pretending.
    if (o.breath) {
      const src = this.mixer.noiseSource(1);
      const g = ctx.createGain();
      const bl = adsr(g.gain, t, o.peak * o.breath, o.a ?? 0.02, o.d * 1.1, o.hold ?? 0);
      src.connect(g);
      for (const f of filters) if (f.type === 'bandpass') g.connect(f);
      const off = this.r() * (this.mixer.noise.duration - bl - 0.05);
      src.start(t, Math.max(0, off), bl + 0.03);
      src.onended = () => { src.disconnect(); g.disconnect(); };
      len = Math.max(len, bl);
    }
    const kill = t + len + 0.05;
    this._live.push({ g: sum, p: sum, t: kill });
    return len;
  }

  // --- the table --------------------------------------------------------

  play(name, opts = {}) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this._retire(now);
    if (this._live.length > this._voiceCap) return 0;
    const def = SOUNDS[ALIAS[name] || name];
    if (!def) return 0;
    const t = Math.max(now + 0.001, opts.when || 0);
    const head = this._head(def.bus || 'sfx', t, opts, def.gain ?? 1);
    let dur = 0;
    try {
      dur = def.build(this, head, t, opts) || def.dur || 0.3;
    } catch (e) {
      console.warn('[sfx]', name, e);
    }
    this._live.push({ g: head, p: head, t: t + dur + 0.6 });
    return dur;
  }
}

// Pitch multiplier shared by every voice: per-call pitch, plus the mixer's
// global drunken sag so the whole world goes flat together.
function pitchOf(K, o) {
  return (o.pitch ?? 1) * (K.mixer.drunkRate ?? 1);
}

// Impact layer tables. Read these top to bottom to hear the difference: the
// jab is all click and bright slap with no sub, the uppercut is all thump and
// sub with a dull low slap. That spread is what the spectral centroid test in
// tools/audio-check.mjs asserts on.
const IMPACTS = {
  jab:      { dmg: 6,  click: [5200, 0.34, 0.008], slap: [3200, 1.1, 0.30, 0.035], thump: [240, 105, 0.055, 0.42], sub: [70, 42, 0.10, 0.10] },
  cross:    { dmg: 11, click: [4200, 0.30, 0.009], slap: [2400, 1.0, 0.32, 0.050], thump: [205, 78, 0.085, 0.55], sub: [65, 36, 0.15, 0.22] },
  hook:     { dmg: 14, click: [3400, 0.26, 0.010], slap: [1800, 0.9, 0.36, 0.075], thump: [180, 62, 0.115, 0.62], sub: [60, 33, 0.19, 0.32] },
  uppercut: { dmg: 18, click: [2200, 0.16, 0.012], slap: [950, 0.8, 0.30, 0.100], thump: [150, 40, 0.190, 0.72], sub: [56, 28, 0.30, 0.50] },
  kick:     { dmg: 15, click: [2600, 0.20, 0.010], slap: [620, 0.7, 0.34, 0.090], thump: [165, 48, 0.140, 0.66], sub: [58, 30, 0.22, 0.40] },
  block:    { dmg: 4,  click: [1500, 0.12, 0.010], slap: [420, 0.9, 0.30, 0.060], thump: [130, 72, 0.070, 0.34], sub: [62, 44, 0.10, 0.12] }
};

const IMPACT_SCALE = 0.6;

function impact(K, dest, t, o, key) {
  const P = IMPACTS[key];
  const r = K.r;
  const pitch = pitchOf(K, o);
  // Damage weight. A jab that lands at 4 damage and a jab that lands during
  // Last Call at 11 are the same sound with different mass behind it.
  const w = clamp((o.damage ?? P.dmg) / P.dmg, 0.45, 2.1);
  const heft = 0.55 + 0.45 * clamp01(w);
  const s = IMPACT_SCALE;

  // 1. knuckle transient
  K.noise(dest, t, {
    type: 'highpass', f0: P.click[0] * (0.85 + r() * 0.3) * pitch,
    Q: 0.7, peak: P.click[1] * s * (0.8 + r() * 0.4), a: 0.0006, d: P.click[2]
  });
  // 2. mass
  const th = P.thump;
  const len = K.tone(dest, t + 0.002, {
    type: 'sine', f0: th[0] * pitch * (0.94 + r() * 0.12),
    f1: th[1] * pitch * (0.9 + r() * 0.2),
    d: th[2] * lerp(0.9, 1.25, clamp01(w - 0.5)), fTime: th[2] * 0.42,
    peak: th[3] * s * heft, a: 0.0018
  });
  // 3. skin and cloth
  const sl = P.slap;
  K.noise(dest, t + 0.001, {
    type: 'bandpass', f0: sl[0] * (0.88 + r() * 0.26) * pitch,
    f1: sl[0] * 0.55 * pitch, Q: sl[1] * (0.85 + r() * 0.4),
    peak: sl[2] * s * (0.75 + r() * 0.5) * heft, a: 0.001, d: sl[3] * (0.85 + r() * 0.35)
  });
  // 4. weight
  const sb = P.sub;
  const subLen = K.tone(dest, t + 0.004, {
    type: 'sine', f0: sb[0] * pitch, f1: sb[1] * pitch,
    d: sb[2] * lerp(0.85, 1.3, clamp01(w - 0.5)), fTime: sb[2] * 0.7,
    peak: sb[3] * s * heft * heft, a: 0.004
  });
  return Math.max(len, subLen) + 0.02;
}

const SOUNDS = {
  jab:      { bus: 'sfx', dur: 0.18, build: (K, d, t, o) => impact(K, d, t, o, 'jab') },
  cross:    { bus: 'sfx', dur: 0.26, build: (K, d, t, o) => impact(K, d, t, o, 'cross') },
  hook:     { bus: 'sfx', dur: 0.32, build: (K, d, t, o) => impact(K, d, t, o, 'hook') },
  uppercut: { bus: 'sfx', dur: 0.44, build: (K, d, t, o) => impact(K, d, t, o, 'uppercut') },
  kick:     { bus: 'sfx', dur: 0.36, build: (K, d, t, o) => impact(K, d, t, o, 'kick') },
  block:    { bus: 'sfx', dur: 0.20, build: (K, d, t, o) => impact(K, d, t, o, 'block') },

  // Bright, metallic, inharmonic. A parry should cut through a crowd roar,
  // so it lives an octave above everything else in the mix.
  parry: {
    bus: 'sfx', gain: 0.85, dur: 0.62,
    build: (K, d, t, o) => {
      const p = pitchOf(K, o);
      K.noise(d, t, { type: 'highpass', f0: 6200 * p, peak: 0.24, d: 0.010 });
      K.tone(d, t, { type: 'sine', f0: 320 * p, f1: 150 * p, d: 0.05, peak: 0.22 });
      const len = K.metal(d, t + 0.003, {
        base: 2100 * p * (0.96 + K.r() * 0.08),
        ratios: [1, 1.71, 2.43, 3.61, 5.12, 6.79],
        peak: 0.34, d: 0.55
      });
      return len + 0.05;
    }
  },

  // A miss is air moving, not a hit. The band sweeps up and back down so the
  // envelope is a hump, never a step.
  whiff: {
    bus: 'sfx', gain: 0.7, dur: 0.26,
    build: (K, d, t, o) => {
      const p = pitchOf(K, o) * (0.9 + K.r() * 0.22);
      K.noise(d, t, {
        type: 'bandpass', f0: 520 * p, f1: 2500 * p, f2: 780 * p, fTime: 0.085,
        Q: 1.7, peak: 0.26 * (o.power ?? 1), a: 0.075, d: 0.13
      });
      K.noise(d, t + 0.02, { type: 'lowpass', f0: 300 * p, Q: 1.2, peak: 0.09, a: 0.06, d: 0.10 });
      return 0.24;
    }
  },

  // Eighty kilograms meeting a tiled floor: one big low thump, a broadband
  // crunch, cloth, and a smaller second bounce a beat later.
  bodyfall: {
    bus: 'sfx', gain: 1, dur: 0.62,
    build: (K, d, t, o) => {
      const r = K.r, p = pitchOf(K, o);
      const w = clamp(o.volume ?? 1, 0.6, 1.6);
      K.tone(d, t, { type: 'sine', f0: 95 * p, f1: 28 * p, d: 0.34, fTime: 0.11, peak: 0.52 * w, a: 0.003 });
      K.noise(d, t, { type: 'lowpass', f0: 520 * p, Q: 1.1, peak: 0.30 * w, a: 0.002, d: 0.12 });
      K.noise(d, t + 0.006, { type: 'bandpass', f0: 1800 * (0.9 + r() * 0.2), Q: 0.8, peak: 0.13 * w, a: 0.004, d: 0.18 });
      const b = t + 0.13 + r() * 0.05;
      K.tone(d, b, { type: 'sine', f0: 72 * p, f1: 30 * p, d: 0.18, peak: 0.22 * w, a: 0.003 });
      K.noise(d, b, { type: 'lowpass', f0: 380, Q: 1, peak: 0.12 * w, a: 0.002, d: 0.07 });
      return 0.55;
    }
  },

  // A skull is a resonator. The high-Q bandpass ring after the thump is the
  // whole character of the sound.
  headhit: {
    bus: 'sfx', gain: 1, dur: 0.44,
    build: (K, d, t, o) => {
      const r = K.r, p = pitchOf(K, o);
      const w = clamp((o.damage ?? 12) / 12, 0.5, 2);
      K.noise(d, t, { type: 'highpass', f0: 3200 * p, peak: 0.18, d: 0.007 });
      K.tone(d, t, { type: 'sine', f0: 190 * p, f1: 55 * p, d: 0.09, peak: 0.40 * w, a: 0.002 });
      K.noise(d, t + 0.004, { type: 'bandpass', f0: 430 * p * (0.92 + r() * 0.16), Q: 16, peak: 0.34 * w, a: 0.003, d: 0.32 });
      K.noise(d, t + 0.004, { type: 'bandpass', f0: 1250 * p, Q: 12, peak: 0.12 * w, a: 0.002, d: 0.15 });
      return 0.40;
    }
  },

  // One crack, a low bottle body, then a scatter of shards over a quarter of a
  // second. The random tap times are why no two bottles break alike.
  glassbreak: {
    bus: 'sfx', gain: 0.9, dur: 0.48,
    build: (K, d, t, o) => {
      const r = K.r;
      K.noise(d, t, { type: 'highpass', f0: 2600, Q: 0.8, peak: 0.42, a: 0.0008, d: 0.030 });
      K.tone(d, t, { type: 'triangle', f0: 220, f1: 88, d: 0.09, peak: 0.16 });
      const shards = 13 + Math.floor(r() * 6);
      for (let i = 0; i < shards; i++) {
        const dt = 0.008 + r() * r() * 0.26;
        K.noise(d, t + dt, {
          type: 'bandpass', f0: 2600 + r() * 5200, Q: 6 + r() * 9,
          peak: 0.08 + r() * 0.14, a: 0.0008, d: 0.018 + r() * 0.05
        });
      }
      return 0.42;
    }
  },

  bottleclink: {
    bus: 'sfx', gain: 0.7, dur: 0.26,
    build: (K, d, t, o) => {
      const p = pitchOf(K, o) * (0.9 + K.r() * 0.3);
      K.noise(d, t, { type: 'highpass', f0: 5000 * p, peak: 0.14, d: 0.006 });
      return K.metal(d, t, { base: 1550 * p, ratios: [1, 2.37, 3.14, 4.62], peak: 0.26, d: 0.20 }) + 0.03;
    }
  },

  // Sticky floor, not a marble hall. Mostly low noise with a hint of body.
  footstep: {
    bus: 'sfx', gain: 0.75, dur: 0.14,
    build: (K, d, t, o) => {
      const r = K.r, p = pitchOf(K, o);
      const i = clamp(o.intensity ?? 1, 0.25, 2);
      if (o.variation === 'scuff') {
        K.noise(d, t, { type: 'bandpass', f0: 2100 * (0.85 + r() * 0.3), Q: 1.3, peak: 0.16 * i, a: 0.012, d: 0.12 });
        K.noise(d, t, { type: 'lowpass', f0: 700, Q: 1, peak: 0.10 * i, a: 0.006, d: 0.08 });
        return 0.15;
      }
      K.noise(d, t, { type: 'lowpass', f0: 1100 * (0.85 + r() * 0.3), Q: 1.1, peak: 0.26 * i, a: 0.0012, d: 0.055 });
      K.noise(d, t, { type: 'highpass', f0: 2600, Q: 0.7, peak: 0.07 * i, a: 0.0008, d: 0.016 });
      K.tone(d, t, { type: 'sine', f0: 120 * p, f1: 58 * p, d: 0.055, peak: 0.16 * i, a: 0.002 });
      return 0.12;
    }
  },

  // Voice. shift and f0 come from the fighter, so the two fighters in a duel
  // never grunt in the same voice.
  grunt: {
    bus: 'voice', gain: 0.9, dur: 0.34,
    build: (K, d, t, o) => {
      const r = K.r;
      const f0 = (o.f0 ?? 132) * pitchOf(K, o) * (0.92 + r() * 0.18);
      const shift = o.shift ?? 1;
      const hurt = clamp01((o.damage ?? 10) / 22);
      const len = K.formants(d, t, {
        vowel: r() < 0.55 ? 'ah' : 'uh', f0: f0 * (1.1 + hurt * 0.25), f1: f0 * 0.74,
        shift, shiftEnd: shift * 0.93, Q: 8.5,
        peak: 0.30 + hurt * 0.22, a: 0.012, d: 0.22 + hurt * 0.1, breath: 0.5, tilt: 1
      });
      K.noise(d, t, { type: 'highpass', f0: 1800, peak: 0.05, a: 0.01, d: 0.09 });
      return len + 0.04;
    }
  },

  // The same machinery with no vocal cords: air through the same throat.
  exhale: {
    bus: 'voice', gain: 0.8, dur: 0.42,
    build: (K, d, t, o) => {
      const shift = o.shift ?? 1;
      const len = K.formants(d, t, {
        src: 'noise', vowel: 'uh', shift, shiftEnd: shift * 1.06, Q: 5,
        peak: 0.30, a: 0.045, d: 0.30, breath: 1, f0: 100, d2: 0
      });
      K.noise(d, t, { type: 'lowpass', f0: 2400 * shift, Q: 0.9, peak: 0.07, a: 0.05, d: 0.26 });
      return len + 0.04;
    }
  },

  // Three glugs and a swallow. The rising pitch per glug is the bottle
  // emptying, which is the only cue that says drink rather than splash.
  gulp: {
    bus: 'voice', gain: 0.9, dur: 0.56,
    build: (K, d, t, o) => {
      const r = K.r, shift = o.shift ?? 1;
      const n = 3;
      let last = t;
      for (let i = 0; i < n; i++) {
        const gt = t + i * (0.105 + r() * 0.03);
        const f = (155 + i * 34) * shift;
        K.tone(d, gt, { type: 'sine', f0: f * 1.6, f1: f * 0.7, d: 0.055, fTime: 0.03, peak: 0.26, a: 0.004 });
        K.noise(d, gt, { type: 'bandpass', f0: 640 * shift, Q: 7, peak: 0.12, a: 0.003, d: 0.045 });
        last = gt;
      }
      K.formants(d, last + 0.11, {
        src: 'noise', vowel: 'oh', shift, Q: 6, peak: 0.16, a: 0.03, d: 0.20, breath: 1, f0: 100
      });
      return 0.52;
    }
  },

  // One person yelling. The crowd bed layers dozens of these; this one is for
  // the heckler close to the camera.
  crowdshout: {
    bus: 'crowd', gain: 0.8, dur: 0.95,
    build: (K, d, t, o) => {
      const r = K.r;
      const shift = (o.shift ?? 1) * (0.8 + r() * 0.5);
      const f0 = (o.f0 ?? 190) * (0.8 + r() * 0.6);
      K.formants(d, t, {
        vowel: r() < 0.5 ? 'ah' : 'eh', f0: f0 * 1.15, f1: f0 * 0.9,
        shift, shiftEnd: shift * 0.95, Q: 7,
        peak: 0.24 * (o.power ?? 1), a: 0.055, hold: 0.09, d: 0.45, breath: 0.7
      });
      K.noise(d, t + 0.01, { type: 'bandpass', f0: 1100 * shift, Q: 1.2, peak: 0.08 * (o.power ?? 1), a: 0.06, d: 0.5 });
      return 0.9;
    }
  },

  // Round bell. Pure inharmonic metal, long tail, no noise at all.
  bell: {
    bus: 'sfx', gain: 0.8, dur: 1.5,
    build: (K, d, t, o) => {
      const p = pitchOf(K, o);
      return K.metal(d, t, {
        base: 880 * p, ratios: [1, 2.01, 2.99, 4.17, 5.43, 6.79, 8.21],
        peak: 0.34, d: 1.35
      }) + 0.05;
    }
  }
};

// Names other subsystems already emit, mapped onto the table above.
const ALIAS = {
  whoosh: 'whiff', miss: 'whiff', swing: 'whiff',
  punch: 'cross', hit: 'cross', headshot: 'headhit', head: 'headhit',
  fall: 'bodyfall', knockdown: 'bodyfall', ko: 'bodyfall',
  glass: 'glassbreak', break: 'glassbreak', propbreak: 'glassbreak',
  bottle: 'bottleclink', clink: 'bottleclink',
  step: 'footstep', scuff: 'footstep',
  drink: 'gulp', breath: 'exhale', shout: 'crowdshout'
};

export const SFX_NAMES = Object.keys(SOUNDS);
export { SOUNDS, ALIAS, VOWELS };

// Two fighters, two throats. Hashing the name keeps a fighter's voice stable
// across rounds without the caller having to remember an id.
export function voiceOf(fighter) {
  if (!fighter) return { f0: 132, shift: 1 };
  if (fighter._audioVoice) return fighter._audioVoice;
  const h = hashString(String(fighter.spec?.name ?? (fighter.isPlayer ? 'player' : 'cpu')));
  const t = (h % 1000) / 1000;
  const v = { f0: lerp(96, 168, t), shift: lerp(0.86, 1.12, 1 - t) };
  try { fighter._audioVoice = v; } catch (e) { /* frozen fighter, recompute */ }
  return v;
}

// --- the crowd --------------------------------------------------------------

// The crowd is an instrument, not a loop. A continuous bed of filtered noise
// carries the room, granular babble on top makes it people, and surges are
// scheduled envelopes with attack, peak and a ragged decay. A roar that is a
// volume step sounds like a fader move, which is exactly what it is.
export class CrowdBed {
  constructor(mixer, kit) {
    this.mixer = mixer;
    this.ctx = mixer.ctx;
    this.kit = kit;
    this.r = makeRng(0xc0ffee);
    this.hype = 0;
    this.running = false;
    this._nextGrain = 0;
    this._grainBudget = 0;

    const ctx = this.ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(mixer.bus('crowd'));

    // Bed: looped noise through a band that opens with hype. Two layers at
    // different rates so the loop point never lines up audibly.
    this.bedGain = ctx.createGain();
    this.bedGain.gain.value = 0.34;
    this.bedLP = ctx.createBiquadFilter();
    this.bedLP.type = 'lowpass';
    this.bedLP.frequency.value = 900;
    this.bedLP.Q.value = 0.6;
    this.bedHP = ctx.createBiquadFilter();
    this.bedHP.type = 'highpass';
    this.bedHP.frequency.value = 190;
    this.bedLP.connect(this.bedHP);
    this.bedHP.connect(this.bedGain);
    this.bedGain.connect(this.out);

    this.beds = [];
    for (let i = 0; i < 2; i++) {
      const s = mixer.noiseSource(0.82 + i * 0.27, true);
      const p = ctx.createStereoPanner();
      p.pan.value = i === 0 ? -0.45 : 0.45;
      s.connect(p);
      p.connect(this.bedLP);
      this.beds.push({ s, p });
    }

    // A slow wander on the band so the room breathes.
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = 0.13;
    this.lfoDepth = ctx.createGain();
    this.lfoDepth.gain.value = 180;
    this.lfo.connect(this.lfoDepth);
    this.lfoDepth.connect(this.bedLP.frequency);

    // Surges get their own node so a setValueCurve roar never collides with
    // the bed's own automation.
    this.surgeGain = ctx.createGain();
    this.surgeGain.gain.value = 1;
    this.surgeGain.connect(mixer.bus('crowd'));

    this._curve = new Float32Array(96);
  }

  start(t = this.ctx.currentTime) {
    if (this.running) return;
    this.running = true;
    for (const b of this.beds) { try { b.s.start(t, this.r() * 1.5); } catch (e) { /* already started */ } }
    try { this.lfo.start(t); } catch (e) { /* already started */ }
    this.out.gain.setValueAtTime(0.0001, t);
    this.out.gain.exponentialRampToValueAtTime(this._level(), t + 1.2);
    this._nextGrain = t + 0.1;
  }

  _level() { return Math.max(0.0001, 0.16 + this.hype * 0.72); }

  setHype(v) {
    this.hype = clamp01(v);
    if (!this.running) return;
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(this._level(), t, 0.55);
    // A louder room is a brighter room: people raise their voices, and raised
    // voices have more top end, not just more level.
    this.bedLP.frequency.setTargetAtTime(760 + this.hype * 2400, t, 0.7);
    this.lfoDepth.gain.setTargetAtTime(160 + this.hype * 520, t, 0.7);
  }

  // Granular babble. Called from the engine tick with a lookahead window, and
  // from the offline renderer with the whole window at once.
  schedule(from, to) {
    if (!this.running) return;
    const rate = 3 + this.hype * 16;     // voices per second
    let t = Math.max(this._nextGrain, from);
    let guard = 0;
    while (t < to && guard++ < 48) {
      this._grain(t);
      t += (0.35 + this.r() * 0.65) / rate * 3;
    }
    this._nextGrain = t;
  }

  _grain(t) {
    const r = this.r;
    const K = this.kit;
    const ctx = this.ctx;
    const g = ctx.createGain();
    const p = ctx.createStereoPanner();
    p.pan.value = (r() * 2 - 1) * 0.85;
    g.gain.value = (0.05 + this.hype * 0.16) * (0.5 + r());
    g.connect(p);
    p.connect(this.out);
    const shift = 0.72 + r() * 0.62;
    const f0 = 110 + r() * 150;
    const d = 0.09 + r() * 0.22;
    K.formants(g, t, {
      vowel: r() < 0.4 ? 'ah' : (r() < 0.6 ? 'eh' : 'uh'),
      f0: f0 * (1 + r() * 0.2), f1: f0 * 0.85, shift, Q: 6,
      peak: 0.5, a: 0.02 + r() * 0.04, d, breath: 0.8
    });
    K._live.push({ g, p, t: t + d + 0.4 });
  }

  // kind: ooh, roar, peak, lastCall. Attack, peak, long ragged decay.
  surge(kind = 'roar', power = 1) {
    if (!this.running) return 0;
    const ctx = this.ctx;
    const r = this.r;
    const t = ctx.currentTime + 0.01;
    const P = SURGE[kind] || SURGE.roar;
    const amp = P.amp * clamp(power, 0.3, 2);
    const dur = P.dur * (0.9 + r() * 0.25);

    const g = ctx.createGain();
    g.connect(this.surgeGain);

    // Ragged decay, drawn as a curve rather than a ramp. A real roar is
    // hundreds of people going quiet at slightly different times, which looks
    // like an exponential with noise on it, not a clean line.
    const c = this._curve;
    const atk = P.attack / dur;
    for (let i = 0; i < c.length; i++) {
      const x = i / (c.length - 1);
      let env;
      if (x < atk) env = Math.pow(x / atk, 0.6);
      else {
        const k = (x - atk) / (1 - atk);
        env = Math.pow(1 - k, P.curve) * (0.82 + r() * 0.3);
      }
      c[i] = Math.max(0, env * amp);
    }
    c[c.length - 1] = 0;
    g.gain.setValueCurveAtTime(c, t, dur);

    // Voices: a wash of formant noise plus a handful of individual shouts
    // poking out of it, which is what makes a crowd sound countable.
    const layers = P.layers;
    for (let i = 0; i < layers; i++) {
      const shift = 0.7 + r() * 0.7;
      const lt = t + r() * P.attack * 0.9;
      this.kit.formants(g, lt, {
        src: r() < 0.35 ? 'noise' : 'saw',
        vowel: r() < 0.5 ? 'ah' : 'eh',
        f0: (130 + r() * 190) * (1 + r() * 0.15), f1: (110 + r() * 120),
        shift, shiftEnd: shift * (0.9 + r() * 0.2), Q: 5 + r() * 5,
        peak: 0.22 / Math.sqrt(layers) * 3, a: 0.05 + r() * 0.12,
        hold: dur * 0.18, d: dur * (0.45 + r() * 0.4), breath: 0.9
      });
    }
    // Broadband body so it is a mass, not four soloists.
    this.kit.noise(g, t, { type: 'bandpass', f0: 700, f1: 1500, Q: 0.7, peak: 0.42, a: P.attack, d: dur * 0.75 });
    this.kit.noise(g, t, { type: 'lowpass', f0: 420, Q: 0.8, peak: 0.22, a: P.attack * 1.3, d: dur * 0.85 });
    if (P.whistle) {
      for (let i = 0; i < 3; i++) {
        const wt = t + P.attack + r() * dur * 0.4;
        this.kit.tone(g, wt, {
          type: 'sine', f0: 2300 + r() * 900, f1: 2000 + r() * 1400,
          d: 0.12 + r() * 0.2, peak: 0.07, a: 0.02
        });
      }
    }
    this.kit._live.push({ g, p: g, t: t + dur + 0.5 });
    return dur;
  }

  dispose() {
    try { this.lfo.stop(); } catch (e) { /* not started */ }
    for (const b of this.beds) { try { b.s.stop(); } catch (e) { /* not started */ } }
    try { this.out.disconnect(); this.surgeGain.disconnect(); } catch (e) { /* already gone */ }
    this.running = false;
  }
}

const SURGE = {
  ooh:      { amp: 0.30, dur: 0.9,  attack: 0.10, curve: 1.7, layers: 3, whistle: false },
  roar:     { amp: 0.55, dur: 1.8,  attack: 0.13, curve: 1.9, layers: 5, whistle: false },
  big:      { amp: 0.75, dur: 2.8,  attack: 0.16, curve: 1.6, layers: 7, whistle: true },
  peak:     { amp: 0.85, dur: 3.4,  attack: 0.18, curve: 1.5, layers: 8, whistle: true },
  lastCall: { amp: 0.95, dur: 4.2,  attack: 0.22, curve: 1.3, layers: 9, whistle: true }
};

export { SURGE };
