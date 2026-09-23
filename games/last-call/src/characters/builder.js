import * as THREE from 'three';
import { makeRng, hashString } from '../core/rng.js';
import { TEX } from '../render/texlib.js';
import {
  MeshBuilder, loft, lobeMul, ringVs, uvAt, computeSkinning, swellMorph, displace,
  smooth01, bump, band, V3
} from './mesh.js';
import {
  SKIN_ATLAS, makeSkinCanvas, makeSkinMaterial, makeClothMaterial, makeRubberMaterial,
  makeHairMaterial, makeEyeMaterial, makeDarkMaterial, makeMetalMaterial, makeSweatSetter
} from './materials.js';
import { createDamage, paintFace, paintTattoos } from './damage.js';

// The fighter. One skinned mesh, lofted along the bone chain, welded across
// part boundaries and weighted by distance to bone so a shoulder rolls instead
// of tearing open.
//
// The bind pose is not the rest pose. Geometry is authored and bound with the
// arms in a relaxed A, then the arms are dropped to the hanging rest that
// anim/rigposer.js treats as its base. Binding in A rather than in T halves
// the rotation the deltoid has to survive, which is most of the difference
// between a shoulder that deforms and a shoulder that creases.
//
// Garments are not lofted along the body and then bent into shape: a hem cut
// after the fact leaves a ring sitting at a height whose radius it no longer
// matches, and the body pokes straight through it. Every garment samples the
// body at the height each of its own vertices actually ends up at.
//
// The 'bones' contract is frozen: animation depends on these names, on the arm
// bones running along local X, the leg bones down local -Y, and hips resting
// at y = 0.98 with the feet on y = 0.
export const BONE_NAMES = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'shoulderL', 'upperArmL', 'forearmL', 'handL',
  'shoulderR', 'upperArmR', 'forearmR', 'handR',
  'thighL', 'shinL', 'footL',
  'thighR', 'shinR', 'footR'
];

// Bind pose arm angles. Rest angles are applied after the skeleton is bound.
const BIND_ARM_Z = 0.62, BIND_FORE_Z = 0.10;
const REST_ARM_Z = 1.35, REST_FORE_Z = 0.15;

const SIDES_BODY = 40, SIDES_LIMB = 24, SIDES_SMALL = 18, SIDES_CLOTH = 30;
const TAU = Math.PI * 2;

// Silhouette is the first thing that reads and the last thing a player forgets,
// so body type drives radii and lobes rather than a uniform scale.
export const BODY_TYPES = {
  bruiser:  { shoulder: 1.18, chest: 1.13, waist: 1.10, arm: 1.20, leg: 1.12, neck: 1.18, belly: 0.20, muscle: 1.25, head: 0.99, tall: 1.035 },
  lean:     { shoulder: 1.00, chest: 0.93, waist: 0.85, arm: 0.87, leg: 0.90, neck: 0.90, belly: -0.04, muscle: 1.05, head: 1.01, tall: 1.005 },
  stocky:   { shoulder: 1.06, chest: 1.09, waist: 1.26, arm: 1.10, leg: 1.12, neck: 1.14, belly: 0.55, muscle: 0.80, head: 1.05, tall: 0.935 },
  athletic: { shoulder: 1.07, chest: 1.02, waist: 0.94, arm: 1.00, leg: 1.01, neck: 1.00, belly: 0.02, muscle: 1.12, head: 1.00, tall: 1.000 },
  rangy:    { shoulder: 0.97, chest: 0.92, waist: 0.87, arm: 0.92, leg: 0.95, neck: 0.89, belly: 0.00, muscle: 0.95, head: 0.97, tall: 1.075 },
  slugger:  { shoulder: 1.12, chest: 1.10, waist: 1.14, arm: 1.14, leg: 1.07, neck: 1.14, belly: 0.34, muscle: 1.00, head: 1.03, tall: 0.975 }
};

// --------------------------------------------------------------- helpers ---

// Walk a polyline by arc length, extrapolating past either end so a limb can
// start inside the torso and finish past the last bone.
function polyline(pts) {
  const segs = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i].distanceTo(pts[i - 1]);
    segs.push({ a: pts[i - 1], b: pts[i], d, t0: total });
    total += d;
  }
  const at = (dist) => {
    let s = segs[0];
    for (let i = 0; i < segs.length; i++) {
      if (dist <= segs[i].t0 + segs[i].d || i === segs.length - 1) { s = segs[i]; break; }
    }
    const k = s.d > 1e-6 ? (dist - s.t0) / s.d : 0;
    return new THREE.Vector3().lerpVectors(s.a, s.b, k);
  };
  return { total, at };
}

const N = (p, depth, width, opts) => Object.assign({ p, depth, width }, opts);

// Linear sample of an upright node list at an arbitrary height. Every garment
// and every shell goes through this, which is why cloth follows the body it is
// worn over instead of approximating it.
function sampleBody(nodes, y) {
  if (y <= nodes[0].p.y) return nodes[0];
  for (let i = 1; i < nodes.length; i++) {
    if (y <= nodes[i].p.y) {
      const a = nodes[i - 1], c = nodes[i];
      const t = (y - a.p.y) / (c.p.y - a.p.y);
      return {
        depth: a.depth + (c.depth - a.depth) * t,
        width: a.width + (c.width - a.width) * t,
        push: (a.push ?? 0) + ((c.push ?? 0) - (a.push ?? 0)) * t,
        lobes: t < 0.5 ? a.lobes : c.lobes
      };
    }
  }
  return nodes[nodes.length - 1];
}

// Radius of an upright body at a height and a ring angle, lobes included.
function bodyAt(nodes, y, th) {
  const n = sampleBody(nodes, y);
  const m = lobeMul(th, n.lobes);
  return { d: n.depth * m, w: n.width * m, push: n.push ?? 0 };
}

