import * as THREE from 'three';
import { bus, EV } from '../core/events.js';
import { clamp01 } from '../core/math.js';
import { rng } from '../core/rng.js';
import { MOVES, TUNE, buzzTier } from './moves.js';
import { resolveContact } from './damage.js';
import { HurtboxSet } from './hitbox.js';

// The clinch. G with nothing to pick up and an opponent inside arm's length
// grabs them: the holder can knee, the held fighter mashes out. It is the
// answer to a turtle, and the toss is how you end a round against the ropes.

const _v = new THREE.Vector3();
const _pt = new THREE.Vector3();

export function canClinch(f, opponent) {
  if (!opponent || opponent.dead || opponent.downed > 0 || f.clinch || opponent.clinch) return false;
  if (f.downed > 0 || f.stun > 0 || f.attacking) return false;
  _v.copy(opponent.position).sub(f.position).setY(0);
  return _v.length() <= TUNE.clinchRange;
}

export function startClinch(f, opponent) {
  f.clinch = { partner: opponent, role: 'hold', t: 0, cd: 0 };
  opponent.clinch = { partner: f, role: 'held', t: 0, escape: 0 };
  opponent.attacking = null;
  opponent.chain.reset('clinched');
  bus.emit(EV.SFX, { name: 'grab', position: f.position });
  bus.emit(EV.CROWD_REACT, { level: 'ooh' });
}

export function breakClinch(f, reason) {
  const c = f.clinch;
  if (!c) return;
  const p = c.partner;
  f.clinch = null;
  if (p && p.clinch && p.clinch.partner === f) p.clinch = null;
  if (reason === 'escape' && p) {
    // The escape shoves the holder off, so mashing out is worth something.
    _v.copy(p.position).sub(f.position).setY(0).normalize();
    p.velocity.addScaledVector(_v, 2.4);
  }
}

// Returns true when the clinch consumed this fighter's turn.
export function updateClinch(f, dt, intent, ctx) {
  const c = f.clinch;
  if (!c) return false;
  const p = c.partner;
  if (!p || p.dead || f.dead || p.downed > 0 || f.downed > 0) { breakClinch(f, 'ended'); return false; }

  c.t += dt;
  c.cd = Math.max(0, (c.cd || 0) - dt);

  // Hold the pair at arm's length and facing each other.
  _v.copy(p.position).sub(f.position).setY(0);
  const d = _v.length() || 1;
  _v.multiplyScalar(1 / d);
  f.facing = Math.atan2(_v.x, _v.z);
  const want = 0.92;
  f.position.addScaledVector(_v, (d - want) * 0.5);
  p.position.addScaledVector(_v, -(d - want) * 0.5);
  f.velocity.multiplyScalar(0.2);

  if (c.role === 'held') {
    // Mashing grab or dodge buys the way out, and being drunk makes the hands
    // slower to find the shirt.
    if (intent.grab || intent.dodge) c.escape += 0.34 * buzzTier(f.drunk).balance;
    c.escape += dt * 0.18;
    if (c.escape >= TUNE.clinchBreak) {
      bus.emit(EV.SFX, { name: 'grabBreak', position: f.position });
      breakClinch(f, 'escape');
    }
    return true;
  }

  // Holder. Knee on an attack press, toss on grab, and the clinch times out on
  // its own so nobody can sit in it.
  if (c.t >= TUNE.clinchMax) { breakClinch(f, 'timeout'); return true; }

  if (intent.grab && c.t > 0.25) {
    tossFrom(f, p, ctx);
    breakClinch(f, 'toss');
    return true;
  }
  if (intent.action && c.cd <= 0 && f.stamina > MOVES.knee.stam) {
    kneeFrom(f, p, ctx);
    c.cd = 0.34;
  }
  return true;
}

function hurtFor(target, zone) {
  const set = target.hurtboxes;
  if (!set) return null;
  for (let i = 0; i < set.capsules.length; i++) if (set.capsules[i].zone === zone) return set.capsules[i];
  return set.capsules[0] || null;
}

function kneeFrom(f, p, ctx) {
  const move = MOVES.knee;
  f.stamina = Math.max(0, f.stamina - move.stam);
  f.poseSafe('uppercut');
  const hurt = hurtFor(p, 'torso');
  if (!hurt) return;
  // The contact is the belly surface in front of the knee, not the spine.
  const knee = f.rig?.bones?.shinL;
  if (knee) HurtboxSet.surfacePoint(hurt, knee.getWorldPosition(_v), _pt);
  else _pt.copy(hurt.a).lerp(hurt.b, 0.5);
  f.noteMove(move.name);
  resolveContact(f, p, move, hurt, _pt, ctx);
}

export function tossFrom(f, p, ctx) {
  const move = MOVES.toss;
  f.stamina = Math.max(0, f.stamina - move.stam);
  f.poseSafe('hook');
  const hurt = hurtFor(p, 'torso');
  if (!hurt) return;
  const hand = f.rig?.bones?.handR;
  if (hand) HurtboxSet.surfacePoint(hurt, hand.getWorldPosition(_v), _pt);
  else _pt.copy(hurt.a).lerp(hurt.b, 0.5);
  f.noteMove(move.name);
  // A toss is a guaranteed trip to the floor, so it resolves the contact and
  // then puts them down regardless of the knockdown roll.
  const res = resolveContact(f, p, move, hurt, _pt, ctx);
  if (res === 'hit' || res === 'block' || res === 'guardBreak') {
    p.goDown(1.9, 'toss');
    bus.emit(EV.KNOCKDOWN, { fighter: p, by: f });
  }
  bus.emit(EV.CAMERA_SHAKE, 1.0);
  ctx?.director?.addHype?.(7 * buzzTier(f.drunk).hype);
  // Drunk fighters throw themselves off balance doing this.
  if (rng.chance(clamp01(1 - buzzTier(f.drunk).balance) * 0.35)) f.startLurch();
}
