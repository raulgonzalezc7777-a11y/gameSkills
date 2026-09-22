import * as THREE from 'three';
import { buildFighter } from '../characters/builder.js';
import { RigPoser } from '../anim/rigposer.js';
import { CFG } from '../core/config.js';
import { clamp, clamp01, damp, expDamp, dampAngle, lerp, wrapAngle } from '../core/math.js';
import { bus, EV } from '../core/events.js';
import { rng } from '../core/rng.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3();

export const PARTS = ['head', 'body', 'legs'];

// Attack table. 'reach' is metres from the chest, 'startup'/'active' are frames
// of a 60 Hz budget expressed in seconds.
export const ATTACKS = {
  jab:      { dmg: 6,  startup: 0.09, active: 0.07, recover: 0.16, reach: 1.30, stam: 6,  push: 1.4, part: 'head' },
  cross:    { dmg: 11, startup: 0.14, active: 0.08, recover: 0.24, reach: 1.42, stam: 10, push: 2.6, part: 'head' },
  hook:     { dmg: 14, startup: 0.17, active: 0.09, recover: 0.28, reach: 1.24, stam: 13, push: 3.1, part: 'head' },
  uppercut: { dmg: 18, startup: 0.21, active: 0.10, recover: 0.34, reach: 1.12, stam: 17, push: 3.8, part: 'head' },
  kick:     { dmg: 15, startup: 0.20, active: 0.10, recover: 0.32, reach: 1.62, stam: 15, push: 3.4, part: 'body' }
};

export class Fighter {
  constructor(spec, ctx) {
    this.spec = spec;
    this.rig = buildFighter(spec);
    this.poser = new RigPoser(this.rig);
    this.object = new THREE.Group();
    this.object.add(this.rig.group);
    this.position = this.object.position;
    this.velocity = new THREE.Vector3();
    this.facing = spec.facing ?? 0;
    this.arena = ctx?.arena;

    this.health = CFG.fighter.maxHealth;
    this.parts = { head: 100, body: 100, legs: 100 };
    this.stamina = CFG.fighter.maxStamina;
    this.drunk = CFG.fighter.drunk.start;
    this.blocking = false;
    this.attacking = null;   // {name, t, cfg, hit}
    this.stun = 0;
    this.downed = 0;
    this.combo = 0; this.comboTimer = 0;
    this.speed = 0;
    this.dead = false;
    this.isPlayer = !!spec.isPlayer;
  }

  get drunk01() { return clamp01(this.drunk / CFG.fighter.drunk.max); }

  attack(name) {
    if (this.attacking || this.stun > 0 || this.downed > 0) return false;
    const cfg = ATTACKS[name];
    if (!cfg || this.stamina < cfg.stam * 0.5) return false;
    this.attacking = { name, t: 0, cfg, hit: false };
    this.stamina = Math.max(0, this.stamina - cfg.stam);
    this.poser.play(name);
    bus.emit(EV.SFX, { name: 'whoosh', position: this.position, drunk: this.drunk01 });
    return true;
  }

  takeHit(from, cfg, part) {
    if (this.dead) return;
    const blocked = this.blocking && !this.downed;
    const drunkArmor = 1 - this.drunk01 * 0.22; // alcohol dulls the pain
    let dmg = cfg.dmg * (1 + from.drunk01 * CFG.fighter.drunk.powerBonusAt100) * drunkArmor;
    if (blocked) dmg *= 0.22;

    this.parts[part] = Math.max(0, this.parts[part] - dmg * 1.4);
    this.health = Math.max(0, this.health - dmg);
    this.stun = blocked ? 0.12 : clamp(0.16 + cfg.dmg * 0.012, 0.16, 0.5);

    _v.copy(this.position).sub(from.position).setY(0).normalize();
    this.velocity.addScaledVector(_v, cfg.push * (blocked ? 0.35 : 1));

    bus.emit(blocked ? EV.HIT_BLOCKED : EV.HIT_LANDED, {
      attacker: from, target: this, cfg, part, damage: dmg,
      point: _w.copy(this.position).setY(part === 'head' ? 1.62 : 1.1)
    });

    if (!blocked) {
      bus.emit(EV.HITSTOP, clamp(0.045 + cfg.dmg * 0.004, 0.045, CFG.time.hitstopMax));
      bus.emit(EV.CAMERA_SHAKE, clamp(0.18 + cfg.dmg * 0.02, 0.18, 0.95));
      from.combo++; from.comboTimer = 1.6;
      if (from.combo > 1) bus.emit(EV.COMBO, { fighter: from, count: from.combo });
    }

    if (this.health <= 0 && !this.dead) {
      this.dead = true; this.downed = 4.5;
      bus.emit(EV.KO, { fighter: this, by: from });
      bus.emit(EV.SLOWMO, { duration: 1.9, scale: CFG.time.slowmoScale });
    } else if (!blocked && (this.parts.head <= 0 || rng.chance(cfg.dmg * 0.006))) {
      this.downed = Math.max(this.downed, 2.0);
      this.parts.head = Math.max(12, this.parts.head);
      bus.emit(EV.KNOCKDOWN, { fighter: this, by: from });
    }
  }

