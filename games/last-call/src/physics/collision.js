// Broadphase, narrowphase and ray queries. Every routine writes into caller
// supplied manifolds and module scratch, so a full step allocates nothing.

import {
  v3, vset, vcopy, vadd, vsub, vmul, vaddScaled, vdot, vcross, vlen, vlen2,
  vnormalize, qrot, qrotInv, EPS
} from './body.js';

/* ------------------------------------------------------------- manifolds */

export class ContactPoint {
  constructor() {
    this.localA = v3();      // contact anchor in A's body frame
    this.localB = v3();      // contact anchor in B's body frame
    this.separation = 0;     // negative means penetrating
    this.id = 0;             // feature id, used to match impulses across frames
    this.normalImpulse = 0;
    this.tangentImpulse1 = 0;
    this.tangentImpulse2 = 0;
    this.relativeVelocity = 0; // approach speed captured for restitution
  }
}

export class Manifold {
  constructor() {
    this.bodyA = null;
    this.bodyB = null;
    this.staticRef = null;     // set when B is a plane or cylinder, not a Body
    this.normal = v3();        // world space, points from A toward B
    this.localNormal = v3();   // same normal in A's frame so it tracks rotation
    this.count = 0;
    this.points = [new ContactPoint(), new ContactPoint(), new ContactPoint(), new ContactPoint()];
    this.friction = 0.5;
    this.restitution = 0.1;
    this.key = 0;
    this.touched = false;
  }
  reset(a, b) {
    this.bodyA = a; this.bodyB = b; this.count = 0;
  }
}

const _p = v3(), _q = v3(), _n = v3(), _d = v3(), _e = v3(), _f = v3(), _g = v3();
const _ca = v3(), _cb = v3(), _seg = v3(), _tmp = v3(), _tmp2 = v3();
const UPV = v3(0, 1, 0);

// Add a world-space contact to a manifold. pA and pB are the witness points on
// each surface, n points from A to B, sep is negative when they overlap.
function addContact(m, a, b, pA, pB, n, sep, id) {
  if (m.count >= 4) return;
  const cp = m.points[m.count];
  if (a) { vsub(_tmp, pA, a.position); qrotInv(cp.localA, a.orientation, _tmp); }
  else vcopy(cp.localA, pA);
  if (b) { vsub(_tmp, pB, b.position); qrotInv(cp.localB, b.orientation, _tmp); }
  else vcopy(cp.localB, pB);
  cp.separation = sep;
  cp.id = id;
  if (m.count === 0) {
    vcopy(m.normal, n);
    if (a) qrotInv(m.localNormal, a.orientation, n); else vcopy(m.localNormal, n);
  }
  m.count++;
}

/* --------------------------------------------------------- basic geometry */

// Closest point on segment [p, p+d] to 'pt', returned as the parameter t.
function closestOnSegment(pt, p, d) {
  const dd = vlen2(d);
  if (dd < EPS) return 0;
  vsub(_tmp2, pt, p);
  return Math.max(0, Math.min(1, vdot(_tmp2, d) / dd));
}

// Closest points between segments [p1,p1+d1] and [p2,p2+d2]. Ericson's
// ClosestPtSegmentSegment, degenerate cases folded in.
function segmentSegment(p1, d1, p2, d2, out) {
  vsub(_d, p1, p2);
  const a = vlen2(d1), e = vlen2(d2), f = vdot(d2, _d);
  let s, t;
  if (a < EPS && e < EPS) { out.s = 0; out.t = 0; return; }
  if (a < EPS) { s = 0; t = Math.max(0, Math.min(1, f / e)); }
  else {
    const c = vdot(d1, _d);
    if (e < EPS) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
    else {
      const b = vdot(d1, d2);
      const denom = a * e - b * b;
      s = denom > EPS ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
      else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
    }
  }
  out.s = s; out.t = t;
}
const _ss = { s: 0, t: 0 };

// World-space endpoints of a capsule's core segment.
export function capsuleSegment(body, outA, outB) {
  qrot(_tmp, body.orientation, UPV);
  vaddScaled(outA, body.position, _tmp, -body.shape.halfHeight);
  vaddScaled(outB, body.position, _tmp, body.shape.halfHeight);
}

