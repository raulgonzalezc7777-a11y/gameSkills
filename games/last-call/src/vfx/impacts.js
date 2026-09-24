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

    // The flash sits just past the contact point along the punch, so it backs
    // the fist instead of covering it, and it stays small: the receiver's
    // reaction is the read, the flash only punctuates it. The contact is now
    // the true skin contact (hitbox.js), so the push is a few centimetres:
    // the old 15 cm was sized for a contact that sat near the middle of the
    // head, and from the skin it buried the flash inside the skull where the
    // depth test hid it.
    // It also leans toward the camera by a hand's width: the fist is sitting
    // exactly on the contact, and a depth tested flash behind it was hidden
    // by the very punch it was meant to punctuate.
    const PUSH = 0.04, LEAN = 0.10;
    let px2 = px + dx * PUSH, py2 = py + dy * PUSH, pz2 = pz + dz * PUSH;
    const cam = this.vfx.camera?.position;
    if (cam) {
      const cx = cam.x - px2, cy = cam.y - py2, cz = cam.z - pz2;
      const cl = Math.hypot(cx, cy, cz);
      if (cl > LEAN * 3) { px2 += (cx / cl) * LEAN; py2 += (cy / cl) * LEAN; pz2 += (cz / cl) * LEAN; }
    }
    reset();
    S.x = px2; S.y = py2; S.z = pz2;
    S.life = 0.09 + power * 0.035;
    S.sizeA = 0.06 * power;
    S.sizeB = 0.34 * power;
    S.r = 1; S.g = 0.9; S.b = 0.78;
    S.r2 = col ? col.r : 1.0; S.g2 = col ? col.g : 0.62; S.b2 = col ? col.b : 0.34;
    // Well above the bloom threshold, so the core blooms rather than the frame.
    S.bright = 1.3 + power * 0.45;
    sys.flash.spawn(S);

    // A second, wider and dimmer flash one tick behind gives the light a decay
    // instead of a hard off.
    reset();
    S.x = px2; S.y = py2; S.z = pz2;
    S.life = 0.2 + power * 0.08;
    S.sizeA = 0.12 * power;
    S.sizeB = 0.42 * power;
    S.r = col ? col.r : 1.0; S.g = col ? col.g : 0.55; S.b = col ? col.b : 0.30;
    S.r2 = 0.42; S.g2 = 0.16; S.b2 = 0.30;
    S.opacity = 0.75;
    S.bright = 0.7 + power * 0.25;
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
    // Earlier values ran to a five metre ring at full power, which with bloom
    // on top filled the frame with a white donut and buried the knockout it
    // was supposed to punctuate. A shockwave punctuates, it does not narrate.
    S.life = 0.26 + power * 0.08;
    S.sizeA = 0.10 * power;
    S.sizeB = 0.85 + 0.55 * power;
    S.r = col ? col.r : 1.0; S.g = col ? col.g : 0.86; S.b = col ? col.b : 0.78;
    S.r2 = 0.6; S.g2 = 0.22; S.b2 = 0.42;
    S.opacity = 0.38;
    S.bright = 0.95 + power * 0.22;
    sys.ringCam.spawn(S);

    const floorY = this.vfx.floorY ?? 0;
    if (py - floorY < 1.9) {
      reset();
      S.x = px; S.y = floorY + 0.02; S.z = pz;
      S.life = 0.42 + power * 0.14;
      S.sizeA = 0.16 * power;
      S.sizeB = 1.1 + 0.75 * power;
      S.r = col ? col.r : 0.95; S.g = col ? col.g : 0.80; S.b = col ? col.b : 0.95;
      S.r2 = 0.35; S.g2 = 0.12; S.b2 = 0.5;
      S.opacity = 0.3;
      S.bright = 0.8 + power * 0.18;
      sys.ringFloor.spawn(S);
    }
  }
}
