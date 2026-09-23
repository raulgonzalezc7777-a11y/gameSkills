import * as THREE from 'three';
import { rng } from '../core/rng.js';
import { CFG } from '../core/config.js';
import { clamp01, lerp, TAU } from '../core/math.js';
import { TEX } from '../render/texlib.js';

// The rig. In a club the lighting is the art direction, so this file carries
// more of the look than the geometry does: one shadowing key on the fight, two
// coloured rims from opposite sides, sweeping moving heads, and the cheap
// beautiful trick that sells the whole room, additive cone meshes standing in
// for volumetric shafts.

const PINK = 0xff2a6d;
const CYAN = 0x05d9e8;
const GOLD = 0xf9c80e;
const VIOLET = 0x9d4edd;

// ------------------------------------------------------------ light shaft ---

const SHAFT_VS = /* glsl */`
varying vec2 vUvS;
varying vec3 vNrm;
varying vec3 vView;
void main() {
  vUvS = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNrm = normalize(normalMatrix * normal);
  vView = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

// The cone shell is shaded by how much of it the eye looks through: head on
// through the axis is a long path and reads bright, grazing the silhouette is
// a short path and reads as the soft edge of the beam. Two scrolling noise
// octaves give the haze inside the beam its churn.
const SHAFT_FS = /* glsl */`
precision highp float;
varying vec2 vUvS;
varying vec3 vNrm;
varying vec3 vView;
uniform vec3 uColor;
uniform float uTime;
uniform float uIntensity;
uniform float uSoft;

