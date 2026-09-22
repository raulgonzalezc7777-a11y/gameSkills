import * as THREE from 'three';
import { HURTBOXES } from './moves.js';

// Real hit detection. Hurtboxes are capsules pinned to the target's bones and
// rebuilt from the bone world matrices every frame, so they follow the pose
// rather than approximating it. The attacking limb is a capsule swept between
// where it was last frame and where it is now, which is the only way a jab
// that crosses 40 cm in two frames cannot tunnel through a head.
//
// Everything here is written against preallocated scratch, because it runs
// twice per fighter per frame.

const _a = new THREE.Vector3(), _b = new THREE.Vector3();
const _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _ax = new THREE.Vector3(), _rt = new THREE.Vector3(), _up = new THREE.Vector3();
const _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_X = new THREE.Vector3(1, 0, 0);

// Squared distance between segment p1q1 and segment p2q2. Ericson, Real-Time
// Collision Detection 5.1.9, written out so it allocates nothing.
export function segDistSq(p1, q1, p2, q2, outA, outB) {
  const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z;
  const d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z;
  const rx = p1.x - p2.x, ry = p1.y - p2.y, rz = p1.z - p2.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  const EPS = 1e-8;
  let s = 0, t = 0;

  if (a <= EPS && e <= EPS) {
    s = 0; t = 0;
  } else if (a <= EPS) {
    s = 0; t = f / e; t = t < 0 ? 0 : t > 1 ? 1 : t;
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) {
      t = 0; s = -c / a; s = s < 0 ? 0 : s > 1 ? 1 : s;
    } else {
      const bb = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - bb * bb;
      s = denom !== 0 ? (bb * f - c * e) / denom : 0;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      t = (bb * s + f) / e;
      if (t < 0) { t = 0; s = -c / a; s = s < 0 ? 0 : s > 1 ? 1 : s; }
      else if (t > 1) { t = 1; s = (bb - c) / a; s = s < 0 ? 0 : s > 1 ? 1 : s; }
    }
  }
  const cax = p1.x + d1x * s, cay = p1.y + d1y * s, caz = p1.z + d1z * s;
  const cbx = p2.x + d2x * t, cby = p2.y + d2y * t, cbz = p2.z + d2z * t;
  if (outA) outA.set(cax, cay, caz);
  if (outB) outB.set(cbx, cby, cbz);
  const dx = cax - cbx, dy = cay - cby, dz = caz - cbz;
  return dx * dx + dy * dy + dz * dz;
}

// The per-fighter set of bone capsules. Built once, refreshed in place.
export class HurtboxSet {
  constructor(rig) {
    this.rig = rig;
    this.capsules = [];
    const bones = rig?.bones || {};
    for (const def of HURTBOXES) {
      const ba = bones[def.a], bb = bones[def.b];
      if (!ba || !bb) continue; // a rig without this bone simply has no such box
      this.capsules.push({
        zone: def.zone, part: def.part, r: def.r, dmg: def.dmg, bias: def.bias,
        up: def.up, boneA: ba, boneB: bb,
        a: new THREE.Vector3(), b: new THREE.Vector3(),
        flash: 0
      });
    }
    this.frame = -1;
  }

  // Cheap idempotence: several attackers may query the same target in one
  // frame and the matrices only need decomposing once.
  refresh(frame) {
    if (frame === this.frame) return this;
    this.frame = frame;
    for (let i = 0; i < this.capsules.length; i++) {
      const c = this.capsules[i];
      c.boneA.matrixWorld.decompose(c.a, _q, _s);
      c.boneB.matrixWorld.decompose(c.b, _q, _s);
      if (c.up) c.b.y += c.up;
      if (c.flash > 0) c.flash -= 0.06;
    }
    return this;
  }

  // Closest capsule to a swept limb capsule, scored with the per-zone bias so
  // a clean body shot beats a graze on the arm that drifted in front of it.
  query(p0, p1, radius, out) {
    let best = null, bestScore = Infinity;
    for (let i = 0; i < this.capsules.length; i++) {
      const c = this.capsules[i];
      const dsq = segDistSq(p0, p1, c.a, c.b, _c, _d);
      const reach = radius + c.r;
      if (dsq > reach * reach) continue;
      const score = Math.sqrt(dsq) - c.bias;
      if (score < bestScore) {
        bestScore = score;
        best = c;
        if (out) out.copy(_d).lerp(_c, 0.5);
      }
    }
    if (best) best.flash = 1;
    return best;
  }

  center(out) {
    if (!this._torso) {
      for (let i = 0; i < this.capsules.length; i++) if (this.capsules[i].zone === 'torso') this._torso = this.capsules[i];
      if (!this._torso) this._torso = this.capsules[0];
    }
    const t = this._torso;
    if (!t) return out.set(0, 1, 0);
    return out.copy(t.a).lerp(t.b, 0.5);
  }
}

// Wireframe overlay. One LineSegments for every capsule in the scene, rebuilt
// each frame into a preallocated buffer, so turning it on costs one draw call.
const RING = 14, ARC = 7;
const VERTS_PER_CAPSULE = RING * 2 * 2 + 8 + ARC * 2 * 4;
const COS = new Float32Array(RING + 1), SIN = new Float32Array(RING + 1);
for (let i = 0; i <= RING; i++) { COS[i] = Math.cos((i / RING) * Math.PI * 2); SIN[i] = Math.sin((i / RING) * Math.PI * 2); }

