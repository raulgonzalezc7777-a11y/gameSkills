import {
  Body, v3, vset, vcopy, vzero, vadd, vsub, vmul, vaddScaled, vdot, vcross,
  vlen2, vlength, vnormalize, qmul, qnormalize, basisFromNormal, EPS, UP
} from './body.js';
import {
  Manifold, SpatialHash, collidePair, bodyVsPlane, bodyVsCylinder,
  rayBody, rayPlane
} from './collision.js';
import { clamp } from '../core/math.js';

// Sequential impulse solver with warm starting and split position correction.
//
// The design choice that matters here is substepping. A ragdoll is a chain of
// stiff constraints, and a single 60 Hz step lets error compound around the
// chain faster than the solver removes it, which is how ragdolls end up
// vibrating or exploding. Four substeps of a cheap solver beat one substep of
// an expensive one for this kind of scene, every time.
const SUBSTEPS = 4;
const ITERATIONS = 6;
const BAUMGARTE = 0.22;        // fraction of penetration resolved per step
const SLOP = 0.004;            // penetration tolerated before correction
const MAX_CORRECTION = 0.2;    // metres per step, so a deep overlap eases out
const SLEEP_LINEAR = 0.035;
const SLEEP_ANGULAR = 0.12;
const SLEEP_TIME = 0.6;

const _r1 = v3(), _r2 = v3(), _v1 = v3(), _v2 = v3(), _rv = v3();
const _imp = v3(), _t1 = v3(), _t2 = v3(), _p = v3(), _tmp = v3();
const _dq = { x: 0, y: 0, z: 0, w: 0 };

export class PhysicsWorld {
  constructor(opts = {}) {
    this.gravity = v3(0, opts.gravity ?? -19.6, 0);   // heavier than real, it reads better
    this.bodies = [];
    this.statics = [];          // planes and cylinders from the arena
    this.constraints = [];
    this.broadphase = new SpatialHash(opts.cellSize ?? 0.55);
    this.manifolds = new Map();
    this.floorY = opts.floorY ?? 0;
    this.arenaRadius = opts.arenaRadius ?? 0;
    this.accumulator = 0;
    this.fixedDt = 1 / 60;
    this.contactCount = 0;
    this.stepCount = 0;

    this.addStatic({ type: 'plane', normal: v3(0, 1, 0), offset: this.floorY, friction: 0.85, restitution: 0.05 });
    if (this.arenaRadius > 0) {
      this.addStatic({ type: 'cylinder', x: 0, z: 0, r: this.arenaRadius, inside: true, friction: 0.4, restitution: 0.2 });
    }
  }

  addBody(desc) {
    const body = desc instanceof Body ? desc : new Body(desc);
    body.world = this;
    this.bodies.push(body);
    return body;
  }

  removeBody(body) {
    const i = this.bodies.indexOf(body);
    if (i >= 0) this.bodies.splice(i, 1);
    body.world = null;
  }

  addStatic(collider) { this.statics.push(collider); return collider; }
  addConstraint(c) { this.constraints.push(c); return c; }
  removeConstraint(c) { const i = this.constraints.indexOf(c); if (i >= 0) this.constraints.splice(i, 1); }

  // The arena hands over boxes and cylinders; a box becomes a static Body so
  // the existing narrowphase handles it with no special cases.
  addArenaColliders(colliders, height = 1.4) {
    for (const c of colliders) {
      if (c.type === 'box') {
        this.addBody({
          shape: { type: 'box', hx: c.hx, hy: height, hz: c.hz },
          position: { x: c.x, y: this.floorY + height, z: c.z },
          static: true, friction: 0.7, tag: 'static'
        });
      } else if (c.type === 'cylinder' && c.inside !== true) {
        this.addBody({
          shape: { type: 'capsule', radius: c.r, halfHeight: height * 0.5 },
          position: { x: c.x, y: this.floorY + height * 0.5, z: c.z },
          static: true, friction: 0.7, tag: 'static'
        });
      }
    }
  }