float h21(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = h21(i), b = h21(i + vec2(1.0, 0.0));
  float c = h21(i + vec2(0.0, 1.0)), d = h21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  float ndv = abs(dot(normalize(vNrm), normalize(vView)));
  float thickness = pow(ndv, uSoft);
  // vUvS.y is 0 at the cone mouth and 1 at the lamp, so the beam falls off
  // with distance from the source the way a real one does.
  float along = mix(0.06, 1.0, pow(vUvS.y, 1.7));
  float n = vnoise(vec2(vUvS.x * 7.0, vUvS.y * 2.2 - uTime * 0.14));
  n = n * 0.62 + vnoise(vec2(vUvS.x * 15.0 + 3.1, vUvS.y * 4.5 - uTime * 0.27)) * 0.38;
  float a = thickness * along * (0.45 + n * 0.85) * uIntensity;
  gl_FragColor = vec4(uColor * a, a);
}`;

function makeShaft(radius, height, color, intensity, soft) {
  // Open-ended so the eye never catches a lid on the beam, and deliberately
  // longer than the drop so its mouth is buried under the floor.
  const geo = new THREE.ConeGeometry(radius, height, 24, 1, true);
  geo.translate(0, -height * 0.5, 0);
  const mat = new THREE.ShaderMaterial({
    vertexShader: SHAFT_VS,
    fragmentShader: SHAFT_FS,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uTime: { value: 0 },
      uIntensity: { value: intensity },
      uSoft: { value: soft }
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.FrontSide,
    fog: false
  });
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = 6;
  m.frustumCulled = false;
  return m;
}

// ------------------------------------------------------------- dust motes ---

const DUST_VS = /* glsl */`
attribute vec3 aDrift;
attribute vec2 aMote;
varying float vFade;
uniform float uTime;
uniform float uCeil;
void main() {
  vec3 p = position;
  p.y = mod(p.y + uTime * aDrift.y, uCeil);
  p.x += sin(uTime * aDrift.x + aMote.x) * 0.42;
  p.z += cos(uTime * aDrift.z + aMote.x * 1.7) * 0.42;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  // Dust is dust: a few pixels. An earlier revision used a 260 multiplier,
  // which turned 900 motes into 900 full-screen alpha blobs and cost more
  // fill rate than the entire rest of the venue put together.
  gl_PointSize = clamp(aMote.y * (9.0 / max(0.4, -mv.z)), 1.0, 7.0);
  // Motes fade out as they climb, so the loop back to the floor never pops.
  vFade = smoothstep(0.0, 0.25, p.y / uCeil) * (1.0 - smoothstep(0.62, 1.0, p.y / uCeil));
  gl_Position = projectionMatrix * mv;
}`;

const DUST_FS = /* glsl */`
precision mediump float;
varying float vFade;
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float f = clamp(1.0 - dot(d, d) * 4.0, 0.0, 1.0);
  gl_FragColor = vec4(uColor, f * f * vFade * uOpacity);
}`;

// ------------------------------------------------------------------- haze ---

function hazeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 256, 256);
  // Layered soft blobs read as drifting smoke once two of these slide over
  // each other at different speeds.
  for (let i = 0; i < 90; i++) {
    const x = rng.range(0, 256), y = rng.range(0, 256), r = rng.range(18, 70);
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const a = rng.range(0.03, 0.1);
    grd.addColorStop(0, `rgba(255,255,255,${a})`);
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// ------------------------------------------------------------------- rig ----

export class Lighting {
  constructor(group, room, quality = {}) {
    this.group = group;
    this.room = room;
    this.shafts = [];
    this.heads = [];
    this.neonLights = [];
    this.hazeLayers = [];

    const G = new THREE.Group();
    this.rigGroup = G;
    group.add(G);

    // Ambient floor: just enough bounce that pure black never sits on screen.
    const hemi = new THREE.HemisphereLight(0x3d2a55, 0x140d1c, 1.15);
    G.add(hemi);
    this.hemi = hemi;

    // Key: the one shadowing light. Hung off the truss, aimed at the fight.
    const key = new THREE.SpotLight(0xfff0dc, 120, 26, 0.46, 0.62, 1.55);
    key.position.set(0.6, room.h - 0.55, 1.4);
    key.target.position.set(0, 1.05, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(CFG.render.shadowMapSize, CFG.render.shadowMapSize);
    key.shadow.camera.near = 1.2;
    key.shadow.camera.far = 24;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.026;
    key.shadow.radius = 2.4;
    G.add(key, key.target);
    this.key = key;

    // Rims from opposite sides in the palette the HUD already uses. These are
    // what separate a sweaty fighter from a black room.
    const rimA = new THREE.SpotLight(PINK, 165, 30, 0.95, 0.85, 1.4);
    rimA.position.set(-3.4, 3.9, -room.hz + 1.2);
    rimA.target.position.set(0.5, 1.1, 1.0);
    G.add(rimA, rimA.target);

    const rimB = new THREE.SpotLight(CYAN, 165, 30, 0.95, 0.85, 1.4);
    rimB.position.set(3.4, 3.9, room.hz - 1.2);
    rimB.target.position.set(-0.5, 1.1, -1.0);
    G.add(rimB, rimB.target);

    // A second shadow caster sells contact under the fighters without the cost
    // of a third: a tight overhead that only ever sees the dance floor.
    const fill = new THREE.SpotLight(0xbfa6ff, 70, 18, 0.9, 1.0, 1.7);
    fill.position.set(-2.0, room.h - 0.9, -2.4);
    fill.target.position.set(0, 0.9, 0);
    G.add(fill, fill.target);
    this.rims = [
      { light: rimA, base: 165, phase: 0.0 },
      { light: rimB, base: 165, phase: 0.5 },
      { light: fill, base: 70, phase: 0.25 }
    ];

    // Static truss beams: geometry only, no extra GPU lights. Four cones of
    // additive haze read as four par cans for the price of four draw calls.
    const beamColors = [PINK, CYAN, GOLD, VIOLET, 0xffffff, PINK];
    const beamX = [-7.5, -3.6, 0.2, 3.9, 7.6, -0.4];
    for (let i = 0; i < 6; i++) {
      const z = i % 2 === 0 ? -4.4 : 4.4;
      const drop = room.h - 0.75;
      const shaft = makeShaft(2.2, drop + 1.4, beamColors[i], 0.5, 1.35);
      shaft.position.set(beamX[i], drop, z);
      shaft.rotation.x = (z < 0 ? 1 : -1) * 0.2;
      G.add(shaft);
      this.shafts.push({ mesh: shaft, base: 0.5, phase: rng.range(0, TAU), spin: 0 });
      // The lamp lens itself, so the source of every beam is visible.
      const lens = new THREE.Mesh(
        new THREE.CircleGeometry(0.17, 12),
        new THREE.MeshBasicMaterial({ color: beamColors[i], fog: false })
      );
      lens.position.set(beamX[i], drop - 0.02, z);
      lens.rotation.x = -Math.PI / 2;
      G.add(lens);
      this.shafts[this.shafts.length - 1].lens = lens;
    }

    // Moving heads: two real spotlights that sweep the crowd, each wearing its
    // own shaft so you can see where the beam is going.
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const pivot = new THREE.Group();
      pivot.position.set(side * 5.6, room.h - 0.6, side * 3.0);
      G.add(pivot);
      const shaft = makeShaft(1.35, 15, i === 0 ? VIOLET : CYAN, 0.62, 1.6);
      pivot.add(shaft);
      const light = new THREE.SpotLight(i === 0 ? VIOLET : CYAN, 110, 22, 0.16, 0.65, 1.5);
      light.position.copy(pivot.position);
      const target = new THREE.Object3D();
      G.add(light, target);
      light.target = target;
      this.heads.push({
        pivot, shaft, light, target, side,
        phase: i * 1.7, speed: 0.34 + i * 0.09
      });
      this.shafts.push({ mesh: shaft, base: 0.62, phase: rng.range(0, TAU) });
    }

    // Neon accent points. Unshadowed and short range, they exist to bounce the
    // sign and strip colours onto nearby plaster.
    const accents = [
      { c: PINK, p: [0, 3.0, room.hz - 0.5] },
      { c: CYAN, p: [-room.hx + 1.2, 2.4, 0] },
      { c: GOLD, p: [room.hx - 1.0, 2.6, -2.5] },
      { c: VIOLET, p: [room.hx - 1.0, 2.6, 3.0] }
    ];
    for (const a of accents) {
      const pl = new THREE.PointLight(a.c, 70, 16, 2);
      pl.position.set(a.p[0], a.p[1], a.p[2]);
      G.add(pl);
      this.neonLights.push({ light: pl, base: 70, phase: rng.range(0, TAU) });
    }

    // Follow spot. The truss key lights the room; this one lights the fight,
    // and it tracks. Without it a fighter who steps off the centre mark
    // becomes a dark cutout against a very bright floor.
    const follow = new THREE.SpotLight(0xfff4e6, 105, 22, 0.58, 0.72, 1.35);
    follow.position.set(0, room.h - 0.3, 2.2);
    follow.target.position.set(0, 1.0, 0);
    follow.castShadow = true;
    follow.shadow.mapSize.set(CFG.render.shadowMapSize, CFG.render.shadowMapSize);
    follow.shadow.camera.near = 1.0;
    follow.shadow.camera.far = 20;
    follow.shadow.bias = -0.0005;
    follow.shadow.normalBias = 0.02;
    follow.shadow.radius = 2.0;
    G.add(follow, follow.target);
    this.follow = follow;

    // A cool back light opposite the follow, so the silhouette separates from
    // the floor instead of merging into it.
    const back = new THREE.SpotLight(0x8fc6ff, 120, 20, 0.72, 0.8, 1.4);
    back.position.set(-1.2, 3.6, -4.4);
    back.target.position.set(0, 1.2, 0);
    G.add(back, back.target);
    this.backLight = back;

    this._buildHaze(room);
    this._buildDust(room, quality);
  }

  _buildHaze(room) {
    const tex = hazeTexture();
    const geo = new THREE.PlaneGeometry(room.hx * 2.4, room.hz * 2.4);
    geo.rotateX(-Math.PI / 2);
    // Three slow-drifting sheets at different heights give the air body
    // without the cost of a real volumetric.
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: tex.clone(),
        color: new THREE.Color().lerpColors(new THREE.Color(0x2a1030), new THREE.Color(0x1a2e42), i / 2),
        transparent: true,
        opacity: 0.16 - i * 0.03,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
        side: THREE.DoubleSide
      });
      mat.map.repeat.set(1.6, 1.6);
      mat.map.needsUpdate = true;
      const m = new THREE.Mesh(geo, mat);
      m.position.y = 0.75 + i * 1.25;
      m.renderOrder = 4;
      m.frustumCulled = false;
      this.rigGroup.add(m);
      this.hazeLayers.push({ mesh: m, speed: 0.008 + i * 0.005, dir: i % 2 === 0 ? 1 : -1 });
    }
  }

  _buildDust(room, quality) {
    const count = quality.particleBudget > 6000 ? 900 : 380;
    const pos = new Float32Array(count * 3);
    const drift = new Float32Array(count * 3);
    const mote = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      // Two thirds of the motes live inside the beam columns, because dust you
      // cannot see in a light shaft is dust nobody renders.
      const inBeam = rng.chance(0.66);
      const x = inBeam ? rng.pick([-7.5, -3.6, 0.2, 3.9, 7.6]) + rng.gauss(0, 1.1)
        : rng.range(-room.hx + 0.5, room.hx - 0.5);
      const z = inBeam ? rng.pick([-4.4, 4.4]) + rng.gauss(0, 1.3)
        : rng.range(-room.hz + 0.5, room.hz - 0.5);
      pos[i * 3] = x;
      pos[i * 3 + 1] = rng.range(0, room.h);
      pos[i * 3 + 2] = z;
      drift[i * 3] = rng.range(0.15, 0.5);
      drift[i * 3 + 1] = rng.range(0.035, 0.14);
      drift[i * 3 + 2] = rng.range(0.15, 0.5);
      mote[i * 2] = rng.range(0, TAU);
      mote[i * 2 + 1] = rng.range(0.7, 2.6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aDrift', new THREE.BufferAttribute(drift, 3));
    geo.setAttribute('aMote', new THREE.BufferAttribute(mote, 2));
    this.dustUniforms = {
      uTime: { value: 0 },
      uCeil: { value: room.h },
      uColor: { value: new THREE.Color(0xffd9f0) },
      uOpacity: { value: 0.55 }
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: DUST_VS, fragmentShader: DUST_FS, uniforms: this.dustUniforms,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 7;
    this.rigGroup.add(pts);
    this.dust = pts;
  }

  // 'pulse' is the sharp on-beat spike, 'energy' the slow-moving excitement of
  // the match, both supplied by the arena so every system agrees on the music.
  // Called by the arena each frame with the point the fight is happening at.
  setFocus(x, y, z) {
    this.follow.target.position.set(x, y, z);
    this.follow.position.set(x * 0.35, this.room.h - 0.3, z * 0.35 + 2.2);
    this.backLight.target.position.set(x, y + 0.2, z);
    this.backLight.position.set(x * 0.4 - 1.2, 3.6, z * 0.4 - 4.4);
  }

  update(dt, t, beat, pulse, energy) {
    const hype = clamp01(energy);
    this.follow.intensity = 105 * (0.88 + pulse * 0.2) + hype * 20;
    this.backLight.intensity = 120 * (0.8 + pulse * 0.3);

    this.key.intensity = 120 * (0.82 + pulse * 0.34) + hype * 24;
    for (let i = 0; i < this.rims.length; i++) {
      const r = this.rims[i];
      const s = Math.sin((beat + r.phase) * Math.PI);
      r.light.intensity = r.base * (0.55 + Math.abs(s) * 0.75 + pulse * 0.5);
    }

    for (let i = 0; i < this.shafts.length; i++) {
      const s = this.shafts[i];
      const flick = 0.72 + Math.sin(t * 1.7 + s.phase) * 0.16 + pulse * 0.5;
      s.mesh.material.uniforms.uIntensity.value = s.base * flick * (0.85 + hype * 0.5);
      s.mesh.material.uniforms.uTime.value = t;
    }

    for (let i = 0; i < this.heads.length; i++) {
      const h = this.heads[i];
      const a = t * h.speed + h.phase;
      // Sweep across the crowd on the far side, tilting as it goes.
      const yaw = Math.sin(a) * 0.85;
      const tilt = 0.62 + Math.sin(a * 1.7 + 1.1) * 0.3;
      h.pivot.rotation.set(tilt * -h.side, yaw, 0, 'YXZ');
      const dir = _dir.set(0, -1, 0).applyEuler(h.pivot.rotation);
      h.target.position.copy(h.pivot.position).addScaledVector(dir, 14);
      h.light.intensity = 110 * (0.6 + pulse * 0.7) * (0.7 + hype * 0.6);
    }

    for (let i = 0; i < this.neonLights.length; i++) {
      const n = this.neonLights[i];
      n.light.intensity = n.base * (0.7 + Math.sin(t * 2.3 + n.phase) * 0.12 + pulse * 0.45);
    }

    for (let i = 0; i < this.hazeLayers.length; i++) {
      const h = this.hazeLayers[i];
      const m = h.mesh.material.map;
      m.offset.x = (t * h.speed * h.dir) % 1;
      m.offset.y = (t * h.speed * 0.6) % 1;
    }

    this.dustUniforms.uTime.value = t;
    this.dustUniforms.uOpacity.value = 0.42 + pulse * 0.28;
  }

  dispose() {
    this.rigGroup.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
  }
}

// Module-level scratch so update() never allocates.
const _dir = new THREE.Vector3();
