import * as THREE from 'three';
import { Body, Capsule, v3, vset, vcopy, vsub, vlength, qnormalize } from './body.js';
import { BallSocket } from './constraints.js';
import { clamp01, expDamp } from '../core/math.js';

// An active ragdoll over the 19 canonical bones.
//
// The feature that matters is the blend. Cutting from animation to a limp
// ragdoll the instant a fighter is hit is what makes physics look like a bug;
// a shipped game drives the ragdoll toward the animated pose with PD
// controllers whose gains fall to zero over a beat, so a knockdown reads as a
// body losing a fight with its own balance.
const SEGMENTS = [
  // name        bone chain          radius  mass   parent        limits
  ['pelvis', 'hips', 'spine', 0.125, 11, null, {}],
  ['torso', 'spine', 'chest', 0.140, 16, 'pelvis', { swing: 0.42, twist: 0.35, k: 900 }],
  ['chest', 'chest', 'neck', 0.145, 13, 'torso', { swing: 0.35, twist: 0.30, k: 900 }],
  ['head', 'neck', 'head', 0.098, 5, 'chest', { swing: 0.62, twist: 0.55, k: 620 }],
  ['upperArmL', 'upperArmL', 'forearmL', 0.055, 2.6, 'chest', { swing: 1.45, twist: 0.9, k: 300 }],
  ['forearmL', 'forearmL', 'handL', 0.046, 1.7, 'upperArmL', { hinge: 2.35, k: 260 }],
  ['upperArmR', 'upperArmR', 'forearmR', 0.055, 2.6, 'chest', { swing: 1.45, twist: 0.9, k: 300 }],
  ['forearmR', 'forearmR', 'handR', 0.046, 1.7, 'upperArmR', { hinge: 2.35, k: 260 }],
  ['thighL', 'thighL', 'shinL', 0.082, 8, 'pelvis', { swing: 1.15, twist: 0.5, k: 520 }],
  ['shinL', 'shinL', 'footL', 0.064, 4.2, 'thighL', { hinge: 2.30, k: 420 }],
  ['thighR', 'thighR', 'shinR', 0.082, 8, 'pelvis', { swing: 1.15, twist: 0.5, k: 520 }],
  ['shinR', 'shinR', 'footR', 0.064, 4.2, 'thighR', { hinge: 2.30, k: 420 }]
];

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _mid = new THREE.Vector3();
const _dir = new THREE.Vector3(), _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _scale = new THREE.Vector3();

export class Ragdoll {
  constructor(bones, opts = {}) {
    this.bones = bones;
    this.segments = new Map();
    this.joints = [];
    this.world = null;
    this.active = false;
    this.blend = 1;            // 1 = animation, 0 = pure physics
    this.limpRate = opts.limpRate ?? 1.8;
    this.massScale = opts.massScale ?? 1;
    this.settleTime = 0;
    this._built = false;
  }

  // Measures the rig in its current pose, so the capsules match the fighter
  // rather than a generic skeleton.
  build(world) {
    this.world = world;
    for (const [name, boneA, boneB, radius, mass, parent, lim] of SEGMENTS) {
      const bA = this.bones[boneA], bB = this.bones[boneB];
      if (!bA || !bB) continue;
      bA.getWorldPosition(_a);
      bB.getWorldPosition(_b);
      const len = Math.max(0.06, _a.distanceTo(_b));
      _mid.copy(_a).lerp(_b, 0.5);
      _dir.copy(_b).sub(_a).normalize();
      _q.setFromUnitVectors(_up, _dir);

      const body = world.addBody({
        shape: Capsule(radius, Math.max(0.02, len * 0.5 - radius * 0.5)),
        position: { x: _mid.x, y: _mid.y, z: _mid.z },
        orientation: { x: _q.x, y: _q.y, z: _q.z, w: _q.w },
        mass: mass * this.massScale,
        friction: 0.72,
        restitution: 0.03,
        linearDamping: 0.06,
        angularDamping: 0.12,
        tag: 'ragdoll',
        // Ragdoll parts never collide with each other: self collision on a
        // chain this short costs stability and buys nothing you can see.
        collisionGroup: 2,
        collisionMask: 0xfffd
      });
      body.userData = { ragdoll: this, segment: name, boneA, boneB, length: len };
      this.segments.set(name, { body, boneA, boneB, length: len, radius, lim, parent, restQ: _q.clone() });
    }

    for (const [name, , , , , parentName, lim] of SEGMENTS) {
      if (!parentName) continue;
      const child = this.segments.get(name);
      const parent = this.segments.get(parentName);
      if (!child || !parent) continue;
      this.bones[child.boneA].getWorldPosition(_a);
      const joint = new BallSocket(parent.body, child.body, {
        anchorA: localOf(parent.body, _a),
        anchorB: localOf(child.body, _a),
        swingAxis: { x: 0, y: 1, z: 0 },
        swingLimit: lim.swing ?? 0.9,
        twistLimit: lim.twist ?? 0.5,
        hinge: lim.hinge ? { max: lim.hinge } : null,
        stiffness: lim.k ?? 300,
        damping: (lim.k ?? 300) * 0.12
      });
      world.addConstraint(joint);
      this.joints.push(joint);
      child.joint = joint;
    }
    this._built = true;
    this.setDrive(1);
    return this;
  }

