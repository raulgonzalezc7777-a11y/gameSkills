import { clamp, clamp01, lerp } from '../core/math.js';
import { makeRng } from '../core/rng.js';

// The track the bar is playing. Four on the floor at 126 BPM, sequenced from a
// pattern table with per-bar variation seeded off the bar number, so it never
// loops audibly and a seeded replay still gets the same bar 37.
//
// The tempo is fixed at 126 because src/world/arena.js runs its own 126 BPM
// clock for the venue lights. onBeat() exists so that clock can be replaced by
// this one without the lights ever drifting; Last Call doubles the pattern
// density rather than the tempo, for exactly that reason.

const BPM = 126;
const SPB = 60 / BPM;
const STEP = SPB / 4;             // sixteenth note
const STEPS_PER_BAR = 16;

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// A minor: Am, F, C, G. Roots low enough to be felt, voicings tight enough to
// sit under a crowd without turning to mud.
const PROG = [
  { root: 33, chord: [57, 60, 64], arp: [69, 72, 76, 72, 69, 76, 72, 69] },
  { root: 29, chord: [53, 57, 60], arp: [65, 69, 72, 69, 65, 72, 69, 65] },
  { root: 36, chord: [60, 64, 67], arp: [72, 76, 79, 76, 72, 79, 76, 72] },
  { root: 31, chord: [55, 59, 62], arp: [67, 71, 74, 71, 67, 74, 71, 67] }
];