// A garment or hair shell: 'rows' rings spanning from a per-angle bottom edge
// to a per-angle top edge, each vertex sampling the body at its own height.
// Rings cannot cross and a hem can therefore be cut any shape without the
// body punching through it.
function shellRings(nodes, sides, rows, loFn, hiFn, padFn) {
  const rings = [];
  for (let k = 0; k < rows; k++) {
    const t = k / (rows - 1);
    const ring = new Array(sides);
    for (let i = 0; i < sides; i++) {
      const th = -Math.PI + (i / sides) * TAU;
      const y = loFn(th) + t * (hiFn(th) - loFn(th));
      const r = bodyAt(nodes, y, th);
      const pad = padFn ? padFn(th, t, y) : 0;
      ring[i] = new THREE.Vector3(
        (r.w + pad) * Math.sin(th),
        y,
        (r.d + pad) * Math.cos(th) + r.push
      );
    }
    rings.push(ring);
  }
  return rings;
}

function ellipsoid(cx, cy, cz, rx, ry, rz, rot, seg = 12) {
  const g = new THREE.SphereGeometry(1, seg, Math.max(6, seg - 4));
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2]));
  m.scale(new THREE.Vector3(rx, ry, rz));
  m.setPosition(cx, cy, cz);
  return { geo: g, mat: m };
}

const uvSub = (r, u0, v0, u1, v1) => [
  r[0] + u0 * (r[2] - r[0]), r[1] + v0 * (r[3] - r[1]),
  r[0] + u1 * (r[2] - r[0]), r[1] + v1 * (r[3] - r[1])
];

// 1 dead ahead, 0 at the ears, used to shape every hem that has a front.
const frontness = (th, lo = 0.10, hi = 0.62) => smooth01((Math.cos(th) - lo) / (hi - lo));
const backness = (th) => smooth01((-Math.cos(th) - 0.10) / 0.5);

// ------------------------------------------------------------- the build ---

