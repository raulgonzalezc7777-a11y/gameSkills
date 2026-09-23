import { Mixer } from './mixer.js';
import { SfxKit, CrowdBed, voiceOf, SFX_NAMES } from './sfx.js';
import { MusicEngine } from './music.js';
import { CFG } from '../core/config.js';
import { clamp01 } from '../core/math.js';

// The one object the rest of the game talks to. Everything below it (mixer,
// synths, crowd, track) is an implementation detail.
//
// Nothing here throws before init(), and init() itself is safe to call before a
// user gesture: the context is created suspended and resumes on the first real
// click or key. Autoplay policy is a browser fact, not an error condition, so
// it is handled here rather than pushed onto main.js.

const GESTURES = ['pointerdown', 'keydown', 'touchstart'];

export class AudioEngine {
  constructor(opts = {}) {
    this.opts = opts;
    this.ready = false;
    this.ctx = opts.context || null;
    this.mixer = null;
    this.sfx = null;
    this.crowd = null;
    this._music = null;
    this._initing = null;
    this._disposed = false;
    this._tickTimer = null;
    this._beatCbs = new Set();
    this._offBeat = null;
    this._gestureOff = null;
    this._drunk = 0;
    this._hype = 0;
    this._lastHypeSent = -1;

    // Intent recorded before init so main.js can call audio.music.start() on
    // the title screen and have it happen the moment the context exists.
    this._want = { playing: false, intensity: 0.7, lastCall: false };

    const self = this;
    this.music = {
      start() { self._want.playing = true; if (self._music) self._music.start(); },
      stop(fade) { self._want.playing = false; if (self._music) self._music.stop(fade); },
      setIntensity(v) { self._want.intensity = clamp01(v); if (self._music) self._music.setIntensity(v); },
      lastCall(on = true) { self._want.lastCall = !!on; if (self._music) self._music.lastCall(on); },
      get engine() { return self._music; },
      get bpm() { return self._music ? self._music.bpm : 126; },
      get playing() { return self._music ? self._music.playing : false; }
    };
  }

  async init() {
    if (this.ready) return this;
    if (this._initing) return this._initing;
    this._initing = this._boot();
    await this._initing;
    return this;
  }

  async _boot() {
    if (!this.ctx) {
      const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return this;   // no Web Audio: the game runs, it is just silent
      this.ctx = new AC({ latencyHint: 'interactive' });
    }
    this.mixer = new Mixer(this.ctx, CFG.audio);
    this.sfx = new SfxKit(this.mixer, this.opts.seed);
    this.crowd = new CrowdBed(this.mixer, this.sfx);
    this._music = new MusicEngine(this.mixer, { offline: !!this.opts.offline });

    this.mixer.setDrunk(this._drunk);
    this._music.setIntensity(this._want.intensity);
    if (this._want.lastCall) this._music.lastCall(true);
    this._offBeat = this._music.onBeat((beat, bar, t) => {
      for (const cb of this._beatCbs) {
        try { cb(beat, bar, t); } catch (e) { console.warn('[audio:onBeat]', e); }
      }
    });

    this.ready = true;
    this.crowd.start();
    this.crowd.setHype(this._hype);
    if (this._want.playing) this._music.start();

    await this.mixer.resume();
    if (this.ctx.state === 'suspended') this._armGesture();

    // One timer drives the crowd scheduler and the voice sweep. The game loop
    // is not involved, so audio keeps breathing through a hitstop.
    if (!this.opts.offline && typeof setInterval === 'function') {
      this._tickTimer = setInterval(() => this._tick(), 120);
    }
    return this;
  }

  _armGesture() {
    if (this._gestureOff || typeof window === 'undefined') return;
    const go = () => { this.mixer && this.mixer.resume(); this._disarmGesture(); };
    for (const g of GESTURES) window.addEventListener(g, go, { once: true, passive: true });
    this._gestureOff = () => { for (const g of GESTURES) window.removeEventListener(g, go); };
  }

  _disarmGesture() {
    if (this._gestureOff) { this._gestureOff(); this._gestureOff = null; }
  }

  _tick() {
    if (!this.ready || this._disposed) return;
    const now = this.ctx.currentTime;
    this.crowd.schedule(now, now + 0.4);
    this.sfx._retire(now);
  }

  // --- public surface ----------------------------------------------------

  play(name, opts) {
    if (!this.ready) return 0;
    return this.sfx.play(name, opts || EMPTY);
  }

  // Convenience for the event wiring: a fighter's own voice, already resolved.
  voice(fighter) { return voiceOf(fighter); }

  surgeCrowd(kind, power) {
    if (!this.ready) return 0;
    return this.crowd.surge(kind, power);
  }

  setDrunk(v) {
    this._drunk = clamp01(v);
    if (this.ready) this.mixer.setDrunk(this._drunk);
  }

  setHype(v) {
    const h = clamp01(v);
    this._hype = h;
    if (!this.ready) return;
    // The crowd bed is already smoothed with setTargetAtTime, so pushing it
    // every frame would just burn automation events for nothing.
    if (Math.abs(h - this._lastHypeSent) < 0.02) return;
    this._lastHypeSent = h;
    this.mixer.setHype(h);
    this.crowd.setHype(h);
  }

  setListener(camera) {
    this.camera = camera;
    if (this.ready) this.mixer.setListener(camera);
  }

  onBeat(cb) {
    this._beatCbs.add(cb);
    return () => this._beatCbs.delete(cb);
  }

  duck(amount, hold, fade) {
    if (this.ready) this.mixer.duckMusic(amount, hold, fade);
  }

  // Optional: the game loop may call this instead of relying on the timer.
  update(dt) { if (this.ready) this._tick(); }

  meter(bus) { return this.ready ? this.mixer.meter(bus) : 0; }

  get names() { return SFX_NAMES; }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
    this._disarmGesture();
    if (this._offBeat) this._offBeat();
    this._beatCbs.clear();
    try { this._music && this._music.dispose(); } catch (e) { /* already gone */ }
    try { this.crowd && this.crowd.dispose(); } catch (e) { /* already gone */ }
    try { this.mixer && this.mixer.dispose(); } catch (e) { /* already gone */ }
    if (this.ctx && this.ctx.close && !this.opts.context) {
      try { this.ctx.close(); } catch (e) { /* already closed */ }
    }
    this.ready = false;
  }
}

const EMPTY = {};
export default AudioEngine;