const COLORS = {
  head: [1.0, 0.25, 0.38], body: [1.0, 0.78, 0.30], legs: [0.35, 0.80, 1.0],
  hit: [0.35, 1.0, 0.48], hitLive: [1.0, 1.0, 0.55]
};

export class HitboxDebug {
  constructor(scene, capacity = 40) {
    this.capacity = capacity;
    const n = capacity * VERTS_PER_CAPSULE;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    geo.setDrawRange(0, 0);
    this.geo = geo;
    this.mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      vertexColors: true, depthTest: false, transparent: true, opacity: 0.95, toneMapped: false
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 999;
    this.count = 0;
    scene?.add(this.mesh);
  }

  begin() { this.count = 0; }

  // Cursor write. A method rather than a per-call closure, because the debug
  // overlay still runs inside update() and must not allocate.
  _put(x, y, z) {
    const o = this._o;
    this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z;
    this.col[o] = this._cr; this.col[o + 1] = this._cg; this.col[o + 2] = this._cb;
    this._o = o + 3;
  }

  // One capsule, in world space, as two rings, four rails and four cap arcs.
  capsule(a, b, r, cr, cg, cb) {
    if (this.count >= this.capacity) return;
    this._o = this.count * VERTS_PER_CAPSULE * 3;
    this._cr = cr; this._cg = cg; this._cb = cb;
    _ax.copy(b).sub(a);
    if (_ax.lengthSq() < 1e-10) _ax.set(0, 1, 0);
    _ax.normalize();
    _rt.copy(Math.abs(_ax.y) > 0.92 ? WORLD_X : WORLD_UP).cross(_ax).normalize();
    _up.copy(_ax).cross(_rt).normalize();

    const put = this._put;
    // Two rings.
    for (let ring = 0; ring < 2; ring++) {
      const e = ring === 0 ? a : b;
      for (let i = 0; i < RING; i++) {
        put.call(this, e.x + (_rt.x * COS[i] + _up.x * SIN[i]) * r, e.y + (_rt.y * COS[i] + _up.y * SIN[i]) * r, e.z + (_rt.z * COS[i] + _up.z * SIN[i]) * r);
        put.call(this, e.x + (_rt.x * COS[i + 1] + _up.x * SIN[i + 1]) * r, e.y + (_rt.y * COS[i + 1] + _up.y * SIN[i + 1]) * r, e.z + (_rt.z * COS[i + 1] + _up.z * SIN[i + 1]) * r);
      }
    }
    // Four rails.
    for (let k = 0; k < 4; k++) {
      const cx = _rt.x * COS[k * (RING / 4) | 0] + _up.x * SIN[k * (RING / 4) | 0];
      const cy = _rt.y * COS[k * (RING / 4) | 0] + _up.y * SIN[k * (RING / 4) | 0];
      const cz = _rt.z * COS[k * (RING / 4) | 0] + _up.z * SIN[k * (RING / 4) | 0];
      put.call(this, a.x + cx * r, a.y + cy * r, a.z + cz * r);
      put.call(this, b.x + cx * r, b.y + cy * r, b.z + cz * r);
    }
    // Cap arcs, bending from the ring plane onto the axis.
    for (let side = 0; side < 2; side++) {
      const e = side === 0 ? a : b;
      const sgn = side === 0 ? -1 : 1;
      for (let plane = 0; plane < 2; plane++) {
        const bx = plane === 0 ? _rt.x : _up.x, by = plane === 0 ? _rt.y : _up.y, bz = plane === 0 ? _rt.z : _up.z;
        for (let i = 0; i < ARC; i++) {
          const t0 = (i / ARC) * Math.PI * 0.5, t1 = ((i + 1) / ARC) * Math.PI * 0.5;
          put.call(this, e.x + (bx * Math.cos(t0) + _ax.x * sgn * Math.sin(t0)) * r,
              e.y + (by * Math.cos(t0) + _ax.y * sgn * Math.sin(t0)) * r,
              e.z + (bz * Math.cos(t0) + _ax.z * sgn * Math.sin(t0)) * r);
          put.call(this, e.x + (bx * Math.cos(t1) + _ax.x * sgn * Math.sin(t1)) * r,
              e.y + (by * Math.cos(t1) + _ax.y * sgn * Math.sin(t1)) * r,
              e.z + (bz * Math.cos(t1) + _ax.z * sgn * Math.sin(t1)) * r);
        }
      }
    }
    this.count++;
  }

  addHurtboxes(set) {
    for (let i = 0; i < set.capsules.length; i++) {
      const c = set.capsules[i];
      const base = COLORS[c.part] || COLORS.body;
      const f = c.flash > 0 ? c.flash : 0;
      this.capsule(c.a, c.b, c.r, base[0] + (1 - base[0]) * f, base[1] + (1 - base[1]) * f, base[2] + (1 - base[2]) * f);
    }
  }

  addHitbox(a, b, r, live) {
    const c = live ? COLORS.hitLive : COLORS.hit;
    this.capsule(a, b, r, c[0], c[1], c[2]);
  }

  commit() {
    this.geo.setDrawRange(0, this.count * VERTS_PER_CAPSULE);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.computeBoundingSphere?.();
  }

  setVisible(v) { this.mesh.visible = v; }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.geo.dispose();
    this.mesh.material.dispose();
  }
}