// Closest point on an oriented box to a world point, plus whether the point is
// inside. Writes the world-space result into 'out'.
function closestOnBox(body, point, out) {
  const s = body.shape;
  vsub(_tmp, point, body.position);
  qrotInv(_tmp, body.orientation, _tmp);
  const cx = Math.max(-s.hx, Math.min(s.hx, _tmp.x));
  const cy = Math.max(-s.hy, Math.min(s.hy, _tmp.y));
  const cz = Math.max(-s.hz, Math.min(s.hz, _tmp.z));
  const inside = cx === _tmp.x && cy === _tmp.y && cz === _tmp.z;
  vset(_tmp2, cx, cy, cz);
  qrot(out, body.orientation, _tmp2);
  vadd(out, body.position, out);
  return inside;
}

// Deepest face normal when a point is inside the box: push it out the nearest
// face so a fully swallowed sphere still resolves in a sane direction.
function boxInteriorNormal(body, point, out) {
  const s = body.shape;
  vsub(_tmp, point, body.position);
  qrotInv(_tmp, body.orientation, _tmp);
  const dx = s.hx - Math.abs(_tmp.x), dy = s.hy - Math.abs(_tmp.y), dz = s.hz - Math.abs(_tmp.z);
  let depth;
  if (dx <= dy && dx <= dz) { vset(_tmp2, Math.sign(_tmp.x) || 1, 0, 0); depth = dx; }
  else if (dy <= dz) { vset(_tmp2, 0, Math.sign(_tmp.y) || 1, 0); depth = dy; }
  else { vset(_tmp2, 0, 0, Math.sign(_tmp.z) || 1); depth = dz; }
  qrot(out, body.orientation, _tmp2);
  return depth;
}

/* ------------------------------------------------------ pair narrowphase */

function sphereSphere(m, a, b) {
  vsub(_n, b.position, a.position);
  const d = vlen(_n);
  const rsum = a.shape.radius + b.shape.radius;
  if (d > rsum) return false;
  if (d < EPS) vset(_n, 0, 1, 0); else vmul(_n, _n, 1 / d);
  vaddScaled(_p, a.position, _n, a.shape.radius);
  vaddScaled(_q, b.position, _n, -b.shape.radius);
  addContact(m, a, b, _p, _q, _n, d - rsum, 1);
  return true;
}

// Sphere against capsule, and the shared core of capsule pairs: two spheres
// placed at the closest points of the cores.
function coreSphereContact(m, a, b, ca, cb, ra, rb, id) {
  vsub(_n, cb, ca);
  const d = vlen(_n);
  const rsum = ra + rb;
  if (d > rsum) return false;
  if (d < EPS) vset(_n, 0, 1, 0); else vmul(_n, _n, 1 / d);
  vaddScaled(_p, ca, _n, ra);
  vaddScaled(_q, cb, _n, -rb);
  addContact(m, a, b, _p, _q, _n, d - rsum, id);
  return true;
}

function sphereCapsule(m, a, b) {
  capsuleSegment(b, _ca, _cb);
  vsub(_seg, _cb, _ca);
  const t = closestOnSegment(a.position, _ca, _seg);
  vaddScaled(_g, _ca, _seg, t);
  return coreSphereContact(m, a, b, a.position, _g, a.shape.radius, b.shape.radius, 1);
}

function capsuleCapsule(m, a, b) {
  capsuleSegment(a, _ca, _cb);
  vsub(_seg, _cb, _ca);
  capsuleSegment(b, _e, _f);
  vsub(_d, _f, _e);
  segmentSegment(_ca, _seg, _e, _d, _ss);
  vaddScaled(_g, _ca, _seg, _ss.s);
  vaddScaled(_tmp, _e, _d, _ss.t);
  return coreSphereContact(m, a, b, _g, _tmp, a.shape.radius, b.shape.radius, 1);
}

