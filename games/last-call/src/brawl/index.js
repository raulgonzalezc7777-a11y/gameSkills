import * as THREE from 'three';
import { BrawlWorld, GROUP } from './world.js';
import { ActiveRagdoll } from './ragdoll.js';
import { BRAWL } from '../core/config.js';
import { bus, EV } from '../core/events.js';
import { rng } from '../core/rng.js';

export { BrawlWorld, ActiveRagdoll, GROUP };

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _dir = new THREE.Vector3();

// Wires the physics to the fight: hits become impulses, knockdowns become
// launches, knockouts become sacks of potatoes, and drink becomes wobble.
export class Brawl {
  constructor(arena, fighters) {
    this.physics = new BrawlWorld(arena);
    this.fighters = fighters;
    fighters.forEach((f, i) => {
      f.ragdoll = new ActiveRagdoll(f, this.physics, i === 0 ? GROUP.A : GROUP.B);
    });

    this._offs = [
      bus.on(EV.HIT_LANDED, (p) => this.onHit(p, 1)),
      bus.on(EV.HIT_BLOCKED, (p) => this.onHit(p, 0.3)),
      bus.on(EV.KNOCKDOWN, (p) => this.onDown(p, BRAWL.knockdownLaunch, 2.2)),
      bus.on(EV.KO, (p) => this.onDown(p, BRAWL.koLaunch, Infinity))
    ];
  }

  // Direction from attacker to target on the floor, tipped upward, which is
  // the direction everything in a cartoon fight gets hit.
  pushDir(attacker, target, lift, out) {
    const ra = attacker?.ragdoll, rt = target.ragdoll;
    if (ra?.built) ra.pelvisPosition(_a); else _a.copy(attacker?.position ?? target.position);
    if (rt?.built) rt.pelvisPosition(_b); else _b.copy(target.position);
    out.copy(_b).sub(_a).setY(0);
    if (out.lengthSq() < 1e-6) out.set(Math.sin(target.facing ?? 0), 0, Math.cos(target.facing ?? 0)).negate();
    out.normalize();
    out.y = lift;
    return out.normalize();
  }

  onHit(p, scale) {
    const t = p.target, r = t?.ragdoll;
    if (!r?.built) return;
    const name = p.move?.name || p.cfg?.name || '';
    const lift = name === 'uppercut' ? 1.1 : name === 'kick' ? 0.2 : 0.3;
    this.pushDir(p.attacker, t, lift, _dir);
    const dmg = (p.damage || 6) * scale;
    const point = p.point || t.position;
    r.strike(point, _dir, dmg * BRAWL.hitImpulse);
    r.hurt(0.18 + dmg * 0.025);
    if (scale >= 1 && dmg >= BRAWL.heavyHit) {
      const v = dmg * BRAWL.launchPerDamage;
      r.launch(_dir.x * v, Math.max(1.2, _dir.y * v), _dir.z * v, 2);
      bus.emit('brawl:launch', { fighter: t, power: dmg });
    }
  }

  onDown(p, launch, limp) {
    const t = p.fighter, r = t?.ragdoll;
    if (!r?.built) return;
    r.goLimp(limp);
    this.pushDir(p.by, t, 0, _dir);
    r.launch(_dir.x * launch[0], launch[1], _dir.z * launch[0], limp === Infinity ? 7 : 4);
  }

  step(dt) {
    for (const f of this.fighters) {
      const r = f.ragdoll;
      if (!r?.built) continue;
      // Keep the physics limp timer in step with the fighter's own state.
      if (f.dead) r.limp = Infinity;
      else if (r.limp === Infinity) r.limp = 0;
      if (f.downed > 0 && !f.dead) r.limp = Math.max(r.limp, f.downed);
      r.preStep(dt, f.drunk01 ?? 0, BRAWL);
    }
    this.physics.step(dt);
    for (const f of this.fighters) {
      const r = f.ragdoll;
      if (!r?.built) continue;
      const ev = r.postStep(dt, f.drunk01 ?? 0, BRAWL);
      if (ev === 'fell' && !f.dead && !(f.downed > 0)) {
        f.goDown?.(1.9, 'fell');
        r.goLimp(1.9);
        bus.emit(EV.STUMBLE, { fighter: f, fell: true });
        bus.emit('brawl:fell', { fighter: f });
      } else if (ev === 'hiccup') {
        bus.emit('brawl:hiccup', { fighter: f });
        bus.emit(EV.SFX, { name: 'hiccup', position: f.position });
      }
    }
  }

  dispose() { this._offs.forEach((o) => o()); this.fighters.forEach((f) => f.ragdoll?.dispose()); }
}
