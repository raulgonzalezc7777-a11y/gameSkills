import * as THREE from 'three';

// Geometry toolkit for the procedural fighter.
//
// Everything the character is made of is a grid of rings lofted along a path:
// torso, limbs, garments, shoes and props all come out of one code path. That
// matters for two reasons. Rings share an explicit topology so a chain never
// cracks when a joint bends, and a single weld pass over the merged buffer
// averages normals across part boundaries so separately lofted pieces read as
// one continuous surface.

const _q = new THREE.Quaternion();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _n = new THREE.Vector3(), _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3();

export const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// ------------------------------------------------------------- frames -----

// Parallel transport frames along a polyline. The basis is right handed with
// u cross v = tangent, so every ring generated from it winds the same way and
// the outward normal always points away from the path.
export function frames(points) {
  const n = points.length;
  const tan = [];
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(n - 1, i + 1)];
    const t = new THREE.Vector3().subVectors(b, a);
    if (t.lengthSq() < 1e-12) t.set(0, 1, 0);
    tan.push(t.normalize());
  }
  const ref = Math.abs(tan[0].z) > 0.85 ? V3(0, 1, 0) : V3(0, 0, 1);
  let u = ref.clone().addScaledVector(tan[0], -ref.dot(tan[0]));
  if (u.lengthSq() < 1e-8) u.set(1, 0, 0);
  u.normalize();
  const out = [];
  let prevT = tan[0];
  for (let i = 0; i < n; i++) {
    _q.setFromUnitVectors(prevT, tan[i]);
    u = u.clone().applyQuaternion(_q);
    u.addScaledVector(tan[i], -u.dot(tan[i]));
    if (u.lengthSq() < 1e-8) u.set(0, 0, 1).addScaledVector(tan[i], -tan[i].z);
    u.normalize();
    const v = new THREE.Vector3().crossVectors(tan[i], u);
    out.push({ p: points[i], t: tan[i], u, v });
    prevT = tan[i];
  }
  return out;
}

// Per angle radius multiplier. A lobe is a soft bulge centred on 'th' in the
// same angle space as the ring, which is how pecs, deltoids, glutes, calves
// and knuckles get added without extra topology.
export function lobeMul(th, lobes) {
  if (!lobes) return 1;
  let m = 1;
  for (let i = 0; i < lobes.length; i++) {
    const L = lobes[i];
    let d = Math.cos(th - L.th);
    if (L.mirror) d = Math.max(d, Math.cos(th + L.th));
    if (d > 0) m += L.amount * Math.pow(d, L.sharp ?? 2);
  }
  return m;
}

// One cross section. 'depth' runs along the frame u axis (the character's
// front for an upright chain), 'width' along v (the sides).
export function ringPoints(frame, node, sides) {
  const pts = new Array(sides);
  const depth = node.depth ?? node.r ?? 0.1;
  const width = node.width ?? node.r ?? 0.1;
  const e = node.squash ?? 1;
  for (let i = 0; i < sides; i++) {
    const th = -Math.PI + (i / sides) * Math.PI * 2;
    let c = Math.cos(th), s = Math.sin(th);
    if (e !== 1) {
      c = Math.sign(c) * Math.pow(Math.abs(c), e);
      s = Math.sign(s) * Math.pow(Math.abs(s), e);
    }
    const m = lobeMul(th, node.lobes);
    const dc = depth * c * m + (node.push ?? 0);
    const ws = width * s * m;
    pts[i] = new THREE.Vector3(
      frame.p.x + frame.u.x * dc + frame.v.x * ws,
      frame.p.y + frame.u.y * dc + frame.v.y * ws,
      frame.p.z + frame.u.z * dc + frame.v.z * ws
    );
  }
  return pts;
}

// Loft a node list into rings. Nodes carry their own position, so this is the
// entry point for both straight chains and bent ones.
export function loft(nodes, sides) {
  const fr = frames(nodes.map((n) => n.p));
  return nodes.map((n, i) => ringPoints(fr[i], n, sides));
}

// The v coordinate addRings will hand each ring. Exposed so a caller can ask
// where a landmark lands in the atlas instead of guessing: painting an eyebrow
// or dropping a cut on a cheekbone needs the exact answer.
export function ringVs(rings, evenV) {
  const nv = rings.length;
  const vs = new Array(nv);
  if (evenV) {
    let total = 0;
    vs[0] = 0;
    for (let k = 1; k < nv; k++) {
      total += rings[k][0].distanceTo(rings[k - 1][0]);
      vs[k] = total;
    }
    for (let k = 0; k < nv; k++) vs[k] = total > 1e-6 ? vs[k] / total : k / (nv - 1);
  } else {
    for (let k = 0; k < nv; k++) vs[k] = k / (nv - 1);
  }
  return vs;
}