function sphereBox(m, a, b) {
  const inside = closestOnBox(b, a.position, _g);
  if (inside) {
    const depth = boxInteriorNormal(b, a.position, _n);
    vmul(_n, _n, -1);                       // push A out along -faceNormal of B
    vaddScaled(_p, a.position, _n, a.shape.radius);
    vaddScaled(_q, a.position, _n, -depth);
    addContact(m, a, b, _p, _q, _n, -(depth + a.shape.radius), 1);
    return true;
  }
  vsub(_n, _g, a.position);
  const d = vlen(_n);
  if (d > a.shape.radius) return false;
  if (d < EPS) vset(_n, 0, 1, 0); else vmul(_n, _n, 1 / d);
  vaddScaled(_p, a.position, _n, a.shape.radius);
  addContact(m, a, b, _p, _g, _n, d - a.shape.radius, 1);
  return true;
}

// Capsule against box. One deep contact from the true closest feature pair,
// plus the two endpoints so a limb lying flat on a table gets a stable
// manifold instead of pivoting on a single point.
const _capPts = [v3(), v3(), v3()];
function capsuleBox(m, a, b) {
  capsuleSegment(a, _ca, _cb);
  vsub(_seg, _cb, _ca);
  // Iterate closest-point-on-box against closest-point-on-segment. Four passes
  // converge for every configuration we generate in this game.
  vaddScaled(_g, _ca, _seg, 0.5);
  let t = 0.5;
  for (let i = 0; i < 4; i++) {
    closestOnBox(b, _g, _tmp);
    t = closestOnSegment(_tmp, _ca, _seg);
    vaddScaled(_g, _ca, _seg, t);
  }
  vcopy(_capPts[0], _g);
  vcopy(_capPts[1], _ca);
  vcopy(_capPts[2], _cb);
  const r = a.shape.radius;
  let hit = false;
  for (let i = 0; i < 3; i++) {
    const pt = _capPts[i];
    if (i > 0 && vlen2(_capPts[0]) === vlen2(pt)) continue;
    const inside = closestOnBox(b, pt, _q);
    let sep, ok = false;
    if (inside) {
      const depth = boxInteriorNormal(b, pt, _n);
      vmul(_n, _n, -1);
      sep = -(depth + r);
      vaddScaled(_q, pt, _n, -depth);
      ok = true;
    } else {
      vsub(_n, _q, pt);
      const d = vlen(_n);
      if (d <= r) {
        if (d < EPS) vset(_n, 0, 1, 0); else vmul(_n, _n, 1 / d);
        sep = d - r;
        ok = true;
      }
    }
    if (!ok) continue;
    // Keep the manifold planar: later points reuse the first normal.
    if (m.count > 0) qrot(_n, a.orientation, m.localNormal);
    vaddScaled(_p, pt, _n, r);
    addContact(m, a, b, _p, _q, _n, sep, i + 1);
    hit = true;
  }
  return hit;
}

/* ------------------------------------------------------------- box vs box */

const _RA = new Float64Array(9), _RB = new Float64Array(9);
const _C = new Float64Array(9), _absC = new Float64Array(9);
const _incident = [v3(), v3(), v3(), v3()];
const _clipIn = [v3(), v3(), v3(), v3(), v3(), v3(), v3(), v3()];
const _clipOut = [v3(), v3(), v3(), v3(), v3(), v3(), v3(), v3()];

function quatToMat3(out, q) {
  const { x, y, z, w } = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = 1 - (yy + zz); out[1] = xy - wz; out[2] = xz + wy;
  out[3] = xy + wz; out[4] = 1 - (xx + zz); out[5] = yz - wx;
  out[6] = xz - wy; out[7] = yz + wx; out[8] = 1 - (xx + yy);
}
const matAxis = (out, m, c) => vset(out, m[c], m[3 + c], m[6 + c]);

