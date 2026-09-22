import * as THREE from 'three';
import { rng } from '../core/rng.js';
import { clamp, clamp01 } from '../core/math.js';
import { PARTICLE_VERT, PARTICLE_FRAG } from './shaders/particle.js';
import { DecalField } from './decals.js';
import { TrailRig } from './trails.js';
import { Impacts } from './impacts.js';

// ---------------------------------------------------------------------------
// Scratch. Nothing below this line is allowed to allocate once boot is done.
// ---------------------------------------------------------------------------
const _v = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _bit = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _col = new THREE.Color();
const _col2 = new THREE.Color();

// Fill-then-submit spawn record. One shared instance, reused by every emitter,
// which is how 'emit' stays allocation free no matter how many particles a hit
// throws.
const S = {
  x: 0, y: 0, z: 0,
  vx: 0, vy: 0, vz: 0,
  life: 1, seed: 0, sizeA: 0.05, sizeB: 0.05,
  gravity: 9.8, drag: 1.0, spin: 0,
  r: 1, g: 1, b: 1,
  r2: 1, g2: 1, b2: 1,
  opacity: 1, bright: 1, stretch: 0, flutter: 0
};

const FLOATS = 24; // aPos3 aVel3 aLife4 aDyn4 aColor3 aColor2_3 aExtra4

// Build an orthonormal basis around a direction so cones can be emitted without
// allocating a quaternion per particle.
function basis(dx, dy, dz) {
  _axis.set(dx, dy, dz);
  if (_axis.lengthSq() < 1e-8) _axis.set(0, 1, 0);
  _axis.normalize();
  _tan.set(0, 1, 0);
  if (Math.abs(_axis.y) > 0.92) _tan.set(1, 0, 0);
  _tan.cross(_axis).normalize();
  _bit.copy(_axis).cross(_tan);
}

// Writes a direction 'spread' radians off the current basis axis into _v.
function cone(spread) {
  const a = rng.range(0, Math.PI * 2);
  const r = Math.tan(spread) * Math.sqrt(rng());
  _v.copy(_axis)
    .addScaledVector(_tan, Math.cos(a) * r)
    .addScaledVector(_bit, Math.sin(a) * r)
    .normalize();
  return _v;
}

