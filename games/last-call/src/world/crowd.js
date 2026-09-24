import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng } from '../core/rng.js';
import { bus, EV } from '../core/events.js';
import { clamp01, expDamp, TAU } from '../core/math.js';
import { TEX } from '../render/texlib.js';

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
  if (!geo.attributes.color) {
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  }
  if (!geo.attributes.uv) {
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  return geo;
}

// Continuous surfaces. The first crowd was boxes, the second was capsules and
// spheres glued at the joints, and a reviewer failed both for the same reason:
// primitives read as primitives the moment the camera comes near. A punter is
// now lofted like the fighters are: one tube from the hips through the chest,
// shoulders, neck and skull, and one per limb with a thigh, a knee, a calf, a
// biceps and a forearm in its radius profile. Ambient occlusion is baked into
// the vertex colour, so armpits, crotch and the underside of the jaw darken.
//
// ring: { c: [x, y, z], rx, rz, ao, part }
function loft(rings, seg, arm = 0, capStart = true, capEnd = true, shape = null) {
  const pos = [], nor = [], uv = [], col = [], parts = [], idx = [];
  const n = rings.length;
  const C = (i) => new THREE.Vector3(...rings[Math.max(0, Math.min(n - 1, i))].c);
  const frames = [];
  for (let i = 0; i < n; i++) {
    const t = C(i + 1).sub(C(i - 1)).normalize();
    const ref = Math.abs(t.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    const n1 = ref.sub(t.clone().multiplyScalar(ref.dot(t))).normalize();
    const n2 = new THREE.Vector3().crossVectors(t, n1).normalize();
    frames.push({ t, n1, n2 });
  }
  for (let i = 0; i < n; i++) {
    const r = rings[i], f = frames[i], c = C(i);
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const sh = shape ? shape(i, a) : null;
      const push = sh ? sh.push : 1;
      pos.push(c.x + (f.n1.x * ca * r.rx + f.n2.x * sa * r.rz) * push,
               c.y + (f.n1.y * ca * r.rx + f.n2.y * sa * r.rz) * push,
               c.z + (f.n1.z * ca * r.rx + f.n2.z * sa * r.rz) * push);
      // Analytic ellipse normal: no seam where the ring closes on itself,
      // which a computed normal would leave as a crease down every limb.
      const nx = ca / r.rx, ny = sa / r.rz, l = Math.hypot(nx, ny) || 1;
      const N = f.n1.clone().multiplyScalar(nx / l).add(f.n2.clone().multiplyScalar(ny / l));
      nor.push(N.x, N.y, N.z);
      uv.push(j / seg, i / (n - 1));
      const ao = r.ao * (sh ? sh.ao : 1);
      col.push(ao, ao, ao);
      parts.push(r.part);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j, b = a + 1, c = a + seg + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const cap = (ri, flip) => {
    const r = rings[ri], f = frames[ri], c = C(ri);
    const centre = pos.length / 3;
    const dir = flip ? f.t.clone().negate() : f.t;
    pos.push(c.x, c.y, c.z); nor.push(dir.x, dir.y, dir.z); uv.push(0.5, ri / (n - 1));
    col.push(r.ao, r.ao, r.ao); parts.push(r.part);
    const base = ri * (seg + 1);
    for (let j = 0; j < seg; j++) {
      if (flip) idx.push(centre, base + j, base + j + 1);
      else idx.push(centre, base + j + 1, base + j);
    }
  };
  if (capStart) cap(0, true);
  if (capEnd) cap(n - 1, false);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  tag(g, 0, arm);
  g.attributes.aPart.array.set(parts);
  return g;
}

// Shoulder pivot the vertex shader rotates the arms around. Shared with the
// shader as a constant so the two never drift apart.
const SHOULDER_X = 0.205;
const SHOULDER_Y = 1.43;

const R = (x, y, z, rx, rz, part, ao = 1) => ({ c: [x, y, z], rx, rz, part, ao });

// Ring indices on the body tube: 11 jaw, 12 mouth and cheeks, 13 eyes, 14 brow.
// Angles are measured so that 3pi/2 faces forward. At crowd distance a face is
// three reads, two dark sockets, a nose and a mouth line, and without them a
// punter is a mannequin however good the body is.
const FRONT = Math.PI * 1.5;
function faceShape(i, a) {
  let d = a - FRONT;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  const ad = Math.abs(d);
  let push = 1, ao = 1;
  if (i === 13) {
    // Eye sockets either side of the nose bridge.
    const eye = Math.exp(-Math.pow((ad - 0.42) / 0.16, 2));
    ao *= 1 - 0.55 * eye;
    push *= 1 - 0.05 * eye;
    if (ad < 0.14) push *= 1.05;              // bridge of the nose
  }
  if (i === 12) {
    if (ad < 0.2) push *= 1.16;               // nose tip sits over the mouth ring
    const cheek = Math.exp(-Math.pow((ad - 0.75) / 0.25, 2));
    ao *= 1 - 0.18 * cheek;
  }
  if (i === 11) {
    if (ad < 0.36) ao *= 0.62;                // mouth line
    push *= 1 + 0.03 * Math.exp(-Math.pow(d / 0.3, 2)); // chin
  }
  if (i === 14 && ad < 0.7) push *= 1.03;     // brow ridge
  return { push, ao };
}

function buildBodyGeometry() {
  const S = PARTS.SKIN, T = PARTS.SHIRT, P = PARTS.TROUSER, H = PARTS.HAIR;
  const parts = [];

  // Hips to crown in one surface: pelvis, belt, waist, ribcage, chest, the
  // shoulder line, the trapezius slope, the neck, the jaw and the skull.
  parts.push(loft([
    R(0, 0.79, 0.0, 0.130, 0.100, P, 0.55),
    R(0, 0.86, 0.0, 0.160, 0.118, P, 0.8),
    R(0, 0.95, 0.0, 0.152, 0.112, P, 0.9),
    R(0, 1.00, 0.004, 0.140, 0.104, T, 0.85),
    R(0, 1.10, 0.008, 0.148, 0.108, T),
    R(0, 1.21, 0.012, 0.165, 0.118, T),
    R(0, 1.31, 0.010, 0.178, 0.118, T),
    R(0, 1.39, 0.004, 0.186, 0.108, T, 0.95),
    R(0, 1.44, 0.000, 0.150, 0.092, T, 0.9),
    R(0, 1.475, 0.004, 0.072, 0.066, S, 0.75),
    R(0, 1.53, 0.010, 0.056, 0.058, S, 0.7),
    R(0, 1.575, 0.022, 0.074, 0.084, S, 0.8),
    R(0, 1.625, 0.012, 0.086, 0.098, S),
    R(0, 1.675, 0.004, 0.090, 0.101, S),
    R(0, 1.72, 0.000, 0.080, 0.092, S),
    R(0, 1.755, -0.004, 0.052, 0.062, S),
    R(0, 1.772, -0.006, 0.02, 0.024, S)
  ], 16, 0, true, true, faceShape));

  // Hair: a thin shell over the crown and back of the skull, pushed back from
  // the brow so it frames a face instead of covering one.
  parts.push(loft([
    R(0, 1.655, -0.016, 0.094, 0.100, H, 0.8),
    R(0, 1.70, -0.012, 0.090, 0.098, H),
    R(0, 1.74, -0.010, 0.076, 0.084, H),
    R(0, 1.768, -0.010, 0.050, 0.058, H),
    R(0, 1.785, -0.010, 0.016, 0.018, H)
  ], 12, 0, false, true));

  // Legs and shoes. Each leg starts inside the pelvis so the join is hidden.
  for (const s of [-1, 1]) {
    const x = s * 0.086;
    parts.push(loft([
      R(x, 0.86, 0.0, 0.080, 0.086, P, 0.6),
      R(x, 0.74, 0.004, 0.078, 0.084, P, 0.75),
      R(x * 1.02, 0.60, 0.008, 0.066, 0.070, P),
      R(x * 1.03, 0.50, 0.010, 0.056, 0.060, P),
      R(x * 1.03, 0.40, 0.004, 0.060, 0.068, P),
      R(x * 1.03, 0.26, 0.000, 0.050, 0.055, P),
      R(x * 1.03, 0.11, 0.004, 0.040, 0.042, P, 0.8)
    ], 8, 0, false, true));
    parts.push(loft([
      R(x * 1.03, 0.05, -0.055, 0.040, 0.034, H, 0.7),
      R(x * 1.03, 0.055, 0.000, 0.048, 0.040, H),
      R(x * 1.03, 0.045, 0.080, 0.044, 0.030, H),
      R(x * 1.03, 0.035, 0.125, 0.026, 0.020, H, 0.8)
    ], 8, 0, true, true));
  }

  // Arms hang from the shoulder pivot; the shader swings them from there. A
  // short sleeve covers the deltoid, then skin: biceps, elbow, forearm, hand.
  for (const s of [-1, 1]) {
    const X = s * SHOULDER_X, Y = SHOULDER_Y;
    parts.push(loft([
      R(X * 0.92, Y + 0.01, 0.0, 0.066, 0.064, T, 0.75),
      R(X * 1.02, Y - 0.07, 0.0, 0.064, 0.062, T),
      R(X * 1.04, Y - 0.12, 0.002, 0.056, 0.056, S, 0.85),
      R(X * 1.06, Y - 0.22, 0.006, 0.050, 0.050, S),
      R(X * 1.07, Y - 0.32, 0.010, 0.040, 0.042, S),
      R(X * 1.07, Y - 0.40, 0.014, 0.043, 0.045, S),
      R(X * 1.06, Y - 0.54, 0.018, 0.031, 0.035, S),
      R(X * 1.06, Y - 0.60, 0.020, 0.036, 0.024, S),
      R(X * 1.06, Y - 0.67, 0.022, 0.026, 0.018, S)
    ], 7, s, false, true));
  }

  // A pint glass in the right hand, collapsed away when unused.
  const cup = new THREE.CylinderGeometry(0.041, 0.034, 0.13, 8, 1);
  cup.translate(SHOULDER_X, SHOULDER_Y - 0.72, 0.03);
  parts.push(tag(cup, PARTS.DRINK, 1));

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
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
uniform vec3 uCam;

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
  // Anyone standing right in front of the lens ducks out of the shot:
  // punters within a metre and a half of the camera shrink to nothing, so the
  // camera never films the fight through the back of someone's head.
  vec2 cWho = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz;
  float cNear = smoothstep(0.9, 1.7, distance(cWho, uCam.xz));
  transformed *= cNear;
`;

const COLOR_HOOK = /* glsl */`
  vColor = vec4(1.0);
  vec3 cSkinTone = aSkin;
  if (aPart > 3.5) cSkinTone = vec3(0.55, 0.62, 0.42);
  else if (aPart > 2.5) cSkinTone = aSkin * 0.22;
  else if (aPart > 1.5) cSkinTone = aTrouser;
  else if (aPart > 0.5) cSkinTone = instanceColor.rgb;
  // Baked occlusion rides in the colour attribute.
  vColor.rgb = cSkinTone * color.rgb;
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
    // A cloth weave in the normal map, so a shirt catching a rim light reads
    // as fabric rather than as a smooth plastic shell.
    const weave = TEX.fabric('#808080', 61, 256, 48).normal.clone();
    weave.repeat.set(1.5, 2.5);
    weave.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x6b6b72, roughness: 0.94, metalness: 0.0, vertexColors: true,
      normalMap: weave, normalScale: new THREE.Vector2(0.32, 0.32)
    });
    this.uniforms = {
      uBeat: { value: 0 }, uTime: { value: 0 }, uExcite: { value: 0 }, uSurge: { value: 0 }, uCam: { value: new THREE.Vector3(0, 0, 99) }
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
