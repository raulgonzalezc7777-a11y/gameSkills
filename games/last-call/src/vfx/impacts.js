import { rng } from '../core/rng.js';
import { clamp } from '../core/math.js';

// Impact flashes and shockwaves. Both are just particles in the shared pools,
// so they cost no extra draw call: a flash is one MODE_FLASH quad plus a few
// stretched sparks, a shockwave is a camera-facing ring plus a ground ring.
// Keeping them here rather than inline in particles.js is what lets the timing
// of a hit be tuned without touching the simulation.
const S = {
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
  life: 1, seed: 0, sizeA: 1, sizeB: 1,
  gravity: 0, drag: 0, spin: 0,
  r: 1, g: 1, b: 1, r2: 1, g2: 1, b2: 1,
  opacity: 1, bright: 1, stretch: 0, flutter: 0
};

function reset() {
  S.vx = S.vy = S.vz = 0;
  S.gravity = 0; S.drag = 0; S.spin = 0;
  S.opacity = 1; S.bright = 1; S.stretch = 0; S.flutter = 0;
  S.seed = rng();
}

export class Impacts {
  constructor(vfx) { this.vfx = vfx; }

  // A hit spark is three layers on top of each other, which is the whole trick:
  // a white-hot core that reads as light, a coloured bloom that reads as heat,
  // and a burst of stretched sparks that gives the frame direction.
  flash(px, py, pz, dx, dy, dz, o = {}) {
    const power = clamp(o.power ?? 1, 0.25, 3);
    const sys = this.vfx.sys;
    const col = o.color;

    reset();
    S.x = px; S.y = py; S.z = pz;
    S.life = 0.11 + power * 0.045;
    S.sizeA = 0.10 * power;
    S.sizeB = 0.72 * power;
    S.r = 1; S.g = 0.97; S.b = 0.92;
    S.r2 = col ? col.r : 1.0; S.g2 = col ? col.g : 0.62; S.b2 = col ? col.b : 0.34;
    // Well above the bloom threshold, so the core blooms rather than the frame.
    S.bright = 5.2 + power * 2.4;
    sys.flash.spawn(S);

    // A second, wider and dimmer flash one tick behind gives the light a decay
    // instead of a hard off.
    reset();
    S.x = px; S.y = py; S.z = pz;
    S.life = 0.26 + power * 0.1;
    S.sizeA = 0.32 * power;
    S.sizeB = 1.25 * power;
    S.r = col ? col.r : 1.0; S.g = col ? col.g : 0.55; S.b = col ? col.b : 0.30;
    S.r2 = 0.42; S.g2 = 0.16; S.b2 = 0.30;
    S.opacity = 0.75;
    S.bright = 2.0 + power;
    sys.flash.spawn(S);

    const n = Math.round((o.count ?? 9) * power);
    for (let i = 0; i < n; i++) {
      reset();
      const sx = dx + rng.gauss(0, 0.55), sy = dy + rng.gauss(0, 0.55), sz = dz + rng.gauss(0, 0.55);
      const len = Math.hypot(sx, sy, sz) || 1;
      const sp = rng.range(3.5, 11) * power;
      S.x = px; S.y = py; S.z = pz;
      S.vx = (sx / len) * sp; S.vy = (sy / len) * sp + rng.range(0.4, 2.2); S.vz = (sz / len) * sp;
      S.life = rng.range(0.13, 0.34);
      S.sizeA = rng.range(0.012, 0.03); S.sizeB = 0.002;
      S.gravity = 6.5; S.drag = 3.2;
      S.r = 1; S.g = 0.88; S.b = 0.62;
      S.r2 = 1; S.g2 = 0.35; S.b2 = 0.18;
      S.bright = 3.6; S.stretch = 0.055;
      sys.spark.spawn(S);
    }
  }

  // The ring that sells a knockout. Two of them: one facing the camera at the
  // contact point, one flat on the floor if the hit happened low enough for a
  // ground ripple to be plausible.
  shockwave(px, py, pz, dx, dy, dz, o = {}) {
    const power = clamp(o.power ?? 1, 0.3, 3);
    const sys = this.vfx.sys;
    const col = o.color;

    reset();
    S.x = px; S.y = py; S.z = pz;
    S.life = 0.34 + power * 0.14;
    S.sizeA = 0.12 * power;
    S.sizeB = 2.4 * power;
    S.r = col ? col.r : 1.0; S.g = col ? col.g : 0.86; S.b = col ? col.b : 0.78;
    S.r2 = 0.6; S.g2 = 0.22; S.b2 = 0.42;
    S.opacity = 0.85;
    S.bright = 2.4 + power * 0.8;
    sys.ringCam.spawn(S);

    const floorY = this.vfx.floorY ?? 0;
    if (py - floorY < 1.9) {
      reset();
      S.x = px; S.y = floorY + 0.02; S.z = pz;
      S.life = 0.5 + power * 0.2;
      S.sizeA = 0.2 * power;
      S.sizeB = 3.4 * power;
      S.r = col ? col.r : 0.95; S.g = col ? col.g : 0.80; S.b = col ? col.b : 0.95;
      S.r2 = 0.35; S.g2 = 0.12; S.b2 = 0.5;
      S.opacity = 0.55;
      S.bright = 1.5 + power * 0.5;
      sys.ringFloor.spawn(S);
    }
  }
}