// uv of ring row 'k' (fractional allowed) at ring angle 'th'.
export function uvAt(rings, rect, vs, k, th, closed = true) {
  const nu = rings[0].length;
  const cols = closed ? nu + 1 : nu;
  const i = ((th + Math.PI) / (Math.PI * 2)) * nu;
  const k0 = Math.max(0, Math.min(vs.length - 1, Math.floor(k)));
  const k1 = Math.min(vs.length - 1, k0 + 1);
  const vv = vs[k0] + (vs[k1] - vs[k0]) * (k - k0);
  return [
    rect[0] + (i / (cols - 1)) * (rect[2] - rect[0]),
    rect[1] + vv * (rect[3] - rect[1])
  ];
}

// -------------------------------------------------------- mesh builder ----

export class MeshBuilder {
  constructor() {
    this.pos = [];
    this.uv = [];
    this.group = [];     // skin weight group name per vertex
    this.weld = [];      // weld island id per vertex
    this.region = [];    // damage region name per vertex
    this.parts = [];     // { mat, idx: [] }
    this._part = null;
  }

  get vertexCount() { return this.pos.length / 3; }

  // Every subsequent add lands in this material bucket. Buckets are merged
  // into geometry groups at build time, so material count equals draw calls.
  begin(mat, opts = {}) {
    this._part = { mat, idx: [], group: opts.group || 'torso', weld: opts.weld ?? mat, region: opts.region || 'torso' };
    this.parts.push(this._part);
    return this;
  }

  _push(x, y, z, u, v) {
    const p = this._part;
    this.pos.push(x, y, z);
    this.uv.push(u, v);
    this.group.push(p.group);
    this.weld.push(p.weld);
    this.region.push(p.region);
    return this.pos.length / 3 - 1;
  }

  // rings: array of arrays of Vector3, all the same length.
  // rect: [u0,v0,u1,v1] slice of the texture atlas this patch occupies.
  addRings(rings, rect, opts = {}) {
    const closed = opts.closed !== false;
    const nv = rings.length;
    const nu = rings[0].length;
    const cols = closed ? nu + 1 : nu;      // seam vertex duplicated for uv
    const base = this.vertexCount;
    const [u0, v0, u1, v1] = rect;
    // Arc length along the chain gives even texel density on tapered limbs.
    const vs = new Array(nv);
    if (opts.evenV) {
      let total = 0;
      vs[0] = 0;
      for (let k = 1; k < nv; k++) {
        total += rings[k][0].distanceTo(rings[k - 1][0]);
        vs[k] = total;
      }
      for (let k = 0; k < nv; k++) vs[k] = total > 1e-6 ? vs[k] / total : k / (nv - 1);
    } else {
      for (let k = 0; k < nv; k++) vs[k] = k / (nv - 1);
    }
    for (let k = 0; k < nv; k++) {
      const vv = v0 + (opts.flipV ? 1 - vs[k] : vs[k]) * (v1 - v0);
      for (let i = 0; i < cols; i++) {
        const p = rings[k][i % nu];
        this._push(p.x, p.y, p.z, u0 + (i / (cols - 1)) * (u1 - u0), vv);
      }
    }
    const idx = this._part.idx;
    for (let k = 0; k < nv - 1; k++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = base + k * cols + i, b = a + 1;
        const c = a + cols, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    if (opts.capStart) this._cap(rings[0], rect, true, opts.capSmooth);
    if (opts.capEnd) this._cap(rings[nv - 1], rect, false, opts.capSmooth);
    return this;
  }

  _cap(ring, rect, isStart, smooth) {
    const nu = ring.length;
    const cx = ring.reduce((s, p) => s + p.x, 0) / nu;
    const cy = ring.reduce((s, p) => s + p.y, 0) / nu;
    const cz = ring.reduce((s, p) => s + p.z, 0) / nu;
    const prevWeld = this._part.weld;
    // A cap welds with its own rim only when asked, which keeps hard edges on
    // soles and bottle bases but leaves the crown of the skull smooth.
    if (!smooth) this._part.weld = prevWeld + ':cap' + this.pos.length;
    const uc = (rect[0] + rect[2]) * 0.5, vc = rect[1] + (isStart ? 0.02 : 0.98) * (rect[3] - rect[1]);
    const c = this._push(cx, cy, cz, uc, vc);
    const start = this.vertexCount;
    for (let i = 0; i < nu; i++) {
      const p = ring[i];
      const a = (i / nu) * Math.PI * 2;
      this._push(p.x, p.y, p.z, uc + Math.cos(a) * (rect[2] - rect[0]) * 0.04, vc + Math.sin(a) * (rect[3] - rect[1]) * 0.04);
    }
    const idx = this._part.idx;
    for (let i = 0; i < nu; i++) {
      const a = start + i, b = start + ((i + 1) % nu);
      if (isStart) idx.push(c, b, a); else idx.push(c, a, b);
    }
    this._part.weld = prevWeld;
    return this;
  }

  // Bake an already positioned THREE geometry into the buffer. Used for ears,
  // eyes and small props that are easier to author as primitives.
  addGeometry(geo, rect, matrix) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.attributes.position.array;
    const uv = g.attributes.uv ? g.attributes.uv.array : null;
    const base = this.vertexCount;
    const n = p.length / 3;
    for (let i = 0; i < n; i++) {
      _a.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      if (matrix) _a.applyMatrix4(matrix);
      const su = uv ? uv[i * 2] : 0.5, sv = uv ? uv[i * 2 + 1] : 0.5;
      this._push(_a.x, _a.y, _a.z, rect[0] + su * (rect[2] - rect[0]), rect[1] + sv * (rect[3] - rect[1]));
    }
    for (let i = 0; i < n; i++) this._part.idx.push(base + i);
    if (g !== geo) g.dispose();
    return this;
  }

