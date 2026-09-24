import * as THREE from 'three';
import { bus, EV } from '../core/events.js';
import { hashString } from '../core/rng.js';
import { MOVES, TUNE, buzzTier } from './moves.js';
import { resolveContact } from './damage.js';
import { HurtboxSet } from './hitbox.js';

// The Borrachera. Full hype buys one scripted, invulnerable sequence that no
// sober person would try. It is the only place in the game where the fighter
// stops taking input, so it has to pay for that with spectacle.

const _v = new THREE.Vector3();
const _pt = new THREE.Vector3();

// Four routines, one per archetype. 'beats' fire on their own clock; 'zone'
// says which hurtbox the scripted hit is aimed at, which is what makes the
// tank's headbutts read as head damage and the spin kick as legs.
export const SUPERS = {
  tanque: {
    key: 'tanque', title: 'CABEZAZO DEL TANQUE', duration: 2.35, invuln: 1.95, dash: 0.45, pose: 'uppercut',
    beats: [
      { t: 0.50, move: 'borraHead', zone: 'head' },
      { t: 0.85, move: 'borraHead', zone: 'head' },
      { t: 1.20, move: 'borraSmack', zone: 'torso' },
      { t: 1.60, move: 'borraFinish', zone: 'head', finish: true }
    ]
  },
  tecnico: {
    key: 'tecnico', title: 'COMBINACION BORRACHA', duration: 2.45, invuln: 2.05, dash: 0.35, pose: 'jab',
    beats: [
      { t: 0.34, move: 'borraRush', zone: 'head' },
      { t: 0.54, move: 'borraRush', zone: 'torso' },
      { t: 0.74, move: 'borraSmack', zone: 'head' },
      { t: 0.96, move: 'borraRush', zone: 'torso' },
      { t: 1.18, move: 'borraSmack', zone: 'head' },
      { t: 1.55, move: 'borraFinish', zone: 'torso', finish: true }
    ]
  },
  agil: {
    key: 'agil', title: 'VUELTA DE BOTELLA', duration: 2.3, invuln: 2.0, dash: 0.4, pose: 'hook',
    beats: [
      { t: 0.42, move: 'borraSpin', zone: 'thighR' },
      { t: 0.72, move: 'borraSpin', zone: 'thighL' },
      { t: 1.02, move: 'borraSmack', zone: 'head' },
      { t: 1.32, move: 'borraSpin', zone: 'torso' },
      { t: 1.62, move: 'borraFinish', zone: 'head', finish: true }
    ]
  },
  showman: {
    key: 'showman', title: 'EL TABURETAZO', duration: 2.5, invuln: 2.1, dash: 0.5, pose: 'hook',
    beats: [
      { t: 0.55, move: 'borraSmack', zone: 'torso' },
      { t: 0.95, move: 'borraSmack', zone: 'head' },
      { t: 1.35, move: 'borraSpin', zone: 'thighR' },
      { t: 1.75, move: 'borraFinish', zone: 'head', finish: true }
    ]
  }
};

const KEYS = ['tanque', 'tecnico', 'agil', 'showman'];

export function archetypeFor(spec = {}) {
  if (spec.archetype && SUPERS[spec.archetype]) return spec.archetype;
  const bulk = spec.bulk ?? 1;
  if (bulk >= 1.18) return 'tanque';
  if (bulk >= 1.08) return 'showman';
  if (bulk <= 0.96) return 'agil';
  if (spec.name) return KEYS[hashString(spec.name) % KEYS.length];
  return 'tecnico';
}

export class Borrachera {
  constructor(fighter) {
    this.f = fighter;
    this.script = SUPERS[archetypeFor(fighter.spec)] || SUPERS.tecnico;
    this.active = false;
    this.t = 0;
    this.fired = 0;
    this.hits = 0;
  }

  get title() { return this.script.title; }

  canStart(ctx) {
    const f = this.f;
    if (this.active || f.dead || f.downed > 0 || f.stun > 0) return false;
    const d = ctx?.director;
    if (!d) return false;
    // The director caps hype at 100 and then decays it every frame, so an
    // exact 'hype >= 100' gate is open for about one frame per fill. Accept
    // the top of the meter instead, and spend whatever is actually there.
    return !!d.borracheraReady || (d.hype ?? 0) >= TUNE.borracheraCost * TUNE.borracheraFloor;
  }

