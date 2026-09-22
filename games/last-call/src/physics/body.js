// Rigid body core. Deliberately free of THREE imports: the whole solver is
// plain objects and Float64Arrays so tools/physcheck.mjs can step it in node
// without a WebGL context, which is how the determinism test runs headless.

export const EPS = 1e-9;

/* ------------------------------------------------------------------ vectors */

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const quat = (x = 0, y = 0, z = 0, w = 1) => ({ x, y, z, w });

export const vset = (o, x, y, z) => { o.x = x; o.y = y; o.z = z; return o; };
export const vcopy = (o, a) => { o.x = a.x; o.y = a.y; o.z = a.z; return o; };
export const vzero = (o) => { o.x = 0; o.y = 0; o.z = 0; return o; };
export const vadd = (o, a, b) => { o.x = a.x + b.x; o.y = a.y + b.y; o.z = a.z + b.z; return o; };
export const vsub = (o, a, b) => { o.x = a.x - b.x; o.y = a.y - b.y; o.z = a.z - b.z; return o; };
export const vmul = (o, a, s) => { o.x = a.x * s; o.y = a.y * s; o.z = a.z * s; return o; };
export const vaddScaled = (o, a, b, s) => { o.x = a.x + b.x * s; o.y = a.y + b.y * s; o.z = a.z + b.z * s; return o; };
export const vdot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const vlen2 = (a) => a.x * a.x + a.y * a.y + a.z * a.z;
export const vlen = (a) => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
export const vdist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const vcross = (o, a, b) => {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  o.x = x; o.y = y; o.z = z; return o;
};
export const vnormalize = (o, a) => {
  const l = vlen(a);
  if (l < EPS) return vset(o, 0, 0, 0);
  const k = 1 / l;
  o.x = a.x * k; o.y = a.y * k; o.z = a.z * k; return o;
};
export const vlerp = (o, a, b, t) => {
  o.x = a.x + (b.x - a.x) * t;
  o.y = a.y + (b.y - a.y) * t;
  o.z = a.z + (b.z - a.z) * t;
  return o;
};
export const vfinite = (a) => Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);

// Any orthonormal pair perpendicular to n. Branch on the dominant axis so the
// basis never degenerates when n is axis aligned.
export function basisFromNormal(n, t1, t2) {
  if (Math.abs(n.x) >= 0.57735) vset(t1, n.y, -n.x, 0);
  else vset(t1, 0, n.z, -n.y);
  vnormalize(t1, t1);
  vcross(t2, n, t1);
}

/* -------------------------------------------------------------- quaternions */

export const qset = (o, x, y, z, w) => { o.x = x; o.y = y; o.z = z; o.w = w; return o; };
export const qcopy = (o, a) => { o.x = a.x; o.y = a.y; o.z = a.z; o.w = a.w; return o; };
export const qidentity = (o) => qset(o, 0, 0, 0, 1);
export const qconj = (o, a) => qset(o, -a.x, -a.y, -a.z, a.w);

export const qmul = (o, a, b) => {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  return qset(o, x, y, z, w);
};

export const qnormalize = (o, a = o) => {
  const l = Math.hypot(a.x, a.y, a.z, a.w);
  if (l < EPS) return qidentity(o);
  const k = 1 / l;
  return qset(o, a.x * k, a.y * k, a.z * k, a.w * k);
};

// v' = q * v * q^-1, expanded so it allocates nothing.
export const qrot = (o, q, v) => {
  const { x: qx, y: qy, z: qz, w: qw } = q;
  const ix = qw * v.x + qy * v.z - qz * v.y;
  const iy = qw * v.y + qz * v.x - qx * v.z;
  const iz = qw * v.z + qx * v.y - qy * v.x;
  const iw = -qx * v.x - qy * v.y - qz * v.z;
  o.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
  o.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
  o.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
  return o;
};

