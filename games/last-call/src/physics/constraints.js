import {
  v3, vset, vcopy, vzero, vadd, vsub, vmul, vaddScaled, vdot, vcross, vlen2,
  vlength, vnormalize, qmul, qconj, qnormalize, qrot, qrotInv, qToScaledAxis,
  EPS
} from './body.js';
import { clamp } from '../core/math.js';

const _ra = v3(), _rb = v3(), _pa = v3(), _pb = v3(), _d = v3();
const _va = v3(), _vb = v3(), _rv = v3(), _imp = v3(), _tmp = v3(), _axis = v3();
const _qa = { x: 0, y: 0, z: 0, w: 1 }, _qb = { x: 0, y: 0, z: 0, w: 1 };
const _qrel = { x: 0, y: 0, z: 0, w: 1 };

// A ball and socket joint with a swing cone and a twist range, plus an optional
// PD drive toward a target orientation.
//
// The limits are the whole point. A ragdoll without them is a rubber doll: it
// is joint stops that make a body look like it has bones in it, and it is the
// drive that lets a knocked-down fighter blend out of animation rather than
// cutting to a corpse.
export class BallSocket {
  constructor(bodyA, bodyB, opts = {}) {
    this.a = bodyA;
    this.b = bodyB;
    this.anchorA = v3(opts.anchorA?.x ?? 0, opts.anchorA?.y ?? 0, opts.anchorA?.z ?? 0);
    this.anchorB = v3(opts.anchorB?.x ?? 0, opts.anchorB?.y ?? 0, opts.anchorB?.z ?? 0);

    // Swing axis in A's frame: the direction the child limb points at rest.
    this.swingAxis = v3(opts.swingAxis?.x ?? 0, opts.swingAxis?.y ?? -1, opts.swingAxis?.z ?? 0);
    vnormalize(this.swingAxis, this.swingAxis);
    this.swingLimit = opts.swingLimit ?? 1.1;     // radians from the rest axis
    this.twistLimit = opts.twistLimit ?? 0.6;
    this.hinge = opts.hinge || null;              // {axis, min, max} for knees and elbows

    this.stiffness = opts.stiffness ?? 0;         // PD drive, 0 disables it
    this.damping = opts.damping ?? 0;
    this.drive = 1;                                // scaled down as a body goes limp
    this.targetQ = { x: 0, y: 0, z: 0, w: 1 };

    this.impulse = v3();
    this.softness = opts.softness ?? 0.0;
  }

  // Point-to-point: keep the two anchors coincident. Solved as three scalar
  // constraints through the shared effective-mass helper.
  solveVelocity(h) {
    const a = this.a, b = this.b;
    a.localToWorld(_pa, this.anchorA);
    b.localToWorld(_pb, this.anchorB);
    vsub(_ra, _pa, a.position);
    vsub(_rb, _pb, b.position);

    a.pointVelocity(_va, _ra);
    b.pointVelocity(_vb, _rb);
    vsub(_rv, _vb, _va);

    // Positional error folded in as bias, which is what stops a chain sagging.
    vsub(_d, _pb, _pa);
    vaddScaled(_rv, _rv, _d, 0.28 / h);

    for (let axis = 0; axis < 3; axis++) {
      vzero(_axis);
      if (axis === 0) _axis.x = 1; else if (axis === 1) _axis.y = 1; else _axis.z = 1;
      const k = effectiveMass(a, b, _ra, _rb, _axis);
      if (k < EPS) continue;
      const lambda = -vdot(_rv, _axis) / k;
      vmul(_imp, _axis, lambda);
      vmul(_tmp, _imp, -1);
      a.applyImpulse(_tmp, _pa);
      b.applyImpulse(_imp, _pb);
      // Recompute the relative velocity for the next axis rather than solving
      // the 3x3 block: cheaper, and it converges in the iterations we run.
      a.pointVelocity(_va, _ra);
      b.pointVelocity(_vb, _rb);
      vsub(_rv, _vb, _va);
    }

    if (this.stiffness > 0 && this.drive > 0) this._solveDrive(h);
    this._solveLimits(h);
  }

