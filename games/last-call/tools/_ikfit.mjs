// Solve the rig toward hand and foot targets, then print the euler angles, so
// the authored stance can be written from positions instead of guesswork.
import * as THREE from 'three';
import { solveTwoBone, AXIS_ARM_L, AXIS_ARM_R, AXIS_LEG } from '../src/anim/ik.js';
import { GUARD_POSE } from '../src/anim/clips.js';
import { BONES, BONE_ORDER, OFF_HIP } from '../src/anim/layers.js';

const g = new THREE.Group();
const bones = {};
const mk = (n, p, x, y, z) => { const b = new THREE.Bone(); b.name = n; b.position.set(x,y,z); (p?bones[p]:g).add(b); bones[n]=b; return b; };
mk('hips', null, 0, 0.98, 0);
mk('spine','hips',0,0.14,0); mk('chest','spine',0,0.20,0); mk('neck','chest',0,0.21,0); mk('head','neck',0,0.10,0);
for (const s of [-1,1]) { const S = s<0?'L':'R';
  mk('shoulder'+S,'chest',0.048*s,0.17,0); mk('upperArm'+S,'shoulder'+S,0.125*s,0.005,0);
  mk('forearm'+S,'upperArm'+S,0.295*s,0,0); mk('hand'+S,'forearm'+S,0.265*s,0,0);
  mk('thigh'+S,'hips',0.098*s,-0.04,0); mk('shin'+S,'thigh'+S,0,-0.44,0); mk('foot'+S,'shin'+S,0,-0.43,0); }
BONES.forEach((n,i)=>{ bones[n].rotation.order = BONE_ORDER[i]; });

const pose = GUARD_POSE;
for (let i=0;i<BONES.length;i++){ const b=bones[BONES[i]]; const o=i*3; b.rotation.set(pose[o],pose[o+1],pose[o+2],BONE_ORDER[i]); }
// Start the arms from the hanging rest, so the solved eulers stay in the
// natural range instead of inheriting a flipped twist.
if (process.env.FROM_REST) {
  for (const S of ['L','R']) { const sg = S==='L'?1:-1;
    bones['upperArm'+S].rotation.set(0,0,sg*1.35); bones['forearm'+S].rotation.set(0,0,sg*0.15);
    bones['thigh'+S].rotation.set(0,0,0); bones['shin'+S].rotation.set(0,0,0); }
}
bones.hips.position.set(pose[OFF_HIP], 0.98+pose[OFF_HIP+1], pose[OFF_HIP+2]);
g.updateMatrixWorld(true);

const T = JSON.parse(process.argv[2]);
const V = (a) => new THREE.Vector3(a[0],a[1],a[2]);
const pos = new THREE.Vector3();
const fit = (root, mid, end, tgt, pole, axis) => {
  solveTwoBone(bones[root], bones[mid], bones[end], V(tgt), V(pole), axis, 1, 1);
};
if (T.handL) fit('upperArmL','forearmL','handL', T.handL, T.poleL || [-0.9,0.2,0.4], AXIS_ARM_L);
if (T.handR) fit('upperArmR','forearmR','handR', T.handR, T.poleR || [0.9,0.2,0.4], AXIS_ARM_R);
if (T.footL) fit('thighL','shinL','footL', T.footL, T.kneeL || [-0.2,0.5,1.4], AXIS_LEG);
if (T.footR) fit('thighR','shinR','footR', T.footR, T.kneeR || [0.2,0.5,1.4], AXIS_LEG);
g.updateMatrixWorld(true);
const names = Object.keys(T).filter(k=>!k.startsWith('pole')&&!k.startsWith('knee'));
const chains = { handL:['upperArmL','forearmL','handL'], handR:['upperArmR','forearmR','handR'], footL:['thighL','shinL','footL'], footR:['thighR','shinR','footR'] };
for (const n of names) for (const b of chains[n]) {
  const r = bones[b].rotation;
  console.log(("'"+b+".x': "+r.x.toFixed(3)+", '"+b+".y': "+r.y.toFixed(3)+", '"+b+".z': "+r.z.toFixed(3)+","));
}
for (const n of names) { bones[chains[n][2]].getWorldPosition(pos); console.log('// '+n+' -> '+pos.x.toFixed(3)+' '+pos.y.toFixed(3)+' '+pos.z.toFixed(3)); }