  setDrive(v) {
    for (const j of this.joints) j.drive = v;
  }

  // Hand the ragdoll the pose the animation is currently in, as the target the
  // PD drives toward. Called every frame while the blend is still partial.
  syncTargets() {
    for (const [, seg] of this.segments) {
      if (!seg.joint) continue;
      const bA = this.bones[seg.boneA], bB = this.bones[seg.boneB];
      bA.getWorldPosition(_a);
      bB.getWorldPosition(_b);
      _dir.copy(_b).sub(_a).normalize();
      _q.setFromUnitVectors(_up, _dir);
      seg.joint.targetQ.x = _q.x; seg.joint.targetQ.y = _q.y;
      seg.joint.targetQ.z = _q.z; seg.joint.targetQ.w = _q.w;
    }
  }

  // Snap the bodies onto the animated pose. Used when activating, so physics
  // starts exactly where the animation left off and there is no pop.
  matchToPose() {
    for (const [, seg] of this.segments) {
      const bA = this.bones[seg.boneA], bB = this.bones[seg.boneB];
      bA.getWorldPosition(_a);
      bB.getWorldPosition(_b);
      _mid.copy(_a).lerp(_b, 0.5);
      _dir.copy(_b).sub(_a).normalize();
      _q.setFromUnitVectors(_up, _dir);
      const body = seg.body;
      vset(body.position, _mid.x, _mid.y, _mid.z);
      body.orientation.x = _q.x; body.orientation.y = _q.y;
      body.orientation.z = _q.z; body.orientation.w = _q.w;
      vset(body.velocity, 0, 0, 0);
      vset(body.angularVelocity, 0, 0, 0);
      body.sleeping = false;
      body.sleepTimer = 0;
      body.updateInertiaWorld();
      body.computeAABB();
    }
  }

  activate(impulse, point) {
    if (!this._built) return;
    this.matchToPose();
    this.active = true;
    this.blend = 1;
    this.settleTime = 0;
    if (impulse) {
      const chest = this.segments.get('chest') || this.segments.get('torso');
      if (chest) chest.body.applyImpulse(impulse, point);
    }
  }

  applyLimbImpulse(boneName, impulse, point) {
    for (const [, seg] of this.segments) {
      if (seg.boneA === boneName || seg.boneB === boneName) {
        seg.body.applyImpulse(impulse, point);
        return true;
      }
    }
    return false;
  }

  // 1 means fully animated, 0 means fully limp. Drive follows it, so the
  // fighter fights the fall for a moment and then stops.
  blendToAnimation(t) { this.blend = clamp01(t); this.setDrive(this.blend); }

  update(dt) {
    if (!this.active) return;
    this.blend = Math.max(0, this.blend - dt * this.limpRate);
    this.setDrive(this.blend);
    if (this.blend > 0.02) this.syncTargets();

    let moving = 0;
    for (const [, seg] of this.segments) {
      const v = seg.body.velocity;
      moving = Math.max(moving, Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z));
    }
    this.settleTime = moving < 0.25 ? this.settleTime + dt : 0;
  }

  // Write the simulated transforms back onto the rig. Each bone is oriented to
  // look along its segment, which is all a capsule ragdoll can say about it.
  applyToRig(rigGroup) {
    if (!this.active || !this._built) return;
    const pelvis = this.segments.get('pelvis');
    if (!pelvis) return;

    for (const [, seg] of this.segments) {
      const bone = this.bones[seg.boneA];
      if (!bone || !bone.parent) continue;
      const body = seg.body;
      _q.set(body.orientation.x, body.orientation.y, body.orientation.z, body.orientation.w);
      _dir.set(0, 1, 0).applyQuaternion(_q).multiplyScalar(seg.length * 0.5);
      _a.set(body.position.x, body.position.y, body.position.z).sub(_dir);

      bone.parent.updateMatrixWorld(true);
      _m.copy(bone.parent.matrixWorld).invert();
      _a.applyMatrix4(_m);
      bone.position.copy(_a);

      bone.parent.matrixWorld.decompose(_b, _q2, _scale);
      _q2.invert();
      _qWork.set(body.orientation.x, body.orientation.y, body.orientation.z, body.orientation.w);
      bone.quaternion.copy(_q2).multiply(_qWork);
    }
  }

  get settled() { return this.settleTime > 0.7; }

  dispose() {
    if (!this.world) return;
    for (const j of this.joints) this.world.removeConstraint(j);
    for (const [, seg] of this.segments) this.world.removeBody(seg.body);
    this.segments.clear();
    this.joints.length = 0;
    this._built = false;
  }
}

const _q2 = new THREE.Quaternion();
const _qWork = new THREE.Quaternion();

function localOf(body, worldPoint) {
  const dx = worldPoint.x - body.position.x;
  const dy = worldPoint.y - body.position.y;
  const dz = worldPoint.z - body.position.z;
  const q = body.orientation;
  // Inverse rotate by the body's orientation.
  const ix = q.w * dx + q.y * dz - q.z * dy;
  const iy = q.w * dy + q.z * dx - q.x * dz;
  const iz = q.w * dz + q.x * dy - q.y * dx;
  const iw = -q.x * dx - q.y * dy - q.z * dz;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x
  };
}
