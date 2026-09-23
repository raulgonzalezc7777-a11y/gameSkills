// Joint positions for an authored pose, so stance angles can be tuned against
// numbers instead of guesses. Mirrors the builder's bone layout.
import * as THREE from 'three';
import { CLIPS, GUARD, sampleClip } from '../src/anim/clips.js';
import { BONES, BONE_ORDER, BI, OFF_HIP, createPose, zeroPose } from '../src/anim/layers.js';

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

const clipName = process.argv[2] || null;
const time = +(process.argv[3] || 0);
const pose = createPose();
if (clipName) sampleClip(CLIPS[clipName], time, zeroPose(pose));
else for (const ch in GUARD) { /* guard table */ }
if (!clipName) { const { GUARD_POSE } = await import('../src/anim/clips.js'); pose.set(GUARD_POSE); }
for (let i=0;i<BONES.length;i++){ const b=bones[BONES[i]]; const o=i*3; b.rotation.set(pose[o],pose[o+1],pose[o+2],BONE_ORDER[i]); }
bones.hips.position.set(pose[OFF_HIP], 0.98+pose[OFF_HIP+1], pose[OFF_HIP+2]);
g.updateMatrixWorld(true);
const v = new THREE.Vector3();
const show = (n) => { bones[n].getWorldPosition(v); return n.padEnd(10)+' x '+v.x.toFixed(3).padStart(7)+'  y '+v.y.toFixed(3).padStart(6)+'  z '+v.z.toFixed(3).padStart(7); };
console.log((clipName||'GUARD')+' @ '+time);
for (const n of ['head','chest','hips','shoulderL','forearmL','handL','shoulderR','forearmR','handR','thighL','shinL','footL','thighR','shinR','footR']) console.log(show(n));