export function buildFighter(spec = {}) {
  const seed = hashString(spec.name || 'fighter');
  const rng = makeRng(seed);
  const bt = BODY_TYPES[spec.build] || BODY_TYPES.athletic;
  const scale = (spec.scale ?? 1) * bt.tall;

  const group = new THREE.Group();
  group.name = spec.name || 'fighter';

  // ---- skeleton, in bind pose -------------------------------------------
  const bones = {};
  const mk = (name, parent, x, y, z) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, z);
    (parent ? bones[parent] : group).add(b);
    bones[name] = b;
    return b;
  };

  mk('hips', null, 0, 0.98, 0);
  mk('spine', 'hips', 0, 0.14, 0);
  mk('chest', 'spine', 0, 0.20, 0);
  mk('neck', 'chest', 0, 0.21, 0);
  mk('head', 'neck', 0, 0.10, 0);
  const shW = bt.shoulder;
  for (const s of [-1, 1]) {
    const S = s < 0 ? 'L' : 'R';
    mk('shoulder' + S, 'chest', 0.046 * s, 0.17, 0);
    mk('upperArm' + S, 'shoulder' + S, 0.122 * s * shW, 0.005, 0);
    mk('forearm' + S, 'upperArm' + S, 0.295 * s, 0, 0);
    mk('hand' + S, 'forearm' + S, 0.265 * s, 0, 0);
    mk('thigh' + S, 'hips', 0.098 * s, -0.04, 0);
    mk('shin' + S, 'thigh' + S, 0, -0.44, 0);
    // 0.075 above the sole: anim/ik.js levels the foot against exactly that.
    mk('foot' + S, 'shin' + S, 0, -0.425, 0);
  }
  for (const S of ['L', 'R']) {
    const sg = S === 'L' ? 1 : -1;
    bones['upperArm' + S].rotation.z = sg * BIND_ARM_Z;
    bones['forearm' + S].rotation.z = sg * BIND_FORE_Z;
  }
  group.updateMatrixWorld(true);

  const P = {};
  for (const n of BONE_NAMES) P[n] = new THREE.Vector3().setFromMatrixPosition(bones[n].matrixWorld);

  // ---- materials ---------------------------------------------------------
  const skinTone = spec.skin ?? '#c08055';
  const skinBundle = TEX.skin(skinTone, (seed % 97) + 3, 512);
  const skinSurf = makeSkinCanvas(skinBundle, 1024);
  const skinTexture = new THREE.CanvasTexture(skinSurf.canvas);
  skinTexture.colorSpace = THREE.SRGBColorSpace;
  skinTexture.wrapS = skinTexture.wrapT = THREE.ClampToEdgeWrapping;
  skinTexture.anisotropy = 8;

  const M = {
    skin: makeSkinMaterial(skinTexture, skinBundle, { sss: spec.sss ?? '#b8452c' }),
    tank: makeClothMaterial(spec.tank ?? '#d8d3c6', { seed: seed % 53, weave: 150, repeat: 5, name: 'tank', sheen: 0.7 }),
    trunks: makeClothMaterial(spec.trunks ?? '#232a3d', { seed: (seed % 31) + 60, weave: 96, repeat: 4, name: 'trunks', sheen: 0.45, sheenColor: '#b9c6e8' }),
    wrap: makeClothMaterial(spec.wrap ?? '#e7e2d6', { seed: (seed % 17) + 120, weave: 230, repeat: 9, name: 'wrap', sheen: 0.35 }),
    shoe: makeClothMaterial(spec.shoe ?? '#2a2f38', { seed: (seed % 23) + 170, weave: 170, repeat: 6, name: 'shoe', sheen: 0.25 }),
    sole: makeRubberMaterial(spec.sole ?? '#cfc8ba', { seed: (seed % 19) + 210 }),
    belt: makeClothMaterial(spec.belt ?? '#12141c', { seed: (seed % 13) + 240, weave: 60, repeat: 3, name: 'belt', sheen: 0.2 }),
    hair: makeHairMaterial(spec.hair ?? '#231a14', (seed % 41) + 300),
    eye: makeEyeMaterial(),
    iris: makeDarkMaterial(spec.eyes ?? '#3a2a1c'),
    dark: makeDarkMaterial('#0d0b0a'),
    trim: makeMetalMaterial('#b9a071', (seed % 29) + 340)
  };

  // ---- torso and head geometry ------------------------------------------
  const b = new MeshBuilder();
  const A = SKIN_ATLAS;
  const mu = bt.muscle;

  const glute = { th: Math.PI, amount: 0.22 * mu, sharp: 2.6 };
  const bellyL = { th: 0, amount: Math.max(0, bt.belly), sharp: 2 };
  const lat = { th: 2.00, amount: 0.13 * mu, sharp: 3.2, mirror: true };
  const pec = { th: 0.58, amount: 0.15 * mu, sharp: 5.0, mirror: true };
  const clav = { th: 0.60, amount: 0.06, sharp: 5, mirror: true };
  const trap = { th: 2.10, amount: 0.15 * mu, sharp: 3.0, mirror: true };
  const obl = { th: 1.45, amount: 0.07 * mu, sharp: 4, mirror: true };

  const W = bt.waist, C = bt.chest, NK = bt.neck, H = bt.head;
  const torsoNodes = [
    N(V3(0, 0.755, 0), 0.093 * W, 0.108 * W, { squash: 0.9 }),
    N(V3(0, 0.845, 0), 0.113 * W, 0.142 * W, { lobes: [glute] }),
    N(V3(0, 0.930, 0), 0.115 * W, 0.146 * W, { lobes: [glute] }),
    N(V3(0, 1.005, 0), 0.105 * W, 0.132 * W, { lobes: [bellyL] }),
    N(V3(0, 1.075, 0), 0.098 * W, 0.124 * W, { lobes: [bellyL, obl] }),
    N(V3(0, 1.145, 0), 0.100 * C, 0.130 * C, { lobes: [bellyL, obl] }),
    N(V3(0, 1.215, 0), 0.108 * C, 0.142 * C, { lobes: [lat] }),
    N(V3(0, 1.285, 0), 0.116 * C, 0.152 * C, { lobes: [lat, pec] }),
    N(V3(0, 1.350, 0), 0.118 * C, 0.158 * C, { lobes: [pec] }),
    N(V3(0, 1.410, 0), 0.112 * C, 0.154 * C, { lobes: [clav] }),
    N(V3(0, 1.460, 0), 0.102 * C, 0.140 * C, { lobes: [trap] }),
    N(V3(0, 1.500, 0), 0.087, 0.112, { lobes: [trap] }),
    N(V3(0, 1.535, 0), 0.070 * NK, 0.080 * NK, {}),
    N(V3(0, 1.572, 0), 0.062 * NK, 0.065 * NK, { push: 0.004 }),
    N(V3(0, 1.610, 0), 0.061 * NK, 0.063 * NK, { push: 0.007 }),
    N(V3(0, 1.645, 0), 0.065 * NK, 0.067 * NK, { push: 0.010 })
  ];

  // The head is its own loft only so it can own a whole atlas row; its first
  // node is the torso's last, so the shared ring is identical in both and the
  // two surfaces weld into one.
  const headNodes = [
    torsoNodes[torsoNodes.length - 1],
    N(V3(0, 1.670, 0), 0.080 * H, 0.062 * H, { push: 0.012, squash: 0.92 }),
    N(V3(0, 1.697, 0), 0.091 * H, 0.071 * H, { push: 0.010, squash: 0.88 }),
    N(V3(0, 1.722, 0), 0.095 * H, 0.074 * H, { push: 0.006, squash: 0.90 }),
    N(V3(0, 1.746, 0), 0.098 * H, 0.076 * H, { push: 0.003, squash: 0.93 }),
    N(V3(0, 1.758, 0), 0.099 * H, 0.077 * H, { push: 0.001, squash: 0.95 }),
    N(V3(0, 1.770, 0), 0.098 * H, 0.076 * H, { push: 0.000 }),
    N(V3(0, 1.781, 0), 0.098 * H, 0.076 * H, { push: -0.001 }),
    N(V3(0, 1.792, 0), 0.097 * H, 0.075 * H, { push: -0.002 }),
    N(V3(0, 1.806, 0), 0.095 * H, 0.074 * H, { push: -0.005 }),
    N(V3(0, 1.822, 0), 0.092 * H, 0.071 * H, { push: -0.008 }),
    N(V3(0, 1.840, 0), 0.085 * H, 0.065 * H, { push: -0.011 }),
    N(V3(0, 1.858, 0), 0.072 * H, 0.055 * H, { push: -0.012 }),
    N(V3(0, 1.872, 0), 0.050 * H, 0.038 * H, { push: -0.012 }),
    N(V3(0, 1.882, 0), 0.018 * H, 0.014 * H, { push: -0.012 })
  ];
  const bodyNodes = torsoNodes.concat(headNodes.slice(1));

  b.begin(M.skin, { group: 'body', region: 'body' });
  b.addRings(loft(torsoNodes, SIDES_BODY), A.body, { evenV: true, capStart: true, capSmooth: true });

  const headRings = loft(headNodes, SIDES_BODY);
  const headVs = ringVs(headRings, true);
  const uvHead = (k, th) => uvAt(headRings, A.head, headVs, k, th);
  const headStart = b.vertexCount;
  b.begin(M.skin, { group: 'body', region: 'head' });
  b.addRings(headRings, A.head, { evenV: true, capEnd: true, capSmooth: true });

  // Facial pass. Rings alone give an egg; these displacements put a brow, a
  // nose, cheekbones, a jaw and an occiput on it.
  displace(b, headStart, (x, y, z) => {
    if (y < 1.652) return null;   // the shared neck ring must never move
    const front = smooth01((z - 0.005) / 0.045);
    const ax = Math.abs(x), sx = Math.sign(x) || 1;
    let dx = 0, dy = 0, dz = 0;

    // Brow ridge and the shelf over the eyes.
    const brow = bump((y - 1.7925) / 0.019) * bump(x / 0.064) * front;
    dz += brow * 0.021;
    const glab = bump((y - 1.796) / 0.014) * bump(x / 0.016) * front;   // between the brows
    dz -= glab * 0.008;
    // Eye sockets, set under the ridge.
    const sock = bump((y - 1.7735) / 0.016) * bump((ax - 0.032) / 0.028) * front;
    dz -= sock * 0.018;
    // Nose: a bridge down to a tip that overhangs the lip, plus the wings.
    const nose = bump(x / 0.021) * band(y, 1.742, 1.800, 0.020) * front;
    dz += nose * 0.026;
    const tip = bump((y - 1.7505) / 0.016) * bump(x / 0.019) * front;
    dz += tip * 0.023; dy -= tip * 0.004;
    const wing = bump((y - 1.7425) / 0.011) * bump((ax - 0.021) / 0.013) * front;
    dz += wing * 0.011;
    // Cheekbones out, cheek hollow under them.
    const cheek = bump((y - 1.7545) / 0.021) * bump((ax - 0.055) / 0.025) * front;
    dx += sx * cheek * 0.011; dz += cheek * 0.008;
    const hollow = bump((y - 1.7245) / 0.019) * bump((ax - 0.050) / 0.023) * front;
    dz -= hollow * 0.010; dx -= sx * hollow * 0.004;
    // Mouth mass, with the philtrum notched above it.
    const lip = bump((y - 1.7225) / 0.013) * bump(x / 0.031) * front;
    dz += lip * 0.011;
    const phil = bump((y - 1.7345) / 0.007) * bump(x / 0.009) * front;
    dz -= phil * 0.005;
    // A square jaw, squarer the heavier the fighter, and a chin under it.
    const jaw = bump((y - 1.6985) / 0.027) * smooth01((ax - 0.016) / 0.038) * smooth01((z + 0.026) / 0.048);
    dx += sx * jaw * 0.016 * (0.7 + mu * 0.4);
    const chin = bump((y - 1.6845) / 0.023) * bump(x / 0.028) * front;
    dz += chin * 0.018; dy -= chin * 0.004;
    // Occiput, so the skull is not a ball from the side.
    const occ = bump((y - 1.808) / 0.058) * smooth01((-z - 0.018) / 0.05);
    dz -= occ * 0.015;
    // Temples flatten where the ears attach.
    const tem = bump((y - 1.806) / 0.032) * smooth01((ax - 0.060) / 0.019);
    dx -= sx * tem * 0.008;
    return [dx, dy, dz];
  });

  // ---- arms --------------------------------------------------------------
  for (const S of ['L', 'R']) {
    const sg = S === 'L' ? 1 : -1;       // lobe angles mirror with the frame
    const Sh = P['upperArm' + S], El = P['forearm' + S], Wr = P['hand' + S];
    const dirF = new THREE.Vector3().subVectors(Wr, El).normalize();
    const pl = polyline([Sh, El, Wr, Wr.clone().addScaledVector(dirF, 0.13)]);
    const L1 = Sh.distanceTo(El), L2 = El.distanceTo(Wr);
    const am = bt.arm;
    const delt = { th: sg * 1.05, amount: 0.22 * mu, sharp: 2.6 };
    const delt2 = { th: sg * 1.30, amount: 0.16 * mu, sharp: 2.8 };
    const bicep = { th: 0, amount: 0.17 * mu, sharp: 3.2 };
    const tri = { th: Math.PI, amount: 0.14 * mu, sharp: 2.8 };
    const fore = { th: sg * 0.85, amount: 0.13 * mu, sharp: 2.8 };
    const knuck = { th: 0, amount: 0.10, sharp: 3 };
    const armNodes = [
      N(pl.at(-0.080), 0.048 * am, 0.048 * am, { lobes: [delt] }),
      N(pl.at(-0.038), 0.060 * am, 0.060 * am, { lobes: [delt] }),
      N(pl.at(0.008), 0.065 * am, 0.065 * am, { lobes: [delt2] }),
      N(pl.at(L1 * 0.26), 0.058 * am, 0.058 * am, { lobes: [bicep, tri] }),
      N(pl.at(L1 * 0.50), 0.053 * am, 0.053 * am, { lobes: [bicep, tri] }),
      N(pl.at(L1 * 0.74), 0.047 * am, 0.047 * am, { lobes: [tri] }),
      N(pl.at(L1 * 0.93), 0.043 * am, 0.043 * am, {}),
      N(pl.at(L1 + L2 * 0.10), 0.047 * am, 0.047 * am, { lobes: [fore] }),
      N(pl.at(L1 + L2 * 0.28), 0.050 * am, 0.050 * am, { lobes: [fore] }),
      N(pl.at(L1 + L2 * 0.55), 0.042 * am, 0.042 * am, {}),
      N(pl.at(L1 + L2 * 0.80), 0.034 * am, 0.034 * am, {}),
      N(pl.at(L1 + L2), 0.030 * am, 0.030 * am, {}),
      N(pl.at(L1 + L2 + 0.030), 0.042 * am, 0.040 * am, { squash: 0.80 }),
      N(pl.at(L1 + L2 + 0.065), 0.049 * am, 0.046 * am, { squash: 0.72, lobes: [knuck] }),
      N(pl.at(L1 + L2 + 0.095), 0.047 * am, 0.043 * am, { squash: 0.72, lobes: [knuck] }),
      N(pl.at(L1 + L2 + 0.115), 0.030 * am, 0.027 * am, { squash: 0.8 })
    ];
    b.begin(M.skin, { group: 'arm' + S, region: 'arm' + S });
    b.addRings(loft(armNodes, SIDES_LIMB), A['arm' + S], { evenV: true, capStart: true, capEnd: true, capSmooth: true });

    // Thumb, folded across the front of the fist.
    const inw = V3(-Math.sign(Wr.x || 1), 0, 0);
    const tp = Wr.clone().addScaledVector(dirF, 0.056).addScaledVector(inw, 0.036 * am);
    tp.z += 0.016;
    const e = ellipsoid(tp.x, tp.y, tp.z, 0.021 * am, 0.030 * am, 0.021 * am, [0.3, 0, sg * 0.5], 10);
    b.begin(M.skin, { group: 'hand' + S, region: 'arm' + S });
    b.addGeometry(e.geo, A['arm' + S], e.mat);
    e.geo.dispose();

    // Hand wrap: one band from mid forearm over the knuckles, fingertips bare
    // so it reads as tape and not a mitten.
    const wn = [];
    const wd = [0.60, 0.70, 0.80, 0.90, 1.00, 1.08, 1.16, 1.24, 1.30];
    for (let i = 0; i < wd.length; i++) {
      const d = L1 + L2 * wd[i];
      const t = i / (wd.length - 1);
      const base = 0.030 + (0.050 - 0.030) * smooth01(t * 1.6) - Math.max(0, t - 0.86) * 0.13;
      wn.push(N(pl.at(d), base * am + 0.007, base * am * 0.94 + 0.007, { squash: t > 0.45 ? 0.76 : 1 }));
    }
    b.begin(M.wrap, { group: 'hand' + S, region: 'cloth' });
    b.addRings(loft(wn, SIDES_LIMB), [0, 0, 1, 1], { evenV: true });
  }

  // ---- legs --------------------------------------------------------------
  const legNodesBy = {};
  for (const S of ['L', 'R']) {
    const Hp = P['thigh' + S], Kn = P['shin' + S], An = P['foot' + S];
    const pl = polyline([Hp, Kn, An]);
    const LT = Hp.distanceTo(Kn), LS = Kn.distanceTo(An);
    const lg = bt.leg;
    const quad = { th: 0, amount: 0.12 * mu, sharp: 3.2 };
    const ham = { th: Math.PI, amount: 0.13 * mu, sharp: 2.8 };
    const calf = { th: Math.PI, amount: 0.26 * mu, sharp: 2.6 };
    const legNodes = [
      N(pl.at(-0.055), 0.082 * lg, 0.086 * lg, { lobes: [glute] }),
      N(pl.at(0.000), 0.088 * lg, 0.092 * lg, { lobes: [ham] }),
      N(pl.at(LT * 0.22), 0.086 * lg, 0.089 * lg, { lobes: [quad, ham] }),
      N(pl.at(LT * 0.45), 0.079 * lg, 0.082 * lg, { lobes: [quad] }),
      N(pl.at(LT * 0.70), 0.070 * lg, 0.072 * lg, { lobes: [quad] }),
      N(pl.at(LT * 0.90), 0.062 * lg, 0.065 * lg, {}),
      N(pl.at(LT), 0.057 * lg, 0.063 * lg, { lobes: [{ th: 0, amount: 0.09, sharp: 5 }] }),
      N(pl.at(LT + LS * 0.10), 0.058 * lg, 0.061 * lg, { lobes: [calf] }),
      N(pl.at(LT + LS * 0.26), 0.061 * lg, 0.062 * lg, { lobes: [calf] }),
      N(pl.at(LT + LS * 0.45), 0.054 * lg, 0.053 * lg, { lobes: [calf] }),
      N(pl.at(LT + LS * 0.66), 0.044 * lg, 0.042 * lg, {}),
      N(pl.at(LT + LS * 0.86), 0.037 * lg, 0.034 * lg, {}),
      N(pl.at(LT + LS), 0.035 * lg, 0.032 * lg, {})
    ];
    legNodesBy[S] = { nodes: legNodes, pl, LT, LS, lg };
    b.begin(M.skin, { group: 'leg' + S, region: 'leg' + S });
    b.addRings(loft(legNodes, SIDES_LIMB), A['leg' + S], { evenV: true, capStart: true, capEnd: true, capSmooth: true });

    // ---- sneaker -------------------------------------------------------
    const fx = An.x, SOLE = 0.030;
    const prof = [
      [-0.080, 0.036, 0.036], [-0.056, 0.052, 0.046], [-0.020, 0.062, 0.051],
      [0.022, 0.056, 0.054], [0.070, 0.048, 0.054], [0.116, 0.040, 0.051],
      [0.156, 0.031, 0.044], [0.184, 0.019, 0.030]
    ];
    const shoeNodes = prof.map((q) => N(V3(fx, SOLE + q[1], q[0]), q[1], q[2], { squash: 0.62 }));
    b.begin(M.shoe, { group: 'foot' + S, region: 'shoe' });
    b.addRings(loft(shoeNodes, SIDES_SMALL), [0, 0, 1, 1], { evenV: true, capStart: true, capEnd: true });

    const soleNodes = prof.map((q) => N(V3(fx, SOLE * 0.5, q[0]), SOLE * 0.5, q[2] + 0.005, { squash: 0.35 }));
    b.begin(M.sole, { group: 'foot' + S, region: 'shoe' });
    b.addRings(loft(soleNodes, SIDES_SMALL), [0, 0, 1, 1], { evenV: true, capStart: true, capEnd: true });

    // Tongue and lace panel down the instep.
    const laceNodes = [];
    for (let i = 0; i <= 4; i++) {
      const z = -0.012 + i * 0.032;
      const q = 0.058 - i * 0.005;
      laceNodes.push(N(V3(fx, SOLE + q + 0.003, z), q * 0.90, 0.022, { squash: 0.7 }));
    }
    b.begin(M.dark, { group: 'foot' + S, region: 'shoe' });
    b.addRings(loft(laceNodes, 10), [0, 0, 1, 1], { evenV: true, capStart: true, capEnd: true });
  }

  // ---- tank top ----------------------------------------------------------
  {
    const hemY = 0.975;
    const top = (th) => {
      const side = Math.abs(Math.sin(th));
      return 1.472 - Math.pow(side, 2.2) * 0.200 - frontness(th, 0.55, 0.99) * 0.070
        - backness(th) * 0.030;
    };
    const rings = shellRings(torsoNodes, SIDES_CLOTH, 9, () => hemY, top,
      (th, t) => 0.013 + t * 0.004);
    b.begin(M.tank, { group: 'body', region: 'cloth' });
    b.addRings(rings, [0, 0, 1, 1], { evenV: true });

    // Shoulder straps, arcing front to back over the trapezius and landing on
    // the tank's own top edge at both ends.
    for (const S of ['L', 'R']) {
      const s = S === 'L' ? -1 : 1;
      const pts = [
        V3(s * 0.070, 1.372, 0.104), V3(s * 0.086, 1.442, 0.080), V3(s * 0.100, 1.492, 0.038),
        V3(s * 0.104, 1.505, -0.012), V3(s * 0.094, 1.462, -0.066), V3(s * 0.080, 1.378, -0.098)
      ];
      const pla = polyline(pts);
      const sn = [];
      for (let i = 0; i <= 11; i++) {
        const t = i / 11;
        const taper = 1 - Math.pow(Math.abs(t - 0.5) * 2, 3) * 0.25;
        sn.push(N(pla.at(t * pla.total), 0.012, 0.032 * taper, { squash: 0.65 }));
      }
      b.begin(M.tank, { group: 'body', region: 'cloth' });
      b.addRings(loft(sn, 10), [0, 0, 1, 1], { evenV: true, capStart: true, capEnd: true });
    }
  }

  // ---- trunks ------------------------------------------------------------
  {
    // Worn high over the vest, which is how trunks actually sit and which also
    // hides the seam where the vest hem meets the body.
    const hi = () => 1.155;
    const rings = shellRings(torsoNodes, SIDES_CLOTH, 8, () => 0.850, hi,
      (th, t) => 0.022 + smooth01((t - 0.55) / 0.45) * 0.014);
    b.begin(M.trunks, { group: 'body', region: 'cloth' });
    b.addRings(rings, [0, 0, 1, 1], { evenV: true, capStart: true });

    const waistband = shellRings(torsoNodes, SIDES_CLOTH, 4, () => 1.078, () => 1.168,
      () => 0.040);
    b.begin(M.belt, { group: 'body', region: 'cloth' });
    b.addRings(waistband, [0, 0, 1, 1], { evenV: true, capEnd: true });

    const bz = sampleBody(torsoNodes, 1.122).depth + 0.044;
    const bg = new THREE.BoxGeometry(0.066, 0.042, 0.014);
    b.begin(M.trim, { group: 'body', region: 'cloth' });
    b.addGeometry(bg, [0, 0, 1, 1], new THREE.Matrix4().setPosition(0, 1.122, bz));
    bg.dispose();

    // Trunk legs. They start above the crotch so they hide the closed bottom
    // of the trunk body rather than hanging off it.
    for (const S of ['L', 'R']) {
      const { nodes, pl } = legNodesBy[S];
      // Sampling a slanted leg chain by height is fragile, so the trunk leg
      // uses the same arc length parameter the leg itself was lofted with.
      const prof = [[-0.012, 0.036], [0.055, 0.038], [0.125, 0.041], [0.190, 0.044], [0.234, 0.050], [0.254, 0.041]];
      const tn = prof.map((q) => {
        const near = legRadiusAt(nodes, pl, q[0]);
        return N(pl.at(q[0]), near.d + q[1], near.w + q[1] + 0.004, {});
      });
      b.begin(M.trunks, { group: 'leg' + S, region: 'cloth' });
      b.addRings(loft(tn, 22), [0, 0, 1, 1], { evenV: true, capEnd: true });
    }
  }

  // ---- head furniture ----------------------------------------------------
  const EYE_Y = 1.770, EYE_X = 0.0305 * H, EYE_R = 0.0130;
  const eyeSurf = (() => {
    const n = sampleBody(headNodes, EYE_Y);
    const t = Math.asin(Math.min(1, EYE_X / n.width));
    return n.depth * Math.cos(t) + (n.push ?? 0);
  })();
  const eyeZ = eyeSurf - 0.0215;
  for (const s of [-1, 1]) {
    const cx = s * EYE_X;
    const g = new THREE.SphereGeometry(EYE_R, 14, 10);
    b.begin(M.eye, { group: 'body', region: 'eye' });
    b.addGeometry(g, [0, 0, 1, 1], new THREE.Matrix4().setPosition(cx, EYE_Y, eyeZ));
    g.dispose();
    const look = new THREE.Matrix4().makeRotationY(s * 0.09)
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    const iris = new THREE.SphereGeometry(EYE_R + 0.0003, 14, 6, 0, TAU, 0, 0.46);
    const im = look.clone(); im.setPosition(cx, EYE_Y, eyeZ);
    b.begin(M.iris, { group: 'body', region: 'eye' });
    b.addGeometry(iris, [0, 0, 1, 1], im);
    iris.dispose();
    const pup = new THREE.SphereGeometry(EYE_R + 0.0008, 10, 5, 0, TAU, 0, 0.22);
    const pm = look.clone(); pm.setPosition(cx, EYE_Y, eyeZ);
    b.begin(M.dark, { group: 'body', region: 'eye' });
    b.addGeometry(pup, [0, 0, 1, 1], pm);
    pup.dispose();

    // Ear: helix plus lobe, angled back off the temple. Its uv sits in the
    // spare atlas patch so it never picks up painted face detail.
    const ex = s * (0.0700 * H), ey = 1.762, ez = -0.018;
    const earRect = uvSub(A.spare, 0.05, 0.05, 0.95, 0.95);
    const e1 = ellipsoid(ex, ey, ez, 0.012, 0.033, 0.023, [0.16, 0, s * 0.18], 10);
    b.begin(M.skin, { group: 'body', region: 'head' });
    b.addGeometry(e1.geo, earRect, e1.mat);
    e1.geo.dispose();
    const e2 = ellipsoid(ex + s * 0.001, ey - 0.026, ez + 0.006, 0.011, 0.013, 0.012, [0, 0, 0], 8);
    b.begin(M.skin, { group: 'body', region: 'head' });
    b.addGeometry(e2.geo, earRect, e2.mat);
    e2.geo.dispose();
  }

  // ---- hair --------------------------------------------------------------
  const style = spec.hairStyle ?? 'short';
  if (style !== 'bald') {
    const thick = style === 'afro' ? 0.040 : style === 'buzz' ? 0.007 : 0.016;
    const CAP = 1.8855;
    // The hairline is the whole read: front high above the brow, sides down to
    // the ear, nape lower still.
    const lo = (th) => 1.7425 - backness(th) * 0.022 + frontness(th, 0.18, 0.80) * 0.088;
    const rings = shellRings(headNodes, 26, 8, lo, () => CAP,
      (th, t) => thick * (0.5 + 0.5 * smooth01(t * 1.4)));
    b.begin(M.hair, { group: 'body', region: 'hair' });
    b.addRings(rings, [0, 0, 1, 1], { evenV: true, capEnd: true, capSmooth: true });
  }

  if (spec.beard) {
    // A closed ring would collar the neck, so the back of the shell is buried
    // inside the skull and only the jaw, chin and moustache stand proud.
    const lo = (th) => 1.6575 + backness(th) * 0.030;
    const hi = (th) => 1.7075 + frontness(th, 0.0, 0.85) * 0.024 - backness(th) * 0.030;
    const rings = shellRings(bodyNodes, 24, 5, lo, hi, (th, t) => {
      const out = 1 - backness(th);
      const mous = bump((t - 1) / 0.35) * bump(Math.cos(th) - 1) * 0.5;
      return -0.008 + (0.019 + mous * 0.004) * out;
    });
    b.begin(M.hair, { group: 'body', region: 'hair' });
    b.addRings(rings, [0, 0, 1, 1], { evenV: true });
  }

  // ---- bake --------------------------------------------------------------
  const built = b.build();
  const geo = built.geometry;

  const seg = (a, c, r, pow, bias) => ({
    ax: a.x, ay: a.y, az: a.z, bx: c.x, by: c.y, bz: c.z, r, pow, bias: bias ?? 1
  });
  const headTop = P.head.clone(); headTop.y += 0.23;
  const segments = {
    hips: seg(V3(0, 0.90, 0), P.spine, 0.26, 3),
    spine: seg(P.spine, P.chest, 0.24, 3),
    chest: seg(P.chest, P.neck, 0.32, 3),
    neck: seg(P.neck, P.head, 0.16, 3, 2.4),
    head: seg(P.head, headTop, 0.22, 3, 2.2)
  };
  for (const S of ['L', 'R']) {
    const dirF = new THREE.Vector3().subVectors(P['hand' + S], P['forearm' + S]).normalize();
    segments['shoulder' + S] = seg(P['shoulder' + S], P['upperArm' + S], 0.17, 3, 1.1);
    segments['upperArm' + S] = seg(P['upperArm' + S], P['forearm' + S], 0.15, 3, 1.3);
    segments['forearm' + S] = seg(P['forearm' + S], P['hand' + S], 0.13, 3, 1.4);
    segments['hand' + S] = seg(P['hand' + S], P['hand' + S].clone().addScaledVector(dirF, 0.10), 0.11, 3, 2.0);
    segments['thigh' + S] = seg(P['thigh' + S], P['shin' + S], 0.155, 3);
    segments['shin' + S] = seg(P['shin' + S], P['foot' + S], 0.14, 3, 1.2);
    segments['foot' + S] = seg(P['foot' + S], P['foot' + S].clone().add(V3(0, -0.03, 0.16)), 0.14, 3, 2.2);
  }

  const groupBones = {
    body: ['hips', 'spine', 'chest', 'neck', 'head', 'shoulderL', 'shoulderR', 'thighL', 'thighR'],
    armL: ['chest', 'shoulderL', 'upperArmL', 'forearmL', 'handL'],
    armR: ['chest', 'shoulderR', 'upperArmR', 'forearmR', 'handR'],
    // Garments must see the same bones as the limb underneath them. The wraps
    // span mid forearm to past the wrist, so skin under them carries upper arm
    // and chest influence while the wrap carried none, and any elbow rotation
    // sheared the two surfaces apart into floating white cuffs.
    handL: ['chest', 'shoulderL', 'upperArmL', 'forearmL', 'handL'],
    handR: ['chest', 'shoulderR', 'upperArmR', 'forearmR', 'handR'],
    legL: ['hips', 'thighL', 'shinL', 'footL'],
    legR: ['hips', 'thighR', 'shinR', 'footR'],
    footL: ['hips', 'thighL', 'shinL', 'footL'],
    footR: ['hips', 'thighR', 'shinR', 'footR'],
    torso: ['hips', 'spine', 'chest']
  };
  const boneIndex = {};
  BONE_NAMES.forEach((n, i) => { boneIndex[n] = i; });
  computeSkinning(geo, built.groups, groupBones, segments, boneIndex);

  // ---- swelling morphs ---------------------------------------------------
  const regions = built.regions;
  const faceC = V3(0, 1.762, 0.045);
  const shL = P.upperArmL, shR = P.upperArmR;
  const _p = new THREE.Vector3();
  const morphIndex = { face: 0, torso: 1, arms: 2, legs: 3 };
  geo.morphTargetsRelative = false;
  geo.morphAttributes.position = [
    swellMorph(geo, (x, y, z, v) => {
      if (regions[v] !== 'head' || y < 1.66) return 0;
      _p.set(x, y, z);
      return 1 - smooth01((_p.distanceTo(faceC) - 0.050) / 0.060);
    }, 0.016),
    swellMorph(geo, (x, y, z, v) => (regions[v] === 'body' && y < 1.60
      ? band(y, 1.06, 1.46, 0.13) * smooth01((z + 0.02) / 0.09) : 0), 0.013),
    swellMorph(geo, (x, y, z, v) => {
      const r = regions[v];
      if (r !== 'armL' && r !== 'armR') return 0;
      _p.set(x, y, z);
      return smooth01((Math.min(_p.distanceTo(shL), _p.distanceTo(shR)) - 0.09) / 0.10);
    }, 0.012),
    swellMorph(geo, (x, y, z, v) => {
      const r = regions[v];
      return (r === 'legL' || r === 'legR') ? smooth01((0.90 - y) / 0.12) : 0;
    }, 0.012)
  ];

  // ---- skinned mesh ------------------------------------------------------
  const boneArray = BONE_NAMES.map((n) => bones[n]);
  const mesh = new THREE.SkinnedMesh(geo, built.materials);
  mesh.name = (spec.name || 'fighter') + ':body';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  group.add(mesh);
  group.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(boneArray);
  mesh.bind(skeleton, new THREE.Matrix4());

  // Bind is done: drop the arms into the rest pose anim/rigposer.js expects.
  for (const S of ['L', 'R']) {
    const sg = S === 'L' ? 1 : -1;
    bones['upperArm' + S].rotation.z = sg * REST_ARM_Z;
    bones['forearm' + S].rotation.z = sg * REST_FORE_Z;
  }
  group.updateMatrixWorld(true);

  // ---- surface pass: face features, tattoos ------------------------------
  const kEye = 6, kMouth = 3, kNose = 4.3, kChin = 1.6;
  const thEye = Math.asin(Math.min(1, EYE_X / headNodes[kEye].width));
  const faceLandmarks = {
    eyeL: uvHead(kEye, -thEye),
    eyeR: uvHead(kEye, thEye),
    mouth: uvHead(kMouth, 0),
    nose: uvHead(kNose, 0),
    chin: uvHead(kChin, 0),
    unit: Math.abs(uvHead(kEye, 0.9)[0] - uvHead(kEye, -0.9)[0]) * 0.50,
    stubble: spec.beard ? 0 : (spec.stubble ?? 0.55)
  };
  paintFace(skinSurf.ctx, skinSurf.size, faceLandmarks);
  if (spec.tattoo) paintTattoos(skinSurf.ctx, skinSurf.size, A, rng, spec.tattoo);
  skinTexture.needsUpdate = true;

  const damage = createDamage({
    ctx: skinSurf.ctx, size: skinSurf.size, texture: skinTexture,
    rects: A, faceLandmarks, morphIndex, influences: mesh.morphTargetInfluences, rng
  });
  const setSweat = makeSweatSetter(M);

  group.scale.setScalar(scale);

  return {
    group, bones, materials: M, spec, skeleton,
    skinnedMeshes: [mesh], mesh,
    triangles: geo.index.count / 3,
    height: 1.886 * scale,
    setDamage: damage.setDamage,
    setSweat,
    resetDamage: damage.reset,
    dispose() {
      damage.dispose();
      geo.dispose();
      skinTexture.dispose();
      for (const m of Object.values(M)) {
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) {
          if (m[k] && m[k] !== skinTexture) m[k].dispose();
        }
        m.dispose();
      }
      skeleton.dispose();
    }
  };
}

// Radius of a limb loft at a given arc length along its own polyline. Garments
// over a limb need this because sampling by height breaks the moment the limb
// is not vertical.
function legRadiusAt(nodes, pl, dist) {
  const target = pl.at(dist);
  let best = nodes[0], bestD = Infinity, second = nodes[0];
  for (const n of nodes) {
    const d = n.p.distanceTo(target);
    if (d < bestD) { second = best; best = n; bestD = d; }
  }
  const da = best.p.distanceTo(target), db = second.p.distanceTo(target);
  const t = da + db > 1e-6 ? da / (da + db) : 0;
  return {
    d: best.depth + (second.depth - best.depth) * t,
    w: best.width + (second.width - best.width) * t
  };
}
