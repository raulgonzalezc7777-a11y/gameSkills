import { CFG } from '../core/config.js';
import { clamp, clamp01, lerp } from '../core/math.js';
import { makeRng } from '../core/rng.js';

// The mixer owns every shared node in the graph. Voices in sfx.js and music.js
// never touch ctx.destination directly, they ask the mixer for a bus input, so
// drunkenness, the room reverb and the master limiter apply to everything for
// free and there is exactly one place to reason about gain staging.
//
// Topology (left to right):
//
//   sfx   ─┐
//   crowd ─┼─ busGain ─┬─ busAnalyser ─┐
//   voice ─┘           ├─ revSend ─ convolver ─ revReturn ─┐
//                      └─ slapSend ─ delay ⟲ fb ─ slapRet ─┤
//   music ─ musicDuck ─ sidechainGain ─ musicComp ─────────┤
//                                                          ▼
//                              preMaster ─ drunkLP ─ masterComp ─ masterGain ─ out
//
// The convolver impulse response is generated, not loaded: this project ships
// no binary assets, and a synthesized IR lets the room change shape at runtime.

const REV_SEED = 0x1ca11ca1;
const NOISE_SEED = 0x0ff1ce5e;

// One shared noise bed for the whole game. Every noise voice reads a random
// window of this buffer instead of filling a fresh one, which is the
// difference between a punch costing four nodes and a punch costing a malloc
// plus eight thousand PRNG calls on the frame the hit lands.
function makeNoiseBuffer(ctx, seconds = 2) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  const r = makeRng(NOISE_SEED);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = r() * 2 - 1;
  }
  return buf;
}

// A small tiled bar: short pre-delay, dense early reflections off hard
// surfaces, then a diffuse tail that loses its top end fast because bodies and
// bottles eat the high frequencies.
function makeRoomIR(ctx, seconds = 1.55, decay = 3.4) {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(2, len, sr);
  const r = makeRng(REV_SEED);

  // Early reflection taps, in seconds and linear gain. Irregular spacing kills
  // the metallic comb ring a uniform tap grid produces.
  const taps = [
    [0.0071, 0.72], [0.0113, -0.58], [0.0169, 0.49], [0.0231, -0.41],
    [0.0297, 0.36], [0.0384, -0.29], [0.0461, 0.24], [0.0573, -0.19]
  ];

  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    // One pole lowpass state, run over the noise so the tail darkens with time.
    let lp = 0, hp = 0, prev = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const env = Math.pow(1 - t, decay) * (0.86 + r() * 0.28);
      let s = (r() * 2 - 1) * env;
      // Progressive darkening: the coefficient closes as the tail decays.
      const a = lerp(0.55, 0.12, t);
      lp += a * (s - lp);
      // Remove rumble so the reverb does not muddy the kick.
      hp = 0.995 * (hp + lp - prev); prev = lp;
      d[i] = hp;
    }
    // Stamp the early reflections on top, sign flipped per channel for width.
    const side = ch === 0 ? 1 : -1;
    for (const [tt, g] of taps) {
      const idx = Math.floor((tt + r() * 0.0025) * sr);
      if (idx < len) d[idx] += g * side * 0.9;
    }
    d[0] += 0.5;
  }
  return buf;
}

export class Mixer {
  constructor(ctx, cfg = CFG.audio) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.drunk = 0;
    this.hype = 0;
    this._disposed = false;

    const now = ctx.currentTime;

    // Master chain, built back to front so every node has a destination.
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = cfg.master ?? 0.85;

    // Analyser on the master tap feeds the sound lab scope and FFT.
    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 2048;
    this.masterAnalyser.smoothingTimeConstant = 0.72;

    // A gentle limiter, not a colour effect: it exists so that a knockdown plus
    // a crowd roar plus the track cannot clip past 1.0.
    this.masterComp = ctx.createDynamicsCompressor();
    this.masterComp.threshold.value = -9;
    this.masterComp.knee.value = 8;
    this.masterComp.ratio.value = 7;
    this.masterComp.attack.value = 0.004;
    this.masterComp.release.value = 0.18;

    // The drunk filter. Wide open when sober, shut and wobbling when legless.
    this.drunkLP = ctx.createBiquadFilter();
    this.drunkLP.type = 'lowpass';
    this.drunkLP.frequency.value = 20000;
    this.drunkLP.Q.value = 0.7;

    this.preMaster = ctx.createGain();
    this.preMaster.gain.value = 1;

    this.preMaster.connect(this.drunkLP);
    this.drunkLP.connect(this.masterComp);
    this.masterComp.connect(this.masterGain);
    this.masterGain.connect(this.masterAnalyser);
    this.masterGain.connect(ctx.destination);

    // The swimmy part: a slow LFO on the cutoff. Depth is zero until setDrunk
    // raises it, so a sober mix is perfectly static.
    this.wobbleLFO = ctx.createOscillator();
    this.wobbleLFO.type = 'sine';
    this.wobbleLFO.frequency.value = 0.31;
    this.wobbleDepth = ctx.createGain();
    this.wobbleDepth.gain.value = 0;
    this.wobbleLFO.connect(this.wobbleDepth);
    this.wobbleDepth.connect(this.drunkLP.frequency);
    try { this.wobbleLFO.start(now); } catch (e) { /* already started */ }