export const qrotInv = (o, q, v) => {
  const { x: qx, y: qy, z: qz, w: qw } = q;
  const ix = qw * v.x - qy * v.z + qz * v.y;
  const iy = qw * v.y - qz * v.x + qx * v.z;
  const iz = qw * v.z - qx * v.y + qy * v.x;
  const iw = qx * v.x + qy * v.y + qz * v.z;
  o.x = ix * qw + iw * qx + iy * qz - iz * qy;
  o.y = iy * qw + iw * qy + iz * qx - ix * qz;
  o.z = iz * qw + iw * qz + ix * qy - iy * qx;
  return o;
};

export const qfromAxisAngle = (o, axis, angle) => {
  const h = angle * 0.5, s = Math.sin(h);
  return qset(o, axis.x * s, axis.y * s, axis.z * s, Math.cos(h));
};

// Shortest-arc rotation taking unit vector a onto unit vector b.
export const qfromUnitVectors = (o, a, b) => {
  let r = vdot(a, b) + 1;
  if (r < 1e-6) {
    // Opposite vectors: any perpendicular axis will do.
    r = 0;
    if (Math.abs(a.x) > Math.abs(a.z)) qset(o, -a.y, a.x, 0, r);
    else qset(o, 0, -a.z, a.y, r);
  } else {
    qset(o, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x, r);
  }
  return qnormalize(o);
};

export const qslerp = (o, a, b, t) => {
  let cos = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let s0, s1;
  if (cos > 0.9995) { s0 = 1 - t; s1 = t; } else {
    const theta = Math.acos(cos), sin = Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) / sin;
    s1 = Math.sin(t * theta) / sin;
  }
  return qnormalize(o, qset(o, a.x * s0 + bx * s1, a.y * s0 + by * s1, a.z * s0 + bz * s1, a.w * s0 + bw * s1));
};

// Axis-angle of a rotation, written into 'out', magnitude = angle in radians.
// Used by every PD controller and by the joint limit solver.
export const qToScaledAxis = (out, q) => {
  let w = q.w, x = q.x, y = q.y, z = q.z;
  if (w < 0) { w = -w; x = -x; y = -y; z = -z; } // shortest arc
  const s = Math.hypot(x, y, z);
  if (s < 1e-8) return vset(out, x * 2, y * 2, z * 2);
  const angle = 2 * Math.atan2(s, w);
  const k = angle / s;
  return vset(out, x * k, y * k, z * k);
};

/* ------------------------------------------------------------------- shapes */

export const Sphere = (radius) => ({ type: 'sphere', radius });
// Capsule runs along the body's local +Y, 'halfHeight' is half the cylinder
// section, so total length is 2 * (halfHeight + radius).
export const Capsule = (radius, halfHeight) => ({ type: 'capsule', radius, halfHeight });
export const Box = (hx, hy, hz) => ({ type: 'box', hx, hy, hz });

export function shapeBoundingRadius(s) {
  if (s.type === 'sphere') return s.radius;
  if (s.type === 'capsule') return s.radius + s.halfHeight;
  return Math.hypot(s.hx, s.hy, s.hz);
}

// Diagonal inertia tensor in the shape's own frame, for unit-uniform density.
export function shapeInertia(out, s, mass) {
  if (s.type === 'sphere') {
    const i = 0.4 * mass * s.radius * s.radius;
    return vset(out, i, i, i);
  }
  if (s.type === 'box') {
    const x = 2 * s.hx, y = 2 * s.hy, z = 2 * s.hz, k = mass / 12;
    return vset(out, k * (y * y + z * z), k * (x * x + z * z), k * (x * x + y * y));
  }
  // Capsule = cylinder + two hemispheres, mass split by volume. The transverse
  // hemisphere term uses the standard parallel-axis approximation (0.75*h*r for
  // the offset cross term), which is within a percent of the exact solid and is
  // what every game engine ships.
  const r = s.radius, h = s.halfHeight;
  const vc = Math.PI * r * r * 2 * h;
  const vs = (4 / 3) * Math.PI * r * r * r;
  const total = vc + vs || EPS;
  const mc = mass * (vc / total), ms = mass * (vs / total);
  const iy = 0.5 * mc * r * r + 0.4 * ms * r * r;
  const ix = mc * ((4 * h * h) / 12 + (r * r) / 4) + ms * (0.4 * r * r + h * h + 0.75 * h * r);
  return vset(out, ix, iy, ix);
}

