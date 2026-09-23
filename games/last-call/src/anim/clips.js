// Every clip in LAST CALL is authored here as sparse keyframes, because there
// are no imported animations and there never will be. A clip is a set of
// channels; a channel is a list of [time, value, ease] keys. Interpolation is
// cubic Hermite with Catmull-Rom tangents by default, which is what gives a
// three key pose the arc a hand animator would draw, and any key can override
// the segment leaving it with a named ease so a punch can snap out and settle
// slowly without extra keys.
import {
  BI, OFF_ROT, OFF_HIP, OFF_IKT, OFF_IKW, POSE_SIZE, createPose,
  IK_HAND_L, IK_HAND_R, IK_FOOT_L, IK_FOOT_R
} from './layers.js';

// Segment eases. null means cubic Hermite, the default.
const EASES = {
  cubic: null,
  lin: (t) => t,
  hold: () => 0,
  ease: (t) => t * t * (3 - 2 * t),
  in: (t) => t * t,
  in3: (t) => t * t * t,
  out: (t) => 1 - (1 - t) * (1 - t),
  out3: (t) => 1 - (1 - t) * (1 - t) * (1 - t),
  // The contact curve: almost all of the travel in the first third.
  snap: (t) => 1 - Math.pow(1 - t, 5),
  // Overshoot, for a limb that passes its target and comes back.
  back: (t) => t * t * (2.55 * t - 1.55)
};

const AXIS = { x: 0, y: 1, z: 2 };
const IK_SLOT = { HandL: IK_HAND_L, HandR: IK_HAND_R, FootL: IK_FOOT_L, FootR: IK_FOOT_R };

// "chest.y" rotation, "hip.x" hips translation, "ikHandR.z" IK target,
// "ikwHandR" IK weight.
function channelIndex(ch) {
  if (ch.startsWith('ikw')) {
    const slot = IK_SLOT[ch.slice(3)];
    if (slot === undefined) throw new Error('bad ik channel ' + ch);
    return OFF_IKW + slot;
  }
  const dot = ch.indexOf('.');
  if (dot < 0) throw new Error('bad channel ' + ch);
  const head = ch.slice(0, dot);
  const axis = AXIS[ch.slice(dot + 1)];
  if (axis === undefined) throw new Error('bad axis in ' + ch);
  if (head === 'hip') return OFF_HIP + axis;
  if (head.startsWith('ik')) {
    const slot = IK_SLOT[head.slice(2)];
    if (slot === undefined) throw new Error('bad ik channel ' + ch);
    return OFF_IKT + slot * 3 + axis;
  }
  const bi = BI[head];
  if (bi === undefined) throw new Error('unknown bone ' + head);
  return OFF_ROT + bi * 3 + axis;
}

function compileTrack(idx, keys, duration, loop) {
  const n = keys.length;
  const times = new Float64Array(n);
  const vals = new Float64Array(n);
  const eases = new Array(n);
  for (let i = 0; i < n; i++) {
    times[i] = keys[i][0];
    vals[i] = keys[i][1];
    const name = keys[i][2] || 'cubic';
    if (!(name in EASES)) throw new Error('unknown ease ' + name);
    eases[i] = EASES[name];
  }
  // Catmull-Rom tangents, wrapped for looping clips so the cycle has no seam.
  const tan = new Float64Array(n);
  if (n > 1) {
    for (let i = 0; i < n; i++) {
      if (i > 0 && i < n - 1) {
        tan[i] = (vals[i + 1] - vals[i - 1]) / (times[i + 1] - times[i - 1]);
      } else if (loop && n > 2) {
        const before = vals[n - 2], after = vals[1];
        const span = times[1] + (duration - times[n - 2]);
        tan[i] = span > 1e-6 ? (after - before) / span : 0;
      } else if (i === 0) {
        tan[i] = (vals[1] - vals[0]) / Math.max(1e-6, times[1] - times[0]);
      } else {
        tan[i] = (vals[n - 1] - vals[n - 2]) / Math.max(1e-6, times[n - 1] - times[n - 2]);
      }
    }
  }
  return { idx, n, times, vals, eases, tan };
}

function sampleTrack(tr, t) {
  const n = tr.n;
  if (n === 1) return tr.vals[0];
  const times = tr.times;
  if (t <= times[0]) return tr.vals[0];
  if (t >= times[n - 1]) return tr.vals[n - 1];
  let i = 0;
  while (i < n - 2 && times[i + 1] <= t) i++;
  const t0 = times[i], t1 = times[i + 1];
  const h = t1 - t0;
  const u = h > 1e-9 ? (t - t0) / h : 0;
  const v0 = tr.vals[i], v1 = tr.vals[i + 1];
  const ease = tr.eases[i];
  if (ease === null) {
    const m0 = tr.tan[i] * h, m1 = tr.tan[i + 1] * h;
    const u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * v0 + (u3 - 2 * u2 + u) * m0 +
           (-2 * u3 + 3 * u2) * v1 + (u3 - u2) * m1;
  }
  return v0 + (v1 - v0) * ease(u);
}

export class Clip {
  constructor(name, def) {
    this.name = name;
    this.duration = def.dur;
    this.loop = !!def.loop;
    this.additive = !!def.additive;
    this.release = def.release || null;   // which foot unplants, and when
    this.events = def.events || null;     // [{t, type}] fired once per pass
    this.tracks = [];
    for (const ch in def.tracks) {
      const keys = def.tracks[ch];
      this.tracks.push(compileTrack(channelIndex(ch), keys, this.duration, this.loop));
    }
  }
}

