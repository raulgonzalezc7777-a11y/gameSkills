import * as THREE from 'three';
import { BrawlWorld, GROUP } from './world.js';
import { ActiveRagdoll } from './ragdoll.js';
import { Debris } from './debris.js';
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
    this.arena = arena;
    this.fighters = fighters;
    fighters.forEach((f, i) => {
      f.ragdoll = new ActiveRagdoll(f, this.physics, i === 0 ? GROUP.A : GROUP.B);
    });
    this.debris = new Debris(this.physics, arena, fighters);

    this._offs = [
      bus.on(EV.HIT_LANDED, (p) => this.onHit(p, 1)),
      bus.on(EV.HIT_BLOCKED, (p) => this.onHit(p, 0.3)),
      bus.on(EV.KNOCKDOWN, (p) => this.onDown(p, BRAWL.knockdownLaunch, 2.2)),
      bus.on(EV.KO, (p) => this.onDown(p, BRAWL.koLaunch, Infinity)),
      bus.on(EV.HIT_WHIFF, (p) => this.onWhiff(p)),
      bus.on(EV.DRINK, (p) => this.onDrink(p)),
      bus.on('brawl:clonk', (p) => { if (p.type !== 'bottle') bus.emit(EV.SFX, { name: 'headhit', position: p.point, volume: 0.8 }); })
    ];
    this._later = [];
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

  // A drunk swing at nothing turns the whole body with it. Sober fighters
  // barely notice; a blind drunk corkscrews and sometimes goes down.
  onWhiff(p) {
    const f = p?.fighter, r = f?.ragdoll;
    if (!r?.built || p.dodged || f.dead) return;
    const d = f.drunk01 ?? 0;
    if (d < 0.3) return;
    const fx = Math.sin(f.facing ?? 0), fz = Math.cos(f.facing ?? 0);
    r.spin(fx, fz, (d - 0.3) * BRAWL.whiffSpin);
    if (d > 0.55) bus.emit('brawl:whiff', { fighter: f });
  }

  // Every drink ends in a belch a beat later, and the belch rocks you back.
  onDrink(p) {
    const f = p?.fighter;
    if (!f) return;
    this._later.push({ t: 0.85, fn: () => {
      if (f.dead) return;
      const r = f.ragdoll;
      const fx = Math.sin(f.facing ?? 0), fz = Math.cos(f.facing ?? 0);
      r?.lean(-fx, -fz, BRAWL.burpLean * (0.6 + (f.drunk01 ?? 0)));
      r?.hurt(0.3);
      bus.emit(EV.SFX, { name: 'burp', position: f.position });
      bus.emit('brawl:burp', { fighter: f });
    } });
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
    this.containAll(dt);
    for (const f of this.fighters) {
      const r = f.ragdoll;
      if (!r?.built) continue;
      const ev = r.postStep(dt, f.drunk01 ?? 0, BRAWL);
      if (ev === 'fell' && !f.dead && !(f.downed > 0)) {
        f.goDown?.(1.1, 'fell');
        r.goLimp(1.1);
        bus.emit(EV.STUMBLE, { fighter: f, fell: true });
        bus.emit('brawl:fell', { fighter: f });
      } else if (ev === 'hiccup') {
        bus.emit('brawl:hiccup', { fighter: f });
        bus.emit(EV.SFX, { name: 'hiccup', position: f.position });
      }
    }
    this.debris.postStep(dt);
    for (let i = this._later.length - 1; i >= 0; i--) {
      const l = this._later[i];
      if ((l.t -= dt) <= 0) { this._later.splice(i, 1); l.fn(); }
    }
  }

  // Nothing leaves the ring: every body is held inside the ropes, and a
  // fighter who slams into them makes them flash and the crowd shout.
  containAll(dt) {
    const P = this.physics;
    for (const f of this.fighters) {
      const r = f.ragdoll;
      if (!r?.built) continue;
      let hit = 0;
      for (const s of r.segs) hit = Math.max(hit, P.contain(s.body, 0.12));
      r._ropeCd = Math.max(0, (r._ropeCd || 0) - dt);
      if (hit > 3 && r._ropeCd <= 0) {
        r._ropeCd = 1;
        this.arena?.flashRopes?.(Math.min(1.5, hit / 6));
        bus.emit('brawl:ropes', { fighter: f, speed: hit });
        bus.emit(EV.SFX, { name: 'bodyfall', position: f.position, volume: Math.min(1, hit / 8) });
      }
    }
    for (const it of this.debris.items) if (it.alive) P.contain(it.body, 0.3);
  }

  dispose() { this._offs.forEach((o) => o()); this.debris?.dispose(); this.fighters.forEach((f) => f.ragdoll?.dispose()); }
}
