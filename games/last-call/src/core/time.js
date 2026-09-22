import { clamp } from './math.js';
import { bus, EV } from './events.js';

// Owns the one authoritative clock. Hitstop and slow motion are the two
// levers combat pulls to sell an impact, so they live here rather than
// being scattered through gameplay code.
class TimeController {
  constructor() {
    this.raw = 0;          // unscaled seconds since boot
    this.elapsed = 0;      // scaled seconds
    this.dt = 0;           // scaled delta, clamped
    this.rawDt = 0;
    this.scale = 1;
    this.targetScale = 1;
    this.hitstop = 0;
    this.slowmo = 0;
    this.frame = 0;
    this.fps = 60;
    this._fpsAcc = 0; this._fpsFrames = 0;
    this._last = 0;

    bus.on(EV.HITSTOP, (d) => this.addHitstop(d));
    bus.on(EV.SLOWMO, ({ duration, scale }) => this.addSlowmo(duration, scale));
  }

  addHitstop(duration) { this.hitstop = Math.max(this.hitstop, clamp(duration, 0, 0.5)); }
  addSlowmo(duration, scale = 0.25) { this.slowmo = Math.max(this.slowmo, duration); this._slowScale = scale; }

  tick(nowMs) {
    if (!this._last) this._last = nowMs;
    let rawDt = (nowMs - this._last) / 1000;
    this._last = nowMs;
    rawDt = clamp(rawDt, 0, 0.1); // a stalled tab must not teleport the sim
    this.rawDt = rawDt;
    this.raw += rawDt;

    if (this.hitstop > 0) {
      this.hitstop -= rawDt;
      this.targetScale = 0.02;
    } else if (this.slowmo > 0) {
      this.slowmo -= rawDt;
      this.targetScale = this._slowScale ?? 0.25;
    } else {
      this.targetScale = 1;
    }
    // Ease so leaving hitstop does not pop.
    this.scale += (this.targetScale - this.scale) * (this.targetScale < this.scale ? 1 : 0.22);

    this.dt = rawDt * this.scale;
    this.elapsed += this.dt;
    this.frame++;

    this._fpsAcc += rawDt; this._fpsFrames++;
    if (this._fpsAcc >= 0.5) { this.fps = this._fpsFrames / this._fpsAcc; this._fpsAcc = 0; this._fpsFrames = 0; }
    return this.dt;
  }
}

export const time = new TimeController();
