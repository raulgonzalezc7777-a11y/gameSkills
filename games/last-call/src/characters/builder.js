import * as THREE from 'three';
import { makeRng, hashString } from '../core/rng.js';
import {
  MeshBuilder, loft, lobeMul, computeSkinning, swellMorph, smooth01, bump, band, V3
} from './mesh.js';
import {
  SKIN_ATLAS, makeSkinCanvas, makeSkinMaterial, makeClothMaterial, makeRubberMaterial,
  makeHairMaterial, makeEyeMaterial, makeDarkMaterial, makeMetalMaterial, makeSweatSetter
} from './materials.js';
import { createDamage, paintTattoos } from './damage.js';
import { HEAD_C, EYE, makeSculpt, buildHeadGrid, buildShell, profile, buildEar, cast } from './head.js';
import { makeHeadPainter, paintFace } from './face.js';

// The fighter. One skinned mesh: a lofted body, a sculpted head and neck
// welded onto it, garments sampled off the body they are worn over, all
// weighted by distance to bone so a shoulder rolls instead of tearing open.
//
// The bind pose is not the rest pose. Geometry is authored and bound with the
// arms in a relaxed A, then the arms are dropped to the hanging rest that
// anim/rigposer.js treats as its base. Binding in A rather than in T halves
// the rotation the deltoid has to survive, which is most of the difference
// between a shoulder that deforms and a shoulder that creases.
//
// Garments are never lofted along the body and then bent into shape: a hem cut
// after the fact leaves a ring at a height whose radius it no longer matches,
// and the body pokes straight through it. Every garment vertex samples the
// body at the height it actually ends up at, then hangs from the widest point
// above it the way cloth does.
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

// The torso and the head grid share one column count so the neck ring welds.
const SIDES_BODY = 80, SIDES_LIMB = 24, SIDES_SMALL = 16, SIDES_CLOTH = 48;
const TAU = Math.PI * 2;