  start(opponent, ctx) {
    if (!this.canStart(ctx)) return false;
    const d = ctx?.director;
    const cost = Math.min(TUNE.borracheraCost, d?.hype ?? 0);
    if (d?.spendHype && !d.spendHype(cost)) return false;
    this.active = true; this.t = 0; this.fired = 0; this.hits = 0;
    const f = this.f;
    f.attacking = null;
    f.blocking = false;
    f.chain.reset('borrachera');
    f.poseSafe(this.script.pose);
    bus.emit('borrachera:start', { fighter: f, name: this.script.title, archetype: this.script.key });
    bus.emit(EV.SLOWMO, { duration: 0.9, scale: 0.35 });
    bus.emit(EV.CAMERA_SHAKE, 1.2);
    bus.emit(EV.UI_STATE, { announce: this.script.title });
    bus.emit(EV.CROWD_REACT, { level: 'peak' });
    bus.emit(EV.SFX, { name: 'borrachera', position: f.position });
    return true;
  }

  // Returns true while it owns the fighter's turn.
  update(dt, opponent, frame, ctx) {
    if (!this.active) return false;
    const f = this.f, s = this.script;
    this.t += dt;
    f.invuln = this.t < s.invuln ? 0.1 : 0;

    if (opponent) {
      _v.copy(opponent.position).sub(f.position).setY(0);
      const d = _v.length() || 1;
      f.facing = Math.atan2(_v.x / d, _v.z / d);
      // Close the gap during the dash, then stay glued to the target so the
      // sequence never plays to an empty patch of floor.
      const want = this.t < s.dash ? 1.05 : 1.0;
      const k = this.t < s.dash ? 6.5 : 3.0;
      f.position.addScaledVector(_v.multiplyScalar(1 / d), Math.min((d - want) * k * dt, Math.max(0, d - want)));
      f.velocity.multiplyScalar(0.1);
    }

    while (this.fired < s.beats.length && this.t >= s.beats[this.fired].t) {
      this.fire(s.beats[this.fired], opponent, frame, ctx);
      this.fired++;
    }

    if (this.t >= s.duration) this.stop();
    return true;
  }

  fire(beat, opponent, frame, ctx) {
    const move = MOVES[beat.move];
    const f = this.f;
    f.poseSafe(beat.finish ? 'uppercut' : f.borracheraPose || 'hook');
    f.noteMove(move.name);
    if (!opponent || opponent.dead || !opponent.hurtboxes) return;
    opponent.hurtboxes.refresh(frame);
    let hurt = null;
    const caps = opponent.hurtboxes.capsules;
    for (let i = 0; i < caps.length; i++) if (caps[i].zone === beat.zone) { hurt = caps[i]; break; }
    if (!hurt) hurt = caps[0];
    if (!hurt) return;
    _v.copy(opponent.position).sub(f.position).setY(0);
    if (_v.length() > move.reach + 1.2) return; // they got away, which is allowed
    // The flash belongs on the skin facing the limb that struck, not inside
    // the target's chest.
    const limb = f.rig?.bones?.[move.limb];
    if (limb) HurtboxSet.surfacePoint(hurt, limb.getWorldPosition(_pt), _pt);
    else _pt.copy(hurt.a).lerp(hurt.b, 0.5);
    const res = resolveContact(f, opponent, move, hurt, _pt, ctx);
    if (res !== 'dodge' && res !== 'grace' && res !== 'dead') this.hits++;
    bus.emit(EV.HITSTOP, beat.finish ? 0.16 : 0.08);
    bus.emit(EV.CAMERA_SHAKE, beat.finish ? 1.6 : 0.7);
    if (beat.finish) {
      bus.emit(EV.SLOWMO, { duration: 1.1, scale: 0.3 });
      bus.emit(EV.CROWD_REACT, { level: 'peak' });
      ctx?.director?.addHype?.(6 * buzzTier(f.drunk).hype);
      if (!opponent.dead) opponent.goDown(2.2, 'borrachera');
    }
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.f.invuln = 0;
    bus.emit('borrachera:end', { fighter: this.f, name: this.script.title, hits: this.hits });
  }
}
