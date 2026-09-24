import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GROUP } from './world.js';
import { rng } from '../core/rng.js';
import { clamp, clamp01 } from '../core/math.js';

// An active ragdoll in the Gang Beasts sense.
//
// The existing animation system still runs every frame, but its pose is no
// longer what the player sees: it is a target. Twelve physical bodies chase it
// with "muscles" (PD motors toward each segment's animated orientation) plus a
// cheat that cancels gravity in proportion to muscle strength. Strength is the
// whole game: sober and fresh it is high and the fighter looks like the
// animation; drunk it sags and every correction overshoots; stunned it dips
// and the head snaps around; knocked out it is zero and the body is a sack.
//
// The skeleton is then rewritten from the bodies, rotations only below the
// hips, so the skinned mesh can flop as far as physics likes and never tears.

// name, bone written (and segment start), end point, half width x, half depth z,
// mass, parent, cone angle, twist, muscle gain, gravity support
const SEGMENTS = [
  ['pelvis', 'hips', 'spine', 0.15, 0.10, 12, null, 0, 0, 560, 1.0],
  ['belly', 'spine', 'chest', 0.14, 0.10, 10, 'pelvis', 0.55, 0.35, 540, 1.0],
  ['chest', 'chest', 'neck', 0.18, 0.11, 14, 'belly', 0.5, 0.35, 540, 1.0],
  ['head', 'neck', 'HEADTOP', 0.10, 0.11, 5, 'chest', 0.8, 0.6, 360, 1.0],
  ['upperArmL', 'upperArmL', 'forearmL', 0.055, 0.055, 2.6, 'chest', 1.7, 0.9, 300, 0.95],
  ['forearmL', 'forearmL', 'FISTL', 0.05, 0.05, 1.9, 'upperArmL', 1.8, 0.6, 260, 0.95],
  ['upperArmR', 'upperArmR', 'forearmR', 0.055, 0.055, 2.6, 'chest', 1.7, 0.9, 300, 0.95],
  ['forearmR', 'forearmR', 'FISTR', 0.05, 0.05, 1.9, 'upperArmR', 1.8, 0.6, 260, 0.95],
  ['thighL', 'thighL', 'shinL', 0.075, 0.075, 8, 'pelvis', 1.3, 0.5, 380, 0.9],
  ['shinL', 'shinL', 'FOOTL', 0.06, 0.06, 4.5, 'thighL', 1.5, 0.3, 320, 0.9],
  ['thighR', 'thighR', 'shinR', 0.075, 0.075, 8, 'pelvis', 1.3, 0.5, 380, 0.9],
  ['shinR', 'shinR', 'FOOTR', 0.06, 0.06, 4.5, 'thighR', 1.5, 0.3, 320, 0.9]
];

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _d = new THREE.Vector3(), _e = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _m = new THREE.Matrix4(), _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const _cv = new CANNON.Vec3(), _cv2 = new CANNON.Vec3();
const _cq = new CANNON.Quaternion();

function endPoint(bones, key, out) {
  if (key === 'HEADTOP') {
    bones.head.getWorldPosition(out);
    bones.head.getWorldQuaternion(_q3);
    return out.add(_e.set(0, 0.23, 0).applyQuaternion(_q3));
  }
  if (key === 'FISTL' || key === 'FISTR') {
    const s = key.slice(-1);
    bones['forearm' + s].getWorldPosition(_e);
    bones['hand' + s].getWorldPosition(out);
    return out.add(_d.copy(out).sub(_e).normalize().multiplyScalar(0.1));
  }
  if (key === 'FOOTL' || key === 'FOOTR') {
    bones['foot' + key.slice(-1)].getWorldPosition(out);
    return out.add(_e.set(0, -0.06, 0));
  }
  return bones[key].getWorldPosition(out);
}

export class ActiveRagdoll {
  constructor(fighter, brawl, group) {
    this.f = fighter;
    this.brawl = brawl;
    this.group = group;
    this.bones = fighter.rig.bones;
    this.segs = [];
    this.byName = {};
    this.built = false;

    this.strength = 1;        // what the muscles deliver right now
    this.stagger = 0;         // seconds of weakened muscle after a hit
    this.limp = 0;            // seconds of zero muscle (knockdown), or Infinity (KO)
    this.hiccupT = rng.range(3, 7);
    this.tiltT = 0;
    this.t = rng.range(0, 100);
    this.totalMass = 0;
  }

