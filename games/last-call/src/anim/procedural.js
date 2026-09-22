// Secondary motion and the drunk layer. Everything here produces additive
// deltas over whatever the base pose is doing, which is why a stumble reads the
// same whether the fighter is standing still or walking.
import { BI, OFF_ROT, OFF_HIP, OFF_IKT, IK_FOOT_L, IK_FOOT_R, zeroPose } from './layers.js';
import { clamp, clamp01, lerp, expDamp, spring, wrapAngle, TAU } from '../core/math.js';
import { rng } from '../core/rng.js';

// Channel index helpers, resolved once.
const R = (bone, axis) => OFF_ROT + BI[bone] * 3 + axis;
const RX = 0, RY = 1, RZ = 2;

const HIPS_X = R('hips', RX), HIPS_Y = R('hips', RY), HIPS_Z = R('hips', RZ);
const SPINE_X = R('spine', RX), SPINE_Y = R('spine', RY), SPINE_Z = R('spine', RZ);
const CHEST_X = R('chest', RX), CHEST_Y = R('chest', RY), CHEST_Z = R('chest', RZ);
const NECK_X = R('neck', RX), NECK_Y = R('neck', RY), NECK_Z = R('neck', RZ);
const HEAD_X = R('head', RX), HEAD_Y = R('head', RY), HEAD_Z = R('head', RZ);
const UAL_Z = R('upperArmL', RZ), UAL_Y = R('upperArmL', RY), UAL_X = R('upperArmL', RX);
const UAR_Z = R('upperArmR', RZ), UAR_Y = R('upperArmR', RY), UAR_X = R('upperArmR', RX);
const FAL_Z = R('forearmL', RZ), FAR_Z = R('forearmR', RZ);
const SHL_Z = R('shoulderL', RZ), SHR_Z = R('shoulderR', RZ);
const THL_X = R('thighL', RX), THR_X = R('thighR', RX);
const SHIN_L_X = R('shinL', RX), SHIN_R_X = R('shinR', RX);

// Sum of sines, irrational ratios so the pattern never visibly repeats.
const wobble = (t, f, p) => Math.sin(t * f + p) * 0.62 + Math.sin(t * f * 2.317 + p * 1.7) * 0.26 + Math.sin(t * f * 0.431 + p * 0.3) * 0.12;

export class Secondary {
  constructor() {
    this.t = 0;
    this.breath = 0;
    this.prevFacing = 0;
    this.turnRate = 0;
    this.lagYaw = 0; this.lagYawS = { v: 0 };     // spine follow through
    this.headYaw = 0;                              // head trails the chest
    this.headPitch = 0;
    this.leanF = 0; this.leanFS = { v: 0 };        // weight shift, forward
    this.leanR = 0; this.leanRS = { v: 0 };        // weight shift, lateral
    this.prevVx = 0; this.prevVz = 0;
    this.slump = 0;
    this.bounceS = { v: 0 };
    this.bounce = 0;
  }