// ---------------------------------------------------------------------------
// Pooled instanced particle system.
//
// Every system here is GPU simulated: the CPU writes 24 floats once at spawn
// and the vertex shader evaluates the trajectory from age. The alternative,
// CPU integration with a per-frame upload, was rejected for all of these
// because they are all pure ballistic-plus-drag motion with no collision
// response beyond the floor clamp, so there is nothing the CPU knows that the
// closed form does not. The two places that genuinely need CPU state are the
// decal field (persistent, mutated over a whole round) and the fist trails
// (they must follow a bone that only the CPU can query), and those live in
// their own modules.
// ---------------------------------------------------------------------------
export class ParticleSystem {
  constructor(scene, shared, opts) {
    this.capacity = Math.max(8, opts.capacity | 0);
    this.cursor = 0;
    this.high = 0;
    this.time = 0;
    this.dirtyLo = Infinity;
    this.dirtyHi = -Infinity;

    this.data = new Float32Array(this.capacity * FLOATS);
    this.death = new Float32Array(this.capacity); // for the alive-range scan

    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('position', new THREE.Float32BufferAttribute(
      [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));

    // One interleaved buffer, seven views. A single upload per dirty frame.
    this.buffer = new THREE.InstancedInterleavedBuffer(this.data, FLOATS);
    this.buffer.setUsage(THREE.DynamicDrawUsage);
    const A = (name, size, offset) =>
      geo.setAttribute(name, new THREE.InterleavedBufferAttribute(this.buffer, size, offset));
    A('aPos', 3, 0);
    A('aVel', 3, 3);
    A('aLife', 4, 6);
    A('aDyn', 4, 10);
    A('aColor', 3, 14);
    A('aColor2', 3, 17);
    A('aExtra', 4, 20);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const defines = { [opts.mode]: '' };
    if (opts.stretch) defines.STRETCH = '';
    if (opts.floorStick) defines.FLOOR_STICK = '';
    if (opts.ringGround) defines.RING_GROUND = '';

    const mat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: shared,
      defines,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: opts.doubleSided ? THREE.DoubleSide : THREE.FrontSide
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = opts.renderOrder ?? 10;
    this.mesh.matrixAutoUpdate = false;
    scene.add(this.mesh);
    this.geo = geo;
    this.mat = mat;
  }

  spawn(s) {
    const i = this.cursor;
    this.cursor = (i + 1) % this.capacity;
    const o = i * FLOATS;
    const d = this.data;
    d[o] = s.x; d[o + 1] = s.y; d[o + 2] = s.z;
    d[o + 3] = s.vx; d[o + 4] = s.vy; d[o + 5] = s.vz;
    d[o + 6] = this.time; d[o + 7] = s.life; d[o + 8] = s.seed; d[o + 9] = s.sizeA;
    d[o + 10] = s.gravity; d[o + 11] = s.drag; d[o + 12] = s.sizeB; d[o + 13] = s.spin;
    d[o + 14] = s.r; d[o + 15] = s.g; d[o + 16] = s.b;
    d[o + 17] = s.r2; d[o + 18] = s.g2; d[o + 19] = s.b2;
    d[o + 20] = s.opacity; d[o + 21] = s.bright; d[o + 22] = s.stretch; d[o + 23] = s.flutter;
    this.death[i] = this.time + s.life;
    if (i < this.dirtyLo) this.dirtyLo = i;
    if (i > this.dirtyHi) this.dirtyHi = i;
    if (i >= this.high) this.high = i + 1;
  }

  update(dt) {
    this.time += dt;
    if (this.dirtyHi >= this.dirtyLo) {
      const b = this.buffer;
      if (b.addUpdateRange) {
        b.clearUpdateRanges();
        b.addUpdateRange(this.dirtyLo * FLOATS, (this.dirtyHi - this.dirtyLo + 1) * FLOATS);
      }
      b.needsUpdate = true;
      this.dirtyLo = Infinity;
      this.dirtyHi = -Infinity;
    }
    // Shrink the draw call back down once the tail of the ring has died. A
    // float compare per slot is nothing next to rasterising a dead quad.
    let hi = 0;
    for (let i = 0; i < this.high; i++) if (this.death[i] > this.time) hi = i + 1;
    this.high = hi;
    this.geo.instanceCount = hi;
  }

  clear() {
    this.death.fill(-1);
    this.high = 0;
    this.geo.instanceCount = 0;
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------------------
// Palettes. Sampled from the arena's own neon set so particles sit in the same
// colour world as the room without importing world/arena.js.
// ---------------------------------------------------------------------------
const PAL = {
  sweatA: new THREE.Color('#b9d6f5'), sweatB: new THREE.Color('#ffffff'),
  bloodA: new THREE.Color('#5e0c14'), bloodB: new THREE.Color('#b8323c'),
  bloodMist: new THREE.Color('#3a0a10'),
  beerA: new THREE.Color('#c87b08'), beerB: new THREE.Color('#ffd775'),
  foamA: new THREE.Color('#fff3da'), foamB: new THREE.Color('#ffe2ae'),
  sparkA: new THREE.Color('#ff7a18'), sparkB: new THREE.Color('#fffdf0'),
  dustA: new THREE.Color('#5a5f72'), dustB: new THREE.Color('#1b1e2b'),
  smokeA: new THREE.Color('#41465a'), smokeB: new THREE.Color('#14161f'),
  glassA: new THREE.Color('#9ad8c6'), glassB: new THREE.Color('#e8fffb'),
  ringA: new THREE.Color('#9fb6ff'), ringB: new THREE.Color('#ffffff'),
  flashA: new THREE.Color('#ffb04a'), flashB: new THREE.Color('#fffaf0')
};

const CONFETTI = [
  ['#ff2a6d', '#8e0b34'], ['#05d9e8', '#046b78'], ['#f9c80e', '#8a6a04'],
  ['#9d4edd', '#4a1d70'], ['#ffffff', '#9aa6c8'], ['#3ef58b', '#12703f'],
  ['#ff8a1f', '#8a3d05']
];

// ---------------------------------------------------------------------------
export class VFX {
  constructor(ctx) {
    this.scene = ctx.scene;
    this.camera = ctx.camera;
    this.renderer = ctx.renderer;
    this.quality = ctx.quality || {};
    this.floorY = ctx.floorY ?? 0;
    this.time = 0;
    this.enabled = true;

    const budget = clamp(this.quality.particleBudget ?? 8000, 600, 60000);
    const share = (f, lo, hi) => clamp(Math.round(budget * f), lo, hi);

    // A 1x1 stand-in so the depth sampler is always bound even before the
    // render owner hands us a real depth target.
    this._nullDepth = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this._nullDepth.needsUpdate = true;

    this.shared = {
      uTime: { value: 0 },
      uFloorY: { value: this.floorY },
      uScale: { value: 1 },
      uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
      uKeyColor: { value: new THREE.Color() },
      uFillDir: { value: new THREE.Vector3(0, 1, 0) },
      uFillColor: { value: new THREE.Color() },
      uRimDirA: { value: new THREE.Vector3(1, 0, 0) },
      uRimColA: { value: new THREE.Color() },
      uRimDirB: { value: new THREE.Vector3(-1, 0, 0) },
      uRimColB: { value: new THREE.Color() },
      uAmbient: { value: new THREE.Color() },
      uDepth: { value: this._nullDepth },
      uHasDepth: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uCamNear: { value: 0.1 },
      uCamFar: { value: 120 },
      uSoftness: { value: 0.55 }
    };

    // World-space light rig, mirrored from arena.js. Transformed into view
    // space once per frame in update().
    this.light = {
      keyDir: new THREE.Vector3(4, 9, 4).normalize(),
      keyColor: new THREE.Color('#fff2e0').multiplyScalar(0.95),
      fillDir: new THREE.Vector3(-6, 5, -7).normalize(),
      fillColor: new THREE.Color('#4e7bff').multiplyScalar(0.55),
      rimDirA: new THREE.Vector3(0.75, 0.40, 0.52).normalize(),
      rimColA: new THREE.Color('#ff2a6d').multiplyScalar(0.85),
      rimDirB: new THREE.Vector3(-0.70, 0.36, -0.62).normalize(),
      rimColB: new THREE.Color('#05d9e8').multiplyScalar(0.85),
      ambient: new THREE.Color('#2a3050').multiplyScalar(0.55)
    };

    const sys = (name, o) => (this.sys[name] = new ParticleSystem(this.scene, this.shared, o));
    this.sys = {};
    // Sweat, blood and beer all share one liquid pool: identical material
    // state, per particle colour, so three effects cost one draw call.
    sys('liquid', { mode: 'MODE_LIQUID', capacity: share(0.30, 200, 6000), stretch: true, floorStick: true, renderOrder: 12 });
    sys('smoke', { mode: 'MODE_SMOKE', capacity: share(0.14, 90, 2400), floorStick: true, renderOrder: 9 });
    sys('spark', { mode: 'MODE_ADDITIVE', capacity: share(0.22, 150, 4000), stretch: true, additive: true, renderOrder: 16 });
    sys('confetti', { mode: 'MODE_FLAKE', capacity: share(0.16, 120, 2600), doubleSided: true, renderOrder: 11 });
    sys('glass', { mode: 'MODE_SHARD', capacity: share(0.08, 60, 1200), doubleSided: true, floorStick: true, renderOrder: 13 });
    sys('flash', { mode: 'MODE_FLASH', capacity: 64, additive: true, renderOrder: 18 });
    sys('ringCam', { mode: 'MODE_RING', capacity: 32, additive: true, renderOrder: 17 });
    sys('ringFloor', { mode: 'MODE_RING', capacity: 32, additive: true, ringGround: true, renderOrder: 17 });

    this.decals = new DecalField(this.scene, {
      capacity: clamp(Math.round(budget / 48), 32, 220),
      floorY: this.floorY,
      light: this.light
    });
    this.trails = new TrailRig(this.scene, this.light);
    this.impacts = new Impacts(this);

    this._emitters = {
      sweat: this._sweat, blood: this._blood, beer: this._beer,
      spark: this._spark, dust: this._dust, smoke: this._smoke,
      confetti: this._confetti, glass: this._glass,
      shockwave: this._shockwave, impactFlash: this._impactFlash,
      splash: this._beer
    };

    this._onResize = () => this._syncResolution();
    window.addEventListener('resize', this._onResize);
    this._syncResolution();
  }

  _syncResolution() {
    if (!this.renderer) return;
    this.renderer.getDrawingBufferSize(this.shared.uResolution.value);
  }

  // The render owner calls this once a depth target exists. Until then the
  // shader falls back to the analytic floor fade.
  // TODO(RENDER): postfx.js currently exposes no depth texture. Wire
  // 'vfx.setDepthTexture(post.depthTexture, camera.near, camera.far)' the
  // moment the depth prepass lands and soft particles become exact.
  setDepthTexture(texture, near, far) {
    this.shared.uDepth.value = texture || this._nullDepth;
    this.shared.uHasDepth.value = texture ? 1 : 0;
    if (near != null) this.shared.uCamNear.value = near;
    if (far != null) this.shared.uCamFar.value = far;
  }

  setLighting(o) {
    Object.assign(this.light, o);
  }

  setFloorY(y) {
    this.floorY = y;
    this.shared.uFloorY.value = y;
    this.decals.floorY = y;
  }

  trackFighter(fighter) { this.trails.track(fighter); }

  // -------------------------------------------------------------------------
  // emit(type, position, dir, opts). Zero allocations: every emitter fills the
  // shared S record and hands it to a pool.
  // -------------------------------------------------------------------------
  emit(type, position, dir, opts) {
    if (!this.enabled) return;
    const fn = this._emitters[type];
    if (!fn) return;
    const px = position?.x ?? 0, py = position?.y ?? 0, pz = position?.z ?? 0;
    let dx = dir?.x ?? 0, dy = dir?.y ?? 1, dz = dir?.z ?? 0;
    if (dx * dx + dy * dy + dz * dz < 1e-8) { dx = 0; dy = 1; dz = 0; }
    fn.call(this, px, py, pz, dx, dy, dz, opts || EMPTY);
  }

  _sweat(px, py, pz, dx, dy, dz, o) {
    const power = o.power ?? 1;
    const n = Math.round((o.count ?? 11) * clamp(power, 0.35, 2.2));
    basis(dx, dy, dz);
    for (let i = 0; i < n; i++) {
      const d = cone(o.spread ?? 1.05);
      const sp = rng.range(1.4, 4.4) * power;
      S.x = px + d.x * 0.04; S.y = py + d.y * 0.04; S.z = pz + d.z * 0.04;
      S.vx = d.x * sp; S.vy = d.y * sp + rng.range(0.6, 2.1); S.vz = d.z * sp;
      S.life = rng.range(0.45, 0.95);
      S.seed = rng();
      S.sizeA = rng.range(0.010, 0.023); S.sizeB = S.sizeA * 0.75;
      S.gravity = 12.5; S.drag = 1.15; S.spin = 0;
      S.r = PAL.sweatA.r; S.g = PAL.sweatA.g; S.b = PAL.sweatA.b;
      S.r2 = PAL.sweatB.r; S.g2 = PAL.sweatB.g; S.b2 = PAL.sweatB.b;
      S.opacity = 0.9; S.bright = 1.15; S.stretch = 0.045; S.flutter = 0;
      this.sys.liquid.spawn(S);
      if (i % 4 === 0) this._scheduleSplat(S, 'sweat', rng.range(0.05, 0.10), PAL.sweatA, 0.30);
    }
  }

  _blood(px, py, pz, dx, dy, dz, o) {
    // Party brawler, not a gore game: a handful of dark droplets plus one
    // short mist puff, no fountain.
    const power = clamp(o.power ?? 1, 0.4, 2.0);
    const n = Math.round((o.count ?? 7) * power);
    basis(dx, dy, dz);
    for (let i = 0; i < n; i++) {
      const d = cone(0.78);
      const sp = rng.range(1.8, 5.2) * power;
      S.x = px; S.y = py; S.z = pz;
      S.vx = d.x * sp; S.vy = d.y * sp + rng.range(0.3, 1.6); S.vz = d.z * sp;
      S.life = rng.range(0.55, 1.05);
      S.seed = rng();
      S.sizeA = rng.range(0.012, 0.031); S.sizeB = S.sizeA * 0.8;
      S.gravity = 14.5; S.drag = 1.25; S.spin = 0;
      S.r = PAL.bloodA.r; S.g = PAL.bloodA.g; S.b = PAL.bloodA.b;
      S.r2 = PAL.bloodB.r; S.g2 = PAL.bloodB.g; S.b2 = PAL.bloodB.b;
      S.opacity = 0.95; S.bright = 0.95; S.stretch = 0.10; S.flutter = 0;
      this.sys.liquid.spawn(S);
      if (i % 3 === 0) this._scheduleSplat(S, 'blood', rng.range(0.07, 0.15), PAL.bloodA, 0.95);
    }
    for (let i = 0; i < 3; i++) {
      const d = cone(1.0);
      S.x = px + d.x * 0.05; S.y = py + d.y * 0.05; S.z = pz + d.z * 0.05;
      S.vx = d.x * 1.1; S.vy = d.y * 1.1 + 0.3; S.vz = d.z * 1.1;
      S.life = rng.range(0.35, 0.6);
      S.seed = rng();
      S.sizeA = rng.range(0.05, 0.10); S.sizeB = S.sizeA * 2.4;
      S.gravity = 0.8; S.drag = 4.2; S.spin = rng.range(-2, 2);
      S.r = PAL.bloodMist.r; S.g = PAL.bloodMist.g; S.b = PAL.bloodMist.b;
      S.r2 = PAL.bloodB.r; S.g2 = PAL.bloodB.g; S.b2 = PAL.bloodB.b;
      S.opacity = 0.42; S.bright = 0.9; S.stretch = 0; S.flutter = 0.02;
      this.sys.smoke.spawn(S);
    }
  }

  // The signature effect. Four layers: heavy droplets, velocity stretched
  // strands, a fine mist that hangs, and a foam head that lingers and spreads.
  // Plus glints so the neon actually catches the liquid, and a puddle decal.
  _beer(px, py, pz, dx, dy, dz, o) {
    const power = clamp(o.power ?? 1, 0.35, 2.4);
    basis(dx, dy, dz);
    const nDrop = Math.round((o.count ?? 24) * power);

    for (let i = 0; i < nDrop; i++) {
      const d = cone(o.spread ?? 0.62);
      const sp = rng.range(2.0, 6.0) * power;
      S.x = px + d.x * 0.05; S.y = py + d.y * 0.05; S.z = pz + d.z * 0.05;
      S.vx = d.x * sp; S.vy = d.y * sp + rng.range(0.4, 1.8); S.vz = d.z * sp;
      S.life = rng.range(0.6, 1.35);
      S.seed = rng();
      S.sizeA = rng.range(0.012, 0.036); S.sizeB = S.sizeA * 0.85;
      S.gravity = 11.5; S.drag = 0.95; S.spin = 0;
      S.r = PAL.beerA.r; S.g = PAL.beerA.g; S.b = PAL.beerA.b;
      S.r2 = PAL.beerB.r; S.g2 = PAL.beerB.g; S.b2 = PAL.beerB.b;
      S.opacity = 0.93; S.bright = 1.75; S.stretch = 0.075; S.flutter = 0;
      this.sys.liquid.spawn(S);
      if (i % 5 === 0) this._scheduleSplat(S, 'beer', rng.range(0.14, 0.30), PAL.beerA, 0.65);
    }

    // Strands: the same liquid but long lived and heavily stretched, which is
    // what makes a pour read as a rope of liquid rather than a bead shower.
    for (let i = 0; i < 8; i++) {
      const d = cone(0.30);
      const sp = rng.range(4.5, 9.0) * power;
      S.x = px; S.y = py; S.z = pz;
      S.vx = d.x * sp; S.vy = d.y * sp + 0.8; S.vz = d.z * sp;
      S.life = rng.range(0.42, 0.78);
      S.seed = rng();
      S.sizeA = rng.range(0.020, 0.038); S.sizeB = S.sizeA * 0.5;
      S.gravity = 10.0; S.drag = 0.7; S.spin = 0;
      S.r = PAL.beerA.r; S.g = PAL.beerA.g; S.b = PAL.beerA.b;
      S.r2 = PAL.beerB.r; S.g2 = PAL.beerB.g; S.b2 = PAL.beerB.b;
      S.opacity = 0.8; S.bright = 1.9; S.stretch = 0.22; S.flutter = 0;
      this.sys.liquid.spawn(S);
    }

    // Atomised mist.
    for (let i = 0; i < 14; i++) {
      const d = cone(1.15);
      const sp = rng.range(0.8, 3.2) * power;
      S.x = px; S.y = py; S.z = pz;
      S.vx = d.x * sp; S.vy = d.y * sp + 0.5; S.vz = d.z * sp;
      S.life = rng.range(0.35, 0.7);
      S.seed = rng();
      S.sizeA = rng.range(0.005, 0.012); S.sizeB = S.sizeA;
      S.gravity = 6.0; S.drag = 2.8; S.spin = 0;
      S.r = PAL.beerB.r; S.g = PAL.beerB.g; S.b = PAL.beerB.b;
      S.r2 = PAL.foamA.r; S.g2 = PAL.foamA.g; S.b2 = PAL.foamA.b;
      S.opacity = 0.55; S.bright = 1.5; S.stretch = 0.02; S.flutter = 0.015;
      this.sys.liquid.spawn(S);
    }

    // Foam head.
    for (let i = 0; i < 11; i++) {
      const d = cone(0.95);
      const sp = rng.range(0.5, 2.4) * power;
      S.x = px + d.x * 0.06; S.y = py + d.y * 0.06; S.z = pz + d.z * 0.06;
      S.vx = d.x * sp; S.vy = d.y * sp + rng.range(0.2, 0.9); S.vz = d.z * sp;
      S.life = rng.range(0.85, 1.6);
      S.seed = rng();
      S.sizeA = rng.range(0.035, 0.075); S.sizeB = S.sizeA * rng.range(2.0, 3.2);
      S.gravity = 1.4; S.drag = 3.1; S.spin = rng.range(-1.6, 1.6);
      S.r = PAL.foamA.r; S.g = PAL.foamA.g; S.b = PAL.foamA.b;
      S.r2 = PAL.foamB.r; S.g2 = PAL.foamB.g; S.b2 = PAL.foamB.b;
      S.opacity = 0.72; S.bright = 1.25; S.stretch = 0; S.flutter = 0.035;
      this.sys.smoke.spawn(S);
    }

    // Glints: tiny additive sparkles riding with the spray so the bloom pass
    // has something above threshold to grab. This is what sells "liquid".
    for (let i = 0; i < 7; i++) {
      const d = cone(0.75);
      const sp = rng.range(1.6, 5.0) * power;
      S.x = px; S.y = py; S.z = pz;
      S.vx = d.x * sp; S.vy = d.y * sp + 0.9; S.vz = d.z * sp;
      S.life = rng.range(0.25, 0.55);
      S.seed = rng();
      S.sizeA = rng.range(0.014, 0.028); S.sizeB = S.sizeA * 0.35;
      S.gravity = 11.0; S.drag = 1.0; S.spin = 0;
      S.r = PAL.beerB.r; S.g = PAL.beerB.g; S.b = PAL.beerB.b;
      S.r2 = 1; S.g2 = 0.97; S.b2 = 0.86;
      S.opacity = 0.9; S.bright = 1.8; S.stretch = 0.03; S.flutter = 0;
      this.sys.spark.spawn(S);
    }
  }

  _spark(px, py, pz, dx, dy, dz, o) {
    const power = clamp(o.power ?? 1, 0.3, 2.5);
    const n = Math.round((o.count ?? 18) * power);
    basis(dx, dy, dz);
    _col.set(o.color ?? PAL.sparkA);
    for (let i = 0; i < n; i++) {
      const d = cone(o.spread ?? 1.3);
      const sp = rng.range(3.5, 11.0) * power;
      S.x = px; S.y = py; S.z = pz;
      S.vx = d.x * sp; S.vy = d.y * sp + rng.range(0, 2.0); S.vz = d.z * sp;
      S.life = rng.range(0.16, 0.48);
      S.seed = rng();
      S.sizeA = rng.range(0.010, 0.022); S.sizeB = 0.003;
      S.gravity = 16.0; S.drag = 1.5; S.spin = 0;
      S.r = _col.r; S.g = _col.g; S.b = _col.b;
      S.r2 = PAL.sparkB.r; S.g2 = PAL.sparkB.g; S.b2 = PAL.sparkB.b;
      S.opacity = 1; S.bright = 2.8; S.stretch = 0.055; S.flutter = 0;
      this.sys.spark.spawn(S);
    }
  }

  _dust(px, py, pz, dx, dy, dz, o) {
    const power = clamp(o.power ?? 1, 0.25, 2.5);
    const n = Math.round((o.count ?? 7) * power);
    basis(dx, dy, dz);
    for (let i = 0; i < n; i++) {
      const d = cone(1.35);
      const sp = rng.range(0.35, 1.7) * power;
      S.x = px + d.x * 0.08; S.y = py + Math.abs(d.y) * 0.03; S.z = pz + d.z * 0.08;
      S.vx = d.x * sp; S.vy = Math.abs(d.y) * sp * 0.5 + 0.25; S.vz = d.z * sp;
      S.life = rng.range(0.7, 1.4);
      S.seed = rng();
      S.sizeA = rng.range(0.08, 0.16); S.sizeB = S.sizeA * rng.range(2.4, 3.8);
      S.gravity = 0.45; S.drag = 3.0; S.spin = rng.range(-1.2, 1.2);
      S.r = PAL.dustA.r; S.g = PAL.dustA.g; S.b = PAL.dustA.b;
      S.r2 = PAL.dustB.r; S.g2 = PAL.dustB.g; S.b2 = PAL.dustB.b;
      S.opacity = (o.opacity ?? 0.34) * power; S.bright = 1.0; S.stretch = 0; S.flutter = 0.03;
      this.sys.smoke.spawn(S);
    }
  }

  _smoke(px, py, pz, dx, dy, dz, o) {
    const power = clamp(o.power ?? 1, 0.25, 2.5);
    const n = Math.round((o.count ?? 6) * power);
    basis(dx, dy, dz);
    for (let i = 0; i < n; i++) {
      const d = cone(1.0);
      const sp = rng.range(0.2, 1.1) * power;
      S.x = px + d.x * 0.12; S.y = py; S.z = pz + d.z * 0.12;
      S.vx = d.x * sp; S.vy = rng.range(0.25, 0.8); S.vz = d.z * sp;
      S.life = rng.range(1.5, 2.8);
      S.seed = rng();
      S.sizeA = rng.range(0.18, 0.34); S.sizeB = S.sizeA * rng.range(2.6, 4.2);
      S.gravity = -0.35; S.drag = 2.1; S.spin = rng.range(-0.7, 0.7);
      S.r = PAL.smokeA.r; S.g = PAL.smokeA.g; S.b = PAL.smokeA.b;
      S.r2 = PAL.smokeB.r; S.g2 = PAL.smokeB.g; S.b2 = PAL.smokeB.b;
      S.opacity = o.opacity ?? 0.28; S.bright = 1.0; S.stretch = 0; S.flutter = 0.05;
      this.sys.smoke.spawn(S);
    }
  }

  _confetti(px, py, pz, dx, dy, dz, o) {
    const power = clamp(o.power ?? 1, 0.3, 2.5);
    const n = Math.round((o.count ?? 90) * power);
    basis(dx, dy, dz);
    for (let i = 0; i < n; i++) {
      const d = cone(o.spread ?? 0.95);
      const sp = rng.range(2.5, 8.0) * power;
      const pair = CONFETTI[rng.int(0, CONFETTI.length - 1)];
      _col.set(pair[0]); _col2.set(pair[1]);
      S.x = px + rng.gauss(0, 0.12); S.y = py + rng.gauss(0, 0.12); S.z = pz + rng.gauss(0, 0.12);
      S.vx = d.x * sp; S.vy = d.y * sp + rng.range(0.5, 2.5); S.vz = d.z * sp;
      S.life = rng.range(3.2, 6.5);
      S.seed = rng();
      S.sizeA = rng.range(0.028, 0.055); S.sizeB = S.sizeA;
      // High drag plus flutter: terminal velocity near 1.2 m/s so the flakes
      // hang and drift instead of dropping like gravel.
      S.gravity = 3.4; S.drag = 2.6; S.spin = rng.range(3.5, 12.0) * rng.sign();
      S.r = _col.r; S.g = _col.g; S.b = _col.b;
      S.r2 = _col2.r; S.g2 = _col2.g; S.b2 = _col2.b;
      S.opacity = 1; S.bright = 1.15; S.stretch = 0; S.flutter = rng.range(0.08, 0.22);
      this.sys.confetti.spawn(S);
    }
  }

  _glass(px, py, pz, dx, dy, dz, o) {
    const power = clamp(o.power ?? 1, 0.3, 2.2);
    const n = Math.round((o.count ?? 22) * power);
    basis(dx, dy, dz);
    for (let i = 0; i < n; i++) {
      const d = cone(o.spread ?? 1.25);
      const sp = rng.range(1.8, 7.0) * power;
      S.x = px; S.y = py; S.z = pz;
      S.vx = d.x * sp; S.vy = d.y * sp + rng.range(0.5, 2.8); S.vz = d.z * sp;
      S.life = rng.range(0.9, 1.9);
      S.seed = rng();
      S.sizeA = rng.range(0.014, 0.042); S.sizeB = S.sizeA;
      S.gravity = 15.0; S.drag = 0.55; S.spin = rng.range(7, 20) * rng.sign();
      S.r = PAL.glassA.r; S.g = PAL.glassA.g; S.b = PAL.glassA.b;
      S.r2 = PAL.glassB.r; S.g2 = PAL.glassB.g; S.b2 = PAL.glassB.b;
      S.opacity = 1; S.bright = 1.25; S.stretch = 0; S.flutter = 0;
      this.sys.glass.spawn(S);
      if (i % 6 === 0) this._scheduleSplat(S, 'glass', rng.range(0.10, 0.20), PAL.glassA, 0.7);
    }
    this._spark(px, py, pz, dx, dy, dz, GLASS_SPARK);
  }

  _shockwave(px, py, pz, dx, dy, dz, o) {
    this.impacts.shockwave(px, py, pz, dx, dy, dz, o);
  }

  _impactFlash(px, py, pz, dx, dy, dz, o) {
    this.impacts.flash(px, py, pz, dx, dy, dz, o);
  }

  // Ballistic landing point, no drag. Only ever used to pick where and when a
  // decal appears, so the small error against the drag solution is invisible.
  _scheduleSplat(s, kind, size, color, alpha) {
    const g = Math.max(s.gravity, 0.001);
    const h = s.y - this.floorY;
    const disc = s.vy * s.vy + 2 * g * h;
    if (disc < 0) return;
    const t = (s.vy + Math.sqrt(disc)) / g;
    if (t > s.life * 2.2 || t > 2.5) return;
    this.decals.schedule(s.x + s.vx * t, s.z + s.vz * t, t, kind, size, color, alpha);
  }

  // -------------------------------------------------------------------------
  update(dt, cameraPosition) {
    if (!(dt > 0)) dt = 0;
    this.time += dt;
    this.shared.uTime.value = this.time;

    // Light vectors into view space once, shared by every system.
    const vm = this.camera.matrixWorldInverse;
    const L = this.light, U = this.shared;
    U.uKeyDir.value.copy(L.keyDir).transformDirection(vm);
    U.uFillDir.value.copy(L.fillDir).transformDirection(vm);
    U.uRimDirA.value.copy(L.rimDirA).transformDirection(vm);
    U.uRimDirB.value.copy(L.rimDirB).transformDirection(vm);
    U.uKeyColor.value.copy(L.keyColor);
    U.uFillColor.value.copy(L.fillColor);
    U.uRimColA.value.copy(L.rimColA);
    U.uRimColB.value.copy(L.rimColB);
    U.uAmbient.value.copy(L.ambient);
    U.uCamNear.value = this.camera.near;
    U.uCamFar.value = this.camera.far;

    for (const k in this.sys) this.sys[k].update(dt);
    this.decals.update(dt);
    this.trails.update(dt, cameraPosition || this.camera.position, this);
  }

  clear() {
    for (const k in this.sys) this.sys[k].clear();
    this.decals.clear();
    this.trails.clear();
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    for (const k in this.sys) this.sys[k].dispose();
    this.decals.dispose();
    this.trails.dispose();
    this._nullDepth.dispose();
  }
}

const EMPTY = Object.freeze({});
const GLASS_SPARK = Object.freeze({ count: 6, power: 0.8, spread: 1.4, color: '#bff5ff' });