function boxBox(m, a, b) {
  quatToMat3(_RA, a.orientation);
  quatToMat3(_RB, b.orientation);
  const ea = [a.shape.hx, a.shape.hy, a.shape.hz];
  const eb = [b.shape.hx, b.shape.hy, b.shape.hz];
  vsub(_d, b.position, a.position);
  const t = [0, 0, 0];
  for (let i = 0; i < 3; i++) { matAxis(_tmp, _RA, i); t[i] = vdot(_d, _tmp); }
  for (let i = 0; i < 3; i++) {
    matAxis(_tmp, _RA, i);
    for (let j = 0; j < 3; j++) {
      matAxis(_tmp2, _RB, j);
      const c = vdot(_tmp, _tmp2);
      _C[i * 3 + j] = c;
      _absC[i * 3 + j] = Math.abs(c) + 1e-6;
    }
  }

  let best = -Infinity, bestAxis = -1, bestSign = 1;
  // Faces of A.
  for (let i = 0; i < 3; i++) {
    const ra = ea[i];
    const rb = eb[0] * _absC[i * 3] + eb[1] * _absC[i * 3 + 1] + eb[2] * _absC[i * 3 + 2];
    const s = Math.abs(t[i]);
    const ov = ra + rb - s;
    if (ov < 0) return false;
    if (ov > best === false && bestAxis >= 0) { /* keep */ }
    if (bestAxis < 0 || ov < best) { best = ov; bestAxis = i; bestSign = t[i] < 0 ? -1 : 1; }
  }
  // Faces of B.
  for (let j = 0; j < 3; j++) {
    const rb = eb[j];
    const ra = ea[0] * _absC[j] + ea[1] * _absC[3 + j] + ea[2] * _absC[6 + j];
    const proj = _C[j] * t[0] + _C[3 + j] * t[1] + _C[6 + j] * t[2];
    const ov = ra + rb - Math.abs(proj);
    if (ov < 0) return false;
    if (ov < best) { best = ov; bestAxis = 3 + j; bestSign = proj < 0 ? -1 : 1; }
  }
  // Edge pairs. Penalised slightly so a near-tie resolves as a face contact,
  // which is what keeps a stack of boxes from rocking on its corners.
  let edgeBest = -Infinity, edgeAxis = -1, edgeSign = 1;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      matAxis(_tmp, _RA, i); matAxis(_tmp2, _RB, j);
      vcross(_n, _tmp, _tmp2);
      const len = vlen(_n);
      if (len < 1e-5) continue;
      vmul(_n, _n, 1 / len);
      let ra = 0, rb = 0;
      for (let k = 0; k < 3; k++) {
        matAxis(_tmp, _RA, k); ra += ea[k] * Math.abs(vdot(_n, _tmp));
        matAxis(_tmp, _RB, k); rb += eb[k] * Math.abs(vdot(_n, _tmp));
      }
      const s = vdot(_d, _n);
      const ov = ra + rb - Math.abs(s);
      if (ov < 0) return false;
      if (ov > edgeBest === false && edgeAxis >= 0) { /* keep */ }
      if (edgeAxis < 0 || ov < edgeBest) { edgeBest = ov; edgeAxis = i * 3 + j; edgeSign = s < 0 ? -1 : 1; }
    }
  }
  if (edgeAxis >= 0 && edgeBest * 1.06 < best) {
    const i = (edgeAxis / 3) | 0, j = edgeAxis % 3;
    matAxis(_tmp, _RA, i); matAxis(_tmp2, _RB, j);
    vcross(_n, _tmp, _tmp2); vnormalize(_n, _n);
    if (edgeSign < 0) vmul(_n, _n, -1);
    // Closest points of the two supporting edges.
    supportPoint(_p, a, _RA, _n);
    vmul(_tmp, _n, -1);
    supportPoint(_q, b, _RB, _tmp);
    matAxis(_e, _RA, i); matAxis(_f, _RB, j);
    vsub(_g, _q, _p);
    segmentSegment(_p, _e, _q, _f, _ss);   // direction vectors, unit length is fine
    vaddScaled(_tmp, _p, _e, _ss.s);
    vaddScaled(_tmp2, _q, _f, _ss.t);
    addContact(m, a, b, _tmp, _tmp2, _n, -edgeBest, 64 + edgeAxis);
    return true;
  }

  // Face contact: clip the incident face against the reference face's sides.
  let refBody, incBody, refMat, incMat, refE, incE, refIdx, flip;
  if (bestAxis < 3) {
    refBody = a; incBody = b; refMat = _RA; incMat = _RB; refE = ea; incE = eb;
    refIdx = bestAxis; flip = false;
  } else {
    refBody = b; incBody = a; refMat = _RB; incMat = _RA; refE = eb; incE = ea;
    refIdx = bestAxis - 3; flip = true;
  }
  matAxis(_n, refMat, refIdx);
  const sign = flip ? -bestSign : bestSign;
  vmul(_n, _n, sign);   // reference face normal, pointing at the incident box

  // Incident face = the face of incBody most anti-parallel to _n.
  let incIdx = 0, incSign = 1, minDot = Infinity;
  for (let k = 0; k < 3; k++) {
    matAxis(_tmp, incMat, k);
    const dp = vdot(_tmp, _n);
    if (dp < minDot) { minDot = dp; incIdx = k; incSign = 1; }
    if (-dp < minDot) { minDot = -dp; incIdx = k; incSign = -1; }
  }
  faceVertices(_incident, incBody, incMat, incE, incIdx, incSign);

  // Clip against the four side planes of the reference face.
  const u = (refIdx + 1) % 3, w = (refIdx + 2) % 3;
  let inCount = 4;
  for (let k = 0; k < 4; k++) vcopy(_clipIn[k], _incident[k]);
  for (const [axisIdx, s] of [[u, 1], [u, -1], [w, 1], [w, -1]]) {
    matAxis(_tmp, refMat, axisIdx);
    vmul(_tmp, _tmp, s);
    const planeD = vdot(_tmp, refBody.position) + refE[axisIdx];
    inCount = clipPolygon(_clipOut, _clipIn, inCount, _tmp, planeD);
    for (let k = 0; k < inCount; k++) vcopy(_clipIn[k], _clipOut[k]);
    if (inCount === 0) return false;
  }

  const refD = vdot(_n, refBody.position) + refE[refIdx];
  // Report the normal in A-to-B orientation regardless of which box was the
  // reference, because the solver assumes that convention everywhere.
  if (flip) vmul(_n, _n, -1);
  let added = 0;
  for (let k = 0; k < inCount && added < 4; k++) {
    const sep = vdot(flip ? _tmp2 : _n, _clipIn[k]);
    // Recompute against the reference plane with its own (unflipped) normal.
    matAxis(_tmp, refMat, refIdx);
    vmul(_tmp, _tmp, sign);
    const s2 = vdot(_tmp, _clipIn[k]) - refD;
    if (s2 > 0.002) continue;
    vaddScaled(_p, _clipIn[k], _tmp, -s2);   // projected onto the reference face
    if (flip) addContact(m, a, b, _clipIn[k], _p, _n, s2, 128 + k);
    else addContact(m, a, b, _p, _clipIn[k], _n, s2, 128 + k);
    added++;
  }
  return added > 0;
}