  build() {
    const w = this.brawl.world;
    const other = this.group === GROUP.A ? GROUP.B : GROUP.A;
    this.f.object.updateMatrixWorld(true);
    for (const [name, bone, end, hw, hd, mass, parent, cone, twist, gain, support] of SEGMENTS) {
      const start = this.bones[bone].getWorldPosition(new THREE.Vector3());
      const stop = endPoint(this.bones, end, new THREE.Vector3());
      const len = Math.max(0.08, start.distanceTo(stop));
      const dir = stop.clone().sub(start).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
      const centre = start.clone().lerp(stop, 0.5);

      const body = new CANNON.Body({
        mass, material: this.brawl.matBody,
        linearDamping: 0.06, angularDamping: 0.35,
        collisionFilterGroup: this.group,
        collisionFilterMask: GROUP.WORLD | other | GROUP.PROP
      });
      body.addShape(new CANNON.Box(new CANNON.Vec3(hw, len * 0.5, hd)));
      body.fighter = this.f;
      body.position.set(centre.x, centre.y, centre.z);
      body.quaternion.set(q.x, q.y, q.z, q.w);
      w.addBody(body);

      // Offset from the body's frame to the bone's frame, captured once.
      const boneQ = this.bones[bone].getWorldQuaternion(new THREE.Quaternion());
      const offQ = q.clone().invert().multiply(boneQ);
      const offP = start.clone().sub(centre).applyQuaternion(q.clone().invert());

      const seg = {
        loose: /Arm|head/.test(name),
        name, bone, end, body, len, gain, support, parent,
        offQ, offP, qt: new THREE.Quaternion(), pt: new THREE.Vector3(),
        inertia: mass * (len * len + hw * hw * 4) / 12
      };
      this.segs.push(seg);
      this.byName[name] = seg;
      this.totalMass += mass;

      if (parent) {
        const p = this.byName[parent];
        const pivotA = start.clone().sub(p.body.position).applyQuaternion(
          new THREE.Quaternion(p.body.quaternion.x, p.body.quaternion.y, p.body.quaternion.z, p.body.quaternion.w).invert());
        const pivotB = start.clone().sub(centre).applyQuaternion(q.clone().invert());
        const axisA = dir.clone().applyQuaternion(
          new THREE.Quaternion(p.body.quaternion.x, p.body.quaternion.y, p.body.quaternion.z, p.body.quaternion.w).invert());
        const c = new CANNON.ConeTwistConstraint(p.body, body, {
          pivotA: new CANNON.Vec3(pivotA.x, pivotA.y, pivotA.z),
          pivotB: new CANNON.Vec3(pivotB.x, pivotB.y, pivotB.z),
          axisA: new CANNON.Vec3(axisA.x, axisA.y, axisA.z),
          axisB: new CANNON.Vec3(0, 1, 0),
          angle: cone, twistAngle: twist, collideConnected: false
        });
        w.addConstraint(c);
        seg.joint = c;
      }
    }
    this.pelvis = this.byName.pelvis;
    this.chest = this.byName.chest;
    this.head = this.byName.head;
    this.built = true;
  }

  // Called by the fighter right after the animation has posed the skeleton.
  // Reads the pose as muscle targets. The bones keep the animated pose until
  // the physics step, so the attacker's hit test swings the fist the player
  // asked for (a floppy physical fist arrives after the active frames and
  // almost never counted) while the defender's hurtboxes, written after the
  // previous step, are where the body physically is.
  afterPose() {
    this.f.object.updateMatrixWorld(true);
    if (!this.built) { this.build(); return; }
    for (const s of this.segs) {
      const bone = this.bones[s.bone];
      bone.getWorldQuaternion(_q);
      // body = bone * inverse(offset)
      s.qt.copy(_q).multiply(_q2.copy(s.offQ).invert());
      bone.getWorldPosition(_a);
      s.pt.copy(_a).sub(_b.copy(s.offP).applyQuaternion(s.qt));
    }
  }