  // ctx: {facing, localAccelF, localAccelR, speed01, stamina01, health01, dt}
  update(dt, ctx, pose) {
    zeroPose(pose);
    this.t += dt;
    const t = this.t;

    // --- spine follow through -------------------------------------------
    // The hips turn first, the chest arrives late and overshoots. The spring
    // is deliberately under damped: that overshoot is the whole effect.
    const dFace = wrapAngle(ctx.facing - this.prevFacing);
    this.prevFacing = ctx.facing;
    const inst = dt > 1e-5 ? dFace / dt : 0;
    this.turnRate = expDamp(this.turnRate, inst, 12, dt);
    const lagTarget = clamp(-this.turnRate * 0.085, -0.5, 0.5);
    this.lagYaw = spring(this.lagYaw, lagTarget, this.lagYawS, 150, dt);
    this.lagYaw = clamp(this.lagYaw, -0.6, 0.6);
    pose[SPINE_Y] += this.lagYaw * 0.45;
    pose[CHEST_Y] += this.lagYaw * 0.85;
    pose[HIPS_Y] += this.lagYaw * 0.12;

    // Head lag: it keeps looking where the body used to face.
    this.headYaw = expDamp(this.headYaw, this.lagYaw * 1.15, 9, dt);
    pose[NECK_Y] += this.headYaw * 0.4;
    pose[HEAD_Y] += this.headYaw * 0.75;

    // --- weight shift ----------------------------------------------------
    // Accelerate and the mass is left behind: lean into it, then settle.
    this.leanF = spring(this.leanF, clamp(ctx.accelF * 0.028, -0.30, 0.30), this.leanFS, 110, dt);
    this.leanR = spring(this.leanR, clamp(ctx.accelR * 0.030, -0.32, 0.32), this.leanRS, 95, dt);
    pose[CHEST_X] += this.leanF * 0.55;
    pose[SPINE_X] += this.leanF * 0.40;
    pose[HIPS_X] += this.leanF * 0.18;
    pose[HEAD_X] -= this.leanF * 0.30;
    pose[HIPS_Z] -= this.leanR * 0.55;
    pose[SPINE_Z] -= this.leanR * 0.30;
    pose[HEAD_Z] += this.leanR * 0.35;
    pose[OFF_HIP] += this.leanR * 0.045;
    pose[OFF_HIP + 2] += this.leanF * 0.05;

    // A landing style bob when the fighter stops hard.
    this.bounce = spring(this.bounce, clamp(-Math.abs(ctx.accelF) * 0.004, -0.05, 0), this.bounceS, 190, dt);
    pose[OFF_HIP + 1] += this.bounce;

    // --- breathing -------------------------------------------------------
    // Deeper and faster as stamina drains, and it does not stop when moving.
    const tired = 1 - clamp01(ctx.stamina01);
    const rate = lerp(1.15, 2.45, tired) + ctx.speed01 * 0.55;
    this.breath += dt * rate;
    const amp = lerp(0.018, 0.062, tired) * (1 - ctx.downWeight);
    const b = Math.sin(this.breath * TAU);
    pose[CHEST_X] += b * amp;
    pose[SPINE_X] += b * amp * 0.5;
    pose[NECK_X] -= b * amp * 0.6;
    pose[SHL_Z] += b * amp * 0.9;
    pose[SHR_Z] -= b * amp * 0.9;
    // At real exhaustion the shoulders ride up on the inhale.
    pose[OFF_HIP + 1] += b * amp * 0.25 * tired;

    // --- fatigue slump ---------------------------------------------------
    // Health, not stamina: a battered fighter carries the guard lower for good.
    const hurt = 1 - clamp01(ctx.health01);
    this.slump = expDamp(this.slump, hurt * hurt, 1.2, dt);
    const s = this.slump;
    pose[CHEST_X] += s * 0.16;
    pose[SPINE_X] += s * 0.10;
    pose[NECK_X] += s * 0.12;
    pose[HEAD_X] += s * 0.14;
    pose[OFF_HIP + 1] -= s * 0.035;
    pose[UAL_Z] += s * 0.22;
    pose[UAR_Z] -= s * 0.22;
    pose[FAL_Z] -= s * 0.30;
    pose[FAR_Z] += s * 0.30;
    pose[THL_X] += s * 0.05;
    pose[THR_X] -= s * 0.05;
    return pose;
  }
}

// ---------------------------------------------------------------------------
// The drunk layer. Three things happen as buzz climbs: the sway gets bigger and
// slower, balance starts overcorrecting instead of correcting, and the fighter
// stops being able to hold a line. It has to read at gameplay distance without
// turning into a cartoon, so the sway is mostly hips and spine, and the big
// comedy beats are rare lurches rather than constant flailing.
// ---------------------------------------------------------------------------
export class DrunkLayer {
  constructor() {
    this.t = 0;
    this.bal = 0; this.balS = { v: 0 };      // lateral balance, overcorrects
    this.balF = 0; this.balFS = { v: 0 };    // fore and aft balance
    this.lurchT = 0;
    this.lurchDir = 1;
    this.nextLurch = 4.5;
    this.lurched = false;
    this.footLag = 0;      // seconds the feet arrive late
    this.footWander = 0;   // metres of lateral error on a plant
    this.lookScale = 1;    // how well the fighter can track the opponent
    this.lookError = 0;
    this.guard = 0;        // how loose and wide the guard sits
    this.phase = rng.range(0, 10);
  }

