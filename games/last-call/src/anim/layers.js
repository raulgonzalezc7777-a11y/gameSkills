// Pose buffers and the layer stack.
//
// A pose is one flat Float32Array so that blending is a tight indexed loop with
// zero property lookups and zero allocation. Rotations are stored as Euler XYZ
// triples because additive layering (guard sway, hit reactions, drunk wobble)
// is a plain componentwise add in that space, and every rotation this rig uses
// stays far from gimbal lock.
import { clamp01, expDamp } from '../core/math.js';

// Frozen by the CHARACTER contract. Index order is ours, not theirs.
export const BONES = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'shoulderL', 'upperArmL', 'forearmL', 'handL',
  'shoulderR', 'upperArmR', 'forearmR', 'handR',
  'thighL', 'shinL', 'footL',
  'thighR', 'shinR', 'footR'
];
export const NB = BONES.length;
export const BI = {};
for (let i = 0; i < NB; i++) BI[BONES[i]] = i;

// Pose layout.
export const OFF_ROT = 0;             // NB * 3 euler floats
export const OFF_HIP = NB * 3;        // hips position, 3 floats, local to the rig group
export const OFF_IKT = NB * 3 + 3;    // 4 IK targets * 3 floats, local to the rig group
export const OFF_IKW = NB * 3 + 15;   // 4 IK weights
export const POSE_SIZE = NB * 3 + 19;

export const IK_HAND_L = 0, IK_HAND_R = 1, IK_FOOT_L = 2, IK_FOOT_R = 3;
// Which bone each IK slot is masked by, so an upper body mask also gates the
// hand targets it is supposed to own.
export const IK_BONE = [BI.handL, BI.handR, BI.footL, BI.footR];

export const createPose = () => new Float32Array(POSE_SIZE);

export function zeroPose(p) { p.fill(0); }
export function copyPose(dst, src) { dst.set(src); }