  // Fixed-step accumulator. Callers hand over wall time; the solver only ever
  // sees its own timestep, which is what keeps a ragdoll identical at 30 fps
  // and at 144.
  step(dt) {
    this.accumulator += Math.min(dt, 0.25);
    let steps = 0;
    while (this.accumulator >= this.fixedDt && steps < 5) {
      this._fixedStep(this.fixedDt);
      this.accumulator -= this.fixedDt;
      steps++;
    }
    if (steps === 5) this.accumulator = 0;
  }

  _fixedStep(dt) {
    const h = dt / SUBSTEPS;
    for (let s = 0; s < SUBSTEPS; s++) this._substep(h);
    this.stepCount++;
  }

  _substep(h) {
    const bodies = this.bodies;

    // 1. Integrate velocities.
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b.static || b.sleeping) continue;
      if (b.invMass > 0) {
        vaddScaled(b.velocity, b.velocity, this.gravity, h * b.gravityScale);
        vaddScaled(b.velocity, b.velocity, b.force, h * b.invMass);
        b.applyInvInertia(_tmp, b.torque);
        vaddScaled(b.angularVelocity, b.angularVelocity, _tmp, h);
      }
      vzero(b.force); vzero(b.torque);
      const ld = Math.exp(-b.linearDamping * h * 60 * 0.016);
      const ad = Math.exp(-b.angularDamping * h * 60 * 0.016);
      vmul(b.velocity, b.velocity, ld);
      vmul(b.angularVelocity, b.angularVelocity, ad);
      b.maxContactImpulse = 0;
    }

    // 2. Collect contacts.
    const list = this._collide();

    // 3. Warm start, then solve velocity constraints.
    for (let i = 0; i < list.length; i++) this._warmStart(list[i]);
    for (let it = 0; it < ITERATIONS; it++) {
      for (let i = 0; i < this.constraints.length; i++) this.constraints[i].solveVelocity(h);
      for (let i = 0; i < list.length; i++) this._solveContact(list[i], h);
    }

    // 4. Integrate positions.
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b.static || b.sleeping) continue;
      vaddScaled(b.position, b.position, b.velocity, h);
      const w = b.angularVelocity;
      _dq.x = w.x * 0.5 * h; _dq.y = w.y * 0.5 * h; _dq.z = w.z * 0.5 * h; _dq.w = 0;
      const q = b.orientation;
      const nx = _dq.w * q.x + _dq.x * q.w + _dq.y * q.z - _dq.z * q.y;
      const ny = _dq.w * q.y - _dq.x * q.z + _dq.y * q.w + _dq.z * q.x;
      const nz = _dq.w * q.z + _dq.x * q.y - _dq.y * q.x + _dq.z * q.w;
      const nw = _dq.w * q.w - _dq.x * q.x - _dq.y * q.y - _dq.z * q.z;
      q.x += nx; q.y += ny; q.z += nz; q.w += nw;
      qnormalize(q);
      b.updateInertiaWorld();
      b.computeAABB();
    }

    // 5. Position constraints last, so joints win over jitter.
    for (let it = 0; it < 2; it++) {
      for (let i = 0; i < this.constraints.length; i++) this.constraints[i].solvePosition();
    }

    this._updateSleep(h);
  }

  _collide() {
    const out = [];
    this.contactCount = 0;
    const bodies = this.bodies;

    // Statics first: the floor and the venue wall touch almost every body, and
    // they need no broadphase.
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b.static || b.sleeping) continue;
      for (let s = 0; s < this.statics.length; s++) {
        const st = this.statics[s];
        const m = this._manifoldFor(b.id, -1 - s);
        const hit = st.type === 'plane' ? bodyVsPlane(m, b, st) : bodyVsCylinder(m, b, st);
        if (hit) {
          m.friction = Math.sqrt(b.friction * (st.friction ?? 0.6));
          m.restitution = Math.max(b.restitution, st.restitution ?? 0.05);
          out.push(m);
          this.contactCount += m.count;
        }
      }
    }

    this.broadphase.build(bodies);
    const pairs = this.broadphase.pairs;
    for (let i = 0; i < this.broadphase.pairCount; i++) {
      const a = pairs[i * 2], b = pairs[i * 2 + 1];
      if (a.static && b.static) continue;
      if (a.sleeping && b.sleeping) continue;
      if (!(a.collisionGroup & b.collisionMask) || !(b.collisionGroup & a.collisionMask)) continue;
      const m = this._manifoldFor(a.id, b.id);
      if (collidePair(m, a, b)) {
        m.friction = Math.sqrt(a.friction * b.friction);
        m.restitution = Math.max(a.restitution, b.restitution);
        out.push(m);
        this.contactCount += m.count;
      }
    }
    return out;
  }

  // Manifolds are cached by body pair so accumulated impulses survive between
  // steps. Warm starting is most of the difference between a stack that settles
  // and a stack that hums.
  _manifoldFor(idA, idB) {
    const key = idA * 100003 + idB;
    let m = this.manifolds.get(key);
    if (!m) { m = new Manifold(); m.key = key; this.manifolds.set(key, m); }
    m.touched = true;
    return m;
  }

  _warmStart(m) {
    const a = m.bodyA, b = m.bodyB;
    basisFromNormal(m.normal, _t1, _t2);
    for (let i = 0; i < m.count; i++) {
      const cp = m.points[i];
      _imp.x = m.normal.x * cp.normalImpulse + _t1.x * cp.tangentImpulse1 + _t2.x * cp.tangentImpulse2;
      _imp.y = m.normal.y * cp.normalImpulse + _t1.y * cp.tangentImpulse1 + _t2.y * cp.tangentImpulse2;
      _imp.z = m.normal.z * cp.normalImpulse + _t1.z * cp.tangentImpulse1 + _t2.z * cp.tangentImpulse2;
      if (a && !a.static) { a.localToWorld(_p, cp.localA); vmul(_tmp, _imp, -1); a.applyImpulse(_tmp, _p); }
      if (b && !b.static) { b.localToWorld(_p, cp.localB); b.applyImpulse(_imp, _p); }
    }
  }

  _solveContact(m, h) {
    const a = m.bodyA, b = m.bodyB;
    const n = m.normal;
    basisFromNormal(n, _t1, _t2);

    for (let i = 0; i < m.count; i++) {
      const cp = m.points[i];
      if (a) { a.localToWorld(_p, cp.localA); vsub(_r1, _p, a.position); } else vzero(_r1);
      if (b) { b.localToWorld(_p, cp.localB); vsub(_r2, _p, b.position); } else vzero(_r2);

      if (a && !a.static) a.pointVelocity(_v1, _r1); else vzero(_v1);
      if (b && !b.static) b.pointVelocity(_v2, _r2); else vzero(_v2);
      vsub(_rv, _v2, _v1);

      const vn = vdot(_rv, n);
      const kN = this._effectiveMass(a, b, _r1, _r2, n);
      if (kN < EPS) continue;

      // Restitution only above a threshold, so a body at rest does not buzz.
      const bounce = cp.relativeVelocity < -1.2 ? -m.restitution * cp.relativeVelocity : 0;
      const bias = Math.max(0, -cp.separation - SLOP) * (BAUMGARTE / h);
      let dPn = (-(vn) + bounce + Math.min(bias, MAX_CORRECTION / h)) / kN;

      const oldPn = cp.normalImpulse;
      cp.normalImpulse = Math.max(0, oldPn + dPn);
      dPn = cp.normalImpulse - oldPn;
      if (a) a.maxContactImpulse = Math.max(a.maxContactImpulse, cp.normalImpulse);
      if (b) b.maxContactImpulse = Math.max(b.maxContactImpulse, cp.normalImpulse);

      vmul(_imp, n, dPn);
      if (a && !a.static) { vmul(_tmp, _imp, -1); a.localToWorld(_p, cp.localA); a.applyImpulse(_tmp, _p); }
      if (b && !b.static) { b.localToWorld(_p, cp.localB); b.applyImpulse(_imp, _p); }

      // Friction, clamped to the Coulomb cone of the normal impulse just applied.
      const maxF = m.friction * cp.normalImpulse;
      this._solveFriction(m, cp, a, b, _t1, maxF, 1);
      this._solveFriction(m, cp, a, b, _t2, maxF, 2);
    }
  }

  _solveFriction(m, cp, a, b, tangent, maxF, slot) {
    if (a) { a.localToWorld(_p, cp.localA); vsub(_r1, _p, a.position); } else vzero(_r1);
    if (b) { b.localToWorld(_p, cp.localB); vsub(_r2, _p, b.position); } else vzero(_r2);
    if (a && !a.static) a.pointVelocity(_v1, _r1); else vzero(_v1);
    if (b && !b.static) b.pointVelocity(_v2, _r2); else vzero(_v2);
    vsub(_rv, _v2, _v1);

    const vt = vdot(_rv, tangent);
    const k = this._effectiveMass(a, b, _r1, _r2, tangent);
    if (k < EPS) return;

    const key = slot === 1 ? 'tangentImpulse1' : 'tangentImpulse2';
    const old = cp[key];
    cp[key] = clamp(old + (-vt / k), -maxF, maxF);
    const d = cp[key] - old;

    vmul(_imp, tangent, d);
    if (a && !a.static) { vmul(_tmp, _imp, -1); a.localToWorld(_p, cp.localA); a.applyImpulse(_tmp, _p); }
    if (b && !b.static) { b.localToWorld(_p, cp.localB); b.applyImpulse(_imp, _p); }
  }

  // 1 / (mA + mB + angular terms), the standard constraint effective mass.
  _effectiveMass(a, b, r1, r2, dir) {
    let k = 0;
    if (a && !a.static) {
      k += a.invMass;
      vcross(_tmp, r1, dir);
      a.applyInvInertia(_tmp, _tmp);
      vcross(_tmp, _tmp, r1);
      k += vdot(_tmp, dir);
    }
    if (b && !b.static) {
      k += b.invMass;
      vcross(_tmp, r2, dir);
      b.applyInvInertia(_tmp, _tmp);
      vcross(_tmp, _tmp, r2);
      k += vdot(_tmp, dir);
    }
    return k;
  }

  _updateSleep(h) {
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (b.static || !b.allowSleep) continue;
      const slow = vlen2(b.velocity) < SLEEP_LINEAR * SLEEP_LINEAR
        && vlen2(b.angularVelocity) < SLEEP_ANGULAR * SLEEP_ANGULAR;
      if (slow) {
        b.sleepTimer += h;
        if (b.sleepTimer > SLEEP_TIME && !b.sleeping) b.sleep();
      } else {
        b.sleepTimer = 0;
        b.sleeping = false;
      }
    }
  }

  // --------------------------------------------------------------- queries --

  raycast(origin, dir, maxDist = 100, filter = null) {
    let best = null;
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (filter && !filter(b)) continue;
      const t = rayBody(origin, dir, b, _tmp);
      if (t !== null && t >= 0 && t <= maxDist && (!best || t < best.distance)) {
        best = { body: b, distance: t, normal: v3(_tmp.x, _tmp.y, _tmp.z) };
      }
    }
    for (let s = 0; s < this.statics.length; s++) {
      const st = this.statics[s];
      if (st.type !== 'plane') continue;
      const t = rayPlane(origin, dir, st);
      if (t !== null && t >= 0 && t <= maxDist && (!best || t < best.distance)) {
        best = { body: null, distance: t, normal: v3(st.normal.x, st.normal.y, st.normal.z), floor: true };
      }
    }
    if (best) {
      best.point = v3(origin.x + dir.x * best.distance, origin.y + dir.y * best.distance, origin.z + dir.z * best.distance);
    }
    return best;
  }

  // Ground height under a point, which is all the animation foot IK needs.
  groundAt(x, z) {
    const hit = this.raycast(v3(x, this.floorY + 4, z), v3(0, -1, 0), 8);
    return hit ? hit.point.y : this.floorY;
  }

  clear() {
    this.bodies.length = 0;
    this.constraints.length = 0;
    this.manifolds.clear();
  }

  get stats() {
    let awake = 0;
    for (const b of this.bodies) if (!b.sleeping && !b.static) awake++;
    return { bodies: this.bodies.length, awake, contacts: this.contactCount, constraints: this.constraints.length };
  }
}
