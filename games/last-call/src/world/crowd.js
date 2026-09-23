import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng } from '../core/rng.js';
import { bus, EV } from '../core/events.js';
import { clamp01, expDamp, TAU } from '../core/math.js';

// The punters. One InstancedMesh, one draw call, a few hundred bodies, all
// animated on the GPU from instanced attributes. The CPU only ever writes a
// handful of uniforms per frame, which is what makes a crowd this size free.
//
// Per-vertex attributes:
//   aPart  0 skin, 1 shirt, 2 trousers, 3 hair, 4 drink
//   aArm  -1 left arm, +1 right arm, 0 otherwise (drives shoulder rotation)
// Per-instance attributes:
//   aRand  (beat phase, bob amplitude, arms-up style)
//   aBody  (lean scale, jump amount, has-drink flag)
//   aSkin / aTrouser colours, plus instanceColor for the shirt.

const PARTS = { SKIN: 0, SHIRT: 1, TROUSER: 2, HAIR: 3, DRINK: 4 };

function tag(geo, part, arm = 0) {
  const n = geo.attributes.position.count;
  const p = new Float32Array(n).fill(part);
  const a = new Float32Array(n).fill(arm);
  geo.setAttribute('aPart', new THREE.BufferAttribute(p, 1));
  geo.setAttribute('aArm', new THREE.BufferAttribute(a, 1));
  // A dummy vertex colour keeps USE_COLOR defined so the fragment stage
  // actually multiplies by the per-instance palette we compute in vColor.
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  if (!geo.attributes.uv) {
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  return geo;
}

// Rounded volumes only. The first crowd was built from boxes, and a box is the
// one shape a human body never makes: the moment the camera came near a punter
// the frame read as a toy. Capsules and spheres at low segment counts cost a
// few hundred triangles more per body and read as people at every distance.
const piece = (geo, x, y, z, part, arm = 0, sx = 1, sy = 1, sz = 1, rx = 0) => {
  if (sx !== 1 || sy !== 1 || sz !== 1) geo.scale(sx, sy, sz);
  if (rx) geo.rotateX(rx);
  geo.translate(x, y, z);
  return tag(geo, part, arm);
};
const cap = (r, len, seg = 7) => new THREE.CapsuleGeometry(r, len, 2, seg);
const ball = (r, w = 10, h = 8) => new THREE.SphereGeometry(r, w, h);

// Shoulder pivot the vertex shader rotates the arms around. Shared with the
// shader as a constant so the two never drift apart.
const SHOULDER_X = 0.205;
const SHOULDER_Y = 1.43;

function buildBodyGeometry() {
  const parts = [];

  // Head: taller than wide, deeper at the back than the face, the way a skull
  // is. The hair is a cap that hugs the crown, not a hat.
  parts.push(piece(ball(0.102, 12, 10), 0, 1.635, 0, PARTS.SKIN, 0, 0.9, 1.13, 1.0));
  const hair = new THREE.SphereGeometry(0.108, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.46);
  parts.push(piece(hair, 0, 1.655, -0.012, PARTS.HAIR, 0, 0.93, 1.1, 1.04));
  parts.push(piece(ball(0.024, 6, 5), 0, 1.622, 0.098, PARTS.SKIN));          // nose
  parts.push(piece(new THREE.CylinderGeometry(0.052, 0.062, 0.12, 8, 1), 0, 1.505, 0, PARTS.SKIN));

  // Torso: a chest capsule over a narrower waist capsule gives the V taper a
  // standing body has, and the shoulder balls round off the top line.
  parts.push(piece(cap(0.17, 0.22, 9), 0, 1.25, 0, PARTS.SHIRT, 0, 1.18, 1.0, 0.72));
  parts.push(piece(cap(0.14, 0.14, 9), 0, 1.0, 0, PARTS.SHIRT, 0, 1.12, 1.0, 0.74));
  for (const s of [-1, 1]) parts.push(piece(ball(0.075, 8, 6), s * SHOULDER_X, SHOULDER_Y, 0, PARTS.SHIRT, s));

  // Hips and legs.
  parts.push(piece(cap(0.13, 0.08, 9), 0, 0.86, 0, PARTS.TROUSER, 0, 1.2, 1.0, 0.8));
  for (const s of [-1, 1]) {
    parts.push(piece(cap(0.078, 0.34), s * 0.092, 0.6, 0, PARTS.TROUSER));
    parts.push(piece(cap(0.062, 0.34), s * 0.094, 0.24, 0.005, PARTS.TROUSER));
    parts.push(piece(cap(0.05, 0.14, 6), s * 0.094, 0.045, 0.045, PARTS.HAIR, 0, 1.15, 0.75, 1, Math.PI / 2));
  }

  // Arms hang from the shoulder pivot; the shader swings them from there.
  for (const s of [-1, 1]) {
    parts.push(piece(cap(0.052, 0.24), s * SHOULDER_X, SHOULDER_Y - 0.17, 0, PARTS.SKIN, s));
    parts.push(piece(cap(0.044, 0.22), s * SHOULDER_X, SHOULDER_Y - 0.46, 0.01, PARTS.SKIN, s));
    parts.push(piece(ball(0.045, 7, 6), s * SHOULDER_X, SHOULDER_Y - 0.64, 0.015, PARTS.SKIN, s));
  }

  // A pint glass in the right hand, collapsed away when unused.
  const cup = new THREE.CylinderGeometry(0.041, 0.034, 0.13, 8, 1);
  cup.translate(SHOULDER_X, SHOULDER_Y - 0.72, 0.03);
  parts.push(tag(cup, PARTS.DRINK, 1));

  // Every piece must carry the same attribute set before a merge.
  for (const g of parts) {
    if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  merged.computeVertexNormals();
  return merged;
}

const HEAD = /* glsl */`
attribute float aPart;
attribute float aArm;
attribute vec3 aRand;
attribute vec3 aBody;
attribute vec3 aSkin;
attribute vec3 aTrouser;
uniform float uBeat;
uniform float uTime;
uniform float uExcite;
uniform float uSurge;

// Rotation about the shoulder: 'raise' lifts the arm out to the side, 'swing'
// pumps it forward and back. Returned as a matrix so the normal pass can reuse
// exactly the same transform as the position pass.
mat3 crowdArmRot(float side, float raise, float swing) {
  float s = sin(raise * side), c = cos(raise * side);
  mat3 rz = mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0);
  float s2 = sin(swing), c2 = cos(swing);
  mat3 rx = mat3(1.0, 0.0, 0.0, 0.0, c2, s2, 0.0, -s2, c2);
  return rx * rz;
}
`;

const NORMAL_HOOK = /* glsl */`
  float cPhase = aRand.x;
  float cBounce = abs(sin(uBeat * 3.14159265 + cPhase));
  float cHype = clamp(uExcite + uSurge, 0.0, 1.6);
  float cRaise = mix(0.22, 2.35, aRand.z) + cBounce * mix(0.1, 0.5, aRand.z) + cHype * 1.05 * aRand.z;
  float cSwing = sin(uBeat * 3.14159265 + cPhase + aArm * 1.7) * (0.22 + cHype * 0.3);
  mat3 cArm = crowdArmRot(aArm, cRaise, cSwing);
  vec3 cPivot = vec3(aArm * ${SHOULDER_X.toFixed(3)}, ${SHOULDER_Y.toFixed(3)}, 0.0);
  if (abs(aArm) > 0.5) objectNormal = cArm * objectNormal;
`;

const POSITION_HOOK = /* glsl */`
  if (abs(aArm) > 0.5) transformed = cArm * (transformed - cPivot) + cPivot;
  if (aPart > 3.5 && aBody.z < 0.5) transformed = cPivot;

  float cAmp = aRand.y * (1.0 + cHype * 2.2);
  float cLift = cBounce * cAmp + cHype * aBody.y * abs(sin(uTime * 8.2 + cPhase)) * 0.22;
  // Lean scales with height so the feet stay planted on the floor.
  float cUp = clamp(transformed.y / 1.8, 0.0, 1.2);
  transformed.x += sin(uBeat * 1.57079633 + cPhase) * aBody.x * cUp;
  transformed.z += cos(uBeat * 1.04719755 + cPhase * 1.7) * aBody.x * 0.6 * cUp;
  transformed.y += cLift;
`;

const COLOR_HOOK = /* glsl */`
  vColor = vec4(1.0);
  vec3 cSkinTone = aSkin;
  if (aPart > 3.5) cSkinTone = vec3(0.55, 0.62, 0.42);
  else if (aPart > 2.5) cSkinTone = aSkin * 0.22;
  else if (aPart > 1.5) cSkinTone = aTrouser;
  else if (aPart > 0.5) cSkinTone = instanceColor.rgb;
  vColor.rgb = cSkinTone;
`;

export class Crowd {
  constructor(group, opts = {}) {
    const count = opts.count ?? 210;
    this.count = count;
    this.excite = 0;
    this.surge = 0;
    this.beat = 0;

    const geo = buildBodyGeometry();
    // The crowd is backlit background. Held at full albedo it blows out to
    // white under the rim spots and competes with the fighters, which is the
    // opposite of what a crowd is for: it should read as silhouette and colour
    // mass, never as detail.
    const mat = new THREE.MeshStandardMaterial({
      color: 0x6b6b72, roughness: 0.94, metalness: 0.0, vertexColors: true
    });
    this.uniforms = {
      uBeat: { value: 0 }, uTime: { value: 0 }, uExcite: { value: 0 }, uSurge: { value: 0 }
    };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = HEAD + shader.vertexShader;
      shader.vertexShader = shader.vertexShader
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n' + NORMAL_HOOK)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + POSITION_HOOK)
        .replace('#include <color_vertex>', COLOR_HOOK);
    };
    mat.customProgramCacheKey = () => 'lastcall-crowd';
    this.material = mat;

    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.mesh = mesh;

    const rand = new Float32Array(count * 3);
    const body = new Float32Array(count * 3);
    const skin = new Float32Array(count * 3);
    const trouser = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);

    // A club crowd is mostly black and denim with a few loud shirts. Sampling
    // that distribution, rather than a flat hue wheel, is what stops it
    // looking like a bag of sweets.
    const shirtPalette = [
      0x14161d, 0x1b1f2b, 0x232734, 0x2c1f2b, 0x101418, 0x3a2430,
      0x7a2030, 0x94402f, 0x9c7f38, 0x1d5f68, 0x523079, 0x9a9daa,
      0x265244, 0x8d3a5e, 0x24386b
    ];
    const skinPalette = ['#c98d6b', '#8a5a3c', '#e6c09a', '#6b4229', '#f0cda8', '#a06a45', '#4e3020'];
    const trouserPalette = [0x14161c, 0x1c2433, 0x232323, 0x2d3648, 0x101010, 0x3a2c22];

    const c = new THREE.Color();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    this.slots = opts.placer ? opts.placer(count) : [];
    for (let i = 0; i < count; i++) {
      const slot = this.slots[i] || { x: 0, z: 0, y: 0, face: 0 };
      const h = rng.range(0.9, 1.13);
      const w = rng.range(0.88, 1.24);
      pos.set(slot.x, slot.y || 0, slot.z);
      scl.set(w, h, w * rng.range(0.92, 1.06));
      q.setFromAxisAngle(up, slot.face + rng.gauss(0, 0.28));
      m.compose(pos, q, scl);
      mesh.setMatrixAt(i, m);

      rand[i * 3] = rng.range(0, TAU);
      rand[i * 3 + 1] = rng.range(0.035, 0.115);
      // A third of the room has its hands in the air at any moment.
      rand[i * 3 + 2] = rng.chance(0.34) ? rng.range(0.72, 1.0) : rng.range(0.0, 0.3);
      body[i * 3] = rng.range(0.03, 0.09);
      body[i * 3 + 1] = rng.range(0.4, 1.0);
      body[i * 3 + 2] = rng.chance(0.4) ? 1 : 0;

      c.set(rng.pick(skinPalette));
      skin[i * 3] = c.r; skin[i * 3 + 1] = c.g; skin[i * 3 + 2] = c.b;
      c.setHex(rng.pick(trouserPalette));
      trouser[i * 3] = c.r; trouser[i * 3 + 1] = c.g; trouser[i * 3 + 2] = c.b;
      c.setHex(rng.pick(shirtPalette));
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    mesh.instanceColor.needsUpdate = true;
    geo.setAttribute('aRand', new THREE.InstancedBufferAttribute(rand, 3));
    geo.setAttribute('aBody', new THREE.InstancedBufferAttribute(body, 3));
    geo.setAttribute('aSkin', new THREE.InstancedBufferAttribute(skin, 3));
    geo.setAttribute('aTrouser', new THREE.InstancedBufferAttribute(trouser, 3));

    group.add(mesh);

    this._offs = [
      bus.on(EV.HIT_LANDED, () => { this.surge = Math.min(1.1, this.surge + 0.4); }),
      bus.on(EV.KO, () => { this.surge = 1.6; }),
      bus.on(EV.KNOCKDOWN, () => { this.surge = Math.min(1.4, this.surge + 0.7); }),
      bus.on(EV.CROWD_REACT, (p) => { this.surge = Math.min(1.6, this.surge + (p?.amount ?? 0.5)); })
    ];
  }

  // 'beat' is the club's running beat phase in beats, shared with the lights so
  // the room moves as one instrument.
  update(dt, t, beat, energy) {
    this.surge = expDamp(this.surge, 0, 1.3, dt);
    this.excite = expDamp(this.excite, clamp01(energy ?? 0.25), 2.4, dt);
    this.uniforms.uBeat.value = beat;
    this.uniforms.uTime.value = t;
    this.uniforms.uExcite.value = this.excite;
    this.uniforms.uSurge.value = this.surge;
  }

  dispose() {
    this._offs.forEach((off) => off());
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