/* --------------------------------------------------------------------- body */

let _bodyId = 1;

export class Body {
  constructor(desc = {}) {
    this.id = _bodyId++;
    this.shape = desc.shape || Sphere(0.25);
    this.position = v3(desc.position?.x ?? 0, desc.position?.y ?? 0, desc.position?.z ?? 0);
    this.orientation = quat();
    if (desc.orientation) qcopy(this.orientation, desc.orientation);
    this.velocity = v3();
    this.angularVelocity = v3();
    if (desc.velocity) vcopy(this.velocity, desc.velocity);
    if (desc.angularVelocity) vcopy(this.angularVelocity, desc.angularVelocity);

    this.force = v3();
    this.torque = v3();

    this.static = !!desc.static;
    this.kinematic = !!desc.kinematic;
    const mass = this.static || this.kinematic ? 0 : (desc.mass ?? 1);
    this.mass = mass;
    this.invMass = mass > 0 ? 1 / mass : 0;

    this.invInertiaLocal = v3();
    this.inertiaLocal = v3();
    this.setMass(mass);

    this.invInertiaWorld = new Float64Array(9);

    this.restitution = desc.restitution ?? 0.12;
    this.friction = desc.friction ?? 0.55;
    this.linearDamping = desc.linearDamping ?? 0.02;
    this.angularDamping = desc.angularDamping ?? 0.06;
    this.gravityScale = desc.gravityScale ?? 1;

    this.sleeping = false;
    this.allowSleep = desc.allowSleep !== false && !this.static;
    this.sleepTimer = 0;

    this.aabbMin = v3();
    this.aabbMax = v3();
    this.boundingRadius = shapeBoundingRadius(this.shape);

    this.tag = desc.tag || null;      // 'prop' | 'ragdoll' | 'static' ...
    this.userData = desc.userData || null;
    this.collisionGroup = desc.collisionGroup ?? 1;
    this.collisionMask = desc.collisionMask ?? 0xffff;
    this.maxContactImpulse = 0;       // largest normal impulse seen this step
    this.world = null;

    this.updateInertiaWorld();
    this.computeAABB();
  }

  setMass(mass) {
    this.mass = mass;
    this.invMass = mass > 0 ? 1 / mass : 0;
    if (mass > 0) {
      shapeInertia(this.inertiaLocal, this.shape, mass);
      vset(this.invInertiaLocal,
        this.inertiaLocal.x > EPS ? 1 / this.inertiaLocal.x : 0,
        this.inertiaLocal.y > EPS ? 1 / this.inertiaLocal.y : 0,
        this.inertiaLocal.z > EPS ? 1 / this.inertiaLocal.z : 0);
    } else {
      vzero(this.inertiaLocal);
      vzero(this.invInertiaLocal);
    }
  }

  // invIworld = R * diag(invIlocal) * R^T, kept as a flat row-major 3x3.
  updateInertiaWorld() {
    const m = this.invInertiaWorld;
    if (this.invMass === 0 && this.invInertiaLocal.x === 0) { m.fill(0); return; }
    const { x, y, z, w } = this.orientation;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    // Columns of R.
    const r00 = 1 - (yy + zz), r01 = xy - wz, r02 = xz + wy;
    const r10 = xy + wz, r11 = 1 - (xx + zz), r12 = yz - wx;
    const r20 = xz - wy, r21 = yz + wx, r22 = 1 - (xx + yy);
    const a = this.invInertiaLocal.x, b = this.invInertiaLocal.y, c = this.invInertiaLocal.z;
    m[0] = r00 * a * r00 + r01 * b * r01 + r02 * c * r02;
    m[1] = r00 * a * r10 + r01 * b * r11 + r02 * c * r12;
    m[2] = r00 * a * r20 + r01 * b * r21 + r02 * c * r22;
    m[3] = m[1];
    m[4] = r10 * a * r10 + r11 * b * r11 + r12 * c * r12;
    m[5] = r10 * a * r20 + r11 * b * r21 + r12 * c * r22;
    m[6] = m[2];
    m[7] = m[5];
    m[8] = r20 * a * r20 + r21 * b * r21 + r22 * c * r22;
  }

