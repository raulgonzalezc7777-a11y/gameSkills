import * as THREE from 'three';
import { rng } from '../core/rng.js';
import { clamp, clamp01 } from '../core/math.js';

// Floor marks that accumulate over a round: spilled beer, blood spots, glass
// and scuffs. One InstancedMesh, one draw call, a ring buffer of slots. The
// splat shape comes from the shader rather than from geometry, so a decal is
// four vertices no matter how ragged its outline looks.
const KINDS = {
  beer:  { color: [0.82, 0.47, 0.10], gloss: 1.0, life: 26, rough: 0.35 },
  blood: { color: [0.36, 0.045, 0.055], gloss: 0.7, life: 34, rough: 0.55 },
  sweat: { color: [0.62, 0.68, 0.78], gloss: 1.0, life: 11, rough: 0.2 },
  glass: { color: [0.72, 0.88, 0.95], gloss: 1.0, life: 30, rough: 0.1 },
  scuff: { color: [0.10, 0.09, 0.11], gloss: 0.0, life: 40, rough: 0.9 }
};

const VERT = /* glsl */`
attribute float aBirth;
attribute float aLife;
attribute float aSeed;
attribute float aGloss;
varying vec2 vUv;
varying vec3 vTint;
varying float vSeed;
varying float vFade;
varying float vGloss;
uniform float uTime;
void main() {
  vUv = uv - 0.5;
  vTint = instanceColor;
  vSeed = aSeed;
  vGloss = aGloss;
  float age = uTime - aBirth;
  // A splat spreads fast then stops, and only starts fading near the end of
  // its life, because a puddle that dims from the instant it lands reads as a
  // bug rather than as evaporation.
  float grow = clamp(age * 6.0, 0.0, 1.0);
  vFade = clamp((aLife - age) / max(aLife * 0.3, 0.001), 0.0, 1.0) * step(0.0, age);
  vec3 p = position * (0.35 + 0.65 * grow);
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
}`;

const FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
varying vec3 vTint;
varying float vSeed;
varying float vFade;
varying float vGloss;
uniform vec3 uKeyColor;
uniform vec3 uAmbient;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  float a = atan(vUv.y, vUv.x);
  float r = length(vUv) * 2.0;
  // Three harmonics of angular wobble turn a circle into a splat with fingers.
  float wob = 0.78
    + 0.16 * sin(a * 3.0 + vSeed * 31.0)
    + 0.10 * sin(a * 5.0 - vSeed * 17.0)
    + 0.07 * sin(a * 9.0 + vSeed * 7.0);
  float mask = 1.0 - smoothstep(wob - 0.18, wob, r);
  if (mask <= 0.003) discard;

  // Speckle around the rim: the droplets that came off the main splash.
  float speck = step(0.86, hash(vUv * 21.0 + vSeed * 13.0)) * smoothstep(wob * 0.7, wob * 1.25, r);
  mask = max(mask, speck * 0.8);

  // A wet decal is mostly a specular event, so the centre gets a highlight
  // rather than just more colour.
  float sheen = vGloss * pow(1.0 - clamp(r / max(wob, 0.001), 0.0, 1.0), 3.0);
  vec3 col = vTint * (uAmbient * 1.4 + 0.25) + uKeyColor * sheen * 0.55;

  gl_FragColor = vec4(col, mask * vFade * (0.55 + vGloss * 0.35));
}`;

export class DecalField {
  constructor(scene, opts = {}) {
    this.capacity = Math.max(8, opts.capacity | 0 || 120);
    this.floorY = opts.floorY ?? 0;
    this.light = opts.light;
    this.time = 0;
    this.cursor = 0;
    this.pending = [];
    this._pendingPool = [];

    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const g = new THREE.InstancedBufferGeometry();
    g.index = geo.index;
    g.attributes.position = geo.attributes.position;
    g.attributes.uv = geo.attributes.uv;
    geo.dispose();

    this.birth = new Float32Array(this.capacity);
    this.life = new Float32Array(this.capacity);
    this.seed = new Float32Array(this.capacity);
    this.gloss = new Float32Array(this.capacity);
    this.birth.fill(-1e6);
    this.life.fill(0.001);

    g.setAttribute('aBirth', new THREE.InstancedBufferAttribute(this.birth, 1));
    g.setAttribute('aLife', new THREE.InstancedBufferAttribute(this.life, 1));
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(this.seed, 1));
    g.setAttribute('aGloss', new THREE.InstancedBufferAttribute(this.gloss, 1));
    g.instanceCount = this.capacity;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.uniforms = {
      uTime: { value: 0 },
      uKeyColor: { value: new THREE.Color(1, 0.95, 0.88) },
      uAmbient: { value: new THREE.Color(0.18, 0.15, 0.26) }
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms,
      transparent: true, depthWrite: false, depthTest: true,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
    });

    this.mesh = new THREE.InstancedMesh(g, mat, this.capacity);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Every slot starts collapsed and off screen, so an unused one draws
    // nothing even before its birth time is set.
    const m = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.capacity; i++) this.mesh.setMatrixAt(i, m);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    scene.add(this.mesh);
    this.scene = scene;
    this.geo = g;
    this.mat = mat;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
  }

  // A droplet in flight knows where and when it will land, so the decal is
  // queued rather than spawned on impact: no per-particle collision needed.
  schedule(x, z, delay, kind, size, color, alpha) {
    const e = this._pendingPool.pop() || { x: 0, z: 0, t: 0, kind: 'beer', size: 0.2, r: 1, g: 1, b: 1, a: 1 };
    e.x = x; e.z = z; e.t = this.time + Math.max(0, delay);
    e.kind = kind; e.size = size;
    e.r = color?.r ?? 1; e.g = color?.g ?? 1; e.b = color?.b ?? 1;
    e.a = alpha ?? 1;
    this.pending.push(e);
  }

  place(x, z, kind = 'beer', size = 0.25, color = null, alpha = 1) {
    const k = KINDS[kind] || KINDS.beer;
    const i = this.cursor;
    this.cursor = (i + 1) % this.capacity;

    this._p.set(x, this.floorY + 0.012, z);
    this._q.setFromAxisAngle(UP, rng.range(0, Math.PI * 2));
    const s = size * rng.range(0.82, 1.3);
    this._s.set(s, 1, s);
    this._m.compose(this._p, this._q, this._s);
    this.mesh.setMatrixAt(i, this._m);
    this.mesh.instanceMatrix.needsUpdate = true;

    const c = this.mesh.instanceColor.array;
    c[i * 3] = color?.r ?? k.color[0];
    c[i * 3 + 1] = color?.g ?? k.color[1];
    c[i * 3 + 2] = color?.b ?? k.color[2];
    this.mesh.instanceColor.needsUpdate = true;

    this.birth[i] = this.time;
    this.life[i] = k.life * clamp(alpha, 0.35, 1.4);
    this.seed[i] = rng();
    this.gloss[i] = k.gloss;
    this.geo.attributes.aBirth.needsUpdate = true;
    this.geo.attributes.aLife.needsUpdate = true;
    this.geo.attributes.aSeed.needsUpdate = true;
    this.geo.attributes.aGloss.needsUpdate = true;
  }

  update(dt) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    if (this.light) {
      this.uniforms.uKeyColor.value.copy(this.light.keyColor);
      this.uniforms.uAmbient.value.copy(this.light.ambient);
    }
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const e = this.pending[i];
      if (this.time < e.t) continue;
      this.place(e.x, e.z, e.kind, e.size, e, e.a);
      this.pending[i] = this.pending[this.pending.length - 1];
      this.pending.pop();
      this._pendingPool.push(e);
    }
  }

  clear() {
    this.birth.fill(-1e6);
    this.geo.attributes.aBirth.needsUpdate = true;
    this.pending.length = 0;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
  }
}

const UP = new THREE.Vector3(0, 1, 0);