  drink() {
    if (this.attacking || this.downed > 0) return;
    this.drunk = Math.min(CFG.fighter.drunk.max, this.drunk + CFG.fighter.drunk.perSip);
    this.stamina = Math.min(CFG.fighter.maxStamina, this.stamina + 18);
    this.health = Math.min(CFG.fighter.maxHealth, this.health + 4);
    bus.emit(EV.DRINK, { fighter: this });
    bus.emit(EV.SFX, { name: 'gulp', position: this.position });
  }

  update(dt, intent, opponent) {
    const D = CFG.fighter;
    this.stun = Math.max(0, this.stun - dt);
    this.downed = Math.max(0, this.downed - dt);
    this.comboTimer -= dt;
    if (this.comboTimer <= 0) this.combo = 0;
    this.drunk = Math.max(0, this.drunk - D.drunk.decayPerSec * dt);
    if (!this.attacking) this.stamina = Math.min(D.maxStamina, this.stamina + D.staminaRegen * dt);

    const locked = this.stun > 0 || this.downed > 0;
    this.blocking = !locked && !this.attacking && !!intent.block;

    // Face the opponent, with drunk error folded in.
    if (opponent) {
      _v.copy(opponent.position).sub(this.position);
      const want = Math.atan2(_v.x, _v.z) + Math.sin(performance.now() * 0.0009) * this.drunk01 * 0.22;
      this.facing = dampAngle(this.facing, want, locked ? 4 : 11, dt);
    }

    // Movement in camera-relative-to-facing space (strafe around the opponent).
    let mx = locked ? 0 : (intent.moveX || 0);
    let my = locked ? 0 : (intent.moveY || 0);
    if (this.attacking) { mx *= 0.15; my *= 0.15; }
    if (this.blocking) { mx *= 0.5; my *= 0.5; }

    const sprint = intent.sprint && this.stamina > 12 && !this.blocking;
    const base = sprint ? D.runSpeed : D.walkSpeed;
    const fx = Math.sin(this.facing), fz = Math.cos(this.facing);
    const rx = fz, rz = -fx;
    const wantVx = (fx * my * (my < 0 ? D.backMul : 1) + rx * mx * D.strafeMul) * base;
    const wantVz = (fz * my * (my < 0 ? D.backMul : 1) + rz * mx * D.strafeMul) * base;

    this.velocity.x = expDamp(this.velocity.x, wantVx, 12, dt);
    this.velocity.z = expDamp(this.velocity.z, wantVz, 12, dt);
    if (sprint) this.stamina = Math.max(0, this.stamina - 11 * dt);

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.velocity.multiplyScalar(Math.exp(-2.2 * dt));

    // Arena containment and fighter separation.
    const R = (this.arena?.radius ?? 9.5) - 0.5;
    const r = Math.hypot(this.position.x, this.position.z);
    if (r > R) { this.position.x *= R / r; this.position.z *= R / r; }
    if (opponent) {
      _v.copy(this.position).sub(opponent.position).setY(0);
      const d = _v.length();
      const minD = D.radius * 2 + 0.28;
      if (d < minD && d > 1e-4) {
        _v.multiplyScalar((minD - d) * 0.5 / d);
        this.position.add(_v);
        opponent.position.sub(_v);
      }
    }

    this.speed = Math.hypot(this.velocity.x, this.velocity.z);

    // Attack timeline.
    if (this.attacking) {
      const a = this.attacking;
      a.t += dt;
      const s = a.cfg.startup, ac = a.cfg.active, rc = a.cfg.recover;
      if (!a.hit && a.t >= s && a.t <= s + ac && opponent) {
        _v.copy(opponent.position).sub(this.position).setY(0);
        const dist = _v.length();
        const facingDot = (_v.x / (dist || 1)) * Math.sin(this.facing) + (_v.z / (dist || 1)) * Math.cos(this.facing);
        const accuracy = 1 - this.drunk01 * CFG.fighter.drunk.accuracyPenaltyAt100;
        const connects = dist <= a.cfg.reach && facingDot > 0.55 && rng() < accuracy;
        if (dist <= a.cfg.reach && facingDot > 0.55) {
          a.hit = true;
          if (connects) opponent.takeHit(this, a.cfg, a.cfg.part);
          else bus.emit(EV.HIT_WHIFF, { fighter: this });
        }
      }
      if (a.t >= s + ac + rc) this.attacking = null;
    }

    if (!locked && intent.action) this.attack(intent.action);

    // Commit transform and pose.
    this.object.rotation.y = this.facing;
    this.poser.update(dt, {
      speed: this.speed,
      drunk: this.drunk01,
      blocking: this.blocking,
      downed: this.downed > 0,
      stun: this.stun
    });
    // Knockdown: fold forward. Replaced by the ragdoll once physics lands.
    const down = clamp01(this.downed / 2.0);
    this.rig.group.rotation.x = lerp(this.rig.group.rotation.x, down * -1.25, 0.18);
    this.rig.group.position.y = lerp(this.rig.group.position.y, -down * 0.55, 0.18);
  }
}