  // out = invInertiaWorld * v
  applyInvInertia(out, v) {
    const m = this.invInertiaWorld;
    const x = m[0] * v.x + m[1] * v.y + m[2] * v.z;
    const y = m[3] * v.x + m[4] * v.y + m[5] * v.z;
    const z = m[6] * v.x + m[7] * v.y + m[8] * v.z;
    return vset(out, x, y, z);
  }

  computeAABB() {
    const s = this.shape, p = this.position;
    if (s.type === 'sphere') {
      const r = s.radius;
      vset(this.aabbMin, p.x - r, p.y - r, p.z - r);
      vset(this.aabbMax, p.x + r, p.y + r, p.z + r);
      return;
    }
    if (s.type === 'capsule') {
      qrot(_a, this.orientation, UP);
      const hx = Math.abs(_a.x) * s.halfHeight + s.radius;
      const hy = Math.abs(_a.y) * s.halfHeight + s.radius;
      const hz = Math.abs(_a.z) * s.halfHeight + s.radius;
      vset(this.aabbMin, p.x - hx, p.y - hy, p.z - hz);
      vset(this.aabbMax, p.x + hx, p.y + hy, p.z + hz);
      return;
    }
    const { x, y, z, w } = this.orientation;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const ex = Math.abs(1 - (yy + zz)) * s.hx + Math.abs(xy - wz) * s.hy + Math.abs(xz + wy) * s.hz;
    const ey = Math.abs(xy + wz) * s.hx + Math.abs(1 - (xx + zz)) * s.hy + Math.abs(yz - wx) * s.hz;
    const ez = Math.abs(xz - wy) * s.hx + Math.abs(yz + wx) * s.hy + Math.abs(1 - (xx + yy)) * s.hz;
    vset(this.aabbMin, p.x - ex, p.y - ey, p.z - ez);
    vset(this.aabbMax, p.x + ex, p.y + ey, p.z + ez);
  }

  localToWorld(out, local) { return vadd(out, this.position, qrot(out, this.orientation, local)); }
  worldToLocal(out, world) { vsub(out, world, this.position); return qrotInv(out, this.orientation, out); }

  // Velocity of the material point at world offset r from the centre of mass.
  pointVelocity(out, r) {
    vcross(out, this.angularVelocity, r);
    return vadd(out, this.velocity, out);
  }

  applyImpulse(impulse, worldPoint) {
    if (this.invMass === 0) return;
    this.wake();
    vaddScaled(this.velocity, this.velocity, impulse, this.invMass);
    if (worldPoint) {
      vsub(_a, worldPoint, this.position);
      vcross(_b, _a, impulse);
      this.applyInvInertia(_b, _b);
      vadd(this.angularVelocity, this.angularVelocity, _b);
    }
  }

  applyForce(force, worldPoint) {
    if (this.invMass === 0) return;
    this.wake();
    vadd(this.force, this.force, force);
    if (worldPoint) {
      vsub(_a, worldPoint, this.position);
      vcross(_b, _a, force);
      vadd(this.torque, this.torque, _b);
    }
  }

  applyTorque(t) { if (this.invMass === 0) return; this.wake(); vadd(this.torque, this.torque, t); }

  wake() {
    if (this.static) return;
    this.sleeping = false;
    this.sleepTimer = 0;
  }

  sleep() {
    this.sleeping = true;
    vzero(this.velocity);
    vzero(this.angularVelocity);
  }

  get kineticEnergy() {
    const l = 0.5 * this.mass * vlen2(this.velocity);
    const w = this.angularVelocity;
    const a = 0.5 * (this.inertiaLocal.x * w.x * w.x + this.inertiaLocal.y * w.y * w.y + this.inertiaLocal.z * w.z * w.z);
    return l + a;
  }
}

export const UP = Object.freeze(v3(0, 1, 0));
const _a = v3(), _b = v3();