// Silhouette is the first thing that reads and the last thing a player forgets,
// so body type drives radii, lobes and the face rather than a uniform scale.
// Every archetype is a trained fighter: even 'lean' carries real shoulders.
export const BODY_TYPES = {
  bruiser:  { shoulder: 1.16, chest: 1.12, waist: 1.08, arm: 1.16, leg: 1.10, neck: 1.18, belly: 0.14, muscle: 1.25, head: 0.99, tall: 1.035, jaw: 1.10, brow: 1.30, cheek: 1.05 },
  lean:     { shoulder: 1.05, chest: 0.98, waist: 0.88, arm: 0.97, leg: 0.95, neck: 1.06, belly: -0.03, muscle: 1.15, head: 1.00, tall: 1.005, jaw: 0.98, brow: 1.05, cheek: 1.00 },
  stocky:   { shoulder: 1.08, chest: 1.10, waist: 1.22, arm: 1.10, leg: 1.12, neck: 1.14, belly: 0.45, muscle: 0.90, head: 1.04, tall: 0.935, jaw: 1.12, brow: 1.15, cheek: 1.18 },
  athletic: { shoulder: 1.08, chest: 1.03, waist: 0.94, arm: 1.02, leg: 1.02, neck: 1.06, belly: 0.02, muscle: 1.12, head: 1.00, tall: 1.000, jaw: 1.00, brow: 1.05, cheek: 1.00 },
  rangy:    { shoulder: 1.02, chest: 0.96, waist: 0.88, arm: 0.97, leg: 0.97, neck: 1.00, belly: 0.00, muscle: 1.02, head: 0.98, tall: 1.075, jaw: 0.96, brow: 1.00, cheek: 0.95 },
  slugger:  { shoulder: 1.12, chest: 1.10, waist: 1.12, arm: 1.12, leg: 1.07, neck: 1.12, belly: 0.30, muscle: 1.02, head: 1.02, tall: 0.975, jaw: 1.06, brow: 1.12, cheek: 1.08 }
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

// Radius of an upright node list at a height and a ring angle, lobes blended
// between the two nodes rather than switched halfway, which used to leave a
// visible step in every garment sampled across a lobe boundary.
function bodyAt(nodes, y, th) {
  let a = nodes[0], c = nodes[0], t = 0;
  if (y > nodes[nodes.length - 1].p.y) { a = c = nodes[nodes.length - 1]; } else if (y > nodes[0].p.y) {
    for (let i = 1; i < nodes.length; i++) {
      if (y <= nodes[i].p.y) { a = nodes[i - 1]; c = nodes[i]; t = (y - a.p.y) / (c.p.y - a.p.y); break; }
    }
  }
  const ma = lobeMul(th, a.lobes), mc = lobeMul(th, c.lobes);
  const m = ma + (mc - ma) * t;
  return {
    d: (a.depth + (c.depth - a.depth) * t) * m,
    w: (a.width + (c.width - a.width) * t) * m,
    push: (a.push ?? 0) + ((c.push ?? 0) - (a.push ?? 0)) * t
  };
}

function bodyPoint(nodes, y, th, pad) {
  const r = bodyAt(nodes, y, th);
  return new THREE.Vector3((r.w + pad) * Math.sin(th), y, (r.d + pad) * Math.cos(th) + r.push);
}

// Draped shell over an upright node list. Columns run bottom to top between
// lo(th) and hi(th); within a column the cloth may not pull in faster than
// 'slope' per metre below whatever it last rested on, so a vest falls straight
// off the chest instead of shrink wrapping the abs. 'tuck' pulls it back onto
// the body (into a waistband), 'fold' adds hanging folds where it is free, and
// the last rows roll the edge back to the skin so no hem floats as a paper
// edge.
function drapeShell(nodes, o) {
  const cols = o.cols, rows = o.rows;
  const rings = [];
  for (let k = 0; k < rows + 2; k++) rings.push(new Array(cols));
  for (let i = 0; i < cols; i++) {
    const th = -Math.PI + (i / cols) * TAU;
    const lo = o.lo(th), hi = o.hi(th);
    const ys = [], rad = [], shell = [];
    for (let k = 0; k < rows; k++) {
      const t = k / (rows - 1);
      const y = lo + (hi - lo) * t;
      const r = bodyAt(nodes, y, th);
      ys.push(y);
      const own = Math.hypot(r.w * Math.sin(th), r.d * Math.cos(th));
      rad.push(o.envelope ? Math.max(own, o.envelope(th, y)) : own);
    }
    let above = -1;
    for (let k = rows - 1; k >= 0; k--) {
      const base = rad[k] + o.pad(th, ys[k]);
      let s = base;
      const slope = typeof o.slope === 'function' ? o.slope(th) : o.slope;
      if (above > 0) s = Math.max(base, above - slope * (ys[k + 1] - ys[k]));
      const tuck = o.tuck ? o.tuck(ys[k]) : 0;
      s = s + (base - s) * tuck;
      shell[k] = s;
      above = s;
    }
    // Points are placed as the node's own ellipse grown by 'pad', so the pad
    // is measured from the node surface even where an envelope set the
    // radius.
    const own = (y) => { const r = bodyAt(nodes, y, th); return Math.hypot(r.w * Math.sin(th), r.d * Math.cos(th)); };
    for (let k = 0; k < rows; k++) {
      const y = ys[k];
      const free = Math.max(0, shell[k] - rad[k] - o.pad(th, y));
      const fold = o.fold ? o.fold(th, y) * Math.min(1, free / 0.008 + 0.25) : 0;
      const pad = shell[k] - own(y) + fold;
      rings[k][i] = bodyPoint(nodes, y, th, pad);
    }
    // Rolled edge: a small bulge, then back down onto the skin.
    const yTop = ys[rows - 1];
    const padTop = shell[rows - 1] - own(yTop);
    rings[rows][i] = bodyPoint(nodes, yTop + 0.003, th, padTop + 0.0012);
    rings[rows + 1][i] = bodyPoint(nodes, yTop + 0.0045, th, Math.min(padTop, 0.0022));
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

// 1 dead ahead, 0 at the sides.
const frontness = (th, lo = 0.10, hi = 0.62) => smooth01((Math.cos(th) - lo) / (hi - lo));

// Cross section of a limb loft at a given arc length along its own polyline,
// interpolated between the two nodes the arc length falls between.
function limbAt(nodes, dists, dist) {
  if (dist <= dists[0]) return nodes[0];
  for (let i = 1; i < nodes.length; i++) {
    if (dist <= dists[i]) {
      const a = nodes[i - 1], c = nodes[i];
      const t = (dist - dists[i - 1]) / (dists[i] - dists[i - 1]);
      // Both nodes' lobes are kept and blended by sectionPoint, the way the
      // loft between two rings blends them; picking the nearer node's lobes
      // undercuts a glute or a calf and lets it poke through a garment.
      return {
        depth: a.depth + (c.depth - a.depth) * t,
        width: a.width + (c.width - a.width) * t,
        squash: (a.squash ?? 1) + ((c.squash ?? 1) - (a.squash ?? 1)) * t,
        lobes: a.lobes, lobesB: c.lobes, lt: t
      };
    }
  }
  return nodes[nodes.length - 1];
}

// One point of a lofted cross section at angle th, matching mesh.js ringPoints.
function sectionPoint(p, u, v, node, th, pad) {
  let c = Math.cos(th), s = Math.sin(th);
  const e = node.squash ?? 1;
  if (e !== 1) {
    c = Math.sign(c) * Math.pow(Math.abs(c), e);
    s = Math.sign(s) * Math.pow(Math.abs(s), e);
  }
  let m = lobeMul(th, node.lobes);
  if (node.lt !== undefined) m += (lobeMul(th, node.lobesB) - m) * node.lt;
  const dc = (node.depth * m + pad) * c, ws = (node.width * m + pad) * s;
  return new THREE.Vector3(p.x + u.x * dc + v.x * ws, p.y + u.y * dc + v.y * ws, p.z + u.z * dc + v.z * ws);
}

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
  const hairStyle = spec.hairStyle ?? 'short';
  const skinSurf = makeSkinCanvas(skinTone, (seed % 97) + 3, 1024);
  const skinTexture = new THREE.CanvasTexture(skinSurf.canvas);
  skinTexture.colorSpace = THREE.SRGBColorSpace;
  skinTexture.wrapS = skinTexture.wrapT = THREE.ClampToEdgeWrapping;
  skinTexture.anisotropy = 8;

  const trunkSheen = new THREE.Color(spec.trunks ?? '#232a3d').lerp(new THREE.Color('#ffffff'), 0.22);
  const M = {
    skin: makeSkinMaterial(skinTexture, { sss: spec.sss ?? '#b8452c', tone: skinTone }),
    tank: makeClothMaterial(spec.tank ?? '#d8d3c6', { kind: 'jersey', seed: seed % 53, repeat: [9, 4], name: 'tank', sheen: 0.6, sheenRoughness: 0.7 }),
    trunks: makeClothMaterial(spec.trunks ?? '#232a3d', { kind: 'satin', seed: (seed % 31) + 60, repeat: [3, 2], name: 'trunks', sheen: 0.55, sheenRoughness: 0.4, sheenColor: '#' + trunkSheen.getHexString(), normalScale: 0.4 }),
    wrap: makeClothMaterial(spec.wrap ?? '#e7e2d6', { kind: 'wrap', seed: (seed % 17) + 120, repeat: [1, 1.8], name: 'wrap', sheen: 0.3, normalScale: 0.9 }),
    shoe: makeClothMaterial(spec.shoe ?? '#2a2f38', { kind: 'knit', seed: (seed % 23) + 170, repeat: [3, 3], name: 'shoe', sheen: 0.25 }),
    sole: makeRubberMaterial(spec.sole ?? '#cfc8ba', { seed: (seed % 19) + 210 }),
    belt: makeClothMaterial(spec.belt ?? '#12141c', { kind: 'rib', seed: (seed % 13) + 240, repeat: [14, 1], name: 'belt', sheen: 0.3 }),
    eye: makeEyeMaterial(spec.eyes ?? '#3a2a1c', seed % 7),
    dark: makeDarkMaterial('#0d0b0a'),
    trim: makeMetalMaterial('#b9a071')
  };
  if (hairStyle !== 'bald') M.hair = makeHairMaterial(spec.hair ?? '#231a14', (seed % 41) + 300, hairStyle);
  if (spec.beard) M.beard = makeHairMaterial(spec.hair ?? '#231a14', (seed % 41) + 330, 'beard');

  // ---- torso ---------------------------------------------------------------
  const b = new MeshBuilder();
  const A = SKIN_ATLAS;
  const mu = bt.muscle;

  const glute = { th: Math.PI, amount: 0.22 * mu, sharp: 2.6 };
  const bellyL = { th: 0, amount: Math.max(0, bt.belly), sharp: 2 };
  const lat = { th: 2.00, amount: 0.14 * mu, sharp: 3.2, mirror: true };
  const pec = { th: 0.58, amount: 0.15 * mu, sharp: 4.0, mirror: true };
  const clav = { th: 0.62, amount: 0.07, sharp: 4, mirror: true };
  const trap = { th: 2.05, amount: 0.20 * mu, sharp: 2.6, mirror: true };
  const obl = { th: 1.45, amount: 0.07 * mu, sharp: 4, mirror: true };
  const spineGroove = { th: Math.PI, amount: -0.05, sharp: 40 };

  const W = bt.waist, Cc = bt.chest, NK = bt.neck, SH = bt.shoulder;
  const torsoNodes = [
    // The crotch is narrow: it lives between the thighs, not across them.
    N(V3(0, 0.765, 0), 0.066 * W, 0.050 * W, { squash: 0.9 }),
    N(V3(0, 0.800, 0), 0.098 * W, 0.120 * W, {}),
    N(V3(0, 0.845, 0), 0.113 * W, 0.168 * W, { lobes: [glute] }),
    N(V3(0, 0.930, 0), 0.116 * W, 0.180 * W, { lobes: [glute] }),
    N(V3(0, 1.005, 0), 0.106 * W, 0.157 * W, { lobes: [bellyL] }),
    N(V3(0, 1.075, 0), 0.098 * W, 0.124 * W, { lobes: [bellyL, obl, spineGroove] }),
    N(V3(0, 1.145, 0), 0.100 * Cc, 0.131 * Cc, { lobes: [bellyL, obl, spineGroove] }),
    N(V3(0, 1.215, 0), 0.108 * Cc, 0.146 * Cc, { lobes: [lat, spineGroove] }),
    N(V3(0, 1.285, 0), 0.117 * Cc, 0.160 * Cc, { lobes: [lat, pec, spineGroove] }),
    N(V3(0, 1.350, 0), 0.121 * Cc, 0.168 * Cc * SH, { lobes: [pec, spineGroove] }),
    N(V3(0, 1.410, 0), 0.115 * Cc, 0.172 * Cc * SH, { lobes: [clav, spineGroove] }),
    N(V3(0, 1.460, 0), 0.100 * Cc, 0.160 * Cc * SH, { lobes: [trap] }),
    N(V3(0, 1.500, 0), 0.088 * Cc, 0.146 * SH, {})
  ];
  // Above this ring the neck and the upper trapezius are sculpted in head.js.
  const neckBase = { y: 1.500, w: 0.146 * SH, d: 0.088 * Cc, push: 0 };

  const torsoRings = loft(torsoNodes, SIDES_BODY);
  b.begin(M.skin, { group: 'body', region: 'body' });
  b.addRings(torsoRings, A.body, { evenV: true, capStart: true, capSmooth: true });

  // ---- head ----------------------------------------------------------------
  // A fighter's face, not a mannequin's: the build sets the jaw and brow, the
  // name seeds the rest so no two share a nose.
  const H = bt.head;
  const face = {
    H, NK, SH, mu,
    jaw: bt.jaw * (0.97 + rng() * 0.06),
    brow: bt.brow * (0.92 + rng() * 0.16),
    cheek: bt.cheek * (0.94 + rng() * 0.12),
    nose: 0.94 + rng() * 0.16,
    noseBreak: rng() < 0.5 ? rng() : 0,
    chin: 0.94 + rng() * 0.14,
    lips: spec.lips ?? (0.95 + rng() * 0.15),
    neckBase
  };
  const sdf = makeSculpt(face);
  const grid = buildHeadGrid(sdf, torsoRings[torsoRings.length - 1], neckBase);
  b.begin(M.skin, { group: 'body', region: 'head' });
  b.addRings(grid.rings, A.head, { capEnd: true, capSmooth: true });

  // Eyes: textured spheres sitting in the sockets the sculpt cut for them.
  const hc = (x, y, z) => new THREE.Vector3(x * H, HEAD_C.y + (y - HEAD_C.y) * H, HEAD_C.z + (z - HEAD_C.z) * H);
  for (const s of [-1, 1]) {
    const c = hc(s * EYE.x, EYE.y, EYE.z);
    const g = new THREE.SphereGeometry(EYE.r * H * 0.985, 16, 10);
    // Pole forward, gaze a touch toward the nose so the eyes converge on a
    // point a couple of metres out rather than staring through it.
    const m = new THREE.Matrix4().makeRotationY(-s * 0.03).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    m.setPosition(c.x, c.y, c.z);
    b.begin(M.eye, { group: 'body', region: 'eye' });
    b.addGeometry(g, [0, 0, 1, 1], m);
    g.dispose();
  }

  // Ears, with thinness in aux so a back light glows through them.
  const earRect = uvSub(A.spare, 0.05, 0.03, 0.95, 0.45);
  for (const s of [-1, 1]) {
    b.begin(M.skin, { group: 'body', region: 'head', aux0: 1 });
    b.addRings(buildEar(s, H), earRect, { capStart: true, capEnd: true, capSmooth: true, flipWinding: s < 0 });
  }

  // ---- arms and fists ----------------------------------------------------
  const fistRect = uvSub(A.spare, 0.05, 0.52, 0.95, 0.97);
  for (const S of ['L', 'R']) {
    const sg = S === 'L' ? 1 : -1;       // lobe angles mirror with the frame
    const Sh = P['upperArm' + S], El = P['forearm' + S], Wr = P['hand' + S];
    const dirF = new THREE.Vector3().subVectors(Wr, El).normalize();
    const pl = polyline([Sh, El, Wr, Wr.clone().addScaledVector(dirF, 0.2)]);
    const L1 = Sh.distanceTo(El), L2 = El.distanceTo(Wr);
    const am = bt.arm;
    const delt = { th: sg * 1.05, amount: 0.24 * mu, sharp: 2.4 };
    const delt2 = { th: sg * 1.35, amount: 0.18 * mu, sharp: 2.6 };
    const deltF = { th: sg * 0.35, amount: 0.10 * mu, sharp: 3.0 };
    const bicep = { th: 0, amount: 0.19 * mu, sharp: 3.0 };
    const tri = { th: Math.PI, amount: 0.16 * mu, sharp: 2.6 };
    const fore = { th: sg * 0.85, amount: 0.15 * mu, sharp: 2.6 };
    const armNodes = [
      N(pl.at(-0.062), 0.050 * am, 0.046 * am, { lobes: [delt] }),
      N(pl.at(-0.040), 0.066 * am, 0.064 * am, { lobes: [delt, deltF] }),
      N(pl.at(0.008), 0.071 * am, 0.069 * am, { lobes: [delt2, deltF] }),
      N(pl.at(L1 * 0.22), 0.064 * am, 0.062 * am, { lobes: [delt2, tri] }),
      N(pl.at(L1 * 0.42), 0.059 * am, 0.057 * am, { lobes: [bicep, tri] }),
      N(pl.at(L1 * 0.64), 0.055 * am, 0.052 * am, { lobes: [bicep, tri] }),
      N(pl.at(L1 * 0.86), 0.047 * am, 0.046 * am, { lobes: [tri] }),
      N(pl.at(L1 * 1.00), 0.045 * am, 0.046 * am, {}),
      N(pl.at(L1 + L2 * 0.14), 0.051 * am, 0.050 * am, { lobes: [fore] }),
      N(pl.at(L1 + L2 * 0.32), 0.052 * am, 0.050 * am, { lobes: [fore] }),
      N(pl.at(L1 + L2 * 0.58), 0.043 * am, 0.040 * am, {}),
      N(pl.at(L1 + L2 * 0.82), 0.035 * am, 0.029 * am, {}),
      N(pl.at(L1 + L2 * 1.00), 0.031 * Math.sqrt(am), 0.022 * Math.sqrt(am), {}),
      N(pl.at(L1 + L2 + 0.025), 0.031 * Math.sqrt(am), 0.021 * Math.sqrt(am), {})
    ];
    b.begin(M.skin, { group: 'arm' + S, region: 'arm' + S });
    b.addRings(loft(armNodes, SIDES_LIMB), A['arm' + S], { evenV: true, capStart: true, capEnd: true, capSmooth: true });

    // Fist: a boxy loft from the wrist to the knuckles. Depth runs along the
    // frame u axis (world Z here), which is across the knuckles; width is palm
    // to back of hand.
    const hs = Math.sqrt(am);

    // Frame of the straight forearm to fist line, identical to the one
    // loft() transports down the arm, so the fist and the wrap can be cut and
    // shaped by angle: the palm faces down in bind pose, the thumb forward.
    const u = V3(0, 0, 1).addScaledVector(dirF, -dirF.z).normalize();
    const v = new THREE.Vector3().crossVectors(dirF, u);
    const palm = V3(0, -1, 0).addScaledVector(dirF, dirF.y).normalize();
    const thPalm = Math.atan2(palm.dot(v), palm.dot(u));
    const sd = Math.sin(thPalm) > 0 ? -1 : 1;           // sign of sin on the back of the hand
    const sp = -sd;
    // Knuckles: four bumps across the back of the hand. Finger grooves: three
    // creases across the palm side where the curled fingers meet.
    const across = (c, side) => Math.atan2(side * Math.sqrt(1 - c * c), c);
    const knuckles = [-0.46, -0.15, 0.15, 0.46].map((c) => ({ th: across(c, sd), amount: 0.055, sharp: 90 }));
    const grooves = [-0.30, 0.0, 0.30].map((c) => ({ th: across(c, sp), amount: -0.045, sharp: 160 }));
    const fistProf = [
      [-0.012, 0.031, 0.022, 0.90, null], [0.010, 0.036, 0.025, 0.75, null], [0.034, 0.044, 0.029, 0.58, null],
      [0.058, 0.049, 0.032, 0.52, grooves], [0.078, 0.050, 0.033, 0.50, grooves], [0.092, 0.050, 0.033, 0.50, knuckles.concat(grooves)],
      [0.102, 0.048, 0.031, 0.52, knuckles], [0.108, 0.044, 0.027, 0.58, null], [0.111, 0.036, 0.021, 0.65, null]
    ];
    const fistNodes = fistProf.map((q) => N(Wr.clone().addScaledVector(dirF, q[0] * hs), q[1] * hs, q[2] * hs, { squash: q[3], lobes: q[4] }));
    const fistD = fistProf.map((q) => q[0] * hs);
    b.begin(M.skin, { group: 'hand' + S, region: 'arm' + S });
    // The front of a fist is a flat face, the backs of the first finger
    // bones; a hard edged cap keeps it from rounding off into a club.
    b.addRings(loft(fistNodes, SIDES_LIMB), fistRect, { evenV: true, capStart: true, capEnd: true, capSmooth: false });

    // Thumb folded across the front of the curled fingers, and the thenar pad
    // at its root.
    const tip = Wr.clone().addScaledVector(dirF, 0.074 * hs).addScaledVector(palm, 0.027 * hs).addScaledVector(u, 0.004);
    const e1 = ellipsoid(tip.x, tip.y, tip.z, 0.011 * hs, 0.011 * hs, 0.026 * hs, [0, 0, 0], 12);
    b.begin(M.skin, { group: 'hand' + S, region: 'arm' + S });
    b.addGeometry(e1.geo, fistRect, e1.mat);
    e1.geo.dispose();
    const th2 = Wr.clone().addScaledVector(dirF, 0.035 * hs).addScaledVector(palm, 0.016 * hs).addScaledVector(u, 0.026 * hs);
    const e2 = ellipsoid(th2.x, th2.y, th2.z, 0.016 * hs, 0.016 * hs, 0.018 * hs, [0, 0, 0], 10);
    b.addGeometry(e2.geo, fistRect, e2.mat);
    e2.geo.dispose();

    // Hand wrap: passes of tape from mid forearm over the knuckles. It stops
    // short on the palm side so the curled fingers and thumb stay bare, which
    // is the read that says 'fist' from across a room.
    const allNodes = armNodes.slice(9, 13);
    const allD = [L2 * 0.32, L2 * 0.58, L2 * 0.82, L2].map((d) => d - L2);
    const WRAP_ROWS = 10;
    const wrapRings = [];
    const d0 = -L2 * 0.42;
    for (let k = 0; k < WRAP_ROWS + 1; k++) wrapRings.push(new Array(SIDES_LIMB));
    for (let i = 0; i < SIDES_LIMB; i++) {
      const th = -Math.PI + (i / SIDES_LIMB) * TAU;
      const toPalm = smooth01((Math.cos(th - thPalm) - 0.1) / 0.8);
      const dEnd = (0.104 - 0.046 * toPalm) * hs;
      for (let k = 0; k < WRAP_ROWS; k++) {
        const t = k / (WRAP_ROWS - 1);
        const d = d0 + (dEnd - d0) * t;
        // Past the wrist the wrap follows the fist, before it the forearm.
        const node = d >= fistD[0] ? limbAt(fistNodes, fistD, d) : limbAt(allNodes, allD, d);
        const layers = 0.0035 + 0.0025 * bump(d / 0.035) + 0.002 * bump((d - 0.07 * hs) / 0.03);
        const pad = layers * smooth01((d - d0) / 0.012) + 0.0006;
        const p = Wr.clone().addScaledVector(dirF, d);
        wrapRings[k][i] = sectionPoint(p, u, v, node, th, pad);
      }
      const dl = dEnd + 0.002;
      const nl = limbAt(fistNodes, fistD, dl);
      wrapRings[WRAP_ROWS][i] = sectionPoint(Wr.clone().addScaledVector(dirF, dl), u, v, nl, th, 0.0008);
    }
    b.begin(M.wrap, { group: 'hand' + S, region: 'cloth' });
    b.addRings(wrapRings, [0, 0, 1, 1], { evenV: true });
  }

  // ---- legs --------------------------------------------------------------
  const legNodesBy = {};
  for (const S of ['L', 'R']) {
    const Hp = P['thigh' + S], Kn = P['shin' + S], An = P['foot' + S];
    const pl = polyline([Hp, Kn, An]);
    const LT = Hp.distanceTo(Kn), LS = Kn.distanceTo(An);
    const lg = bt.leg;
    const quad = { th: 0, amount: 0.13 * mu, sharp: 3.0 };
    const vmo = { th: (S === 'L' ? 1 : -1) * 0.9, amount: 0.08 * mu, sharp: 4 };
    const ham = { th: Math.PI, amount: 0.13 * mu, sharp: 2.8 };
    const calf = { th: Math.PI, amount: 0.27 * mu, sharp: 2.4 };
    const legNodes = [
      N(pl.at(-0.055), 0.078 * lg, 0.080 * lg, { lobes: [glute] }),
      N(pl.at(0.000), 0.090 * lg, 0.094 * lg, { lobes: [ham] }),
      N(pl.at(LT * 0.22), 0.088 * lg, 0.091 * lg, { lobes: [quad, ham] }),
      N(pl.at(LT * 0.45), 0.081 * lg, 0.084 * lg, { lobes: [quad] }),
      N(pl.at(LT * 0.70), 0.072 * lg, 0.074 * lg, { lobes: [quad, vmo] }),
      N(pl.at(LT * 0.90), 0.063 * lg, 0.066 * lg, { lobes: [vmo] }),
      N(pl.at(LT), 0.057 * lg, 0.063 * lg, { lobes: [{ th: 0, amount: 0.09, sharp: 5 }] }),
      N(pl.at(LT + LS * 0.10), 0.058 * lg, 0.061 * lg, { lobes: [calf] }),
      N(pl.at(LT + LS * 0.26), 0.062 * lg, 0.063 * lg, { lobes: [calf] }),
      N(pl.at(LT + LS * 0.45), 0.055 * lg, 0.054 * lg, { lobes: [calf] }),
      N(pl.at(LT + LS * 0.66), 0.044 * lg, 0.042 * lg, {}),
      N(pl.at(LT + LS * 0.86), 0.037 * lg, 0.034 * lg, {}),
      N(pl.at(LT + LS), 0.035 * lg, 0.032 * lg, {})
    ];
    const legD = [-0.055, 0, LT * 0.22, LT * 0.45, LT * 0.70, LT * 0.90, LT, LT + LS * 0.10,
      LT + LS * 0.26, LT + LS * 0.45, LT + LS * 0.66, LT + LS * 0.86, LT + LS];
    legNodesBy[S] = { nodes: legNodes, dists: legD, pl, LT, LS, lg };
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
  // Upper body surface at a height and angle: the loft up to the neck base,
  // the sculpt above it, so a strap over the trapezius lies on the muscle.
  const surf = (y, th, pad) => (y <= neckBase.y ? bodyPoint(torsoNodes, y, th, pad)
    : cast(sdf, 0, y, neckBase.push, Math.sin(th), 0, Math.cos(th), pad, 0.02));
  {
    const tankTop = profile([
      [0.00, 1.345], [0.24, 1.358], [0.40, 1.398], [0.52, 1.440], [0.60, 1.452], [0.70, 1.425],
      [0.86, 1.340], [1.08, 1.268], [1.5708, 1.230], [2.05, 1.272], [2.26, 1.360], [2.42, 1.448],
      [2.52, 1.470], [2.66, 1.452], [2.88, 1.430], [Math.PI, 1.424]
    ]);
    const ph = [rng() * TAU, rng() * TAU, rng() * TAU];
    // More columns than the other garments: the vest crosses the sharpest
    // lobes on the body (pecs, lats), and a coarse facet between two columns
    // cuts under the skin there.
    const rings = drapeShell(torsoNodes, {
      cols: 60, rows: 16,
      lo: () => 1.02, hi: tankTop,
      pad: (th) => 0.0042 + 0.0012 * frontness(th),
      // Hangs off the pecs in front, clings across the lats and the back.
      slope: (th) => 0.14 + 0.22 * (1 - frontness(th, -0.1, 0.7)),
      tuck: (y) => smooth01((1.19 - y) / 0.08),
      // Hanging folds fan down from the chest; just above the waistband the
      // cloth that was tucked in bunches into short horizontal ridges.
      fold: (th, y) => {
        const hang = smooth01((1.34 - y) / 0.10) * smooth01((y - 1.15) / 0.05);
        const bunch = Math.exp(-(((y - 1.19) / 0.025) ** 2));
        return hang * (0.0042 * Math.sin(th * 9 + ph[0] + y * 18) + 0.0028 * Math.sin(th * 14 + ph[1] - y * 26)
          + 0.0015 * Math.sin(th * 23 + ph[2]))
          + bunch * 0.0035 * (0.6 + 0.4 * Math.sin(th * 17 + ph[1])) * Math.max(0, Math.sin(y * 260 + th * 3));
      }
    });
    b.begin(M.tank, { group: 'body', region: 'cloth' });
    b.addRings(rings, [0, 0, 1, 1], { evenV: true });

    // Straps: a flat band laid over the trapezius from the front panel to
    // the back one, built in the body's own surface frame so it cannot twist.
    for (const s of [-1, 1]) {
      const path = [[0.585, 1.418], [0.605, 1.455], [0.74, 1.494], [1.00, 1.518], [1.45, 1.530],
        [1.90, 1.522], [2.22, 1.502], [2.44, 1.470], [2.51, 1.432]];
      const cen = [];
      for (let i = 0; i <= 22; i++) {
        const f = (i / 22) * (path.length - 1);
        const j = Math.min(path.length - 2, Math.floor(f)), t = f - j;
        const th = s * (path[j][0] + (path[j + 1][0] - path[j][0]) * t);
        const y = path[j][1] + (path[j + 1][1] - path[j][1]) * t;
        cen.push({ th, y, p: surf(y, th, 0.0035) });
      }
      const rings2 = [];
      for (let i = 0; i < cen.length; i++) {
        const a = cen[Math.max(0, i - 1)].p, c = cen[Math.min(cen.length - 1, i + 1)].p;
        const T = new THREE.Vector3().subVectors(c, a).normalize();
        const q = cen[i];
        // Surface normal from four neighbours on the body around this point.
        const pu = surf(q.y + 0.004, q.th, 0.0035), pd = surf(q.y - 0.004, q.th, 0.0035);
        const pr = surf(q.y, q.th + 0.03, 0.0035), pll = surf(q.y, q.th - 0.03, 0.0035);
        const Nn = new THREE.Vector3().crossVectors(pr.clone().sub(pll), pu.clone().sub(pd)).normalize();
        if (Nn.dot(new THREE.Vector3(Math.sin(q.th), 0.2, Math.cos(q.th))) < 0) Nn.negate();
        const Bn = new THREE.Vector3().crossVectors(T, Nn).normalize();
        // Narrowest over the shoulder, flaring where it runs into the panel.
        const e = Math.abs(i / (cen.length - 1) - 0.5) * 2;
        // The end rings collapse onto the panel so the band closes into the
        // vest instead of showing an open tube mouth.
        const endK = (i === 0 || i === cen.length - 1) ? 0.15 : 1;
        const hw = 0.017 * (0.92 + 0.45 * Math.pow(e, 6)) * (endK < 1 ? 0.8 : 1), th0 = 0.0018 * endK;
        const ring = [];
        const sec = [[-1, 0.2], [-0.6, 0.9], [0, 1], [0.6, 0.9], [1, 0.2], [0.6, -0.8], [0, -1], [-0.6, -0.8]];
        for (const [x, yy] of sec) ring.push(q.p.clone().addScaledVector(Bn, x * hw).addScaledVector(Nn, yy * th0 - (1 - Math.abs(yy)) * 0.0006 - (1 - endK) * 0.0012));
        rings2.push(ring);
      }
      b.begin(M.tank, { group: 'body', region: 'cloth' });
      b.addRings(rings2, [0, 0, 1, 1], { evenV: true, flipWinding: s > 0 });
    }
  }

  // ---- trunks ------------------------------------------------------------
  // Built with trouser topology: a seat that hangs from the waistband down to
  // a ring just above the crotch, then one leg per side whose top edge is that
  // ring's half on its own side closed by an inseam through the crotch. The
  // legs share the seat's edge vertex for vertex, so the garment is one
  // welded surface with no flap, no open tube top and no skin at the hip.
  {
    const ph = [rng() * TAU, rng() * TAU];
    const SEAT_Y = 0.848;
    // The hips are the torso and the tops of both thighs together, so the
    // seat hangs off whichever sticks out further along each ray.
    const thighReach = (th, y) => {
      let best = 0;
      // The loft puts parameter th on an ellipse, so the point it produces
      // lies along this direction, not along th itself.
      const r0 = bodyAt(torsoNodes, y, th);
      const ex0 = r0.w * Math.sin(th), ez0 = r0.d * Math.cos(th), el = Math.hypot(ex0, ez0) || 1;
      const dx = ex0 / el, dz = ez0 / el;
      for (const S of ['L', 'R']) {
        const { nodes, dists, pl } = legNodesBy[S];
        let d = P['thigh' + S].y - y;
        if (d < dists[0] - 0.03) continue;
        d = Math.max(d, dists[0]);
        const node = limbAt(nodes, dists, d);
        const c = pl.at(d);
        const t0 = new THREE.Vector3().subVectors(P['shin' + S], P['thigh' + S]).normalize();
        const u = V3(0, 0, 1).addScaledVector(t0, -t0.z).normalize();
        const v = new THREE.Vector3().crossVectors(t0, u);
        let prev = null;
        for (let i = 0; i <= 24; i++) {
          const q = sectionPoint(c, u, v, node, -Math.PI + (i / 24) * TAU, 0);
          if (prev) {
            // Ray from the torso axis against this edge of the section.
            const ex = q.x - prev.x, ez = q.z - prev.z;
            const den = dx * ez - dz * ex;
            if (Math.abs(den) > 1e-9) {
              const t = (prev.x * ez - prev.z * ex) / den;
              const sgm = (prev.x * dz - prev.z * dx) / den;
              if (t > 0 && sgm >= 0 && sgm <= 1) best = Math.max(best, t);
            }
          }
          prev = q;
        }
      }
      return best;
    };
    const seat = drapeShell(torsoNodes, {
      cols: SIDES_CLOTH, rows: 9,
      lo: () => SEAT_Y, hi: () => 1.108, envelope: thighReach,
      pad: () => 0.009,
      slope: 0.13,
      fold: (th, y) => smooth01((1.0 - y) / 0.08) * (0.0030 * Math.sin(th * 7 + ph[0]) + 0.0018 * Math.sin(th * 12 + ph[1] + y * 20))
    });
    // The drape rolls its top edge onto the skin; under a waistband that edge
    // is hidden, so it is simply kept.
    b.begin(M.trunks, { group: 'body', region: 'cloth' });
    b.addRings(seat, [0, 0, 1, 1], { evenV: true });
    const edge = seat[0];
    const half = SIDES_CLOTH / 2;

    for (const S of ['L', 'R']) {
      const { nodes, dists, pl } = legNodesBy[S];
      const right = S === 'R';
      const Hp = P['thigh' + S], Kn = P['shin' + S];
      const t0 = new THREE.Vector3().subVectors(Kn, Hp).normalize();
      const u = V3(0, 0, 1).addScaledVector(t0, -t0.z).normalize();
      const v = new THREE.Vector3().crossVectors(t0, u);
      // Top ring: this side's half of the seat edge, front centre to back
      // centre, then back to the front through the crotch.
      const top = [];
      if (right) for (let i = half; i <= SIDES_CLOTH; i++) top.push(edge[i % SIDES_CLOTH]);
      else for (let i = 0; i <= half; i++) top.push(edge[i]);
      // The inseam is a half ellipse in the midline plane, from the back seam
      // down under the crotch and up to the front seam, wide enough to wrap
      // the torso's own crotch so no skin shows at either end of it.
      const a = top[top.length - 1], c = top[0];
      const INSEAM = 7;
      for (let k = 1; k <= INSEAM; k++) {
        const psi = (k / (INSEAM + 1)) * Math.PI;
        const from = right ? a : c, to = right ? c : a;   // back to front for the right leg
        const zb = Math.min(from.z, to.z), zf = Math.max(from.z, to.z);
        const cs = Math.cos(psi);
        const z = right ? (cs > 0 ? zb * cs : -zf * cs) : (cs > 0 ? zf * cs : -zb * cs);
        top.push(new THREE.Vector3(0, SEAT_Y - 0.108 * Math.sin(psi), z));
      }
      const n = top.length;
      const dTop = (Hp.y - SEAT_Y) / Math.max(0.5, -t0.y);
      const axisTop = pl.at(dTop);
      const ang = top.map((p) => {
        const rel = new THREE.Vector3().subVectors(p, axisTop);
        return Math.atan2(rel.dot(v), rel.dot(u));
      });
      // Rows from the seat edge down to a mid thigh hem. Every column walks
      // down from its own top height, so the short inseam and the long outer
      // side both descend monotonically, easing from the seat's shape onto
      // the thigh within the first few centimetres.
      const HEM = 0.232;
      const yHem = pl.at(HEM).y;
      const rows = [];
      const R = 5;
      for (let k = 0; k <= R; k++) {
        const t = k / R;
        const blend = smooth01(t / 0.55);
        const ring = new Array(n);
        for (let j = 0; j < n; j++) {
          if (k === 0) { ring[j] = top[j].clone(); continue; }
          const y = top[j].y + (yHem - top[j].y) * t;
          const d = Math.max(dists[0], P['thigh' + S].y - y);
          const node = limbAt(nodes, dists, d);
          const outer = Math.max(0, Math.sin(ang[j]) * (right ? 1 : -1) * Math.sign(v.x || 1));
          const pad = 0.010 + 0.010 * t + 0.005 * outer * t
            + t * (0.0025 * Math.sin(ang[j] * 5 + ph[0]) + 0.0015 * Math.sin(ang[j] * 9 + ph[1]));
          const onLeg = sectionPoint(pl.at(d), u, v, node, ang[j], pad);
          ring[j] = top[j].clone().lerp(onLeg, blend);
          ring[j].y = y;
        }
        rows.push(ring);
      }
      // Rolled hem, back onto the thigh.
      const dH = HEM + 0.006, nH = limbAt(nodes, dists, dH);
      const hem = new Array(n);
      for (let j = 0; j < n; j++) hem[j] = sectionPoint(pl.at(dH), u, v, nH, ang[j], 0.005);
      rows.push(hem);
      b.begin(M.trunks, { group: 'body', region: 'shorts' });
      b.addRings(rows, [0, 0, 1, 1], { evenV: true, flipWinding: true });
    }

    // Waistband: thick elastic with a rounded top edge.
    const wb = [];
    const wbRows = [[1.090, 0.0125], [1.100, 0.0175], [1.140, 0.0190], [1.160, 0.0180], [1.168, 0.0140], [1.170, 0.0080]];
    for (const [y, pad] of wbRows) {
      const ring = [];
      for (let i = 0; i < SIDES_CLOTH; i++) {
        const th = -Math.PI + (i / SIDES_CLOTH) * TAU;
        ring.push(bodyPoint(torsoNodes, y, th, pad + 0.0035));
      }
      wb.push(ring);
    }
    b.begin(M.belt, { group: 'body', region: 'cloth' });
    b.addRings(wb, [0, 0, 1, 1], { evenV: true });

    // Drawcord knot at the front.
    const kz = bodyAt(torsoNodes, 1.128, 0).d + 0.0235;
    for (const s of [-1, 1]) {
      const e = ellipsoid(s * 0.008, 1.126, kz, 0.009, 0.006, 0.005, [0, 0, s * 0.4], 8);
      b.begin(M.trim, { group: 'body', region: 'cloth' });
      b.addGeometry(e.geo, [0, 0, 1, 1], e.mat);
      e.geo.dispose();
      const c = new THREE.CylinderGeometry(0.0022, 0.0018, 0.07, 6);
      const m = new THREE.Matrix4().makeRotationZ(s * 0.18).setPosition(s * 0.010, 1.088, kz - 0.002);
      b.addGeometry(c, [0, 0, 1, 1], m);
      c.dispose();
    }
  }

  // ---- hair and beard ----------------------------------------------------
  // Hairlines are tuned as elevation (radians up from the head centre) at a
  // handful of angles round the head: forehead, temple corner, sideburn,
  // over the ear, nape.
  const hairLine = profile(hairStyle === 'buzz'
    ? [[0, 0.80], [0.35, 0.78], [0.62, 0.66], [0.85, 0.64], [1.05, 0.50], [1.18, 0.22], [1.28, 0.02], [1.40, 0.12], [1.55, 0.42], [1.80, 0.42], [2.05, 0.18], [2.40, -0.22], [Math.PI, -0.36]]
    : hairStyle === 'afro'
      ? [[0, 0.74], [0.35, 0.72], [0.62, 0.66], [0.85, 0.62], [1.05, 0.50], [1.18, 0.22], [1.28, 0.00], [1.40, 0.10], [1.55, 0.40], [1.80, 0.40], [2.05, 0.18], [2.40, -0.24], [Math.PI, -0.38]]
      : [[0, 0.80], [0.35, 0.77], [0.60, 0.69], [0.85, 0.66], [1.05, 0.52], [1.18, 0.21], [1.28, -0.03], [1.40, 0.10], [1.55, 0.42], [1.80, 0.42], [2.05, 0.17], [2.40, -0.24], [Math.PI, -0.38]]);
  const HR = 0.092 * H;   // rough radius of the scalp for turning angles into metres
  const hairFade = hairStyle === 'afro' ? 0.006 : 0.010;
  const hairDensity = hairStyle === 'buzz' ? 0.80 : 1.0;
  const hairCover = (th, ph, forPaint) => {
    const dist = (ph - hairLine(th)) * HR;
    const w = hairFade * (1 + 0.6 * smooth01((Math.abs(th) - 1.9) / 0.8));
    const c = smooth01((dist + (forPaint ? 0.004 : 0.001)) / w);
    return c * (forPaint ? 1 : hairDensity);
  };

  if (hairStyle !== 'bald') {
    const T = hairStyle === 'afro' ? 0.0125 : hairStyle === 'buzz' ? 0.0022 : 0.0065;
    const lump = [rng() * TAU, rng() * TAU, rng() * TAU];
    const shell = buildShell(sdf, {
      cols: 48, rows: hairStyle === 'afro' ? 16 : 13, rowPow: 1.5,
      th0: -Math.PI, th1: Math.PI,
      lo: (th) => hairLine(th) - 0.03, hi: () => 1.53,
      thick: (th, ph) => {
        const dist = (ph - hairLine(th)) * HR;
        const ramp = smooth01(dist / (hairStyle === 'afro' ? 0.035 : 0.012));
        let t = T;
        if (hairStyle === 'short') t *= 1 + 0.45 * smooth01((ph - 0.5) / 0.7);
        if (hairStyle === 'afro') {
          t *= 1 + 0.45 * smooth01((ph - 0.2) / 0.9) + 0.15 * smooth01((Math.abs(th) - 1.2) / 1.2);
          t += 0.0012 * (Math.sin(th * 17 + lump[0] + ph * 9) * Math.sin(ph * 19 + lump[1]) + 0.6 * Math.sin(th * 29 + lump[2] - ph * 23));
        }
        return 0.0007 + t * ramp;
      },
      cover: (th, ph) => hairCover(th, ph, false)
    });
    b.begin(M.hair, { group: 'body', region: 'hair' });
    b.addRings(shell.rings, [0, 0, 1, 1], { capEnd: true, capSmooth: true, aux: shell.cover });
  }

  // Beard region as elevation bounds per angle. It follows the jaw back to
  // the sideburn and leaves a hole for the lips.
  const beardLo = profile([[0, -1.02], [0.8, -1.0], [1.2, -0.92], [1.40, -0.72], [1.48, -0.5]]);
  const beardHi = profile([[0, -0.305], [0.22, -0.30], [0.42, -0.26], [0.70, -0.17], [1.0, -0.09], [1.22, 0.02], [1.34, 0.05], [1.48, -0.1]]);
  const beardCover = (th, ph, forPaint) => {
    const a = Math.abs(th);
    if (a > 1.5) return 0;
    const top = smooth01((beardHi(th) - ph) * HR / 0.012);
    const bot = smooth01((ph - beardLo(th)) * HR / 0.006 + 0.3);
    const side = smooth01((1.40 - a) / 0.16);
    const e = Math.hypot(th / 0.27, (ph + 0.55) / 0.115);
    const lips = smooth01((e - 1) / 0.25);
    return top * bot * side * lips * (forPaint ? 1 : 0.84);
  };
  if (spec.beard) {
    const shell = buildShell(sdf, {
      cols: 48, rows: 10, closed: false,
      th0: -1.5, th1: 1.5,
      lo: (th) => beardLo(th) - 0.02, hi: (th) => beardHi(th) + 0.03,
      thick: (th, ph) => {
        const c = beardCover(th, ph, true);
        const chin = Math.exp(-((th / 0.4) ** 2) - ((ph + 0.85) / 0.2) ** 2);
        return 0.0007 + (0.0026 + 0.0022 * chin) * smooth01(c * 1.6);
      },
      cover: (th, ph) => beardCover(th, ph, false)
    });
    b.begin(M.beard, { group: 'body', region: 'hair' });
    b.addRings(shell.rings, [0, 0, 1, 1], { closed: false, aux: shell.cover });
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
  rigidHead(geo, built.groups, boneIndex);

  // Oily zones for the skin shader, from bind positions: forehead and nose,
  // the tops of the shoulders and traps, the upper chest.
  {
    const pos = geo.attributes.position.array, aux = geo.attributes.aux.array;
    for (let v = 0; v < built.vertexCount; v++) {
      if (built.vmat[v] !== M.skin) continue;
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      const ax = Math.abs(x);
      const hx = Math.abs(x / H), hy = HEAD_C.y + (y - HEAD_C.y) / H, hz = HEAD_C.z + (z - HEAD_C.z) / H;
      let o = 0;
      o = Math.max(o, band(hy, 1.795, 1.86, 0.02) * smooth01((hz - 0.03) / 0.04) * (1 - smooth01((hx - 0.045) / 0.02)));
      o = Math.max(o, band(hy, 1.735, 1.795, 0.01) * smooth01((hz - 0.085) / 0.012) * (1 - smooth01((hx - 0.012) / 0.01)));
      o = Math.max(o, 0.7 * band(hy, 1.66, 1.69, 0.012) * smooth01((hz - 0.07) / 0.02) * (1 - smooth01((hx - 0.02) / 0.02)));
      if (y < 1.6) {
        o = Math.max(o, 0.8 * band(y, 1.42, 1.57, 0.05) * smooth01((ax - 0.07) / 0.06));
        o = Math.max(o, 0.4 * band(y, 1.30, 1.44, 0.05) * smooth01(z / 0.05));
      }
      aux[v * 2 + 1] = Math.min(1, o);
    }
    geo.attributes.aux.needsUpdate = true;
  }

  // ---- swelling morphs ---------------------------------------------------
  const regions = built.regions, groups = built.groups;
  const faceC = V3(0, 1.762, 0.045);
  const shL = P.upperArmL, shR = P.upperArmR;
  const _p = new THREE.Vector3();
  const morphIndex = { face: 0, torso: 1, arms: 2, legs: 3 };
  geo.morphTargetsRelative = false;
  geo.morphAttributes.position = [
    swellMorph(geo, (x, y, z, v) => {
      const r = regions[v];
      if ((r !== 'head' && r !== 'hair') || y < 1.66) return 0;
      _p.set(x, y, z);
      return 1 - smooth01((_p.distanceTo(faceC) - 0.050) / 0.060);
    }, 0.012),
    // Garments swell with the flesh under them, or a bruised chest pushes
    // straight through the vest and a swollen forearm through the wraps.
    swellMorph(geo, (x, y, z, v) => ((regions[v] === 'body' || (regions[v] === 'cloth' && groups[v] === 'body')) && y < 1.60
      ? band(y, 1.06, 1.46, 0.13) * smooth01((z + 0.02) / 0.09) : 0), 0.013),
    swellMorph(geo, (x, y, z, v) => {
      const r = regions[v], g = groups[v];
      if (r !== 'armL' && r !== 'armR' && !(r === 'cloth' && (g === 'handL' || g === 'handR'))) return 0;
      _p.set(x, y, z);
      return smooth01((Math.min(_p.distanceTo(shL), _p.distanceTo(shR)) - 0.09) / 0.10);
    }, 0.012),
    swellMorph(geo, (x, y, z, v) => {
      const r = regions[v], g = groups[v];
      return (r === 'legL' || r === 'legR' || r === 'shorts' || (r === 'cloth' && (g === 'legL' || g === 'legR'))) ? smooth01((0.90 - y) / 0.12) : 0;
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

  // ---- surface pass: face, scalp, tattoos ------------------------------
  const painter = makeHeadPainter(skinSurf.ctx, skinSurf.size, grid, A.head, H);
  paintFace(painter, {
    skin: skinTone, hair: spec.hair ?? '#231a14', rng,
    stubble: spec.beard ? 0 : (spec.stubble ?? 0.55), beard: !!spec.beard,
    hairCover: hairStyle === 'bald' ? null : hairCover,
    bald: hairStyle === 'bald', baldCover: (th, ph) => hairCover(th, ph, true),
    beardCover
  });
  if (spec.tattoo) paintTattoos(skinSurf.ctx, skinSurf.size, A, rng, spec.tattoo);
  skinTexture.needsUpdate = true;

  const toUv = (x, y, z) => {
    const w = hc(x, y, z);
    const [u, v] = grid.uvOf(w.x, w.y, w.z);
    return [A.head[0] + u * (A.head[2] - A.head[0]), A.head[1] + v * (A.head[3] - A.head[1])];
  };
  const faceLandmarks = {
    eyeL: toUv(-EYE.x, EYE.y, 0.08),
    eyeR: toUv(EYE.x, EYE.y, 0.08),
    mouth: toUv(0, 1.706, 0.1),
    nose: toUv(0, 1.74, 0.11),
    chin: toUv(0, 1.675, 0.09),
    unit: Math.abs(toUv(0.045, EYE.y, 0.08)[0] - toUv(-0.045, EYE.y, 0.08)[0])
  };

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

// The skull and jaw are one rigid piece. Distance weights alone let the chin
// and the back of the skull pick up neck influence and lag behind a nod, so
// above a line that runs from under the jaw to the base of the skull every
// vertex is handed to the head bone, blended over a few centimetres into the
// neck below it. The line is the same for skin, hair, beard and eyes, so the
// shells ride the scalp exactly.
function rigidHead(geo, groups, boneIndex) {
  const pos = geo.attributes.position.array;
  const si = geo.attributes.skinIndex.array, sw = geo.attributes.skinWeight.array;
  const hi = boneIndex.head;
  const tmp = new Map();
  for (let v = 0; v < groups.length; v++) {
    if (groups[v] !== 'body') continue;
    const y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    if (y < 1.58) continue;
    const back = smooth01((0.02 - z) / 0.08);
    const yLow = 1.625 + back * 0.055;
    const f = smooth01((y - yLow) / 0.045);
    if (f <= 0) continue;
    tmp.clear();
    for (let j = 0; j < 4; j++) {
      const w = sw[v * 4 + j] * (1 - f);
      if (w > 0) tmp.set(si[v * 4 + j], (tmp.get(si[v * 4 + j]) || 0) + w);
    }
    tmp.set(hi, (tmp.get(hi) || 0) + f);
    const list = [...tmp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    let sum = 0;
    for (const e of list) sum += e[1];
    for (let j = 0; j < 4; j++) {
      si[v * 4 + j] = j < list.length ? list[j][0] : 0;
      sw[v * 4 + j] = j < list.length ? list[j][1] / sum : 0;
    }
  }
  geo.attributes.skinIndex.needsUpdate = true;
  geo.attributes.skinWeight.needsUpdate = true;
}