const PAT = {
  kick:  [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
  kickX: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1],
  clap:  [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
  hat:   [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
  hatX:  [0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1],
  bass:  [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0],
  stab:  [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  arp:   [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
};

const MIN = 0.0001;

export class MusicEngine {
  constructor(mixer, opts = {}) {
    this.mixer = mixer;
    this.ctx = mixer.ctx;
    this.offline = !!opts.offline;
    this.intensity = 0.7;
    this.isLastCall = false;
    this.playing = false;
    this.step = 0;
    this.nextTime = 0;
    this.lookahead = 0.28;
    this._timer = null;
    this._beatCbs = new Set();
    this._beatQueue = [];
    this._r = makeRng(0x5eed1e);

    const ctx = this.ctx;
    const bus = mixer.bus('music');
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(bus);

    // Per element gains, so setIntensity can bring the arrangement up and down
    // like a DJ rather than just riding one fader.
    this.g = {};
    for (const [k, v] of [['kick', 0.95], ['clap', 0.46], ['hat', 0.26], ['bass', 0.70], ['stab', 0.40], ['arp', 0.26]]) {
      const g = ctx.createGain();
      g.gain.value = v;
      g.connect(this.out);
      this.g[k] = g;
      g._base = v;
    }
    // The hats and the arp share a top-end shelf so the whole upper half of
    // the track opens together when the intensity rises.
    this.air = ctx.createBiquadFilter();
    this.air.type = 'highshelf';
    this.air.frequency.value = 5200;
    this.air.gain.value = 0;
    this.air.connect(this.out);
    this.g.hat.disconnect(); this.g.hat.connect(this.air);
    this.g.arp.disconnect(); this.g.arp.connect(this.air);
  }

  get bpm() { return BPM; }
  get beatSeconds() { return SPB; }

  onBeat(cb) {
    this._beatCbs.add(cb);
    return () => this._beatCbs.delete(cb);
  }

  setIntensity(v) {
    this.intensity = clamp01(v);
    const t = this.ctx.currentTime;
    const i = this.intensity;
    this.out.gain.setTargetAtTime(this.playing ? lerp(0.5, 1.0, i) : 0, t, 0.4);
    this.g.stab.gain.setTargetAtTime(this.g.stab._base * lerp(0.35, 1.25, i), t, 0.5);
    this.g.arp.gain.setTargetAtTime(this.g.arp._base * lerp(0.15, 1.35, i), t, 0.5);
    this.g.hat.gain.setTargetAtTime(this.g.hat._base * lerp(0.6, 1.3, i), t, 0.5);
    this.air.gain.setTargetAtTime(lerp(-6, 5, i), t, 0.6);
  }

  // Last Call doubles the pattern, not the clock: the venue lights stay locked
  // to 126 while the track goes twice as busy.
  lastCall(on = true) {
    this.isLastCall = !!on;
    const t = this.ctx.currentTime;
    this.g.kick.gain.setTargetAtTime(this.g.kick._base * (on ? 1.06 : 1), t, 0.3);
    this.air.gain.setTargetAtTime(on ? 6 : lerp(-6, 5, this.intensity), t, 0.4);
  }

  start(when) {
    if (this.playing) return;
    this.playing = true;
    const t = when ?? (this.ctx.currentTime + 0.06);
    this.nextTime = t;
    this.step = 0;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(MIN, t);
    this.out.gain.exponentialRampToValueAtTime(lerp(0.5, 1.0, this.intensity), t + 1.1);
    if (!this.offline && typeof setInterval === 'function') {
      this._timer = setInterval(() => this._tick(), 25);
      this._tick();
    }
  }

  stop(fade = 0.6) {
    if (!this.playing) return;
    this.playing = false;
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(Math.max(MIN, this.out.gain.value), t);
    this.out.gain.exponentialRampToValueAtTime(MIN, t + fade);
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._beatQueue.length = 0;
  }

  _tick() {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    this.scheduleUntil(now + this.lookahead);
    // Beat callbacks fire in real time, not at schedule time, so a listener
    // that flashes a light flashes on the beat and not a lookahead early.
    const q = this._beatQueue;
    while (q.length && q[0].t <= now + 0.016) {
      const b = q.shift();
      for (const cb of this._beatCbs) {
        try { cb(b.beat, b.bar, b.t); } catch (e) { console.warn('[music:onBeat]', e); }
      }
    }
  }

  // Schedules every step whose start time falls before the horizon. Public so
  // the offline renderer in tools/audio-check.mjs can lay down four bars in
  // one call with no timer involved.
  scheduleUntil(horizon) {
    let guard = 0;
    while (this.nextTime < horizon && guard++ < 256) {
      this._scheduleStep(this.step, this.nextTime);
      this.step++;
      this.nextTime += STEP;
    }
  }

  _scheduleStep(i, t) {
    const s = i % STEPS_PER_BAR;
    const bar = Math.floor(i / STEPS_PER_BAR);
    const harmony = PROG[bar % PROG.length];
    // Reseeding per bar rather than per step keeps a whole bar coherent and
    // costs no allocation.
    const r = this._r;
    r.seed((0x5eed1e ^ (bar * 2654435761)) >>> 0);
    for (let k = 0; k < s; k++) r();   // advance so steps differ within a bar

    const lc = this.isLastCall;
    const inten = this.intensity;
    const fill = (bar % 8) === 7;

    if (s === 0) {
      this._beatQueue.push({ t, beat: 0, bar });
    } else if (s % 4 === 0) {
      this._beatQueue.push({ t, beat: s / 4, bar });
    }
    if (this._beatQueue.length > 64) this._beatQueue.splice(0, 32);

    const kickPat = lc ? PAT.kickX : PAT.kick;
    if (kickPat[s] || (fill && lc && s >= 12)) this._kick(t, s === 0 ? 1 : 0.94);
    if (PAT.clap[s] || (fill && s === 14)) this._clap(t, 1);

    const hatPat = lc ? PAT.hatX : PAT.hat;
    if (hatPat[s] || (inten > 0.75 && r() < 0.35)) {
      const open = (s === 14 && r() < 0.6) || (lc && s === 6);
      this._hat(t, open, open ? 0.7 : 0.5 + r() * 0.5);
    }

    if (PAT.bass[s] || (lc && s % 2 === 1 && r() < 0.5)) {
      const oct = r() < 0.12 ? 12 : 0;
      this._bass(t, harmony.root + oct, STEP * (lc ? 1.4 : 2.4));
    }

    if (PAT.stab[s] || (fill && s === 13)) {
      const inv = r() < 0.4 ? 12 : 0;
      this._stab(t, harmony.chord, inv, 0.34 + r() * 0.2);
    }

    // The arp is the layer that carries variation: presence, octave and
    // direction all come from the bar seed.
    const arpOn = inten > 0.35 && (lc || bar % 2 === 1 || inten > 0.8);
    if (arpOn && PAT.arp[s]) {
      const seq = harmony.arp;
      const dir = r() < 0.5 ? 1 : -1;
      const n = seq[(dir > 0 ? s : seq.length * 2 - s) % seq.length];
      const oct = lc && s % 2 === 1 ? 12 : (r() < 0.18 ? 12 : 0);
      if (lc || s % 2 === 0 || r() < 0.55) this._arp(t, n + oct, 0.22 + r() * 0.2);
    }
  }

  // --- voices ------------------------------------------------------------

  _kick(t, vel = 1) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(128, t);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.055);
    const g = ctx.createGain();
    g.gain.setValueAtTime(MIN, t);
    g.gain.exponentialRampToValueAtTime(0.9 * vel, t + 0.004);
    g.gain.exponentialRampToValueAtTime(MIN, t + 0.26);
    g.gain.setValueAtTime(0, t + 0.27);
    o.connect(g); g.connect(this.g.kick);
    o.start(t); o.stop(t + 0.3);
    o.onended = () => { o.disconnect(); g.disconnect(); };

    // Beater click. Without it the kick disappears on laptop speakers.
    const n = this.mixer.noiseSource(1);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1800;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.25 * vel, t);
    ng.gain.exponentialRampToValueAtTime(MIN, t + 0.012);
    n.connect(hp); hp.connect(ng); ng.connect(this.g.kick);
    n.start(t, this._r() * 1.5, 0.03);
    n.onended = () => { n.disconnect(); hp.disconnect(); ng.disconnect(); };

    // The pump. Everything else on the music bus bows to the kick.
    this.mixer.sidechain(t, this.isLastCall ? 0.62 : 0.5, this.isLastCall ? 0.2 : 0.26);
  }

  _clap(t, vel = 1) {
    const ctx = this.ctx;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1450; bp.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.value = 1;
    bp.connect(g); g.connect(this.g.clap);
    // Three short grains then a tail: one burst reads as a snare, three read
    // as hands.
    for (let i = 0; i < 3; i++) {
      const gt = t + i * 0.009;
      const n = this.mixer.noiseSource(1);
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.5 * vel, gt);
      ng.gain.exponentialRampToValueAtTime(MIN, gt + 0.018);
      n.connect(ng); ng.connect(bp);
      n.start(gt, this._r() * 1.5, 0.03);
      n.onended = () => { n.disconnect(); ng.disconnect(); };
    }
    const tail = this.mixer.noiseSource(1);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.34 * vel, t + 0.026);
    tg.gain.exponentialRampToValueAtTime(MIN, t + 0.16);
    tail.connect(tg); tg.connect(bp);
    tail.start(t + 0.026, this._r() * 1.5, 0.18);
    tail.onended = () => {
      tail.disconnect(); tg.disconnect();
      try { bp.disconnect(); g.disconnect(); } catch (e) { /* already gone */ }
    };
  }

  _hat(t, open, vel = 1) {
    const ctx = this.ctx;
    const d = open ? 0.17 : 0.038;
    const n = this.mixer.noiseSource(1.4);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = open ? 6200 : 7600;
    hp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.3 * vel, t);
    g.gain.exponentialRampToValueAtTime(MIN, t + d);
    n.connect(hp); hp.connect(g); g.connect(this.g.hat);
    n.start(t, this._r() * 1.5, d + 0.02);
    n.onended = () => { n.disconnect(); hp.disconnect(); g.disconnect(); };
  }

  _bass(t, midi, dur) {
    const ctx = this.ctx;
    const f = mtof(midi);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(f * 6, t);
    lp.frequency.exponentialRampToValueAtTime(f * 2.6, t + dur * 0.6);
    lp.Q.value = 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(MIN, t);
    g.gain.exponentialRampToValueAtTime(0.8, t + 0.012);
    g.gain.setValueAtTime(0.8, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(MIN, t + dur);
    lp.connect(g); g.connect(this.g.bass);
    // Sine for the body, a quiet square an octave up so it survives small
    // speakers that cannot reproduce 49 Hz at all.
    const a = ctx.createOscillator();
    a.type = 'sine'; a.frequency.value = f;
    const b = ctx.createOscillator();
    b.type = 'square'; b.frequency.value = f * 2; b.detune.value = 5;
    const bg = ctx.createGain(); bg.gain.value = 0.16;
    a.connect(lp); b.connect(bg); bg.connect(lp);
    a.start(t); b.start(t);
    a.stop(t + dur + 0.05); b.stop(t + dur + 0.05);
    a.onended = () => { a.disconnect(); b.disconnect(); bg.disconnect(); lp.disconnect(); g.disconnect(); };
  }

  _stab(t, chord, inv, dur) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 11;
    lp.frequency.setValueAtTime(340, t);
    lp.frequency.exponentialRampToValueAtTime(3800 + this.intensity * 2600, t + 0.035);
    lp.frequency.exponentialRampToValueAtTime(620, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(MIN, t);
    g.gain.exponentialRampToValueAtTime(0.42, t + 0.008);
    g.gain.exponentialRampToValueAtTime(MIN, t + dur);
    lp.connect(g); g.connect(this.g.stab);
    const oscs = [];
    for (const m of chord) {
      const f = mtof(m + inv);
      // Three detuned saws per note. The beating between them is the whole
      // reason a supersaw sounds wide instead of thin.
      for (const cents of [-11, 0, 9]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = cents;
        o.connect(lp);
        o.start(t);
        o.stop(t + dur + 0.04);
        oscs.push(o);
      }
    }
    oscs[oscs.length - 1].onended = () => {
      for (const o of oscs) o.disconnect();
      lp.disconnect(); g.disconnect();
    };
  }

  _arp(t, midi, vel) {
    const ctx = this.ctx;
    const f = mtof(midi);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(f * 2, t);
    bp.frequency.exponentialRampToValueAtTime(f * 4.5, t + 0.05);
    bp.Q.value = 2.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(MIN, t);
    g.gain.exponentialRampToValueAtTime(vel, t + 0.005);
    g.gain.exponentialRampToValueAtTime(MIN, t + 0.085);
    o.connect(bp); bp.connect(g); g.connect(this.g.arp);
    o.start(t); o.stop(t + 0.12);
    o.onended = () => { o.disconnect(); bp.disconnect(); g.disconnect(); };
  }

  dispose() {
    this.stop(0.05);
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._beatCbs.clear();
    try { this.out.disconnect(); this.air.disconnect(); } catch (e) { /* already gone */ }
  }
}

export { BPM, STEP, SPB, PROG, PAT };
