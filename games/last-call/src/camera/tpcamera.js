import * as THREE from 'three';
import { CFG } from '../core/config.js';
import { clamp, damp, expDamp, dampAngle, lerp, wrapAngle } from '../core/math.js';
import { bus, EV } from '../core/events.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _mid = new THREE.Vector3(), _dir = new THREE.Vector3();

// Duel camera: frames two fighters, orbits behind the player, collides with the
// arena, and shakes on impact. The CAMERA owner extends this with cinematic
// KO cameras, replays and dynamic composition.
export class TPCamera {
  constructor(camera, ctx = {}) {
    this.camera = camera;
    this.arena = ctx.arena;
    this.yaw = 0; this.pitch = 0.08;
    this.dist = CFG.camera.distance;
    this.fov = CFG.camera.fov;
    this.shake = 0; this.shakeFreq = 34;
    this.kick = new THREE.Vector3();
    this.drunk = 0;
    this.pos = new THREE.Vector3(0, 2, 6);
    this.look = new THREE.Vector3(0, 1.4, 0);
    this._t = 0;
    // Photo mode. The capture harness and any future replay camera need to
    // pin framing values that update() otherwise recomputes every frame,
    // which is exactly the trap that made an earlier shot list silently
    // photograph the default framing while claiming to be a close-up.
    this.override = null;
    bus.on(EV.CAMERA_SHAKE, (amt) => { this.shake = Math.min(1.4, this.shake + amt); });
    bus.on(EV.CAMERA_KICK, (v) => { this.kick.add(v); });
  }

  setTargets(a, b) { this.a = a; this.b = b; }

  update(dt, lookInput = { x: 0, y: 0 }) {
    this._t += dt;
    const A = this.a, B = this.b;
    if (!A) return;

    // Targets are the fighters' physical pelvises, supplied by the match, so
    // a body sent flying stays in frame instead of leaving its root behind.
    _a.copy(A); _a.y += 0.45;
    if (B) { _b.copy(B); _b.y += 0.45; } else _b.copy(_a);
    _mid.copy(_a).lerp(_b, 0.5);
    const sep = _a.distanceTo(_b);

    // Side-on fighting-game framing. The camera sits most of the way round to
    // the side of the line between the fighters, so both bodies, the gap
    // between them and every flailing limb read in profile; a small bias
    // toward the player's back keeps "forward" meaning toward the opponent.
    // There are two mirror-image sides; the camera keeps whichever it is on
    // and only swaps when the other is much closer, so it never flips when
    // the fighters trade places mid-exchange.
    _dir.copy(_b).sub(_a);
    const duelYaw = Math.atan2(_dir.x, _dir.z);
    const off = CFG.camera.orbitOffset;
    const yA = duelYaw + Math.PI + off, yB = duelYaw + Math.PI - off;
    const dA = Math.abs(wrapAngle(yA - this.yaw)), dB = Math.abs(wrapAngle(yB - this.yaw));
    if (this._side === undefined) this._side = dA <= dB ? 1 : -1;
    else if (this._side === 1 && dB + 0.6 < dA) this._side = -1;
    else if (this._side === -1 && dA + 0.6 < dB) this._side = 1;
    const wantYaw = this._side === 1 ? yA : yB;
    this.yaw = dampAngle(this.yaw, wantYaw, 3.2, dt) + lookInput.x * dt * 2.4;
    this.pitch = clamp(expDamp(this.pitch, CFG.camera.pitch, 2, dt) + lookInput.y * dt * 1.6, -0.2, 0.6);

    // Pull back as the fighters separate or one goes airborne, so a launch is
    // a wide shot of the whole arc rather than two bodies leaving frame.
    const air = Math.max(0, Math.max(_a.y, _b.y) - 1.6);
    const wantDist = clamp(CFG.camera.distance + sep * 0.62 + air * 1.2, CFG.camera.distance, 10.5);
    this.dist = expDamp(this.dist, wantDist, 3.2, dt);
    const wantFov = CFG.camera.fov + clamp(sep * 0.8, 0, 8);
    this.fov = expDamp(this.fov, wantFov, 4.0, dt);

    if (this.override) {
      const o = this.override;
      if (o.dist !== undefined) this.dist = o.dist;
      if (o.pitch !== undefined) this.pitch = o.pitch;
      if (o.yaw !== undefined) this.yaw = o.yaw;
      if (o.fov !== undefined) this.fov = o.fov;
    }

    const sinP = Math.sin(this.pitch), cosP = Math.cos(this.pitch);
    _c.set(
      _mid.x + Math.sin(this.yaw) * cosP * this.dist,
      _mid.y + sinP * this.dist + CFG.camera.height,
      _mid.z + Math.cos(this.yaw) * cosP * this.dist
    );

    // Keep the camera inside the venue. The room is a 9.6 by 7.4 rectangle
    // with a 4.7 ceiling, so a single radius clamp both over-restricted the
    // long axis and let the camera climb straight through the roof, where a
    // BackSide ceiling plane filled the frustum with unlit black.
    if (this.arena) {
      const room = this.arena.room;
      if (room) {
        _c.x = clamp(_c.x, -room.hx + 0.5, room.hx - 0.5);
        _c.z = clamp(_c.z, -room.hz + 0.5, room.hz - 0.5);
        // Stay under the truss. Up among the lamps, a pulled-out camera put a
        // blown lens the size of a door in the foreground.
        _c.y = clamp(_c.y, 0.65, room.h - 1.25);
      } else {
        const r = Math.hypot(_c.x, _c.z);
        const lim = (this.arena.radius ?? 8) + 1.6;
        if (r > lim) { _c.x *= lim / r; _c.z *= lim / r; }
        _c.y = clamp(_c.y, 0.65, 4.2);
      }
    }

    this.pos.copy(_c);
    this.look.copy(_mid);

    // Impact shake: decaying noise with a hard directional kick.
    this.shake = expDamp(this.shake, 0, 6.5, dt);
    const s = this.shake * this.shake;
    const n = (f, p) => Math.sin(this._t * f + p) * Math.sin(this._t * f * 1.7 + p * 2.3);
    this.kick.multiplyScalar(Math.exp(-14 * dt));

    // Drunk sway: slow, wide, nauseating. Drives the post FX warp too.
    const d = this.drunk;
    const swayX = Math.sin(this._t * 0.63) * 0.16 * d + Math.sin(this._t * 0.27) * 0.09 * d;
    const swayY = Math.sin(this._t * 0.41 + 1.7) * 0.10 * d;
    const roll = Math.sin(this._t * 0.35) * 0.11 * d + n(21, 0.7) * s * 0.06;

    this.camera.position.set(
      this.pos.x + n(this.shakeFreq, 0) * s * 0.28 + this.kick.x + swayX,
      this.pos.y + n(this.shakeFreq * 1.31, 2.1) * s * 0.22 + this.kick.y + swayY,
      this.pos.z + n(this.shakeFreq * 0.87, 4.3) * s * 0.28 + this.kick.z
    );
    this.camera.lookAt(this.look.x + swayX * 0.4, this.look.y + swayY * 0.3, this.look.z);
    this.camera.rotation.z += roll;
    this.camera.fov = this.fov + s * 3.2;
    this.camera.updateProjectionMatrix();
  }
}
