import * as THREE from 'three';
import { rng as gRng, makeRng, hashString } from '../core/rng.js';

// Procedural humanoid. Version 1: a bone hierarchy (THREE.Bone) with limb
// meshes parented to bones. The CHARACTER owner upgrades this to a single
// skinned mesh with smooth weights, authored skin/cloth materials and damage.
// The 'bones' contract below is frozen: animation code depends on these names.
export const BONE_NAMES = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'shoulderL', 'upperArmL', 'forearmL', 'handL',
  'shoulderR', 'upperArmR', 'forearmR', 'handR',
  'thighL', 'shinL', 'footL',
  'thighR', 'shinR', 'footR'
];

const capsule = (r1, r2, len, seg = 12) => {
  const g = new THREE.CylinderGeometry(r2, r1, len, seg, 3, false);
  g.translate(0, len * 0.5, 0);
  return g;
};

export function buildFighter(spec = {}) {
  const seed = hashString(spec.name || 'fighter');
  const rng = makeRng(seed);
  const scale = spec.scale ?? 1;
  const bulk = spec.bulk ?? rng.range(0.9, 1.25);
  const skin = new THREE.Color(spec.skin ?? '#c98d6b');
  const shirt = new THREE.Color(spec.shirt ?? '#2b3a55');
  const pants = new THREE.Color(spec.pants ?? '#1b2030');

  const group = new THREE.Group();
  group.name = spec.name || 'fighter';

  const bones = {};
  const mk = (name, parent, pos) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(pos[0], pos[1], pos[2]);
    (parent ? bones[parent] : group).add(b);
    bones[name] = b;
    return b;
  };

  // Proportions in metres for a 1.82 m fighter.
  mk('hips', null, [0, 0.98, 0]);
  mk('spine', 'hips', [0, 0.14, 0]);
  mk('chest', 'spine', [0, 0.20, 0]);
  mk('neck', 'chest', [0, 0.21, 0]);
  mk('head', 'neck', [0, 0.10, 0]);
  for (const s of [-1, 1]) {
    const S = s < 0 ? 'L' : 'R';
    mk('shoulder' + S, 'chest', [0.055 * s, 0.17, 0]);
    mk('upperArm' + S, 'shoulder' + S, [0.16 * s * bulk, 0.01, 0]);
    mk('forearm' + S, 'upperArm' + S, [0.29 * s, 0, 0]);
    mk('hand' + S, 'forearm' + S, [0.26 * s, 0, 0]);
    mk('thigh' + S, 'hips', [0.105 * s, -0.04, 0]);
    mk('shin' + S, 'thigh' + S, [0, -0.44, 0]);
    mk('foot' + S, 'shin' + S, [0, -0.43, 0]);
  }
  // Arms hang down by default; combat poses rotate from there.
  for (const s of ['L', 'R']) {
    const sign = s === 'L' ? 1 : -1;
    bones['upperArm' + s].rotation.z = sign * 1.35;
    bones['forearm' + s].rotation.z = sign * 0.15;
  }

  const matSkin = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.62, metalness: 0.0 });
  const matShirt = new THREE.MeshStandardMaterial({ color: shirt, roughness: 0.85, metalness: 0.0 });
  const matPants = new THREE.MeshStandardMaterial({ color: pants, roughness: 0.9, metalness: 0.0 });
  const materials = { skin: matSkin, shirt: matShirt, pants: matPants };

  const limbs = [];
  const attach = (boneName, geo, mat, offset = [0, 0, 0], rot = [0, 0, 0]) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(offset[0], offset[1], offset[2]);
    m.rotation.set(rot[0], rot[1], rot[2]);
    m.castShadow = true; m.receiveShadow = true;
    bones[boneName].add(m);
    limbs.push(m);
    return m;
  };

  const b = bulk;
  // Torso
  attach('hips', capsule(0.19 * b, 0.17 * b, 0.16), matPants);
  attach('spine', capsule(0.20 * b, 0.22 * b, 0.20), matShirt);
  attach('chest', capsule(0.23 * b, 0.19 * b, 0.22), matShirt);
  attach('neck', new THREE.CylinderGeometry(0.055, 0.07, 0.09, 10), matSkin, [0, 0.045, 0]);
  // Head
  const headGeo = new THREE.SphereGeometry(0.115, 20, 16);
  headGeo.scale(0.92, 1.12, 1.0);
  attach('head', headGeo, matSkin, [0, 0.105, 0.008]);
  attach('head', new THREE.SphereGeometry(0.03, 8, 8), matSkin, [0, 0.085, 0.108]); // nose mass
  // Arms and legs, with the length running down the local -Y of each bone but
  // the arm bones are laid out along X, so the meshes rotate into place.
  for (const s of [-1, 1]) {
    const S = s < 0 ? 'L' : 'R';
    attach('upperArm' + S, capsule(0.075 * b, 0.065 * b, 0.28), matSkin, [0, 0, 0], [0, 0, s < 0 ? Math.PI / 2 : -Math.PI / 2]);
    attach('forearm' + S, capsule(0.065 * b, 0.05 * b, 0.25), matSkin, [0, 0, 0], [0, 0, s < 0 ? Math.PI / 2 : -Math.PI / 2]);
    const fist = new THREE.SphereGeometry(0.068 * b, 12, 10);
    attach('hand' + S, fist, matSkin, [0.03 * s, 0, 0]);
    attach('thigh' + S, capsule(0.105 * b, 0.085 * b, 0.42), matPants, [0, 0, 0], [Math.PI, 0, 0]);
    attach('shin' + S, capsule(0.082 * b, 0.055 * b, 0.41), matPants, [0, 0, 0], [Math.PI, 0, 0]);
    const foot = new THREE.BoxGeometry(0.1, 0.07, 0.25);
    attach('foot' + S, foot, matPants, [0, -0.03, 0.05]);
  }

  group.scale.setScalar(scale);
  group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  return {
    group, bones, materials, limbs, spec,
    height: 1.82 * scale,
    setDamage() {},
    setSweat() {},
    dispose() {
      limbs.forEach((m) => m.geometry.dispose());
      Object.values(materials).forEach((m) => m.dispose());
    }
  };
}