  // Returns true on the frame a lurch starts, so the caller can emit STUMBLE.
  update(dt, drunk, ctx, pose) {
    zeroPose(pose);
    const d = clamp01(drunk);
    this.lurched = false;
    if (d <= 0.001) {
      this.footLag = 0; this.footWander = 0; this.lookScale = 1; this.guard = 0;
      return false;
    }
    this.t += dt;
    const t = this.t + this.phase;

    // Sway: low frequency, gets slower and wider with buzz. Curved response so
    // a quarter full buzz is a hint and a full one is a problem.
    const amp = d * d * 0.75 + d * 0.25;
    const slow = lerp(1.0, 0.62, d);
    pose[HIPS_Z] += wobble(t, 0.55 * slow, 0.0) * 0.14 * amp;
    pose[HIPS_X] += wobble(t, 0.41 * slow, 2.1) * 0.07 * amp;
    pose[HIPS_Y] += wobble(t, 0.33 * slow, 4.0) * 0.16 * amp;
    pose[SPINE_Z] += wobble(t, 0.47 * slow, 1.3) * 0.12 * amp;
    pose[SPINE_X] += wobble(t, 0.61 * slow, 3.2) * 0.06 * amp;
    pose[CHEST_Z] += wobble(t, 0.39 * slow, 5.1) * 0.10 * amp;
    pose[CHEST_X] += wobble(t, 0.52 * slow, 0.7) * 0.07 * amp;
    pose[HEAD_Z] += wobble(t, 0.44 * slow, 2.6) * 0.20 * amp;
    pose[HEAD_X] += wobble(t, 0.37 * slow, 4.4) * 0.13 * amp;
    pose[OFF_HIP] += wobble(t, 0.29 * slow, 1.1) * 0.05 * amp;
    pose[OFF_HIP + 2] += wobble(t, 0.35 * slow, 3.9) * 0.04 * amp;
    pose[OFF_HIP + 1] -= amp * 0.03;

    // Balance correction. A sober fighter damps its own sway; this spring is
    // under damped and driven by a wandering target, so every correction
    // overshoots and has to be corrected again.
    const stiff = lerp(60, 17, d);
    const drive = wobble(t, 0.21 * slow, 6.2) * d * 0.55;
    this.bal = spring(this.bal, drive, this.balS, stiff, dt);
    this.balF = spring(this.balF, wobble(t, 0.17 * slow, 2.8) * d * 0.40, this.balFS, stiff * 1.25, dt);
    this.bal = clamp(this.bal, -1.1, 1.1);
    this.balF = clamp(this.balF, -0.9, 0.9);

    // Lurches: rarer than the sway, and the thing the player actually notices.
    if (d > 0.3) {
      this.nextLurch -= dt * (0.5 + d * 1.8);
      if (this.nextLurch <= 0) {
        this.nextLurch = rng.range(2.6, 6.5) * lerp(2.2, 0.75, d);
        this.lurchT = rng.range(0.45, 0.8);
        this.lurchDir = rng.sign();
        this.balS.v += this.lurchDir * rng.range(3.5, 6.0) * d;
        this.balFS.v += rng.range(-2.2, 3.4) * d;
        this.lurched = true;
      }
    }
    if (this.lurchT > 0) this.lurchT = Math.max(0, this.lurchT - dt);
    const lurch = this.lurchT > 0 ? Math.sin(clamp01(this.lurchT / 0.8) * Math.PI) : 0;

    const bal = this.bal + this.lurchDir * lurch * 0.55;
    const balF = this.balF + lurch * 0.18;
    pose[HIPS_Z] += bal * 0.16;
    pose[SPINE_Z] += bal * 0.13;
    pose[CHEST_Z] += bal * 0.10;
    pose[HEAD_Z] += bal * 0.22;
    pose[OFF_HIP] += bal * 0.085;
    pose[HIPS_X] += balF * 0.12;
    pose[CHEST_X] += balF * 0.14;
    pose[OFF_HIP + 2] += balF * 0.07;
    pose[OFF_HIP + 1] -= Math.abs(bal) * 0.045 + lurch * 0.05;
    // Knees buckle a little under a lurch, which sells the lost balance.
    pose[THL_X] -= lurch * 0.18;
    pose[THR_X] += lurch * 0.14;
    pose[SHIN_L_X] += lurch * 0.26;
    pose[SHIN_R_X] += lurch * 0.22;

    // The guard opens: elbows drift out, gloves drop off the chin.
    this.guard = d;
    const g = d * d;
    pose[UAL_Z] -= g * 0.30 + bal * 0.10;
    pose[UAL_Y] -= g * 0.22;
    pose[UAL_X] += g * 0.12;
    pose[FAL_Z] -= g * 0.42 + wobble(t, 0.5 * slow, 1.9) * 0.10 * amp;
    pose[UAR_Z] += g * 0.32 - bal * 0.10;
    pose[UAR_Y] += g * 0.24;
    pose[UAR_X] += g * 0.10;
    pose[FAR_Z] += g * 0.46 + wobble(t, 0.46 * slow, 3.4) * 0.10 * amp;
    pose[SHL_Z] -= g * 0.10;
    pose[SHR_Z] += g * 0.10;

    // Feet arrive late and land in roughly the wrong place.
    this.footLag = d * d * 0.16;
    this.footWander = (d * 0.09) * (0.5 + 0.5 * wobble(t, 0.27 * slow, 5.5)) + lurch * 0.12 * this.lurchDir;
    // Tracking the opponent stops working: the head drifts off target.
    this.lookScale = lerp(1, 0.35, d * d);
    this.lookError = wobble(t, 0.23 * slow, 0.4) * d * 0.55;
    // Nudge the foot targets so the plant is visibly off, not just late.
    pose[OFF_IKT + IK_FOOT_L * 3] += this.footWander * 0.6;
    pose[OFF_IKT + IK_FOOT_R * 3] -= this.footWander * 0.6;
    return this.lurched;
  }
}

// Head and chest aim at the opponent. Angles come in already resolved into the
// rig's local frame; this only smooths them and spreads them over the chain.
export class LookAt {
  constructor() { this.yaw = 0; this.pitch = 0; }
  update(dt, wantYaw, wantPitch, rate, pose) {
    this.yaw = expDamp(this.yaw, clamp(wantYaw, -1.15, 1.15), rate, dt);
    this.pitch = expDamp(this.pitch, clamp(wantPitch, -0.55, 0.65), rate, dt);
    pose[CHEST_Y] += this.yaw * 0.18;
    pose[NECK_Y] += this.yaw * 0.30;
    pose[HEAD_Y] += this.yaw * 0.52;
    pose[CHEST_X] += this.pitch * 0.10;
    pose[NECK_X] += this.pitch * 0.35;
    pose[HEAD_X] += this.pitch * 0.55;
    return pose;
  }
}