  // Angular PD toward the animated pose. Gains fall to zero as `drive` does,
  // which is how a fighter goes from fighting back to fully limp over a beat
  // rather than dropping like a dead weight the instant they are hit.
  _solveDrive(h) {
    const a = this.a, b = this.b;
    qconj(_qa, a.orientation);
    qmul(_qrel, _qa, b.orientation);          // b relative to a
    // Shortest arc.
    if (_qrel.w < 0) { _qrel.x = -_qrel.x; _qrel.y = -_qrel.y; _qrel.z = -_qrel.z; _qrel.w = -_qrel.w; }
    qconj(_qb, this.targetQ);
    const ex = _qrel.x - this.targetQ.x, ey = _qrel.y - this.targetQ.y, ez = _qrel.z - this.targetQ.z;
    vset(_tmp, ex, ey, ez);
    qrot(_tmp, a.orientation, _tmp);

    const k = this.stiffness * this.drive;
    const d = this.damping * this.drive;
    vsub(_rv, b.angularVelocity, a.angularVelocity);
    vset(_imp,
      -_tmp.x * k * h - _rv.x * d * h,
      -_tmp.y * k * h - _rv.y * d * h,
      -_tmp.z * k * h - _rv.z * d * h);
    applyAngularImpulse(a, _imp, -1);
    applyAngularImpulse(b, _imp, 1);
  }

  // Swing cone and twist, or a hinge stop for an elbow or a knee.
  _solveLimits(h) {
    const a = this.a, b = this.b;
    qconj(_qa, a.orientation);
    qmul(_qrel, _qa, b.orientation);
    if (_qrel.w < 0) { _qrel.x = -_qrel.x; _qrel.y = -_qrel.y; _qrel.z = -_qrel.z; _qrel.w = -_qrel.w; }

    // Where the child's rest axis has been carried to, expressed in A's frame.
    qrot(_d, _qrel, this.swingAxis);
    const cosSwing = clamp(vdot(_d, this.swingAxis), -1, 1);
    const swing = Math.acos(cosSwing);

    if (this.hinge) {
      // A knee bends one way only. Push back on anything outside the arc.
      const over = swing - this.hinge.max;
      if (over > 0) this._pushBack(a, b, _d, over, h, 26);
      return;
    }

    const over = swing - this.swingLimit;
    if (over > 0) this._pushBack(a, b, _d, over, h, 22);

    const twist = 2 * Math.atan2(
      _qrel.x * this.swingAxis.x + _qrel.y * this.swingAxis.y + _qrel.z * this.swingAxis.z,
      _qrel.w
    );
    const tOver = Math.abs(twist) - this.twistLimit;
    if (tOver > 0) {
      qrot(_axis, a.orientation, this.swingAxis);
      vmul(_imp, _axis, -Math.sign(twist) * tOver * 14 * h);
      applyAngularImpulse(a, _imp, -1);
      applyAngularImpulse(b, _imp, 1);
    }
  }

  _pushBack(a, b, current, over, h, gain) {
    qrot(_tmp, a.orientation, this.swingAxis);
    qrot(_axis, a.orientation, current);
    vcross(_imp, _axis, _tmp);
    const len = vlength(_imp);
    if (len < EPS) return;
    vmul(_imp, _imp, (over * gain * h) / len);
    applyAngularImpulse(a, _imp, -1);
    applyAngularImpulse(b, _imp, 1);
  }

  // Hard position pass, run after integration, so a deep violation does not
  // wait a frame to be corrected.
  solvePosition() {
    const a = this.a, b = this.b;
    a.localToWorld(_pa, this.anchorA);
    b.localToWorld(_pb, this.anchorB);
    vsub(_d, _pb, _pa);
    const err = vlength(_d);
    if (err < 0.002) return;
    const total = a.invMass + b.invMass;
    if (total < EPS) return;
    vmul(_d, _d, 0.4 / total);
    if (a.invMass > 0) vaddScaled(a.position, a.position, _d, a.invMass);
    if (b.invMass > 0) vaddScaled(b.position, b.position, _d, -b.invMass);
  }
}

function applyAngularImpulse(body, imp, sign) {
  if (body.invMass === 0) return;
  body.wake();
  vset(_tmp, imp.x * sign, imp.y * sign, imp.z * sign);
  body.applyInvInertia(_tmp, _tmp);
  vadd(body.angularVelocity, body.angularVelocity, _tmp);
}

function effectiveMass(a, b, ra, rb, dir) {
  let k = 0;
  const t = v3();
  if (a && !a.static) {
    k += a.invMass;
    vcross(t, ra, dir); a.applyInvInertia(t, t); vcross(t, t, ra);
    k += vdot(t, dir);
  }
  if (b && !b.static) {
    k += b.invMass;
    vcross(t, rb, dir); b.applyInvInertia(t, t); vcross(t, t, rb);
    k += vdot(t, dir);
  }
  return k;
}