  build() {
    const vc = this.vertexCount;
    const position = new Float32Array(this.pos);
    const uv = new Float32Array(this.uv);
    // Material buckets become geometry groups, ordered so equal materials are
    // one contiguous draw.
    const byMat = new Map();
    for (const p of this.parts) {
      if (!p.idx.length) continue;
      if (!byMat.has(p.mat)) byMat.set(p.mat, []);
      byMat.get(p.mat).push(...p.idx);
    }
    const mats = [...byMat.keys()];
    let total = 0;
    for (const list of byMat.values()) total += list.length;
    const index = total > 65535 ? new Uint32Array(total) : new Uint16Array(total);
    const geo = new THREE.BufferGeometry();
    let off = 0, mi = 0;
    for (const list of byMat.values()) {
      index.set(list, off);
      geo.addGroup(off, list.length, mi);
      off += list.length;
      mi++;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.setAttribute('normal', new THREE.BufferAttribute(smoothNormals(position, index, this.weld), 3));
    geo.computeBoundingSphere();
    return { geometry: geo, materials: mats, groups: this.group, regions: this.region, vertexCount: vc };
  }
}

// Area weighted normals averaged over welded positions. Vertices only weld
// with others carrying the same weld island id, which is what lets a shoe sole
// keep a hard rim while the torso and head share one smooth surface.
export function smoothNormals(pos, index, weldIds) {
  const n = pos.length / 3;
  const rep = new Int32Array(n);
  const map = new Map();
  const Q = 1e4;
  for (let i = 0; i < n; i++) {
    const key = (weldIds ? weldIds[i] : '') + '|' +
      Math.round(pos[i * 3] * Q) + '|' + Math.round(pos[i * 3 + 1] * Q) + '|' + Math.round(pos[i * 3 + 2] * Q);
    const hit = map.get(key);
    if (hit === undefined) { map.set(key, i); rep[i] = i; } else rep[i] = hit;
  }
  const acc = new Float32Array(n * 3);
  for (let f = 0; f < index.length; f += 3) {
    const ia = index[f], ib = index[f + 1], ic = index[f + 2];
    _a.set(pos[ia * 3], pos[ia * 3 + 1], pos[ia * 3 + 2]);
    _b.set(pos[ib * 3], pos[ib * 3 + 1], pos[ib * 3 + 2]);
    _c.set(pos[ic * 3], pos[ic * 3 + 1], pos[ic * 3 + 2]);
    _e1.subVectors(_b, _a); _e2.subVectors(_c, _a);
    _n.crossVectors(_e1, _e2);
    for (const i of [ia, ib, ic]) {
      const r = rep[i] * 3;
      acc[r] += _n.x; acc[r + 1] += _n.y; acc[r + 2] += _n.z;
    }
  }
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = rep[i] * 3;
    let x = acc[r], y = acc[r + 1], z = acc[r + 2];
    const len = Math.hypot(x, y, z) || 1;
    out[i * 3] = x / len; out[i * 3 + 1] = y / len; out[i * 3 + 2] = z / len;
  }
  return out;
}