    // Room reverb.
    this.convolver = ctx.createConvolver();
    this.convolver.normalize = true;
    this.convolver.buffer = makeRoomIR(ctx);
    this.revReturn = ctx.createGain();
    this.revReturn.gain.value = 0.85;
    // Keep the tail out of the sub range so it never fights the kick.
    this.revHP = ctx.createBiquadFilter();
    this.revHP.type = 'highpass';
    this.revHP.frequency.value = 180;
    this.convolver.connect(this.revHP);
    this.revHP.connect(this.revReturn);
    this.revReturn.connect(this.preMaster);

    // Slapback: the hard parallel walls of a narrow venue. Short, filtered,
    // one and a bit repeats so speech and impacts get a room, not an echo.
    this.slapDelay = ctx.createDelay(0.5);
    this.slapDelay.delayTime.value = 0.081;
    this.slapFB = ctx.createGain();
    this.slapFB.gain.value = 0.26;
    this.slapTone = ctx.createBiquadFilter();
    this.slapTone.type = 'lowpass';
    this.slapTone.frequency.value = 2600;
    this.slapReturn = ctx.createGain();
    this.slapReturn.gain.value = 0.5;
    this.slapDelay.connect(this.slapTone);
    this.slapTone.connect(this.slapFB);
    this.slapFB.connect(this.slapDelay);
    this.slapTone.connect(this.slapReturn);
    this.slapReturn.connect(this.preMaster);

    // Music path. musicDuck is the slow duck (KO slow motion, Borrachera),
    // sidechainGain is the fast per kick pump. Two nodes because they are two
    // different gestures and stomping one automation with the other looks like
    // a bug the moment both fire in the same second.
    this.musicDuck = ctx.createGain();
    this.musicDuck.gain.value = 1;
    this.sidechainGain = ctx.createGain();
    this.sidechainGain.gain.value = 1;
    this.musicComp = ctx.createDynamicsCompressor();
    this.musicComp.threshold.value = -14;
    this.musicComp.knee.value = 12;
    this.musicComp.ratio.value = 3.2;
    this.musicComp.attack.value = 0.008;
    this.musicComp.release.value = 0.14;

    this.buses = {};
    this.analysers = {};
    this._meterBuf = new Uint8Array(256);

    this._makeBus('music', cfg.music ?? 0.5, { rev: 0.06, slap: 0.0 });
    this._makeBus('sfx', cfg.sfx ?? 0.9, { rev: 0.24, slap: 0.16 });
    this._makeBus('crowd', cfg.crowd ?? 0.55, { rev: 0.38, slap: 0.1 });
    this._makeBus('voice', (cfg.voice ?? 0.8), { rev: 0.3, slap: 0.22 });

    // Music alone runs through the duck and pump chain.
    this.buses.music.disconnect(this.preMaster);
    this.buses.music.connect(this.musicDuck);
    this.musicDuck.connect(this.sidechainGain);
    this.sidechainGain.connect(this.musicComp);
    this.musicComp.connect(this.preMaster);

    // Values voices read every time they spawn. Cheaper than reaching through
    // three nodes per voice, and it keeps the drunk maths in one place.
    this.drunkDetune = 0;
    this.drunkRate = 1;
    this.sendScale = 1;