function supportPoint(out, body, mat, dir) {
  const e = [body.shape.hx, body.shape.hy, body.shape.hz];
  vcopy(out, body.position);
  for (let k = 0; k < 3; k++) {
    matAxis(_tmp, mat, k);
    vaddScaled(out, out, _tmp, vdot(_tmp, dir) >= 0 ? e[k] : -e[k]);
  }
  return out;
}

function faceVertices(out, body, mat, e, axis, sign) {
  const u = (axis + 1) % 3, w = (axis + 2) % 3;
  const su = [1, 1, -1, -1], sw = [1, -1, -1, 1];
  for (let k = 0; k < 4; k++) {
    vcopy(out[k], body.position);
    matAxis(_tmp, mat, axis); vaddScaled(out[k], out[k], _tmp, e[axis] * sign);
    matAxis(_tmp, mat, u); vaddScaled(out[k], out[k], _tmp, e[u] * su[k]);
    matAxis(_tmp, mat, w); vaddScaled(out[k], out[k], _tmp, e[w] * sw[k]);
  }
}

// Sutherland-Hodgman against the half space dot(n, p) <= d.
function clipPolygon(out, poly, count, n, d) {
  let o = 0;
  for (let i = 0; i < count; i++) {
    const a = poly[i], b = poly[(i + 1) % count];
    const da = vdot(n, a) - d, db = vdot(n, b) - d;
    if (da <= 0) vcopy(out[o++], a);
    if ((da > 0) !== (db > 0)) {
      const t = da / (da - db);
      vlerpInto(out[o++], a, b, t);
    }
    if (o >= 8) break;
  }
  return o;
}
const vlerpInto = (o, a, b, t) => vset(o, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

/* --------------------------------------------- dynamic against static sets */

// Plane: n points away from the solid side, bodies live at dot(n,p) >= d.
export function bodyVsPlane(m, body, plane) {
  const s = body.shape;
  const n = plane.normal;
  vmul(_n, n, -1);   // normal runs from the body (A) toward the plane (B)
  let hit = false;
  if (s.type === 'sphere') {
    const sep = vdot(n, body.position) - plane.d - s.radius;
    if (sep > 0) return false;
    vaddScaled(_p, body.position, n, -s.radius);
    vaddScaled(_q, _p, n, -sep);
    addContact(m, body, null, _p, _q, _n, sep, 1);
    return true;
  }
  if (s.type === 'capsule') {
    capsuleSegment(body, _ca, _cb);
    for (let i = 0; i < 2; i++) {
      const pt = i === 0 ? _ca : _cb;
      const sep = vdot(n, pt) - plane.d - s.radius;
      if (sep > 0.004) continue;
      vaddScaled(_p, pt, n, -s.radius);
      vaddScaled(_q, _p, n, -sep);
      addContact(m, body, null, _p, _q, _n, sep, i + 1);
      hit = true;
    }
    return hit;
  }
  // Box: the vertices that are under the plane, deepest first, capped at four.
  quatToMat3(_RA, body.orientation);
  const e = [s.hx, s.hy, s.hz];
  for (let k = 0; k < 8 && m.count < 4; k++) {
    vcopy(_p, body.position);
    for (let axis = 0; axis < 3; axis++) {
      matAxis(_tmp, _RA, axis);
      vaddScaled(_p, _p, _tmp, (k & (1 << axis)) ? e[axis] : -e[axis]);
    }
    const sep = vdot(n, _p) - plane.d;
    if (sep > 0.004) continue;
    vaddScaled(_q, _p, n, -sep);
    addContact(m, body, null, _p, _q, _n, sep, k + 1);
    hit = true;
  }
  return hit;
}

// Cylinder wall. 'inside' keeps bodies within the radius, which is the arena
// case; the other direction is a pillar.
export function bodyVsCylinder(m, body, cyl) {
  const s = body.shape;
  const testPoint = (pt, radius, id) => {
    const dx = pt.x - cyl.x, dz = pt.z - cyl.z;
    const dist = Math.hypot(dx, dz);
    if (pt.y < cyl.yMin - radius || pt.y > cyl.yMax + radius) return false;
    let sep, nx, nz;
    if (cyl.inside) {
      sep = cyl.r - dist - radius;
      if (sep > 0) return false;
      if (dist < EPS) { nx = 1; nz = 0; } else { nx = dx / dist; nz = dz / dist; }
      vset(_n, nx, 0, nz);                      // from body outward to the wall
      vaddScaled(_p, pt, _n, radius);
      vset(_q, cyl.x + nx * cyl.r, _p.y, cyl.z + nz * cyl.r);
    } else {
      sep = dist - cyl.r - radius;
      if (sep > 0) return false;
      if (dist < EPS) { nx = 1; nz = 0; } else { nx = dx / dist; nz = dz / dist; }
      vset(_n, -nx, 0, -nz);
      vaddScaled(_p, pt, _n, radius);
      vset(_q, cyl.x + nx * cyl.r, _p.y, cyl.z + nz * cyl.r);
    }
    addContact(m, body, null, _p, _q, _n, sep, id);
    return true;
  };
  if (s.type === 'sphere') return testPoint(body.position, s.radius, 1);
  if (s.type === 'capsule') {
    capsuleSegment(body, _ca, _cb);
    const h1 = testPoint(_ca, s.radius, 1);
    const h2 = testPoint(_cb, s.radius, 2);
    return h1 || h2;
  }
  quatToMat3(_RA, body.orientation);
  const e = [s.hx, s.hy, s.hz];
  let hit = false;
  for (let k = 0; k < 8 && m.count < 4; k++) {
    vcopy(_g, body.position);
    for (let axis = 0; axis < 3; axis++) {
      matAxis(_tmp, _RA, axis);
      vaddScaled(_g, _g, _tmp, (k & (1 << axis)) ? e[axis] : -e[axis]);
    }
    if (testPoint(_g, 0, k + 1)) hit = true;
  }
  return hit;
}

/* ---------------------------------------------------------------- dispatch */

const ORDER = { sphere: 0, capsule: 1, box: 2 };

// Returns true when the pair touches. May swap so the manifold's A is always
// the lower shape rank, which halves the number of routines needed.
export function collidePair(m, a, b) {
  let A = a, B = b;
  if (ORDER[a.shape.type] > ORDER[b.shape.type]) { A = b; B = a; }
  m.reset(A, B);
  const ta = A.shape.type, tb = B.shape.type;
  if (ta === 'sphere' && tb === 'sphere') return sphereSphere(m, A, B);
  if (ta === 'sphere' && tb === 'capsule') return sphereCapsule(m, A, B);
  if (ta === 'sphere' && tb === 'box') return sphereBox(m, A, B);
  if (ta === 'capsule' && tb === 'capsule') return capsuleCapsule(m, A, B);
  if (ta === 'capsule' && tb === 'box') return capsuleBox(m, A, B);
  if (ta === 'box' && tb === 'box') return boxBox(m, A, B);
  return false;
}

/* ------------------------------------------------------------- broadphase */

// Uniform spatial hash. Rebuilt every step: the body count here is in the
// hundreds, so rebuilding beats incremental bookkeeping and never goes stale.
export class SpatialHash {
  constructor(cellSize = 0.6) {
    this.cell = cellSize;
    this.map = new Map();
    this.pairs = [];
    this.pairCount = 0;
    this._seen = new Set();
  }

  _key(ix, iy, iz) { return ix * 73856093 ^ iy * 19349663 ^ iz * 83492791; }

  build(bodies) {
    this.map.clear();
    const c = 1 / this.cell;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b.sleeping && !b.static) continue;
      const x0 = Math.floor(b.aabbMin.x * c), x1 = Math.floor(b.aabbMax.x * c);
      const y0 = Math.floor(b.aabbMin.y * c), y1 = Math.floor(b.aabbMax.y * c);
      const z0 = Math.floor(b.aabbMin.z * c), z1 = Math.floor(b.aabbMax.z * c);
      // A body spanning a silly number of cells would thrash the map; the
      // arena's statics are the only such bodies and they are cheap to skip.
      if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 4096) { b._hashBig = true; continue; }
      b._hashBig = false;
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          for (let z = z0; z <= z1; z++) {
            const k = this._key(x, y, z);
            let list = this.map.get(k);
            if (!list) { list = []; this.map.set(k, list); }
            list.push(b);
          }
        }
      }
    }
  }

  // Fills 'this.pairs' with candidate [a, b] pairs, deduped.
  query(bodies) {
    this.pairCount = 0;
    this._seen.clear();
    for (const list of this.map.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          this._push(list[i], list[j]);
        }
      }
    }
    // Oversized bodies skipped by the hash fall back to a linear sweep.
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      if (!a._hashBig) continue;
      for (let j = 0; j < bodies.length; j++) {
        if (i === j) continue;
        this._push(a, bodies[j]);
      }
    }
    return this.pairCount;
  }

  _push(a, b) {
    if (a.static && b.static) return;
    if (a.sleeping && b.sleeping) return;
    if ((a.collisionGroup & b.collisionMask) === 0 || (b.collisionGroup & a.collisionMask) === 0) return;
    if (a.ignore && a.ignore.has(b.id)) return;
    if (b.ignore && b.ignore.has(a.id)) return;
    if (a.aabbMax.x < b.aabbMin.x || a.aabbMin.x > b.aabbMax.x) return;
    if (a.aabbMax.y < b.aabbMin.y || a.aabbMin.y > b.aabbMax.y) return;
    if (a.aabbMax.z < b.aabbMin.z || a.aabbMin.z > b.aabbMax.z) return;
    const lo = a.id < b.id ? a : b, hi = a.id < b.id ? b : a;
    const key = lo.id * 100003 + hi.id;
    if (this._seen.has(key)) return;
    this._seen.add(key);
    let slot = this.pairs[this.pairCount];
    if (!slot) { slot = { a: null, b: null, key: 0 }; this.pairs[this.pairCount] = slot; }
    slot.a = lo; slot.b = hi; slot.key = key;
    this.pairCount++;
  }
}

