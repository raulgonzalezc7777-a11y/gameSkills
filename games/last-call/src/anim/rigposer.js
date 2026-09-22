import * as THREE from 'three';
import { lerp, clamp01, damp, TAU } from '../core/math.js';

// Version 1 procedural poser: a boxing stance with breathing, a locomotion
// cycle, drunk sway and simple punch poses. The ANIM owner replaces this with
// a layered state machine, IK and ragdoll blending.
const _e = new THREE.Euler();

export class RigPoser {
  constructor(rig) {
    this.rig = rig;
    this.bones = rig.bones;
    this.t = 0;
    this.punch = { arm: null, t: 0, dur: 0.34, kind: 'jab' };
    this.rest = {};
    for (const [k, b] of Object.entries(this.bones)) this.rest[k] = b.rotation.clone();
  }

  play(kind = 'jab') {
    const arm = kind === 'cross' || kind === 'uppercut' ? 'R' : kind === 'hook' ? 'L' : 'R';
    this.punch = { arm, t: 0, dur: kind === 'uppercut' ? 0.44 : 0.32, kind };
  }

  update(dt, state = {}) {
    this.t += dt;
    const B = this.bones;
    const speed = state.speed ?? 0;
    const drunk = state.drunk ?? 0;
    const t = this.t;

    // Reset toward rest so layers are additive over a clean base.
    for (const [k, b] of Object.entries(B)) {
      const r = this.rest[k];
      b.rotation.set(
        damp(b.rotation.x, r.x, 0.5, dt),
        damp(b.rotation.y, r.y, 0.5, dt),
        damp(b.rotation.z, r.z, 0.5, dt)
      );
    }

    // Boxing guard.
    const guard = clamp01(1 - speed * 0.12);
    for (const s of ['L', 'R']) {
      const sign = s === 'L' ? 1 : -1;
      const ua = B['upperArm' + s], fa = B['forearm' + s];
      ua.rotation.z = lerp(ua.rotation.z, sign * 0.72, guard);
      ua.rotation.x = lerp(ua.rotation.x, -0.35, guard);
      fa.rotation.z = lerp(fa.rotation.z, sign * 1.55, guard);
      fa.rotation.y = lerp(fa.rotation.y, -sign * 0.45, guard);
    }
    B.chest.rotation.y = lerp(B.chest.rotation.y, -0.28, guard);
    B.hips.rotation.y = lerp(B.hips.rotation.y, -0.18, guard);

    // Breathing + idle weight shift.
    const breathe = Math.sin(t * 1.9) * 0.02;
    B.chest.rotation.x += breathe;
    B.spine.rotation.x += breathe * 0.5;

    // Locomotion: a two-beat cycle driven by ground speed.
    const cycle = t * (2.2 + speed * 1.35);
    const gait = clamp01(speed / 3.2);
    const swing = Math.sin(cycle * TAU * 0.5);
    B.thighL.rotation.x = lerp(B.thighL.rotation.x, swing * 0.62 * gait, 0.8);
    B.thighR.rotation.x = lerp(B.thighR.rotation.x, -swing * 0.62 * gait, 0.8);
    B.shinL.rotation.x = lerp(B.shinL.rotation.x, Math.max(0, -swing) * 0.85 * gait, 0.8);
    B.shinR.rotation.x = lerp(B.shinR.rotation.x, Math.max(0, swing) * 0.85 * gait, 0.8);
    B.hips.position.y = 0.98 + Math.abs(Math.sin(cycle * TAU)) * 0.028 * gait - gait * 0.03;

    // Drunk layer: low-frequency noise on the spine and head.
    if (drunk > 0) {
      const d = drunk;
      B.hips.rotation.z += Math.sin(t * 0.83) * 0.11 * d;
      B.spine.rotation.z += Math.sin(t * 0.61 + 1.1) * 0.13 * d;
      B.chest.rotation.x += Math.sin(t * 0.47 + 2.2) * 0.09 * d;
      B.head.rotation.z += Math.sin(t * 0.71 + 0.4) * 0.18 * d;
      B.head.rotation.x += Math.sin(t * 0.53 + 3.1) * 0.12 * d;
      B.hips.position.x = Math.sin(t * 0.67) * 0.035 * d;
    }

    // Punch layer.
    const p = this.punch;
    if (p.arm) {
      p.t += dt;
      const k = clamp01(p.t / p.dur);
      // Fast out, slow back: the classic impact curve.
      const ext = k < 0.35 ? Math.pow(k / 0.35, 0.55) : 1 - Math.pow((k - 0.35) / 0.65, 1.6);
      const s = p.arm, sign = s === 'L' ? 1 : -1;
      const ua = B['upperArm' + s], fa = B['forearm' + s];
      if (p.kind === 'uppercut') {
        ua.rotation.x -= ext * 1.15; ua.rotation.z = lerp(ua.rotation.z, sign * 0.35, ext);
        fa.rotation.z = lerp(fa.rotation.z, sign * 0.55, ext);
      } else if (p.kind === 'hook') {
        ua.rotation.y -= sign * ext * 1.25; ua.rotation.z = lerp(ua.rotation.z, sign * 0.25, ext);
        fa.rotation.z = lerp(fa.rotation.z, sign * 1.2, ext);
      } else {
        ua.rotation.x -= ext * 1.35; ua.rotation.z = lerp(ua.rotation.z, sign * 0.12, ext);
        fa.rotation.z = lerp(fa.rotation.z, sign * 0.08, ext);
      }
      B.chest.rotation.y += -sign * ext * 0.45;
      B.hips.rotation.y += -sign * ext * 0.22;
      if (k >= 1) p.arm = null;
    }
  }
}