    // Listener frame, packed flat so panFor allocates nothing in a hot path.
    this._lp = [0, 1.6, 6];
    this._lr = [1, 0, 0];
    this._lf = [0, 0, -1];
    this.camera = null;
  }

  _makeBus(name, gain, sends) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = gain;
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    an.smoothingTimeConstant = 0.6;
    g.connect(an);
    g.connect(this.preMaster);

    const rev = ctx.createGain();
    rev.gain.value = sends.rev;
    g.connect(rev);
    rev.connect(this.convolver);

    const slap = ctx.createGain();
    slap.gain.value = sends.slap;
    g.connect(slap);
    slap.connect(this.slapDelay);

    this.buses[name] = g;
    this.analysers[name] = an;
    g._revSend = rev;
    g._slapSend = slap;
    g._baseGain = gain;
    g._baseRev = sends.rev;
    return g;
  }

  bus(name) { return this.buses[name] || this.buses.sfx; }

  get now() { return this.ctx.currentTime; }

  // Lazily built so a Mixer constructed before a user gesture costs nothing.
  get noise() {
    if (!this._noiseBuf) this._noiseBuf = makeNoiseBuffer(this.ctx, 2);
    return this._noiseBuf;
  }

  // A one-shot voice reading a random window of the shared bed. The random
  // offset is what stops twenty footsteps sounding like the same footstep.
  noiseSource(rate = 1, loop = false) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.playbackRate.value = rate;
    s.loop = loop;
    if (loop) { s.loopStart = 0; s.loopEnd = this.noise.duration; }
    return s;
  }

  // Safe to call at any time. Browsers only honour it inside a gesture, and a
  // rejected resume is not an error worth propagating to the game loop.
  resume() {
    if (this.ctx.state === 'suspended' && this.ctx.resume) {
      return this.ctx.resume().catch(() => {});
    }
    return Promise.resolve();
  }

  // 0..1. Muffled, swimmy and too loud, in that order of audibility.
  setDrunk(v) {
    const d = clamp01(v);
    this.drunk = d;
    const now = this.ctx.currentTime;
    // 20 kHz to 1.4 kHz is the difference between "in the room" and "head
    // underwater", and it is exponential because hearing is.
    const cutoff = 20000 * Math.pow(0.07, d);
    this.drunkLP.frequency.cancelScheduledValues(now);
    this.drunkLP.frequency.setTargetAtTime(cutoff, now, 0.25);
    this.drunkLP.Q.setTargetAtTime(0.7 + d * 3.2, now, 0.25);
    this.wobbleDepth.gain.setTargetAtTime(cutoff * 0.34 * d, now, 0.25);
    this.wobbleLFO.frequency.setTargetAtTime(0.28 + d * 0.5, now, 0.3);
    // Everything gets louder and wetter, the way a bar does at 2am.
    this.masterGain.gain.setTargetAtTime((this.cfg.master ?? 0.85) * (1 + d * 0.22), now, 0.3);
    this.sendScale = 1 + d * 1.35;
    for (const k in this.buses) {
      const b = this.buses[k];
      b._revSend.gain.setTargetAtTime(b._baseRev * this.sendScale, now, 0.3);
    }
    this.drunkDetune = d * 22;          // cents, applied by voices
    this.drunkRate = 1 - d * 0.045;     // everything sags a little flat
  }

  setHype(v) { this.hype = clamp01(v); }

  // Fast pump keyed off the kick. Called by music.js on every kick hit.
  sidechain(time, amount = 0.55, release = 0.26) {
    const p = this.sidechainGain.gain;
    const t = Math.max(time, this.ctx.currentTime);
    p.cancelScheduledValues(t);
    p.setValueAtTime(1 - clamp01(amount), t);
    p.linearRampToValueAtTime(1 - clamp01(amount) * 0.55, t + release * 0.35);
    p.setTargetAtTime(1, t + release * 0.35, release * 0.5);
  }

  // Slow duck for the KO slow motion and cinematic beats.
  duckMusic(amount = 0.65, hold = 1.6, fade = 0.35) {
    const p = this.musicDuck.gain;
    const t = this.ctx.currentTime;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(1 - clamp01(amount), t + 0.08);
    p.setValueAtTime(1 - clamp01(amount), t + hold);
    p.linearRampToValueAtTime(1, t + hold + fade);
  }

  setListener(camera) {
    this.camera = camera;
    this.syncListener();
  }

  // Pulls the camera basis into flat arrays. Called on demand, not per frame,
  // because a punch needs the pose at the instant it fires and nothing else.
  syncListener() {
    const cam = this.camera;
    if (!cam || !cam.matrixWorld) return;
    const e = cam.matrixWorld.elements;
    this._lr[0] = e[0]; this._lr[1] = e[1]; this._lr[2] = e[2];
    // Column 2 of a THREE matrix points backwards, so forward is its negation.
    this._lf[0] = -e[8]; this._lf[1] = -e[9]; this._lf[2] = -e[10];
    this._lp[0] = e[12]; this._lp[1] = e[13]; this._lp[2] = e[14];
  }

  // Manual stereo pan plus distance rolloff. Cheaper than a PannerNode per
  // voice and it cannot drift out of sync with the render camera, because it
  // reads the same matrix the frame was drawn with.
  panFor(pos, out) {
    out.pan = 0; out.gain = 1; out.dist = 0;
    if (!pos) return out;
    this.syncListener();
    const dx = pos.x - this._lp[0], dy = (pos.y ?? 0) - this._lp[1], dz = pos.z - this._lp[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    out.dist = dist;
    const inv = dist > 1e-4 ? 1 / dist : 0;
    const side = (dx * this._lr[0] + dy * this._lr[1] + dz * this._lr[2]) * inv;
    out.pan = clamp(side * 0.92, -1, 1);
    // Inverse distance with a 3.2 m reference: audible falloff across a 19 m
    // room without a sound ever vanishing entirely.
    const ref = 3.2;
    out.gain = ref / (ref + Math.max(0, dist - ref) * 0.85);
    return out;
  }

  meter(name) {
    const an = name === 'master' ? this.masterAnalyser : this.analysers[name];
    if (!an) return 0;
    const n = Math.min(this._meterBuf.length, an.frequencyBinCount);
    an.getByteTimeDomainData(this._meterBuf);
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const v = Math.abs(this._meterBuf[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    return peak;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    try { this.wobbleLFO.stop(); } catch (e) { /* not started */ }
    try { this.masterGain.disconnect(); } catch (e) { /* already gone */ }
    try { this.preMaster.disconnect(); } catch (e) { /* already gone */ }
    for (const k in this.buses) { try { this.buses[k].disconnect(); } catch (e) { /* already gone */ } }
  }
}