/* ------------------------------------------------------------ ray queries */

// Every ray routine returns the distance along 'dir' (assumed unit) or -1.
export function raySphere(origin, dir, center, radius) {
  vsub(_d, origin, center);
  const b = vdot(_d, dir);
  const c = vlen2(_d) - radius * radius;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t < 0 ? 0 : t;
}

export function rayBox(origin, dir, body, outNormal) {
  const s = body.shape;
  vsub(_d, origin, body.position);
  qrotInv(_e, body.orientation, _d);
  qrotInv(_f, body.orientation, dir);
  let tmin = -Infinity, tmax = Infinity, axis = 0, sign = 1;
  const o = [_e.x, _e.y, _e.z], dd = [_f.x, _f.y, _f.z], e = [s.hx, s.hy, s.hz];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dd[i]) < 1e-8) {
      if (o[i] < -e[i] || o[i] > e[i]) return -1;
      continue;
    }
    const inv = 1 / dd[i];
    let t1 = (-e[i] - o[i]) * inv, t2 = (e[i] - o[i]) * inv, sg = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; sg = 1; }
    if (t1 > tmin) { tmin = t1; axis = i; sign = sg; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  if (tmax < 0) return -1;
  const t = tmin < 0 ? 0 : tmin;
  if (outNormal) {
    vset(_tmp, axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
    qrot(outNormal, body.orientation, _tmp);
  }
  return t;
}

export function rayCapsule(origin, dir, body, outNormal) {
  capsuleSegment(body, _ca, _cb);
  vsub(_seg, _cb, _ca);
  // Sample the segment's closest approach, then refine with a sphere test at
  // that point. Two passes are exact enough for foot IK and camera occlusion.
  let t = 0;
  for (let i = 0; i < 3; i++) {
    vaddScaled(_g, origin, dir, t);
    const u = closestOnSegment(_g, _ca, _seg);
    vaddScaled(_tmp, _ca, _seg, u);
    const hit = raySphere(origin, dir, _tmp, body.shape.radius);
    if (hit < 0) return -1;
    t = hit;
  }
  if (outNormal) {
    vaddScaled(_g, origin, dir, t);
    const u = closestOnSegment(_g, _ca, _seg);
    vaddScaled(_tmp, _ca, _seg, u);
    vsub(outNormal, _g, _tmp);
    vnormalize(outNormal, outNormal);
  }
  return t;
}

export function rayBody(origin, dir, body, outNormal) {
  const s = body.shape;
  if (s.type === 'sphere') {
    const t = raySphere(origin, dir, body.position, s.radius);
    if (t >= 0 && outNormal) {
      vaddScaled(_g, origin, dir, t);
      vsub(outNormal, _g, body.position);
      vnormalize(outNormal, outNormal);
    }
    return t;
  }
  if (s.type === 'capsule') return rayCapsule(origin, dir, body, outNormal);
  return rayBox(origin, dir, body, outNormal);
}

export function rayPlane(origin, dir, plane) {
  const dn = vdot(dir, plane.normal);
  if (Math.abs(dn) < 1e-8) return -1;
  const t = (plane.d - vdot(origin, plane.normal)) / dn;
  return t < 0 ? -1 : t;
}

export function rayCylinder(origin, dir, cyl) {
  const ox = origin.x - cyl.x, oz = origin.z - cyl.z;
  const a = dir.x * dir.x + dir.z * dir.z;
  if (a < 1e-9) return -1;
  const b = 2 * (ox * dir.x + oz * dir.z);
  const c = ox * ox + oz * oz - cyl.r * cyl.r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  const t0 = (-b - sq) / (2 * a), t1 = (-b + sq) / (2 * a);
  const t = cyl.inside ? t1 : (t0 >= 0 ? t0 : t1);
  if (t < 0) return -1;
  const y = origin.y + dir.y * t;
  if (y < cyl.yMin || y > cyl.yMax) return -1;
  return t;
}
