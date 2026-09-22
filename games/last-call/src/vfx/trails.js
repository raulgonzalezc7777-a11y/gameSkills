import * as THREE from 'three';
import { clamp01 } from '../core/math.js';

// Fist trails. A ribbon that follows each hand, fading along its length and
// flaring on a connect. In a fighting game this is the read that tells you a
// punch actually travelled, and it is close to free: one strip mesh per hand,
// rewritten from a small ring buffer of world positions each frame.
const SEGMENTS = 14;
const MIN_SPEED = 3.2;    // metres per second before a trail shows at all

const VERT = /* glsl */`
attribute float aAlong;
attribute float aSide;
varying float vAlong;
varying float vSide;
void main() {
  vAlong = aAlong;
  vSide = aSide;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */`
precision highp float;
varying float vAlong;
varying float vSide;
uniform vec3 uColorNear;
uniform vec3 uColorFar;
uniform float uStrength;
void main() {
  // Soft across the ribbon, tapering to nothing at the tail.
  float across = 1.0 - abs(vSide);
  float along = pow(1.0 - vAlong, 1.6);
  float a = across * across * along * uStrength;
  if (a <= 0.004) discard;
  vec3 col = mix(uColorNear, uColorFar, vAlong);
  gl_FragColor = vec4(col * (0.6 + along * 1.8), a);
}`;

class Ribbon {
  constructor(scene, color) {
    this.points = new Float32Array(SEGMENTS * 3);
    this.filled = 0;
    this.strength = 0;

    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(SEGMENTS * 2 * 3);
    const along = new Float32Array(SEGMENTS * 2);
    const side = new Float32Array(SEGMENTS * 2);
    const idx = [];
    for (let i = 0; i < SEGMENTS; i++) {
      along[i * 2] = along[i * 2 + 1] = i / (SEGMENTS - 1);
      side[i * 2] = -1; side[i * 2 + 1] = 1;
      if (i < SEGMENTS - 1) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.uniforms = {
      uColorNear: { value: new THREE.Color(color.near) },
      uColorFar: { value: new THREE.Color(color.far) },
      uStrength: { value: 0 }
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms,
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 15;
    this.mesh.matrixAutoUpdate = false;
    scene.add(this.mesh);
    this.geo = geo;
    this.mat = mat;
    this.scene = scene;
  }

  push(x, y, z) {
    // Shift the ring down by one and write the newest sample at the head.
    const p = this.points;
    for (let i = SEGMENTS - 1; i > 0; i--) {
      p[i * 3] = p[(i - 1) * 3];
      p[i * 3 + 1] = p[(i - 1) * 3 + 1];
      p[i * 3 + 2] = p[(i - 1) * 3 + 2];
    }
    p[0] = x; p[1] = y; p[2] = z;
    if (this.filled < SEGMENTS) this.filled++;
  }

  reset(x, y, z) {
    for (let i = 0; i < SEGMENTS; i++) {
      this.points[i * 3] = x; this.points[i * 3 + 1] = y; this.points[i * 3 + 2] = z;
    }
    this.filled = SEGMENTS;
  }

  // The ribbon is built in world space and billboarded by crossing the path
  // direction with the view vector, so it stays edge-on to nothing.
  build(camPos, width) {
    const p = this.points, out = this.positions;
    for (let i = 0; i < SEGMENTS; i++) {
      const o = i * 3;
      const x = p[o], y = p[o + 1], z = p[o + 2];
      const n = Math.min(i + 1, SEGMENTS - 1) * 3;
      const q = Math.max(i - 1, 0) * 3;
      let dx = p[q] - p[n], dy = p[q + 1] - p[n + 1], dz = p[q + 2] - p[n + 2];
      let dl = Math.hypot(dx, dy, dz);
      if (dl < 1e-5) { dx = 0; dy = 1; dz = 0; dl = 1; }
      dx /= dl; dy /= dl; dz /= dl;
      let vx = x - camPos.x, vy = y - camPos.y, vz = z - camPos.z;
      const vl = Math.hypot(vx, vy, vz) || 1;
      vx /= vl; vy /= vl; vz /= vl;
      // side = dir x view
      let sx = dy * vz - dz * vy, sy = dz * vx - dx * vz, sz = dx * vy - dy * vx;
      const sl = Math.hypot(sx, sy, sz) || 1;
      const w = width * (1 - i / SEGMENTS) * 0.5;
      sx = (sx / sl) * w; sy = (sy / sl) * w; sz = (sz / sl) * w;
      const a = i * 6;
      out[a] = x - sx; out[a + 1] = y - sy; out[a + 2] = z - sz;
      out[a + 3] = x + sx; out[a + 4] = y + sy; out[a + 5] = z + sz;
    }
    this.geo.attributes.position.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
  }
}

export class TrailRig {
  constructor(scene, light) {
    this.scene = scene;
    this.light = light;
    this.tracked = [];
    this._v = new THREE.Vector3();
    this._prev = new THREE.Vector3();
  }

  track(fighter) {
    if (!fighter?.rig?.bones) return;
    const colors = {
      L: { near: '#fff0d6', far: '#ff2a6d' },
      R: { near: '#eaf7ff', far: '#05d9e8' }
    };
    const entry = { fighter, hands: [] };
    for (const s of ['L', 'R']) {
      const bone = fighter.rig.bones['hand' + s];
      if (!bone) continue;
      entry.hands.push({
        bone,
        ribbon: new Ribbon(this.scene, colors[s]),
        last: new THREE.Vector3(),
        primed: false
      });
    }
    this.tracked.push(entry);
    return entry;
  }

  untrack(fighter) {
    const i = this.tracked.findIndex((t) => t.fighter === fighter);
    if (i < 0) return;
    this.tracked[i].hands.forEach((h) => h.ribbon.dispose());
    this.tracked.splice(i, 1);
  }

  update(dt, camPos, vfx) {
    if (dt <= 0) return;
    for (let t = 0; t < this.tracked.length; t++) {
      const entry = this.tracked[t];
      const f = entry.fighter;
      const attacking = !!f.attacking;
      for (let h = 0; h < entry.hands.length; h++) {
        const hand = entry.hands[h];
        hand.bone.getWorldPosition(this._v);

        if (!hand.primed) { hand.ribbon.reset(this._v.x, this._v.y, this._v.z); hand.primed = true; }
        this._prev.copy(hand.last);
        hand.last.copy(this._v);
        const speed = this._prev.distanceTo(this._v) / dt;

        hand.ribbon.push(this._v.x, this._v.y, this._v.z);

        // A trail only exists while the hand is genuinely moving fast. Showing
        // one on an idle guard is the single most common way this effect ends
        // up looking like a toy.
        const want = attacking ? clamp01((speed - MIN_SPEED) / 9) : 0;
        hand.ribbon.strength += (want - hand.ribbon.strength) * Math.min(1, dt * (want > hand.ribbon.strength ? 22 : 7));
        hand.ribbon.uniforms.uStrength.value = hand.ribbon.strength * 0.9;
        hand.ribbon.mesh.visible = hand.ribbon.strength > 0.01;
        if (hand.ribbon.mesh.visible) hand.ribbon.build(camPos, 0.19 + hand.ribbon.strength * 0.14);
      }
    }
  }

  clear() {
    for (const t of this.tracked) for (const h of t.hands) h.primed = false;
  }

  dispose() {
    for (const t of this.tracked) for (const h of t.hands) h.ribbon.dispose();
    this.tracked.length = 0;
  }
}