export function lerpPose(out, a, b, t) {
  if (t <= 0) { out.set(a); return out; }
  if (t >= 1) { out.set(b); return out; }
  for (let i = 0; i < POSE_SIZE; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

// out = a - b, used to turn a clip into an additive delta over its own rest key.
export function subPose(out, a, b) {
  for (let i = 0; i < POSE_SIZE; i++) out[i] = a[i] - b[i];
  return out;
}

// Additive accumulate. 'mask' is an optional per bone weight array. IK weights
// are never additive: a layer may nudge a target, not decide the solver runs.
export function addPose(out, add, w, mask) {
  if (w === 0) return out;
  for (let b = 0; b < NB; b++) {
    const m = mask ? mask[b] * w : w;
    if (m === 0) continue;
    const o = b * 3;
    out[o] += add[o] * m;
    out[o + 1] += add[o + 1] * m;
    out[o + 2] += add[o + 2] * m;
  }
  const hm = mask ? mask[BI.hips] * w : w;
  out[OFF_HIP] += add[OFF_HIP] * hm;
  out[OFF_HIP + 1] += add[OFF_HIP + 1] * hm;
  out[OFF_HIP + 2] += add[OFF_HIP + 2] * hm;
  for (let k = 0; k < 4; k++) {
    const km = mask ? mask[IK_BONE[k]] * w : w;
    if (km === 0) continue;
    const o = OFF_IKT + k * 3;
    out[o] += add[o] * km;
    out[o + 1] += add[o + 1] * km;
    out[o + 2] += add[o + 2] * km;
  }
  return out;
}

// Per bone masks. Written once at module load, read only afterwards.
function mask(spec, fill = 0) {
  const m = new Float32Array(NB).fill(fill);
  for (const k in spec) m[BI[k]] = spec[k];
  return m;
}

export const MASK_ALL = new Float32Array(NB).fill(1);

// Upper body: full weight on the arms, tapering down the spine so a punch does
// not snap the hips around while the legs are running a walk cycle.
export const MASK_UPPER = mask({
  hips: 0.25, spine: 0.55, chest: 0.9, neck: 0.8, head: 0.6,
  shoulderL: 1, upperArmL: 1, forearmL: 1, handL: 1,
  shoulderR: 1, upperArmR: 1, forearmR: 1, handR: 1
});

export const MASK_ARMS = mask({
  shoulderL: 1, upperArmL: 1, forearmL: 1, handL: 1,
  shoulderR: 1, upperArmR: 1, forearmR: 1, handR: 1
});

export const MASK_HEAD = mask({ chest: 0.25, neck: 0.75, head: 1 });

export const MASK_LOWER = mask({
  hips: 1, spine: 0.4,
  thighL: 1, shinL: 1, footL: 1, thighR: 1, shinR: 1, footR: 1
});

// Spine chain only, for follow through and overshoot.
export const MASK_SPINE = mask({ hips: 0.6, spine: 1, chest: 1, neck: 0.7, head: 0.45 });

export class Layer {
  constructor(name, opts = {}) {
    this.name = name;
    this.pose = createPose();
    this.weight = opts.weight ?? 0;
    this.target = this.weight;
    this.rate = opts.rate ?? 14;
    this.mask = opts.mask ?? null;
    this.additive = opts.additive !== false;
    this.userScale = 1; // what setLayerWeight() from the outside controls
  }
  get effective() { return this.weight * this.userScale; }
}

export class LayerStack {
  constructor() {
    this.list = [];
    this.byName = new Map();
  }
  add(name, opts) {
    const l = new Layer(name, opts);
    this.list.push(l);
    this.byName.set(name, l);
    return l;
  }
  get(name) { return this.byName.get(name); }
  setTarget(name, w, immediate = false) {
    const l = this.byName.get(name);
    if (!l) return;
    l.target = clamp01(w);
    if (immediate) l.weight = l.target;
  }
  setUserScale(name, w) {
    const l = this.byName.get(name);
    if (l) l.userScale = clamp01(w);
  }
  update(dt) {
    for (let i = 0; i < this.list.length; i++) {
      const l = this.list[i];
      l.weight = expDamp(l.weight, l.target, l.rate, dt);
      if (Math.abs(l.weight - l.target) < 0.0015) l.weight = l.target;
    }
  }
  // Fold every additive layer into 'out', which already holds the base pose.
  apply(out) {
    for (let i = 0; i < this.list.length; i++) {
      const l = this.list[i];
      if (!l.additive) continue;
      const w = l.effective;
      if (w <= 0.0005) continue;
      addPose(out, l.pose, w, l.mask);
    }
    return out;
  }
}

// Weighted accumulate for the locomotion blendspace: out += src * w across
// every channel, IK slots included, because a blendspace owns its own targets.
export function accumPose(out, src, w) {
  if (w === 0) return out;
  for (let i = 0; i < POSE_SIZE; i++) out[i] += src[i] * w;
  return out;
}

// A kick needs the swinging leg as well as the torso, but must still leave the
// support leg to the locomotion base underneath.
export const MASK_KICK = mask({
  hips: 0.7, spine: 0.85, chest: 1, neck: 0.9, head: 0.7,
  shoulderL: 1, upperArmL: 1, forearmL: 1, handL: 1,
  shoulderR: 1, upperArmR: 1, forearmR: 1, handR: 1,
  thighR: 1, shinR: 1, footR: 1, thighL: 0.45, shinL: 0.45, footL: 0.45
});

// A hit reaction travels further down the body than a punch does: the knees
// buckle a little even on a light flinch.
export const MASK_HIT = mask({
  hips: 0.85, spine: 1, chest: 1, neck: 1, head: 1,
  shoulderL: 1, upperArmL: 1, forearmL: 1, handL: 1,
  shoulderR: 1, upperArmR: 1, forearmR: 1, handR: 1,
  thighL: 0.6, shinL: 0.6, footL: 0.35, thighR: 0.6, shinR: 0.6, footR: 0.35
});
