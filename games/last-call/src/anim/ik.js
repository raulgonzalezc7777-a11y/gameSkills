// Analytic two bone IK with a pole vector, plus the hip drop that makes foot
// planting believable. Everything here runs in world space on THREE.Bone
// objects after the pose has been written, and everything reuses module scope
// scratch objects: nothing in this file allocates per frame.
import * as THREE from 'three';
import { clamp, clamp01 } from '../core/math.js';

const _root = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _end = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _perp = new THREE.Vector3();
const _want = new THREE.Vector3();
const _cur = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _tmp = new THREE.Vector3();

// The local direction each bone's child hangs off. Frozen by the rig contract:
// arms run along local X (L toward -X), legs down local -Y.
export const AXIS_ARM_L = new THREE.Vector3(-1, 0, 0);
export const AXIS_ARM_R = new THREE.Vector3(1, 0, 0);
export const AXIS_LEG = new THREE.Vector3(0, -1, 0);

export const boneLength = (child, scale) => child.position.length() * scale;

// Rotate 'bone' so the world direction of its local 'axis' points along 'dir'.
// The minimum rotation is used, which preserves whatever twist the pose had.
export function aimBone(bone, axis, dir, weight = 1) {
  bone.updateWorldMatrix(true, false);
  bone.getWorldQuaternion(_q0);
  _cur.copy(axis).applyQuaternion(_q0).normalize();
  if (_cur.lengthSq() < 1e-9 || dir.lengthSq() < 1e-9) return;
  _q1.setFromUnitVectors(_cur, dir);
  _q1.multiply(_q0);                       // desired world rotation
  bone.parent.getWorldQuaternion(_q2);
  _q2.invert();
  _q1.premultiply(_q2);                    // back to parent local
  if (weight >= 1) bone.quaternion.copy(_q1);
  else bone.quaternion.slerp(_q1, clamp01(weight));
  bone.updateMatrixWorld(true);
}

// Two bone solve. 'target' and 'pole' are world positions; 'pole' only has to
// lie roughly on the side the joint should bend toward.
export function solveTwoBone(rootBone, midBone, endBone, target, pole, axis, weight = 1, scale = 1) {
  if (weight <= 0.001) return;
  rootBone.updateWorldMatrix(true, false);
  _root.setFromMatrixPosition(rootBone.matrixWorld);
  const l1 = boneLength(midBone, scale);
  const l2 = boneLength(endBone, scale);
  if (l1 < 1e-5 || l2 < 1e-5) return;

  _dir.copy(target).sub(_root);
  let len = _dir.length();
  if (len < 1e-5) return;
  _dir.multiplyScalar(1 / len);
  const minLen = Math.abs(l1 - l2) + 0.012;
  const maxLen = (l1 + l2) * 0.998;
  len = clamp(len, minLen, maxLen);

  // Law of cosines for the angle at the root between the first bone and the
  // root to target line.
  const cosA = clamp((l1 * l1 + len * len - l2 * l2) / (2 * l1 * len), -1, 1);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));

  // Bend plane: the component of the pole that is perpendicular to the chain.
  _perp.copy(pole).sub(_root);
  _perp.addScaledVector(_dir, -_perp.dot(_dir));
  if (_perp.lengthSq() < 1e-8) {
    // Degenerate pole: pick any perpendicular so the joint still bends somewhere.
    _tmp.set(0, 1, 0);
    if (Math.abs(_dir.y) > 0.95) _tmp.set(0, 0, 1);
    _perp.copy(_tmp).addScaledVector(_dir, -_tmp.dot(_dir));
  }
  _perp.normalize();

  // Where the knee or elbow wants to be.
  _mid.copy(_root).addScaledVector(_dir, l1 * cosA).addScaledVector(_perp, l1 * sinA);

  _want.copy(_mid).sub(_root).normalize();
  aimBone(rootBone, axis, _want, weight);

  // The mid joint moved with its parent, so read it back before the second aim.
  midBone.updateWorldMatrix(true, false);
  _end.setFromMatrixPosition(midBone.matrixWorld);
  _want.copy(_root).addScaledVector(_dir, len).sub(_end);
  if (_want.lengthSq() < 1e-8) return;
  _want.normalize();
  aimBone(midBone, axis, _want, weight);
}

// Level a foot against a ground normal, keeping its heading. Runs after the leg
// solve, otherwise the parent chain would undo it.
export function levelFoot(footBone, normal, weight = 1, pitch = 0) {
  if (weight <= 0.001) return;
  footBone.updateWorldMatrix(true, false);
  footBone.getWorldQuaternion(_q0);
  _cur.set(0, 1, 0).applyQuaternion(_q0).normalize();
  _axis.copy(normal).normalize();
  if (pitch !== 0) {
    // Tip the toes without changing the heading, for a foot that is rolling off.
    _tmp.set(1, 0, 0).applyQuaternion(_q0).normalize();
    _q2.setFromAxisAngle(_tmp, pitch);
    _axis.applyQuaternion(_q2);
  }
  _q1.setFromUnitVectors(_cur, _axis);
  _q1.multiply(_q0);
  footBone.parent.getWorldQuaternion(_q2);
  _q2.invert();
  _q1.premultiply(_q2);
  footBone.quaternion.slerp(_q1, clamp01(weight));
  footBone.updateMatrixWorld(true);
}

// How far the hips have to drop so a leg can reach its target without locking
// straight. Returns metres, always >= 0.
export function reachDeficit(hipBone, target, legLength, scale = 1) {
  hipBone.updateWorldMatrix(true, false);
  _root.setFromMatrixPosition(hipBone.matrixWorld);
  const d = _root.distanceTo(target);
  const usable = legLength * scale * 0.985;
  return d > usable ? d - usable : 0;
}