  writeBones() {
    if (!this.built) return;
    for (const s of this.segs) {
      const bone = this.bones[s.bone];
      const b = s.body;
      _q.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w).multiply(s.offQ);
      bone.parent.matrixWorld.decompose(_a, _q2, _s);
      bone.quaternion.copy(_q2.invert().multiply(_q));
      if (s.name === 'pelvis') {
        _c.copy(s.offP).applyQuaternion(_q3.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w))
          .add(_d.set(b.position.x, b.position.y, b.position.z));
        _m.copy(bone.parent.matrixWorld).invert();
        bone.position.copy(_c.applyMatrix4(_m));
      }
      bone.updateMatrixWorld(true);
    }
  }

  // --- muscle strength --------------------------------------------------------

  get isLimp() { return this.limp > 0; }

  goLimp(seconds) { this.limp = Math.max(this.limp, seconds); }
  wake() { this.limp = 0; }
  hurt(seconds) { this.stagger = Math.max(this.stagger, seconds); }

  // Cartoon launch: every body gets the same velocity plus a tumble, which is
  // what reads as "sent flying" instead of "a limb got pushed".
  launch(vx, vy, vz, spin = 0) {
    if (!this.built) return;
    for (const s of this.segs) {
      s.body.velocity.x += vx; s.body.velocity.y += vy; s.body.velocity.z += vz;
      if (spin) {
        s.body.angularVelocity.x += rng.range(-spin, spin);
        s.body.angularVelocity.z += rng.range(-spin, spin);
      }
    }
  }

  // A blow on one part: an impulse where it landed, and half as much on the
  // chest so the whole torso rocks rather than one limb twitching.
  strike(point, dir, impulse) {
    if (!this.built) return;
    let best = this.chest, bd = Infinity;
    for (const s of this.segs) {
      const p = s.body.position;
      const d = (p.x - point.x) ** 2 + (p.y - point.y) ** 2 + (p.z - point.z) ** 2;
      if (d < bd) { bd = d; best = s; }
    }
    _cv.set(dir.x * impulse, dir.y * impulse, dir.z * impulse);
    _cv2.set(point.x, point.y, point.z);
    best.body.applyImpulse(_cv, _cv2);
    _cv.scale(0.5, _cv);
    this.chest.body.applyImpulse(_cv, this.chest.body.position);
  }

  // A drunk's haymaker that meets nothing: the torso keeps turning after the
  // fist and the body corkscrews after it.
  spin(dirX, dirZ, power) {
    if (!this.built) return;
    const sign = rng.chance(0.5) ? 1 : -1;
    for (const s of [this.pelvis, this.byName.belly, this.chest, this.head].filter(Boolean)) {
      s.body.angularVelocity.y += sign * power * 5;
      s.body.velocity.x += dirX * power * 1.6;
      s.body.velocity.z += dirZ * power * 1.6;
    }
    this.hurt(0.25 + power * 0.5);
  }

  // Leans the top half back by a shove at the chest, for a belch or a stagger.
  lean(dx, dz, power) {
    if (!this.built) return;
    _cv.set(dx * power, 0.2 * power, dz * power);
    this.chest.body.applyImpulse(_cv, this.chest.body.position);
    if (this.head) this.head.body.applyImpulse(_cv.scale(0.4, _cv), this.head.body.position);
  }

  // --- the per-step motor pass ------------------------------------------------

  preStep(dt, drunk01, tuning) {
    if (!this.built) return;
    this.t += dt;
    this.stagger = Math.max(0, this.stagger - dt);
    if (this.limp !== Infinity) this.limp = Math.max(0, this.limp - dt);

    // Target strength. Drink takes the legs first: at full buzz a fighter
    // keeps half their muscle, and it breathes up and down on its own.
    let target = 1 - tuning.drunkWeakness * drunk01;
    target *= 1 - 0.18 * drunk01 * (0.5 + 0.5 * Math.sin(this.t * 1.3));
    if (this.stagger > 0) target *= tuning.staggerStrength;
    if (this.limp > 0) target = 0;
    // Muscle drops at once and comes back over a beat, so a hit reads as a
    // lurch and a get-up reads as effort.
    this.strength = target < this.strength ? target : Math.min(target, this.strength + dt * 1.6);
    const s = this.strength;
    const g = -this.brawl.world.gravity.y;
    const a = this.f.attacking;
    const limb = a && a.phase !== 'recovery' ? (a.move?.limb || '') : '';
    this._tense = limb === 'handL' ? 'ArmL' : limb === 'handR' ? 'ArmR' : limb === 'footR' ? 'R' : limb === 'footL' ? 'L' : null;
    if (this._tense && limb.startsWith('foot')) this._tense = null;

    for (const seg of this.segs) {
      const b = seg.body;

      // Gravity support, the cheat that stands the puppet up.
      b.force.y += b.mass * g * s * seg.support;

      if (s > 0.01) {
        // Orientation muscle toward the animated pose.
        _q.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
        _q2.copy(seg.qt).multiply(_q.invert());
        if (_q2.w < 0) { _q2.x = -_q2.x; _q2.y = -_q2.y; _q2.z = -_q2.z; _q2.w = -_q2.w; }
        const sinHalf = Math.hypot(_q2.x, _q2.y, _q2.z);
        const angle = 2 * Math.atan2(sinHalf, _q2.w);
        // The striking limb tenses for the punch, so a floppy drunk still
        // throws a fast, snapping fist, and loosens again on recovery.
        const tense = this._tense && /Arm|arm/.test(seg.name) && seg.name.endsWith(this._tense.slice(-1)) ? tuning.punchTense : 1;
        const loose = seg.loose ? tuning.looseLimbs : 1;
        const gain = seg.gain * tense * loose;
        const kp = gain * s;
        const kd = 2 * Math.sqrt(gain) * 0.8 * Math.sqrt(s);
        let ax = 0, ay = 0, az = 0;
        if (sinHalf > 1e-5) { ax = _q2.x / sinHalf; ay = _q2.y / sinHalf; az = _q2.z / sinHalf; }
        // Desired angular acceleration, then torque through the body's real
        // inertia tensor. A single scalar inertia overdrives the long axis of
        // a thin limb six times over, and a forearm spinning on its own axis
        // is how the first version of this launched a fighter into orbit.
        const w = b.angularVelocity;
        _cv.set(kp * angle * ax - kd * w.x, kp * angle * ay - kd * w.y, kp * angle * az - kd * w.z);
        b.quaternion.conjugate(_cq).vmult(_cv, _cv2);
        _cv2.x *= b.inertia.x; _cv2.y *= b.inertia.y; _cv2.z *= b.inertia.z;
        b.quaternion.vmult(_cv2, _cv);
        b.torque.vadd(_cv, b.torque);
      }
    }

    // Position springs on the trunk, each at its own mass. The pelvis leads,
    // the chest follows more softly so a drunk can sag without folding, and
    // the head is left to its muscles, which is where the bobble comes from.
    // A spring sized to the whole body but applied to a 12 kg pelvis damps
    // six times too hard and oscillates itself apart.
    if (s > 0.01) {
      for (const [seg, k] of [[this.pelvis, tuning.rootSpring], [this.byName.belly, tuning.rootSpring * 0.8], [this.chest, tuning.chestSpring]]) {
        const b = seg.body, pt = seg.pt;
        const kp = k * s, kd = 2 * Math.sqrt(k) * 0.9 * Math.sqrt(s);
        let fx = kp * (pt.x - b.position.x) - kd * b.velocity.x;
        let fy = kp * (pt.y - b.position.y) - kd * b.velocity.y;
        let fz = kp * (pt.z - b.position.z) - kd * b.velocity.z;
        const mag = Math.hypot(fx, fy, fz), cap = 90;
        if (mag > cap) { fx *= cap / mag; fy *= cap / mag; fz *= cap / mag; }
        b.force.x += b.mass * fx; b.force.y += b.mass * fy; b.force.z += b.mass * fz;
      }
    }

    // Punch pull: while the strike is live, the fist is yanked toward what it
    // is aimed at. Muscles alone give a soft, late fist; this gives the snap.
    if (s > 0.05 && this._tense && this.f._aimed && this.f._strikeT && a && a.phase !== 'recovery') {
      const fist = this.byName['forearm' + this._tense.slice(-1)];
      if (fist) {
        const b = fist.body, t = this.f._strikeT;
        const k = tuning.punchPull * (a.phase === 'active' ? 1 : 0.55);
        let fx = k * (t.x - b.position.x), fy = k * (t.y - b.position.y), fz = k * (t.z - b.position.z);
        const mag = Math.hypot(fx, fy, fz), cap = 900;
        if (mag > cap) { fx *= cap / mag; fy *= cap / mag; fz *= cap / mag; }
        b.force.x += b.mass * fx; b.force.y += b.mass * fy; b.force.z += b.mass * fz;
      }
    }

    // Drunk wobble: slow, wide, unrelated sines on the torso and head, so the
    // body keeps overcorrecting a balance it never quite finds.
    if (drunk01 > 0.02 && this.limp === 0) {
      const A = tuning.wobble * drunk01 * drunk01;
      const t = this.t;
      const wx = Math.sin(t * 1.7) + 0.6 * Math.sin(t * 3.1 + 1.3);
      const wz = Math.sin(t * 1.3 + 2.1) + 0.5 * Math.sin(t * 2.7 + 0.4);
      for (const seg of [this.belly ?? this.byName.belly, this.chest, this.head]) {
        seg.body.torque.x += seg.inertia * A * wx * 60;
        seg.body.torque.z += seg.inertia * A * wz * 60;
      }
      this.chest.body.force.x += this.chest.body.mass * A * 9 * Math.sin(t * 0.9);
      this.chest.body.force.z += this.chest.body.mass * A * 9 * Math.cos(t * 0.7 + 1.0);
    }
  }

  // After the step: tie the gameplay root to the body, hiccup, and fall over.
  postStep(dt, drunk01, tuning) {
    if (!this.built) return null;
    let event = null;
    const p = this.pelvis.body.position;
    const root = this.f.position;
    const dx = p.x - root.x, dz = p.z - root.z;
    const dist = Math.hypot(dx, dz);
    if (this.limp > 0) {
      // Limp: the body leads, the root follows, so the get-up happens where
      // the fighter landed and not where they were standing.
      root.x = p.x; root.z = p.z;
      if (this.f.velocity) this.f.velocity.set(0, 0, 0);
    } else if (dist > 0.45) {
      const k = (dist - 0.45) / dist;
      root.x += dx * k; root.z += dz * k;
    }

    // Hiccups: a sharp jolt up the chest every few seconds when properly drunk.
    if (drunk01 > 0.35 && this.limp === 0) {
      this.hiccupT -= dt;
      if (this.hiccupT <= 0) {
        this.hiccupT = rng.range(2.5, 6) * (1.4 - drunk01);
        _cv.set(0, tuning.hiccup * (0.6 + drunk01), 0);
        this.chest.body.applyImpulse(_cv, this.chest.body.position);
        _cv.set(rng.range(-1, 1) * 3, 4, rng.range(-1, 1) * 3);
        this.head.body.applyImpulse(_cv, this.head.body.position);
        event = 'hiccup';
      }
    }

    // Falling over under your own buzz: if the chest tips far enough for long
    // enough, the legs just stop.
    const q = this.chest.body.quaternion;
    _a.set(0, 1, 0).applyQuaternion(_q.set(q.x, q.y, q.z, q.w));
    const tilt = Math.acos(clamp(_a.y, -1, 1));
    if (this.limp === 0 && tilt > tuning.fallTilt && drunk01 > 0.45) {
      this.tiltT += dt;
      if (this.tiltT > 0.35) { this.tiltT = 0; event = 'fell'; }
    } else {
      this.tiltT = Math.max(0, this.tiltT - dt);
    }
    this.writeBones();
    return event;
  }

  pelvisPosition(out) { const p = this.pelvis.body.position; return out.set(p.x, p.y, p.z); }

  dispose() {
    if (!this.built) return;
    const w = this.brawl.world;
    for (const s of this.segs) { if (s.joint) w.removeConstraint(s.joint); w.removeBody(s.body); }
    this.segs.length = 0;
    this.built = false;
  }
}
