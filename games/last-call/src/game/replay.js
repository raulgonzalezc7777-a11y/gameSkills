import * as THREE from 'three';

// Instant replay. While a bout runs, the last few seconds of everything you
// can see are kept in a ring buffer: each fighter's root and its twelve
// ragdoll bodies (the skeleton is written from those, so they are the whole
// pose), the junk on the floor, and the camera. When the bout ends on a
// knockout the buffer is played back at half speed with a slow orbit, which
// is the clip people send to each other.
//
// Nothing is simulated during playback: the stored transforms are written
// straight back and the bones are rebuilt from them.

const HZ = 30;                 // stored frames per second
const SECONDS = 4.5;
const FRAMES = HZ * SECONDS;

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

export class ReplayRecorder {
  constructor(match) {
    this.match = match;
    this.stride = 0;
  }

  reset() {
    const m = this.match;
    const bodies = (f) => f?.ragdoll?.segs?.length || 0;
    this.nf = [bodies(m.player), bodies(m.cpu)];
    this.nd = m.brawl?.debris?.items?.length || 0;
    // Per frame: 2 x (root xyz + yaw + bodies x 7) + debris x 8 + camera 6.
    this.stride = 2 * 4 + (this.nf[0] + this.nf[1]) * 7 + this.nd * 8 + 6;
    this.buf = new Float32Array(this.stride * FRAMES);
    this.count = 0;
    this.head = 0;
    this.acc = 0;
  }

  // Called every simulation step.
  record(dt) {
    // The ragdolls are built on the fighters' first update, so the layout is
    // fixed on the first frame that has them, not when the recorder is made.
    const m0 = this.match, built = m0.player?.ragdoll?.built && m0.cpu?.ragdoll?.built;
    if (!built) return;
    if (!this.stride) this.reset();
    this.acc += dt;
    if (this.acc < 1 / HZ) return;
    this.acc -= 1 / HZ;
    const m = this.match, b = this.buf;
    let o = this.head * this.stride;
    for (const f of [m.player, m.cpu]) {
      b[o++] = f.position.x; b[o++] = f.position.y; b[o++] = f.position.z; b[o++] = f.object.rotation.y;
      for (const s of f.ragdoll?.segs || []) {
        const p = s.body.position, q = s.body.quaternion;
        b[o++] = p.x; b[o++] = p.y; b[o++] = p.z; b[o++] = q.x; b[o++] = q.y; b[o++] = q.z; b[o++] = q.w;
      }
    }
    for (const it of m.brawl?.debris?.items || []) {
      const t = it.mesh;
      b[o++] = t.position.x; b[o++] = t.position.y; b[o++] = t.position.z;
      b[o++] = t.quaternion.x; b[o++] = t.quaternion.y; b[o++] = t.quaternion.z; b[o++] = t.quaternion.w;
      b[o++] = t.visible ? 1 : 0;
    }
    const c = m.tpcam;
    b[o++] = c.pos.x; b[o++] = c.pos.y; b[o++] = c.pos.z; b[o++] = c.look.x; b[o++] = c.look.y; b[o++] = c.look.z;
    this.head = (this.head + 1) % FRAMES;
    this.count = Math.min(FRAMES, this.count + 1);
  }

  get length() { return this.count / HZ; }

  // Writes frame i (0 = oldest kept) back into the scene.
  apply(i) {
    const m = this.match, b = this.buf;
    i = Math.max(0, Math.min(this.count - 1, Math.floor(i)));
    const idx = (this.head - this.count + i + FRAMES) % FRAMES;
    let o = idx * this.stride;
    for (const f of [m.player, m.cpu]) {
      f.position.set(b[o], b[o + 1], b[o + 2]); f.object.rotation.y = b[o + 3]; o += 4;
      f.object.updateMatrixWorld(true);
      for (const s of f.ragdoll?.segs || []) {
        s.body.position.set(b[o], b[o + 1], b[o + 2]);
        s.body.quaternion.set(b[o + 3], b[o + 4], b[o + 5], b[o + 6]);
        o += 7;
      }
      f.ragdoll?.writeBones();
    }
    for (const it of m.brawl?.debris?.items || []) {
      it.mesh.position.set(b[o], b[o + 1], b[o + 2]);
      it.mesh.quaternion.set(b[o + 3], b[o + 4], b[o + 5], b[o + 6]);
      it.mesh.visible = b[o + 7] > 0.5;
      o += 8;
    }
    return { pos: _v.set(b[o], b[o + 1], b[o + 2]), look: new THREE.Vector3(b[o + 3], b[o + 4], b[o + 5]) };
  }
}

// Plays the buffer back: half speed, a slow orbit around the fight, and a
// push in on the knockout at the end.
export class ReplayPlayer {
  constructor(recorder, camera) {
    this.rec = recorder;
    this.camera = camera;
    this.active = false;
  }

  // Speed ramp: real time on the way in, deep slow motion around the
  // knockout (which sits 'peakFromEnd' seconds before the end of the
  // buffer), and a little faster again for the landing.
  start({ peakFromEnd = 1.6, onEnd } = {}) {
    if (!(this.rec.count >= 10)) { onEnd?.(); return false; }
    this.active = true;
    this.t = 0;
    this.src = 0;
    this.len = this.rec.length;
    this.peak = Math.max(0, this.len - peakFromEnd);
    this.dur = this._duration();
    this.onEnd = onEnd;
    this.spin = Math.random() < 0.5 ? 1 : -1;
    this.baseFov = this.camera.fov;
    return true;
  }

  speedAt(src) {
    const d = src - this.peak;
    if (d > -0.55 && d < 0.75) return 0.3;
    return d < 0 ? 0.95 : 0.6;
  }

  _duration() {
    let s = 0, t = 0;
    while (s < this.len && t < 30) { s += (1 / 60) * this.speedAt(s); t += 1 / 60; }
    return t;
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    const cb = this.onEnd; this.onEnd = null;
    cb?.();
  }

  update(dt) {
    if (!this.active) return;
    this.t += dt;
    this.src = Math.min(this.len, this.src + dt * this.speedAt(this.src));
    const k = Math.min(1, this.t / this.dur);
    const frame = this.rec.apply((this.src / this.len) * (this.rec.count - 1));
    // Orbit around where the stored camera was looking, drifting a quarter
    // turn over the replay and closing in for the last beat.
    const look = frame.look;
    const off = _v.copy(frame.pos).sub(look);
    // Closer and lower than the fight camera: a replay is about the bodies.
    const dist = Math.max(2.4, Math.min(5.5, off.length() * 0.72) * (1 - 0.3 * k * k));
    const yaw = Math.atan2(off.x, off.z) + this.spin * (k * 0.9);
    const h = Math.max(0.7, Math.min(2.2, off.y * 0.6) * (1 - 0.3 * k));
    this.camera.position.set(look.x + Math.sin(yaw) * dist, look.y + h, look.z + Math.cos(yaw) * dist);
    this.camera.lookAt(look.x, look.y - 0.1, look.z);
    this.camera.fov = this.baseFov * (1 - 0.18 * k);
    this.camera.updateProjectionMatrix();
    if (this.src >= this.len) this.stop();
  }
}