// ------------------------------------------------------------ skinning ----

function distToSegment(px, py, pz, s) {
  const dx = s.bx - s.ax, dy = s.by - s.ay, dz = s.bz - s.az;
  const l2 = dx * dx + dy * dy + dz * dz;
  let t = 0;
  if (l2 > 1e-9) t = ((px - s.ax) * dx + (py - s.ay) * dy + (pz - s.az) * dz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (s.ax + dx * t), py - (s.ay + dy * t), pz - (s.az + dz * t));
}

// Distance-to-bone-segment falloff, normalised to the four strongest
// influences. 'groups' restricts which bones a vertex may bind to, which is
// what stops a hand that rests beside the thigh in bind pose from picking up
// leg weight.
export function computeSkinning(geo, vertexGroups, groupBones, segments, boneIndex) {
  const pos = geo.attributes.position.array;
  const n = pos.length / 3;
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  const cand = [];
  for (let v = 0; v < n; v++) {
    const names = groupBones[vertexGroups[v]] || groupBones.torso;
    const px = pos[v * 3], py = pos[v * 3 + 1], pz = pos[v * 3 + 2];
    cand.length = 0;
    let nearest = -1, nearestD = Infinity;
    for (let i = 0; i < names.length; i++) {
      const s = segments[names[i]];
      if (!s) continue;
      const d = distToSegment(px, py, pz, s);
      if (d < nearestD) { nearestD = d; nearest = boneIndex[names[i]]; }
      if (d < s.r) {
        const f = 1 - d / s.r;
        // The falloff exponent is per bone: a low power widens the blend band
        // across a joint, which is what keeps an elbow from creasing, while a
        // high power keeps a hand from grabbing weight off a nearby thigh.
        const p = s.pow ?? 4;
        const w = p === 4 ? f * f * f * f : p === 3 ? f * f * f : Math.pow(f, p);
        cand.push({ i: boneIndex[names[i]], w: w * (s.bias ?? 1) });
      }
    }
    if (!cand.length) { si[v * 4] = nearest < 0 ? 0 : nearest; sw[v * 4] = 1; continue; }
    cand.sort((a, b) => b.w - a.w);
    let sum = 0;
    const take = Math.min(4, cand.length);
    for (let i = 0; i < take; i++) sum += cand[i].w;
    for (let i = 0; i < take; i++) {
      si[v * 4 + i] = cand[i].i;
      sw[v * 4 + i] = cand[i].w / sum;
    }
  }
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  return geo;
}

// A morph target built by pushing masked vertices along their normal. Used for
// swelling around a struck limb.
export function swellMorph(geo, maskFn, amount) {
  const pos = geo.attributes.position.array;
  const nor = geo.attributes.normal.array;
  const n = pos.length / 3;
  const out = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const m = maskFn(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2], v);
    const k = m * amount;
    out[v * 3] = pos[v * 3] + nor[v * 3] * k;
    out[v * 3 + 1] = pos[v * 3 + 1] + nor[v * 3 + 1] * k;
    out[v * 3 + 2] = pos[v * 3 + 2] + nor[v * 3 + 2] * k;
  }
  return new THREE.BufferAttribute(out, 3);
}

// Displace vertices in place, used for the facial pass on the head rings.
export function displace(builder, fromVertex, fn) {
  const pos = builder.pos;
  for (let v = fromVertex; v < builder.vertexCount; v++) {
    const i = v * 3;
    const r = fn(pos[i], pos[i + 1], pos[i + 2]);
    if (!r) continue;
    pos[i] += r[0]; pos[i + 1] += r[1]; pos[i + 2] += r[2];
  }
}

export const smooth01 = (x) => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); };
// Symmetric bump that peaks at 1 when x is 0 and dies at |x| = 1.
export const bump = (x) => { const t = Math.abs(x); return t >= 1 ? 0 : Math.cos(t * Math.PI) * 0.5 + 0.5; };
export const band = (x, lo, hi, feather) => smooth01((x - lo) / feather) * smooth01((hi - x) / feather);