// Writes the clip at time t into 'out'. 'out' is expected to be zeroed by the
// caller, since a clip only owns the channels it declares.
export function sampleClip(clip, t, out) {
  let time = t;
  if (clip.loop) {
    const d = clip.duration;
    time = time % d;
    if (time < 0) time += d;
  } else {
    time = t < 0 ? 0 : t > clip.duration ? clip.duration : t;
  }
  const tracks = clip.tracks;
  for (let i = 0; i < tracks.length; i++) {
    const tr = tracks[i];
    out[tr.idx] = sampleTrack(tr, time);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The stance every clip is authored against.
//
// Rest pose contract: identity rotation is a T pose. Arm bones run along local
// X (L toward -X, R toward +X), leg bones down local -Y, hips at y 0.98. The
// fighter faces +Z. L is the lead side, R is the power side, so the torso is
// bladed by a negative Y rotation which brings the L shoulder forward.
// ---------------------------------------------------------------------------
export const GUARD = {
  'hips.y': 0.26, 'hips.x': 0.02, 'hips.z': 0.0,
  'hip.x': 0.0, 'hip.y': -0.085, 'hip.z': 0.0,
  'spine.y': 0.10, 'spine.x': 0.08, 'spine.z': 0.0,
  'chest.y': 0.16, 'chest.x': 0.10, 'chest.z': 0.0,
  'neck.y': -0.14, 'neck.x': -0.06, 'neck.z': 0.0,
  'head.y': -0.26, 'head.x': -0.10, 'head.z': 0.0,
  'shoulderL.y': -0.10, 'shoulderL.x': 0.0, 'shoulderL.z': 0.10,
  'shoulderR.y': 0.10, 'shoulderR.x': 0.0, 'shoulderR.z': -0.14,
  // Lead arm: elbow down and forward, glove by the cheek.
  'upperArmL.z': 1.16, 'upperArmL.y': 0.42, 'upperArmL.x': -0.34,
  'forearmL.z': -1.55, 'forearmL.y': -0.55, 'forearmL.x': 0.0,
  'handL.z': -0.18, 'handL.y': 0.0, 'handL.x': 0.0,
  // Power arm: tighter, glove on the chin.
  'upperArmR.z': -1.30, 'upperArmR.y': -0.30, 'upperArmR.x': -0.30,
  'forearmR.z': 1.85, 'forearmR.y': 0.62, 'forearmR.x': 0.0,
  'handR.z': 0.18, 'handR.y': 0.0, 'handR.x': 0.0,
  // Lead leg forward, power leg back, both knees loaded.
  'thighL.x': -0.30, 'thighL.y': 0.10, 'thighL.z': -0.06,
  'shinL.x': 0.46, 'shinL.y': 0.0, 'shinL.z': 0.0,
  'footL.x': -0.16, 'footL.y': 0.12, 'footL.z': 0.0,
  'thighR.x': 0.20, 'thighR.y': -0.22, 'thighR.z': 0.07,
  'shinR.x': 0.30, 'shinR.y': 0.0, 'shinR.z': 0.0,
  'footR.x': -0.44, 'footR.y': -0.16, 'footR.z': 0.0
};

// Merge the stance under a clip's own tracks so every full body clip writes
// every channel. A clip that does not mention the guard still holds it.
function fullBody(tracks) {
  const out = {};
  for (const ch in GUARD) out[ch] = [[0, GUARD[ch]]];
  for (const ch in tracks) out[ch] = tracks[ch];
  return out;
}

export const GUARD_POSE = createPose();
for (const ch in GUARD) GUARD_POSE[channelIndex(ch)] = GUARD[ch];

export const CLIPS = {};
const def = (name, d) => { CLIPS[name] = new Clip(name, { ...d, tracks: fullBody(d.tracks) }); return CLIPS[name]; };

// --- idles -----------------------------------------------------------------

def('idleGuard', {
  dur: 3.2, loop: true,
  tracks: {
    'hip.y': [[0, -0.085], [0.8, -0.070], [1.6, -0.085], [2.4, -0.072], [3.2, -0.085]],
    'hip.x': [[0, 0.0], [1.6, 0.022], [3.2, 0.0]],
    'hips.z': [[0, 0.0], [1.6, -0.035], [3.2, 0.0]],
    'chest.x': [[0, 0.10], [0.9, 0.145], [1.8, 0.10], [2.6, 0.14], [3.2, 0.10]],
    'spine.x': [[0, 0.08], [0.9, 0.105], [1.8, 0.08], [2.6, 0.10], [3.2, 0.08]],
    'chest.y': [[0, 0.16], [1.1, 0.21], [2.2, 0.13], [3.2, 0.16]],
    'head.y': [[0, -0.26], [1.1, -0.30], [2.2, -0.23], [3.2, -0.26]],
    'upperArmL.z': [[0, 1.16], [0.9, 1.10], [1.8, 1.16], [2.6, 1.11], [3.2, 1.16]],
    'upperArmR.z': [[0, -1.30], [0.9, -1.25], [1.8, -1.30], [2.6, -1.26], [3.2, -1.30]],
    'forearmL.z': [[0, -1.55], [1.1, -1.62], [2.2, -1.52], [3.2, -1.55]],
    'forearmR.z': [[0, 1.85], [1.1, 1.79], [2.2, 1.88], [3.2, 1.85]],
    'thighL.x': [[0, -0.30], [1.6, -0.26], [3.2, -0.30]],
    'thighR.x': [[0, 0.20], [1.6, 0.16], [3.2, 0.20]]
  }
});

def('idleDrunk', {
  dur: 4.6, loop: true,
  tracks: {
    'hip.x': [[0, 0.0], [1.15, 0.075], [2.3, 0.0], [3.45, -0.075], [4.6, 0.0]],
    'hip.y': [[0, -0.105], [1.5, -0.075], [3.0, -0.115], [4.6, -0.105]],
    'hip.z': [[0, 0.0], [2.3, 0.045], [4.6, 0.0]],
    'hips.z': [[0, 0.0], [1.15, 0.10], [2.3, 0.0], [3.45, -0.11], [4.6, 0.0]],
    'hips.y': [[0, 0.26], [1.6, 0.34], [3.2, 0.18], [4.6, 0.26]],
    'spine.z': [[0, 0.0], [1.4, -0.10], [2.9, 0.09], [4.6, 0.0]],
    'chest.x': [[0, 0.16], [1.5, 0.22], [3.1, 0.13], [4.6, 0.16]],
    'chest.z': [[0, 0.0], [1.15, -0.08], [3.45, 0.10], [4.6, 0.0]],
    'head.z': [[0, 0.0], [1.4, 0.16], [2.6, -0.06], [3.8, 0.13], [4.6, 0.0]],
    'head.x': [[0, -0.02], [1.6, 0.10], [3.3, -0.06], [4.6, -0.02]],
    'head.y': [[0, -0.26], [1.2, -0.36], [2.8, -0.12], [4.6, -0.26]],
    // The guard sags and spreads: elbows out, gloves off the chin.
    'upperArmL.z': [[0, 0.94], [2.3, 0.84], [4.6, 0.94]],
    'upperArmL.y': [[0, 0.30], [2.3, 0.22], [4.6, 0.30]],
    'forearmL.z': [[0, -1.32], [1.9, -1.20], [3.6, -1.38], [4.6, -1.32]],
    'upperArmR.z': [[0, -1.02], [2.3, -0.92], [4.6, -1.02]],
    'forearmR.z': [[0, 1.46], [1.9, 1.58], [3.6, 1.38], [4.6, 1.46]],
    'thighL.x': [[0, -0.26], [2.3, -0.34], [4.6, -0.26]],
    'thighR.x': [[0, 0.22], [2.3, 0.14], [4.6, 0.22]]
  }
});

// --- locomotion ------------------------------------------------------------
// Phase 0 is the left foot contact. All four cycles share the phase so the
// blendspace never crosses its feet.

def('walk', {
  dur: 1.0, loop: true,
  tracks: {
    'thighL.x': [[0, -0.46], [0.22, -0.16], [0.5, 0.30, 'out'], [0.62, 0.20], [0.78, -0.30], [1.0, -0.46]],
    'shinL.x': [[0, 0.20], [0.2, 0.06], [0.5, 0.34], [0.66, 0.92, 'out'], [0.84, 0.30], [1.0, 0.20]],
    'footL.x': [[0, -0.20], [0.16, -0.05], [0.5, -0.42], [0.68, 0.10], [0.86, -0.26], [1.0, -0.20]],
    'thighR.x': [[0, 0.30, 'out'], [0.12, 0.20], [0.28, -0.30], [0.5, -0.46], [0.72, -0.16], [1.0, 0.30]],
    'shinR.x': [[0, 0.34], [0.16, 0.92, 'out'], [0.34, 0.30], [0.5, 0.20], [0.7, 0.06], [1.0, 0.34]],
    'footR.x': [[0, -0.42], [0.18, 0.10], [0.36, -0.26], [0.5, -0.20], [0.66, -0.05], [1.0, -0.42]],
    'hip.y': [[0, -0.115], [0.25, -0.055], [0.5, -0.115], [0.75, -0.055], [1.0, -0.115]],
    'hip.x': [[0, 0.0], [0.25, 0.035], [0.5, 0.0], [0.75, -0.035], [1.0, 0.0]],
    'hips.z': [[0, 0.0], [0.25, -0.075], [0.5, 0.0], [0.75, 0.075], [1.0, 0.0]],
    'hips.y': [[0, 0.34], [0.5, 0.18], [1.0, 0.34]],
    'chest.y': [[0, 0.09], [0.5, 0.23], [1.0, 0.09]],
    'spine.x': [[0, 0.10], [0.5, 0.10], [1.0, 0.10]],
    'upperArmL.z': [[0, 1.12], [0.5, 1.20], [1.0, 1.12]],
    'upperArmL.y': [[0, 0.50], [0.5, 0.34], [1.0, 0.50]],
    'upperArmR.z': [[0, -1.26], [0.5, -1.34], [1.0, -1.26]],
    'upperArmR.y': [[0, -0.22], [0.5, -0.38], [1.0, -0.22]],
    'head.y': [[0, -0.24], [0.5, -0.30], [1.0, -0.24]]
  },
  events: [{ t: 0.02, type: 'foot', foot: 'L' }, { t: 0.52, type: 'foot', foot: 'R' }]
});

def('run', {
  dur: 0.68, loop: true,
  tracks: {
    'thighL.x': [[0, -0.78], [0.14, -0.28], [0.34, 0.52, 'out'], [0.46, 0.36], [0.56, -0.48], [0.68, -0.78]],
    'shinL.x': [[0, 0.34], [0.12, 0.10], [0.34, 0.64], [0.46, 1.42, 'out'], [0.58, 0.52], [0.68, 0.34]],
    'footL.x': [[0, -0.28], [0.12, -0.02], [0.34, -0.55], [0.48, 0.22], [0.6, -0.34], [0.68, -0.28]],
    'thighR.x': [[0, 0.52, 'out'], [0.1, 0.36], [0.22, -0.48], [0.34, -0.78], [0.48, -0.28], [0.68, 0.52]],
    'shinR.x': [[0, 0.64], [0.12, 1.42, 'out'], [0.24, 0.52], [0.34, 0.34], [0.46, 0.10], [0.68, 0.64]],
    'footR.x': [[0, -0.55], [0.14, 0.22], [0.26, -0.34], [0.34, -0.28], [0.46, -0.02], [0.68, -0.55]],
    'hip.y': [[0, -0.15], [0.17, -0.015], [0.34, -0.15], [0.51, -0.015], [0.68, -0.15]],
    'hip.x': [[0, 0.0], [0.17, 0.05], [0.34, 0.0], [0.51, -0.05], [0.68, 0.0]],
    'hips.z': [[0, 0.0], [0.17, -0.10], [0.34, 0.0], [0.51, 0.10], [0.68, 0.0]],
    'hips.y': [[0, 0.40], [0.34, 0.12], [0.68, 0.40]],
    'spine.x': [[0, 0.22], [0.34, 0.26], [0.68, 0.22]],
    'chest.x': [[0, 0.20], [0.34, 0.24], [0.68, 0.20]],
    'chest.y': [[0, 0.02], [0.34, 0.30], [0.68, 0.02]],
    // The guard drops toward a runner's pump but never fully opens.
    'upperArmL.z': [[0, 0.98], [0.34, 1.16], [0.68, 0.98]],
    'upperArmL.y': [[0, 0.72], [0.34, 0.20], [0.68, 0.72]],
    'forearmL.z': [[0, -1.68], [0.34, -1.50], [0.68, -1.68]],
    'upperArmR.z': [[0, -1.16], [0.34, -0.98], [0.68, -1.16]],
    'upperArmR.y': [[0, -0.06], [0.34, -0.58], [0.68, -0.06]],
    'forearmR.z': [[0, 1.72], [0.34, 1.90], [0.68, 1.72]],
    'head.x': [[0, -0.18], [0.34, -0.20], [0.68, -0.18]]
  },
  events: [{ t: 0.02, type: 'foot', foot: 'L' }, { t: 0.36, type: 'foot', foot: 'R' }]
});

def('backstep', {
  dur: 1.06, loop: true,
  tracks: {
    'thighL.x': [[0, 0.22], [0.26, -0.06], [0.53, -0.34], [0.8, -0.05], [1.06, 0.22]],
    'shinL.x': [[0, 0.52], [0.26, 0.74], [0.53, 0.34], [0.8, 0.30], [1.06, 0.52]],
    'footL.x': [[0, -0.30], [0.3, 0.08], [0.53, -0.34], [0.8, -0.18], [1.06, -0.30]],
    'thighR.x': [[0, -0.34], [0.27, -0.05], [0.53, 0.22], [0.79, -0.06], [1.06, -0.34]],
    'shinR.x': [[0, 0.34], [0.27, 0.30], [0.53, 0.52], [0.79, 0.74], [1.06, 0.34]],
    'footR.x': [[0, -0.34], [0.27, -0.18], [0.53, -0.30], [0.83, 0.08], [1.06, -0.34]],
    'hip.y': [[0, -0.115], [0.27, -0.075], [0.53, -0.115], [0.79, -0.075], [1.06, -0.115]],
    'hip.z': [[0, -0.02], [0.53, -0.05], [1.06, -0.02]],
    'hips.z': [[0, 0.0], [0.27, 0.05], [0.53, 0.0], [0.79, -0.05], [1.06, 0.0]],
    'spine.x': [[0, 0.02], [0.53, 0.0], [1.06, 0.02]],
    'chest.x': [[0, 0.04], [0.53, 0.02], [1.06, 0.04]],
    'head.x': [[0, -0.04], [1.06, -0.04]],
    'upperArmL.z': [[0, 1.22], [0.53, 1.26], [1.06, 1.22]],
    'upperArmR.z': [[0, -1.36], [0.53, -1.40], [1.06, -1.36]]
  },
  events: [{ t: 0.03, type: 'foot', foot: 'R' }, { t: 0.56, type: 'foot', foot: 'L' }]
});

// Shuffle steps. No crossing: the trailing foot closes after the lead foot
// opens, which is how a fighter actually moves sideways.
def('strafeL', {
  dur: 0.92, loop: true,
  tracks: {
    'thighL.z': [[0, -0.06], [0.23, -0.30], [0.5, -0.24], [0.75, -0.06], [0.92, -0.06]],
    'thighL.x': [[0, -0.26], [0.25, -0.34], [0.5, -0.28], [0.92, -0.26]],
    'shinL.x': [[0, 0.44], [0.23, 0.62], [0.5, 0.40], [0.92, 0.44]],
    'thighR.z': [[0, 0.07], [0.25, 0.24], [0.6, 0.02], [0.92, 0.07]],
    'thighR.x': [[0, 0.20], [0.5, 0.14], [0.75, 0.24], [0.92, 0.20]],
    'shinR.x': [[0, 0.30], [0.5, 0.26], [0.72, 0.60], [0.92, 0.30]],
    'hip.x': [[0, 0.0], [0.25, -0.05], [0.6, 0.03], [0.92, 0.0]],
    'hip.y': [[0, -0.10], [0.25, -0.075], [0.6, -0.105], [0.92, -0.10]],
    'hips.z': [[0, 0.0], [0.3, 0.075], [0.66, -0.04], [0.92, 0.0]],
    'chest.z': [[0, 0.0], [0.3, 0.05], [0.66, -0.03], [0.92, 0.0]],
    'head.z': [[0, 0.0], [0.3, -0.04], [0.66, 0.03], [0.92, 0.0]]
  },
  events: [{ t: 0.05, type: 'foot', foot: 'L' }, { t: 0.55, type: 'foot', foot: 'R' }]
});

def('strafeR', {
  dur: 0.92, loop: true,
  tracks: {
    'thighR.z': [[0, 0.07], [0.23, 0.32], [0.5, 0.26], [0.75, 0.07], [0.92, 0.07]],
    'thighR.x': [[0, 0.20], [0.25, 0.28], [0.5, 0.22], [0.92, 0.20]],
    'shinR.x': [[0, 0.30], [0.23, 0.50], [0.5, 0.28], [0.92, 0.30]],
    'thighL.z': [[0, -0.06], [0.25, -0.24], [0.6, -0.02], [0.92, -0.06]],
    'thighL.x': [[0, -0.30], [0.5, -0.24], [0.75, -0.34], [0.92, -0.30]],
    'shinL.x': [[0, 0.46], [0.5, 0.42], [0.72, 0.76], [0.92, 0.46]],
    'hip.x': [[0, 0.0], [0.25, 0.05], [0.6, -0.03], [0.92, 0.0]],
    'hip.y': [[0, -0.10], [0.25, -0.075], [0.6, -0.105], [0.92, -0.10]],
    'hips.z': [[0, 0.0], [0.3, -0.075], [0.66, 0.04], [0.92, 0.0]],
    'chest.z': [[0, 0.0], [0.3, -0.05], [0.66, 0.03], [0.92, 0.0]],
    'head.z': [[0, 0.0], [0.3, 0.04], [0.66, -0.03], [0.92, 0.0]]
  },
  events: [{ t: 0.05, type: 'foot', foot: 'R' }, { t: 0.55, type: 'foot', foot: 'L' }]
});

// --- attacks ---------------------------------------------------------------
// Durations match ATTACKS in combat/fighter.js (startup + active + recover) so
// the pose lands on the frame the hitbox opens. Shape: a short coil against the
// direction of travel, a snap to contact, a slow settle back to guard. The
// ikw channels hand the wrist to the arm solver around contact so the punch
// reaches the opponent instead of playing a fixed pose into thin air.

def('jab', {
  dur: 0.32,
  tracks: {
    'hips.y': [[0, 0.26], [0.035, 0.30], [0.09, 0.18, 'snap'], [0.16, 0.20], [0.32, 0.26, 'out']],
    'chest.y': [[0, 0.16], [0.035, 0.24, 'out'], [0.09, -0.16, 'snap'], [0.16, -0.12], [0.32, 0.16, 'out']],
    'chest.x': [[0, 0.10], [0.035, 0.06], [0.09, 0.16, 'snap'], [0.32, 0.10, 'out']],
    'shoulderL.y': [[0, -0.10], [0.035, -0.02], [0.09, -0.34, 'snap'], [0.32, -0.10, 'out']],
    'upperArmL.z': [[0, 1.16], [0.035, 1.22], [0.09, 0.26, 'snap'], [0.16, 0.30], [0.32, 1.16, 'out']],
    'upperArmL.y': [[0, 0.42], [0.035, 0.30], [0.09, 1.06, 'snap'], [0.16, 1.02], [0.32, 0.42, 'out']],
    'upperArmL.x': [[0, -0.34], [0.09, -0.06, 'snap'], [0.32, -0.34, 'out']],
    'forearmL.z': [[0, -1.55], [0.035, -1.72], [0.09, -0.16, 'snap'], [0.16, -0.20], [0.32, -1.55, 'out']],
    'forearmL.y': [[0, -0.55], [0.09, -0.08, 'snap'], [0.32, -0.55, 'out']],
    'handL.z': [[0, -0.18], [0.09, -0.02], [0.32, -0.18]],
    'head.y': [[0, -0.26], [0.09, -0.06], [0.32, -0.26]],
    'thighL.x': [[0, -0.30], [0.09, -0.40, 'snap'], [0.32, -0.30, 'out']],
    'thighR.x': [[0, 0.20], [0.09, 0.30, 'snap'], [0.32, 0.20, 'out']],
    'hip.z': [[0, 0.0], [0.09, 0.055, 'snap'], [0.2, 0.03], [0.32, 0.0, 'out']],
    'ikwHandL': [[0, 0, 'lin'], [0.06, 0.85, 'lin'], [0.17, 0.85, 'lin'], [0.24, 0, 'lin']]
  }
});

def('cross', {
  dur: 0.46,
  tracks: {
    'hips.y': [[0, 0.26], [0.05, 0.34, 'out'], [0.14, -0.20, 'snap'], [0.22, -0.18], [0.46, 0.26, 'out']],
    'chest.y': [[0, 0.16], [0.05, 0.30, 'out'], [0.14, -0.40, 'snap'], [0.22, -0.36], [0.46, 0.16, 'out']],
    'chest.x': [[0, 0.10], [0.05, 0.04], [0.14, 0.18, 'snap'], [0.46, 0.10, 'out']],
    'spine.y': [[0, 0.10], [0.05, 0.16], [0.14, -0.14, 'snap'], [0.46, 0.10, 'out']],
    'shoulderR.y': [[0, 0.10], [0.05, 0.22], [0.14, -0.26, 'snap'], [0.46, 0.10, 'out']],
    'upperArmR.z': [[0, -1.30], [0.05, -1.40], [0.14, -0.22, 'snap'], [0.22, -0.26], [0.46, -1.30, 'out']],
    'upperArmR.y': [[0, -0.30], [0.05, -0.16], [0.14, -1.16, 'snap'], [0.22, -1.12], [0.46, -0.30, 'out']],
    'upperArmR.x': [[0, -0.30], [0.14, -0.04, 'snap'], [0.46, -0.30, 'out']],
    'forearmR.z': [[0, 1.85], [0.05, 1.98], [0.14, 0.18, 'snap'], [0.22, 0.22], [0.46, 1.85, 'out']],
    'forearmR.y': [[0, 0.62], [0.14, 0.10, 'snap'], [0.46, 0.62, 'out']],
    // The lead hand comes back to protect while the power hand goes.
    'forearmL.z': [[0, -1.55], [0.14, -1.78, 'snap'], [0.46, -1.55, 'out']],
    'upperArmL.y': [[0, 0.42], [0.14, 0.28, 'snap'], [0.46, 0.42, 'out']],
    'head.y': [[0, -0.26], [0.14, 0.06], [0.46, -0.26]],
    'thighR.x': [[0, 0.20], [0.05, 0.26], [0.14, -0.06, 'snap'], [0.46, 0.20, 'out']],
    'thighR.y': [[0, -0.22], [0.14, -0.52, 'snap'], [0.46, -0.22, 'out']],
    'footR.x': [[0, -0.44], [0.14, -0.66, 'snap'], [0.46, -0.44, 'out']],
    'thighL.x': [[0, -0.30], [0.14, -0.44, 'snap'], [0.46, -0.30, 'out']],
    'hip.z': [[0, 0.0], [0.05, -0.02], [0.14, 0.085, 'snap'], [0.26, 0.05], [0.46, 0.0, 'out']],
    'hip.y': [[0, -0.085], [0.14, -0.11, 'snap'], [0.46, -0.085, 'out']],
    'ikwHandR': [[0, 0, 'lin'], [0.1, 0.9, 'lin'], [0.24, 0.9, 'lin'], [0.32, 0, 'lin']]
  }
});

def('hook', {
  dur: 0.54,
  tracks: {
    'hips.y': [[0, 0.26], [0.06, 0.38, 'out'], [0.17, -0.26, 'snap'], [0.26, -0.22], [0.54, 0.26, 'out']],
    'chest.y': [[0, 0.16], [0.06, 0.36, 'out'], [0.17, -0.52, 'snap'], [0.26, -0.46], [0.54, 0.16, 'out']],
    'spine.y': [[0, 0.10], [0.06, 0.20], [0.17, -0.22, 'snap'], [0.54, 0.10, 'out']],
    'chest.z': [[0, 0.0], [0.17, 0.12, 'snap'], [0.54, 0.0, 'out']],
    'shoulderL.y': [[0, -0.10], [0.06, 0.06], [0.17, -0.30, 'snap'], [0.54, -0.10, 'out']],
    // Elbow stays bent and travels horizontally: that is what makes it a hook.
    'upperArmL.z': [[0, 1.16], [0.06, 1.24], [0.17, 0.30, 'snap'], [0.26, 0.34], [0.54, 1.16, 'out']],
    'upperArmL.y': [[0, 0.42], [0.06, 0.10], [0.17, 0.92, 'snap'], [0.26, 0.98], [0.54, 0.42, 'out']],
    'upperArmL.x': [[0, -0.34], [0.17, 0.22, 'snap'], [0.54, -0.34, 'out']],
    'forearmL.z': [[0, -1.55], [0.06, -1.66], [0.17, -1.24, 'snap'], [0.54, -1.55, 'out']],
    'forearmL.y': [[0, -0.55], [0.17, -0.30, 'snap'], [0.54, -0.55, 'out']],
    'head.y': [[0, -0.26], [0.17, -0.02], [0.54, -0.26]],
    'head.z': [[0, 0.0], [0.17, 0.10], [0.54, 0.0]],
    'thighL.x': [[0, -0.30], [0.17, -0.22, 'snap'], [0.54, -0.30, 'out']],
    'thighL.y': [[0, 0.10], [0.17, 0.42, 'snap'], [0.54, 0.10, 'out']],
    'footL.y': [[0, 0.12], [0.17, 0.46, 'snap'], [0.54, 0.12, 'out']],
    'thighR.x': [[0, 0.20], [0.17, 0.06, 'snap'], [0.54, 0.20, 'out']],
    'hip.z': [[0, 0.0], [0.06, -0.03], [0.17, 0.06, 'snap'], [0.54, 0.0, 'out']],
    'hip.x': [[0, 0.0], [0.17, -0.04, 'snap'], [0.54, 0.0, 'out']],
    'ikwHandL': [[0, 0, 'lin'], [0.13, 0.8, 'lin'], [0.28, 0.8, 'lin'], [0.36, 0, 'lin']]
  }
});

def('uppercut', {
  dur: 0.65,
  tracks: {
    'hip.y': [[0, -0.085], [0.09, -0.19, 'out'], [0.21, 0.04, 'snap'], [0.3, 0.0], [0.65, -0.085, 'out']],
    'hips.y': [[0, 0.26], [0.09, 0.34], [0.21, -0.18, 'snap'], [0.65, 0.26, 'out']],
    'chest.y': [[0, 0.16], [0.09, 0.28], [0.21, -0.34, 'snap'], [0.65, 0.16, 'out']],
    'chest.x': [[0, 0.10], [0.09, 0.30, 'out'], [0.21, -0.20, 'snap'], [0.32, -0.14], [0.65, 0.10, 'out']],
    'spine.x': [[0, 0.08], [0.09, 0.22], [0.21, -0.10, 'snap'], [0.65, 0.08, 'out']],
    'upperArmR.z': [[0, -1.30], [0.09, -1.62, 'out'], [0.21, -0.72, 'snap'], [0.3, -0.76], [0.65, -1.30, 'out']],
    'upperArmR.y': [[0, -0.30], [0.09, -0.12], [0.21, -0.66, 'snap'], [0.65, -0.30, 'out']],
    'upperArmR.x': [[0, -0.30], [0.09, -0.12], [0.21, -0.92, 'snap'], [0.3, -0.88], [0.65, -0.30, 'out']],
    'forearmR.z': [[0, 1.85], [0.09, 2.10, 'out'], [0.21, 2.30, 'snap'], [0.65, 1.85, 'out']],
    'forearmR.y': [[0, 0.62], [0.21, 0.24, 'snap'], [0.65, 0.62, 'out']],
    'forearmL.z': [[0, -1.55], [0.21, -1.82, 'snap'], [0.65, -1.55, 'out']],
    'head.x': [[0, -0.10], [0.09, 0.04], [0.21, -0.22], [0.65, -0.10]],
    'head.y': [[0, -0.26], [0.21, 0.02], [0.65, -0.26]],
    'thighR.x': [[0, 0.20], [0.09, 0.42, 'out'], [0.21, -0.10, 'snap'], [0.65, 0.20, 'out']],
    'shinR.x': [[0, 0.30], [0.09, 0.58, 'out'], [0.21, 0.14, 'snap'], [0.65, 0.30, 'out']],
    'thighL.x': [[0, -0.30], [0.09, -0.16], [0.21, -0.46, 'snap'], [0.65, -0.30, 'out']],
    'shinL.x': [[0, 0.46], [0.09, 0.62], [0.21, 0.30, 'snap'], [0.65, 0.46, 'out']],
    'ikwHandR': [[0, 0, 'lin'], [0.16, 0.75, 'lin'], [0.31, 0.75, 'lin'], [0.4, 0, 'lin']]
  }
});

def('kick', {
  dur: 0.62,
  release: { foot: 'R', from: 0.06, to: 0.52 },
  tracks: {
    'hips.y': [[0, 0.26], [0.07, 0.40, 'out'], [0.20, -0.30, 'snap'], [0.3, -0.26], [0.62, 0.26, 'out']],
    'chest.y': [[0, 0.16], [0.07, 0.34], [0.20, -0.44, 'snap'], [0.62, 0.16, 'out']],
    'chest.x': [[0, 0.10], [0.07, 0.14], [0.20, -0.30, 'snap'], [0.3, -0.24], [0.62, 0.10, 'out']],
    'chest.z': [[0, 0.0], [0.20, -0.22, 'snap'], [0.62, 0.0, 'out']],
    'hips.z': [[0, 0.0], [0.20, -0.20, 'snap'], [0.62, 0.0, 'out']],
    'hip.y': [[0, -0.085], [0.07, -0.16, 'out'], [0.20, -0.02, 'snap'], [0.62, -0.085, 'out']],
    'hip.x': [[0, 0.0], [0.20, 0.06, 'snap'], [0.62, 0.0, 'out']],
    // Kicking leg: chamber the knee, then whip the shin out.
    'thighR.x': [[0, 0.20], [0.07, 0.34, 'out'], [0.20, -0.96, 'snap'], [0.3, -0.88], [0.62, 0.20, 'out']],
    'thighR.y': [[0, -0.22], [0.20, -0.62, 'snap'], [0.62, -0.22, 'out']],
    'thighR.z': [[0, 0.07], [0.12, 0.34], [0.20, 0.30, 'snap'], [0.62, 0.07, 'out']],
    'shinR.x': [[0, 0.30], [0.12, 1.30, 'out'], [0.20, 0.22, 'snap'], [0.3, 0.26], [0.62, 0.30, 'out']],
    'footR.x': [[0, -0.44], [0.20, -0.18, 'snap'], [0.62, -0.44, 'out']],
    // Support leg straightens and pivots.
    'thighL.x': [[0, -0.30], [0.07, -0.40], [0.20, -0.10, 'snap'], [0.62, -0.30, 'out']],
    'shinL.x': [[0, 0.46], [0.07, 0.60], [0.20, 0.14, 'snap'], [0.62, 0.46, 'out']],
    'thighL.y': [[0, 0.10], [0.20, 0.46, 'snap'], [0.62, 0.10, 'out']],
    'footL.y': [[0, 0.12], [0.20, 0.52, 'snap'], [0.62, 0.12, 'out']],
    // Arms counterbalance: the lead arm drops, the rear arm opens.
    'upperArmL.z': [[0, 1.16], [0.20, 1.44, 'snap'], [0.62, 1.16, 'out']],
    'upperArmL.y': [[0, 0.42], [0.20, 0.12, 'snap'], [0.62, 0.42, 'out']],
    'upperArmR.z': [[0, -1.30], [0.20, -0.86, 'snap'], [0.62, -1.30, 'out']],
    'upperArmR.y': [[0, -0.30], [0.20, 0.30, 'snap'], [0.62, -0.30, 'out']],
    'forearmR.z': [[0, 1.85], [0.20, 1.30, 'snap'], [0.62, 1.85, 'out']],
    'head.y': [[0, -0.26], [0.20, 0.10], [0.62, -0.26]]
  }
});

// --- defence ---------------------------------------------------------------
// Block is held: the state machine parks time at the last key while the guard
// is up, so the tail of the clip is the pose, not a wind down.

def('block', {
  dur: 0.20,
  tracks: {
    'hips.y': [[0, 0.26], [0.2, 0.34, 'out']],
    'chest.y': [[0, 0.16], [0.2, 0.26, 'out']],
    'chest.x': [[0, 0.10], [0.2, 0.22, 'out']],
    'spine.x': [[0, 0.08], [0.2, 0.16, 'out']],
    'neck.x': [[0, -0.06], [0.2, 0.14, 'out']],
    'head.x': [[0, -0.10], [0.2, 0.16, 'out']],
    'hip.y': [[0, -0.085], [0.2, -0.155, 'out']],
    'upperArmL.z': [[0, 1.16], [0.2, 0.86, 'out']],
    'upperArmL.y': [[0, 0.42], [0.2, 0.62, 'out']],
    'upperArmL.x': [[0, -0.34], [0.2, -0.52, 'out']],
    'forearmL.z': [[0, -1.55], [0.2, -2.20, 'out']],
    'forearmL.y': [[0, -0.55], [0.2, -0.30, 'out']],
    'upperArmR.z': [[0, -1.30], [0.2, -0.96, 'out']],
    'upperArmR.y': [[0, -0.30], [0.2, -0.50, 'out']],
    'upperArmR.x': [[0, -0.30], [0.2, -0.48, 'out']],
    'forearmR.z': [[0, 1.85], [0.2, 2.32, 'out']],
    'forearmR.y': [[0, 0.62], [0.2, 0.34, 'out']],
    'thighL.x': [[0, -0.30], [0.2, -0.38, 'out']],
    'shinL.x': [[0, 0.46], [0.2, 0.58, 'out']],
    'thighR.x': [[0, 0.20], [0.2, 0.30, 'out']],
    'shinR.x': [[0, 0.30], [0.2, 0.44, 'out']]
  }
});

def('blockHit', {
  dur: 0.28,
  tracks: {
    'hip.z': [[0, 0.0], [0.05, -0.085, 'snap'], [0.28, 0.0, 'out']],
    'hip.y': [[0, -0.085], [0.05, -0.14, 'snap'], [0.28, -0.085, 'out']],
    'chest.x': [[0, 0.10], [0.05, 0.26, 'snap'], [0.28, 0.10, 'out']],
    'spine.x': [[0, 0.08], [0.05, 0.20, 'snap'], [0.28, 0.08, 'out']],
    'head.x': [[0, -0.10], [0.05, 0.18, 'snap'], [0.28, -0.10, 'out']],
    'upperArmL.z': [[0, 1.16], [0.05, 0.96, 'snap'], [0.28, 1.16, 'out']],
    'forearmL.z': [[0, -1.55], [0.05, -2.30, 'snap'], [0.28, -1.55, 'out']],
    'upperArmR.z': [[0, -1.30], [0.05, -1.06, 'snap'], [0.28, -1.30, 'out']],
    'forearmR.z': [[0, 1.85], [0.05, 2.40, 'snap'], [0.28, 1.85, 'out']],
    'thighL.x': [[0, -0.30], [0.05, -0.42, 'snap'], [0.28, -0.30, 'out']],
    'thighR.x': [[0, 0.20], [0.05, 0.34, 'snap'], [0.28, 0.20, 'out']]
  }
});

def('parry', {
  dur: 0.30,
  tracks: {
    'chest.y': [[0, 0.16], [0.06, -0.16, 'snap'], [0.3, 0.16, 'out']],
    'hips.y': [[0, 0.26], [0.06, 0.12, 'snap'], [0.3, 0.26, 'out']],
    'upperArmL.z': [[0, 1.16], [0.06, 0.66, 'snap'], [0.3, 1.16, 'out']],
    'upperArmL.y': [[0, 0.42], [0.06, 1.02, 'snap'], [0.3, 0.42, 'out']],
    'forearmL.z': [[0, -1.55], [0.06, -1.00, 'snap'], [0.3, -1.55, 'out']],
    'forearmL.y': [[0, -0.55], [0.06, -1.10, 'snap'], [0.3, -0.55, 'out']],
    'handL.y': [[0, 0.0], [0.06, -0.6, 'snap'], [0.3, 0.0, 'out']],
    'head.y': [[0, -0.26], [0.06, -0.12], [0.3, -0.26]],
    'hip.y': [[0, -0.085], [0.06, -0.12, 'snap'], [0.3, -0.085, 'out']]
  }
});

// --- reactions -------------------------------------------------------------

def('flinchLight', {
  dur: 0.28,
  tracks: {
    'head.x': [[0, -0.10], [0.045, -0.46, 'snap'], [0.12, -0.20], [0.28, -0.10, 'out']],
    'head.z': [[0, 0.0], [0.045, 0.20, 'snap'], [0.28, 0.0, 'out']],
    'neck.x': [[0, -0.06], [0.045, -0.30, 'snap'], [0.28, -0.06, 'out']],
    'chest.x': [[0, 0.10], [0.05, -0.10, 'snap'], [0.28, 0.10, 'out']],
    'chest.z': [[0, 0.0], [0.05, 0.10, 'snap'], [0.28, 0.0, 'out']],
    'spine.x': [[0, 0.08], [0.06, -0.02, 'snap'], [0.28, 0.08, 'out']],
    'hip.z': [[0, 0.0], [0.07, -0.045, 'snap'], [0.28, 0.0, 'out']],
    'upperArmL.z': [[0, 1.16], [0.05, 1.02, 'snap'], [0.28, 1.16, 'out']],
    'upperArmR.z': [[0, -1.30], [0.05, -1.14, 'snap'], [0.28, -1.30, 'out']]
  }
});

def('flinchHeavy', {
  dur: 0.52,
  tracks: {
    'head.x': [[0, -0.10], [0.06, -0.85, 'snap'], [0.2, -0.30], [0.52, -0.10, 'out']],
    'head.z': [[0, 0.0], [0.06, 0.42, 'snap'], [0.24, -0.10], [0.52, 0.0, 'out']],
    'head.y': [[0, -0.26], [0.06, -0.60, 'snap'], [0.52, -0.26, 'out']],
    'neck.x': [[0, -0.06], [0.06, -0.52, 'snap'], [0.52, -0.06, 'out']],
    'chest.x': [[0, 0.10], [0.07, -0.34, 'snap'], [0.24, 0.16], [0.52, 0.10, 'out']],
    'chest.z': [[0, 0.0], [0.07, 0.26, 'snap'], [0.52, 0.0, 'out']],
    'chest.y': [[0, 0.16], [0.07, 0.44, 'snap'], [0.52, 0.16, 'out']],
    'spine.x': [[0, 0.08], [0.09, -0.20, 'snap'], [0.52, 0.08, 'out']],
    'hips.z': [[0, 0.0], [0.1, 0.16, 'snap'], [0.52, 0.0, 'out']],
    'hip.z': [[0, 0.0], [0.1, -0.11, 'snap'], [0.52, 0.0, 'out']],
    'hip.y': [[0, -0.085], [0.12, -0.20, 'snap'], [0.52, -0.085, 'out']],
    'hip.x': [[0, 0.0], [0.12, -0.05, 'snap'], [0.52, 0.0, 'out']],
    'upperArmL.z': [[0, 1.16], [0.07, 0.82, 'snap'], [0.52, 1.16, 'out']],
    'upperArmL.y': [[0, 0.42], [0.07, 0.10, 'snap'], [0.52, 0.42, 'out']],
    'forearmL.z': [[0, -1.55], [0.07, -1.16, 'snap'], [0.52, -1.55, 'out']],
    'upperArmR.z': [[0, -1.30], [0.07, -0.90, 'snap'], [0.52, -1.30, 'out']],
    'forearmR.z': [[0, 1.85], [0.07, 1.32, 'snap'], [0.52, 1.85, 'out']],
    'thighL.x': [[0, -0.30], [0.14, -0.52, 'snap'], [0.52, -0.30, 'out']],
    'shinL.x': [[0, 0.46], [0.14, 0.74, 'snap'], [0.52, 0.46, 'out']],
    'thighR.x': [[0, 0.20], [0.14, 0.44, 'snap'], [0.52, 0.20, 'out']],
    'shinR.x': [[0, 0.30], [0.14, 0.60, 'snap'], [0.52, 0.30, 'out']]
  }
});

// Stagger is full body: balance is gone and the feet scramble to find it.
def('stagger', {
  dur: 0.95,
  tracks: {
    'hip.z': [[0, 0.0], [0.12, -0.16, 'out'], [0.4, -0.22], [0.7, -0.08], [0.95, 0.0, 'out']],
    'hip.x': [[0, 0.0], [0.18, -0.10], [0.5, 0.10], [0.95, 0.0]],
    'hip.y': [[0, -0.085], [0.2, -0.22, 'out'], [0.55, -0.14], [0.95, -0.085]],
    'hips.z': [[0, 0.0], [0.18, 0.24], [0.5, -0.16], [0.95, 0.0]],
    'hips.y': [[0, 0.26], [0.3, 0.52], [0.6, 0.10], [0.95, 0.26]],
    'spine.x': [[0, 0.08], [0.16, -0.26, 'out'], [0.5, 0.20], [0.95, 0.08]],
    'chest.x': [[0, 0.10], [0.16, -0.30, 'out'], [0.5, 0.26], [0.95, 0.10]],
    'chest.z': [[0, 0.0], [0.2, 0.22], [0.55, -0.14], [0.95, 0.0]],
    'head.x': [[0, -0.10], [0.2, -0.48], [0.55, 0.14], [0.95, -0.10]],
    'head.z': [[0, 0.0], [0.22, 0.30], [0.6, -0.16], [0.95, 0.0]],
    'upperArmL.z': [[0, 1.16], [0.2, 0.50, 'out'], [0.6, 0.92], [0.95, 1.16]],
    'upperArmL.y': [[0, 0.42], [0.2, -0.20], [0.6, 0.30], [0.95, 0.42]],
    'forearmL.z': [[0, -1.55], [0.2, -0.90], [0.6, -1.30], [0.95, -1.55]],
    'upperArmR.z': [[0, -1.30], [0.2, -0.56, 'out'], [0.6, -1.02], [0.95, -1.30]],
    'upperArmR.y': [[0, -0.30], [0.2, 0.34], [0.6, -0.16], [0.95, -0.30]],
    'forearmR.z': [[0, 1.85], [0.2, 1.00], [0.6, 1.44], [0.95, 1.85]],
    'thighL.x': [[0, -0.30], [0.16, 0.22, 'out'], [0.34, -0.62], [0.62, -0.20], [0.95, -0.30]],
    'shinL.x': [[0, 0.46], [0.2, 0.88], [0.4, 0.30], [0.95, 0.46]],
    'thighR.x': [[0, 0.20], [0.2, 0.48], [0.45, -0.34], [0.7, 0.30], [0.95, 0.20]],
    'shinR.x': [[0, 0.30], [0.28, 0.92], [0.5, 0.22], [0.95, 0.30]],
    'thighR.y': [[0, -0.22], [0.4, -0.62], [0.95, -0.22]]
  },
  events: [{ t: 0.34, type: 'foot', foot: 'L' }, { t: 0.62, type: 'foot', foot: 'R' }]
});

// --- downed ----------------------------------------------------------------
// The rig group pitch is owned by combat/fighter.js, so these clips only carry
// the body shape of the fall: the spine curl, the limbs, the hip drop.

def('knockdownBack', {
  dur: 1.05,
  tracks: {
    'hip.y': [[0, -0.085], [0.12, 0.04, 'out'], [0.42, -0.42, 'in'], [0.62, -0.50], [1.05, -0.50]],
    'hip.z': [[0, 0.0], [0.12, -0.10], [0.45, -0.34], [1.05, -0.36]],
    'hips.x': [[0, 0.02], [0.18, -0.30, 'out'], [0.5, -0.20], [1.05, -0.16]],
    'hips.z': [[0, 0.0], [0.3, 0.20], [1.05, 0.14]],
    'spine.x': [[0, 0.08], [0.2, -0.30], [0.5, 0.26], [1.05, 0.18]],
    'chest.x': [[0, 0.10], [0.2, -0.36], [0.5, 0.34], [1.05, 0.26]],
    'head.x': [[0, -0.10], [0.18, -0.52], [0.48, 0.34], [0.7, 0.16], [1.05, 0.22]],
    'head.z': [[0, 0.0], [0.3, 0.26], [1.05, 0.18]],
    'upperArmL.z': [[0, 1.16], [0.22, 0.28, 'out'], [0.6, 0.72], [1.05, 0.80]],
    'upperArmL.y': [[0, 0.42], [0.22, -0.40], [1.05, -0.20]],
    'forearmL.z': [[0, -1.55], [0.25, -0.60], [0.7, -1.05], [1.05, -1.00]],
    'upperArmR.z': [[0, -1.30], [0.22, -0.34, 'out'], [0.6, -0.80], [1.05, -0.88]],
    'upperArmR.y': [[0, -0.30], [0.22, 0.46], [1.05, 0.24]],
    'forearmR.z': [[0, 1.85], [0.25, 0.70], [0.7, 1.10], [1.05, 1.05]],
    'thighL.x': [[0, -0.30], [0.2, -0.90, 'out'], [0.55, -0.50], [1.05, -0.42]],
    'shinL.x': [[0, 0.46], [0.25, 1.20], [0.6, 0.70], [1.05, 0.62]],
    'thighR.x': [[0, 0.20], [0.2, -0.60, 'out'], [0.55, -0.26], [1.05, -0.20]],
    'shinR.x': [[0, 0.30], [0.25, 1.00], [0.6, 0.52], [1.05, 0.46]],
    'thighR.z': [[0, 0.07], [0.35, 0.30], [1.05, 0.24]]
  }
});

def('knockdownForward', {
  dur: 1.0,
  tracks: {
    'hip.y': [[0, -0.085], [0.15, -0.16], [0.45, -0.46, 'in'], [0.65, -0.52], [1.0, -0.52]],
    'hip.z': [[0, 0.0], [0.15, 0.10], [0.45, 0.30], [1.0, 0.32]],
    'hips.x': [[0, 0.02], [0.2, 0.46, 'out'], [0.5, 0.30], [1.0, 0.26]],
    'spine.x': [[0, 0.08], [0.2, 0.42], [0.5, 0.16], [1.0, 0.12]],
    'chest.x': [[0, 0.10], [0.2, 0.44], [0.5, 0.10], [1.0, 0.06]],
    'head.x': [[0, -0.10], [0.16, 0.30], [0.5, -0.34], [1.0, -0.28]],
    'upperArmL.z': [[0, 1.16], [0.25, 0.60, 'out'], [0.55, 1.00], [1.0, 1.05]],
    'upperArmL.y': [[0, 0.42], [0.25, 0.92], [1.0, 0.70]],
    'forearmL.z': [[0, -1.55], [0.25, -0.80], [0.6, -1.35], [1.0, -1.30]],
    'upperArmR.z': [[0, -1.30], [0.25, -0.66, 'out'], [0.55, -1.08], [1.0, -1.12]],
    'upperArmR.y': [[0, -0.30], [0.25, -0.88], [1.0, -0.66]],
    'forearmR.z': [[0, 1.85], [0.25, 0.90], [0.6, 1.40], [1.0, 1.36]],
    'thighL.x': [[0, -0.30], [0.25, 0.30, 'out'], [0.6, 0.12], [1.0, 0.10]],
    'shinL.x': [[0, 0.46], [0.3, 0.90], [0.7, 0.36], [1.0, 0.32]],
    'thighR.x': [[0, 0.20], [0.25, 0.44], [0.6, 0.18], [1.0, 0.16]],
    'shinR.x': [[0, 0.30], [0.3, 0.80], [0.7, 0.30], [1.0, 0.28]]
  }
});

def('getUp', {
  dur: 1.45,
  tracks: {
    'hip.y': [[0, -0.50], [0.3, -0.44], [0.62, -0.30, 'out'], [0.95, -0.14], [1.45, -0.085, 'out']],
    'hip.z': [[0, -0.30], [0.4, -0.16], [0.8, -0.04], [1.45, 0.0]],
    'hips.x': [[0, -0.16], [0.35, 0.22, 'out'], [0.75, 0.30], [1.1, 0.10], [1.45, 0.02, 'out']],
    'hips.y': [[0, 0.10], [0.7, 0.34], [1.45, 0.26]],
    'spine.x': [[0, 0.18], [0.4, 0.30], [0.9, 0.24], [1.45, 0.08]],
    'chest.x': [[0, 0.26], [0.4, 0.34], [0.9, 0.26], [1.45, 0.10]],
    'head.x': [[0, 0.22], [0.4, -0.26], [0.9, -0.20], [1.45, -0.10]],
    'upperArmL.z': [[0, 0.80], [0.35, 0.44], [0.8, 0.90], [1.45, 1.16, 'out']],
    'upperArmL.y': [[0, -0.20], [0.35, 0.30], [1.45, 0.42]],
    'forearmL.z': [[0, -1.00], [0.35, -0.50], [0.8, -1.20], [1.45, -1.55, 'out']],
    'upperArmR.z': [[0, -0.88], [0.35, -0.52], [0.8, -1.00], [1.45, -1.30, 'out']],
    'upperArmR.y': [[0, 0.24], [0.35, -0.20], [1.45, -0.30]],
    'forearmR.z': [[0, 1.05], [0.35, 0.60], [0.8, 1.35], [1.45, 1.85, 'out']],
    'thighL.x': [[0, -0.42], [0.35, -1.05, 'out'], [0.7, -0.75], [1.1, -0.44], [1.45, -0.30]],
    'shinL.x': [[0, 0.62], [0.35, 1.45], [0.7, 1.10], [1.1, 0.64], [1.45, 0.46]],
    'thighR.x': [[0, -0.20], [0.35, -0.70], [0.7, -0.30], [1.1, 0.10], [1.45, 0.20]],
    'shinR.x': [[0, 0.46], [0.35, 1.25], [0.7, 0.85], [1.1, 0.42], [1.45, 0.30]]
  },
  events: [{ t: 0.72, type: 'foot', foot: 'L' }, { t: 1.02, type: 'foot', foot: 'R' }]
});

def('koCollapse', {
  dur: 1.6,
  tracks: {
    'hip.y': [[0, -0.085], [0.18, -0.20, 'in'], [0.5, -0.46], [0.9, -0.54], [1.6, -0.56]],
    'hip.z': [[0, 0.0], [0.4, -0.18], [1.6, -0.26]],
    'hips.x': [[0, 0.02], [0.25, -0.22], [0.7, -0.14], [1.6, -0.10]],
    'hips.z': [[0, 0.0], [0.3, 0.26], [0.8, 0.16], [1.6, 0.12]],
    'spine.x': [[0, 0.08], [0.3, 0.30], [0.8, 0.22], [1.6, 0.20]],
    'chest.x': [[0, 0.10], [0.3, 0.36], [0.8, 0.26], [1.6, 0.24]],
    'chest.z': [[0, 0.0], [0.3, 0.22], [1.6, 0.14]],
    'head.x': [[0, -0.10], [0.2, 0.34], [0.7, 0.28], [1.6, 0.30]],
    'head.z': [[0, 0.0], [0.35, 0.34], [1.6, 0.26]],
    // The guard is gone the instant the lights go out: arms just fall.
    'upperArmL.z': [[0, 1.16], [0.28, 0.34, 'out'], [0.8, 0.44], [1.6, 0.40]],
    'upperArmL.y': [[0, 0.42], [0.3, -0.10], [1.6, -0.05]],
    'forearmL.z': [[0, -1.55], [0.3, -0.42], [0.9, -0.34], [1.6, -0.30]],
    'upperArmR.z': [[0, -1.30], [0.28, -0.40, 'out'], [0.8, -0.50], [1.6, -0.46]],
    'upperArmR.y': [[0, -0.30], [0.3, 0.14], [1.6, 0.08]],
    'forearmR.z': [[0, 1.85], [0.3, 0.50], [0.9, 0.40], [1.6, 0.36]],
    'thighL.x': [[0, -0.30], [0.3, -0.70], [0.8, -0.46], [1.6, -0.44]],
    'shinL.x': [[0, 0.46], [0.35, 1.05], [0.9, 0.66], [1.6, 0.64]],
    'thighR.x': [[0, 0.20], [0.3, -0.34], [0.8, -0.20], [1.6, -0.18]],
    'shinR.x': [[0, 0.30], [0.35, 0.86], [0.9, 0.50], [1.6, 0.48]],
    'thighR.z': [[0, 0.07], [0.4, 0.34], [1.6, 0.30]]
  }
});

// --- flavour ---------------------------------------------------------------

def('taunt', {
  dur: 1.70,
  tracks: {
    'hips.y': [[0, 0.26], [0.35, 0.02], [1.0, 0.06], [1.7, 0.26, 'out']],
    'chest.y': [[0, 0.16], [0.35, -0.10], [1.0, -0.06], [1.7, 0.16, 'out']],
    'chest.x': [[0, 0.10], [0.3, -0.26, 'out'], [1.1, -0.20], [1.7, 0.10, 'out']],
    'spine.x': [[0, 0.08], [0.3, -0.16], [1.1, -0.12], [1.7, 0.08]],
    'head.x': [[0, -0.10], [0.3, 0.26], [0.75, 0.10], [1.2, 0.26], [1.7, -0.10]],
    'head.y': [[0, -0.26], [0.4, 0.10], [1.0, -0.10], [1.7, -0.26]],
    'head.z': [[0, 0.0], [0.5, 0.16], [1.0, -0.12], [1.7, 0.0]],
    // Arms open wide: come on then.
    'upperArmL.z': [[0, 1.16], [0.3, 0.30, 'out'], [0.7, 0.18], [1.2, 0.34], [1.7, 1.16, 'out']],
    'upperArmL.y': [[0, 0.42], [0.3, -0.30], [1.2, -0.20], [1.7, 0.42]],
    'upperArmL.x': [[0, -0.34], [0.35, -0.14], [1.7, -0.34]],
    'forearmL.z': [[0, -1.55], [0.3, -0.55], [0.75, -0.90], [1.2, -0.60], [1.7, -1.55, 'out']],
    'upperArmR.z': [[0, -1.30], [0.3, -0.36, 'out'], [0.7, -0.24], [1.2, -0.40], [1.7, -1.30, 'out']],
    'upperArmR.y': [[0, -0.30], [0.3, 0.34], [1.2, 0.24], [1.7, -0.30]],
    'forearmR.z': [[0, 1.85], [0.3, 0.65], [0.75, 1.00], [1.2, 0.70], [1.7, 1.85, 'out']],
    'hip.y': [[0, -0.085], [0.35, -0.04], [1.1, -0.06], [1.7, -0.085]],
    'hip.z': [[0, 0.0], [0.35, -0.05], [1.7, 0.0]],
    'thighL.x': [[0, -0.30], [0.35, -0.20], [1.7, -0.30]],
    'thighR.x': [[0, 0.20], [0.35, 0.10], [1.7, 0.20]]
  }
});

def('drink', {
  dur: 1.55,
  tracks: {
    // The power hand brings the bottle up, the head tips back, then a wipe.
    'upperArmR.z': [[0, -1.30], [0.3, -1.06, 'out'], [0.55, -0.92], [1.0, -0.98], [1.3, -1.20], [1.55, -1.30, 'out']],
    'upperArmR.y': [[0, -0.30], [0.3, -0.62], [0.55, -0.78], [1.0, -0.76], [1.55, -0.30, 'out']],
    'upperArmR.x': [[0, -0.30], [0.55, -0.16], [1.55, -0.30]],
    'forearmR.z': [[0, 1.85], [0.3, 2.25, 'out'], [0.55, 2.55], [1.0, 2.50], [1.3, 2.10], [1.55, 1.85, 'out']],
    'forearmR.y': [[0, 0.62], [0.55, 0.30], [1.55, 0.62]],
    'handR.z': [[0, 0.18], [0.55, 0.55], [1.0, 0.50], [1.55, 0.18]],
    'head.x': [[0, -0.10], [0.4, -0.20], [0.65, -0.52, 'out'], [1.0, -0.46], [1.25, 0.10], [1.55, -0.10, 'out']],
    'neck.x': [[0, -0.06], [0.65, -0.34], [1.0, -0.30], [1.55, -0.06]],
    'head.y': [[0, -0.26], [0.6, -0.34], [1.55, -0.26]],
    'chest.x': [[0, 0.10], [0.6, -0.14, 'out'], [1.0, -0.10], [1.55, 0.10, 'out']],
    'spine.x': [[0, 0.08], [0.6, -0.06], [1.55, 0.08]],
    'chest.y': [[0, 0.16], [0.6, 0.26], [1.55, 0.16]],
    // The lead hand drops off guard, which is what makes drinking a risk.
    'upperArmL.z': [[0, 1.16], [0.4, 1.34], [1.0, 1.36], [1.55, 1.16, 'out']],
    'upperArmL.y': [[0, 0.42], [0.4, 0.22], [1.55, 0.42]],
    'forearmL.z': [[0, -1.55], [0.4, -1.10], [1.0, -1.14], [1.55, -1.55, 'out']],
    'hip.y': [[0, -0.085], [0.6, -0.05], [1.55, -0.085]],
    'hips.y': [[0, 0.26], [0.6, 0.18], [1.55, 0.26]]
  }
});

def('victory', {
  dur: 2.6, loop: true,
  tracks: {
    'upperArmL.z': [[0, 0.34], [0.9, 0.18], [1.8, 0.34], [2.6, 0.34]],
    'upperArmL.y': [[0, -0.20], [0.9, -0.05], [1.8, -0.20], [2.6, -0.20]],
    'upperArmL.x': [[0, 0.30], [1.3, 0.45], [2.6, 0.30]],
    'forearmL.z': [[0, -0.40], [0.9, -0.24], [1.8, -0.42], [2.6, -0.40]],
    'upperArmR.z': [[0, -0.34], [0.9, -0.18], [1.8, -0.34], [2.6, -0.34]],
    'upperArmR.y': [[0, 0.20], [0.9, 0.05], [1.8, 0.20], [2.6, 0.20]],
    'upperArmR.x': [[0, 0.30], [1.3, 0.45], [2.6, 0.30]],
    'forearmR.z': [[0, 0.40], [0.9, 0.24], [1.8, 0.42], [2.6, 0.40]],
    'chest.x': [[0, -0.14], [1.3, -0.24], [2.6, -0.14]],
    'chest.y': [[0, 0.06], [1.3, -0.06], [2.6, 0.06]],
    'spine.x': [[0, -0.06], [1.3, -0.12], [2.6, -0.06]],
    'head.x': [[0, 0.10], [1.3, 0.22], [2.6, 0.10]],
    'head.y': [[0, -0.10], [1.3, 0.10], [2.6, -0.10]],
    'hips.y': [[0, 0.10], [1.3, 0.02], [2.6, 0.10]],
    'hip.y': [[0, -0.05], [0.65, -0.01], [1.3, -0.05], [1.95, -0.01], [2.6, -0.05]],
    'thighL.x': [[0, -0.16], [1.3, -0.22], [2.6, -0.16]],
    'thighR.x': [[0, 0.12], [1.3, 0.18], [2.6, 0.12]]
  }
});

export const CLIP_NAMES = Object.keys(CLIPS);
