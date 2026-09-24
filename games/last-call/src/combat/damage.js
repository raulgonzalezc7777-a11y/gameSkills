import * as THREE from 'three';
import { bus, EV } from '../core/events.js';
import { clamp, clamp01 } from '../core/math.js';
import { rng } from '../core/rng.js';
import { TUNE, buzzTier } from './moves.js';

// One place decides what a contact means. Everything above it (the fighter)
// only supplies who hit whom, with what, and where; everything below it (VFX,
// the director, the HUD) hears about it on the bus.

const _dir = new THREE.Vector3();
const _pt = new THREE.Vector3();

// Reaction shapes per hit level: how long the target is stuck, how much of the
// knockback it eats, and how likely it is to end up on the floor.
const LEVELS = {
  light:  { stun: 0.9,  push: 0.8, down: 0.4, shake: 0.7 },
  mid:    { stun: 1.0,  push: 1.0, down: 0.8, shake: 1.0 },
  heavy:  { stun: 1.25, push: 1.3, down: 1.5, shake: 1.4 },
  launch: { stun: 1.45, push: 1.6, down: 3.2, shake: 1.8 },
  slam:   { stun: 1.6,  push: 2.2, down: 6.0, shake: 2.2 }
};

export function levelOf(move) { return LEVELS[move.level] || LEVELS.mid; }

// Damage before any defence is applied. Exposed on its own so the balance
// harness and the preview readout can show the number without landing a hit.
export function computeDamage(attacker, target, move, hurtMul, counter, ctx) {
  const at = buzzTier(attacker.drunk);
  const dt = buzzTier(target.drunk);
  const exhausted = attacker.stamina < 20 ? TUNE.exhaustedDmg : 1;
  const matchMul = ctx?.director?.damageMul ?? 1;
  return move.dmg * (TUNE.damageScale ?? 1) * at.power * hurtMul * (counter ? TUNE.counterMul : 1) *
         attacker.chain.damageScale * exhausted * matchMul / dt.pain;
}

// The single contact resolver. Returns what happened so the caller can decide
// whether the attacker keeps its chain.
export function resolveContact(attacker, target, move, hurt, point, ctx) {
  if (target.dead) return 'dead';
  // 'point' is the contact the caller measured (hitbox.js query: where the
  // limb surface met the hurtbox surface). Copied, never re-derived from the
  // target's bones, so the flash, the sound and the blood all start there.
  _pt.copy(point);

  // Invulnerability first: a dodge that works is a dodge that works, and a
  // drunken lurch that happens to work is the best thing in the game.
  if (target.iFrames > 0) {
    if (target.lurching && !target.dodging) return grace(attacker, target, move, ctx);
    bus.emit(EV.HIT_WHIFF, { fighter: attacker, dodged: true, target });
    bus.emit(EV.SFX, { name: 'whoosh', position: target.position });
    return 'dodge';
  }
  if (target.invuln > 0) return 'invuln';

  const counter = !!(target.attacking && target.attacking.phase === 'startup') && move.type !== 'super';

  // Parry: block pressed within the window of the contact itself, which is why
  // it is a read and not a habit.
  const sinceBlock = target.clock - target.blockPressT;
  if (target.blocking && sinceBlock <= TUNE.parryWindow && move.type !== 'super' && target.stun <= 0) {
    return parry(attacker, target, move, ctx);
  }

  const dmg = computeDamage(attacker, target, move, hurt.dmg, counter, ctx);

  if (target.blocking && target.stun <= 0 && target.downed <= 0) {
    return blocked(attacker, target, move, hurt, dmg, ctx, counter);
  }
  return clean(attacker, target, move, hurt, dmg, counter, ctx);
}

function grace(attacker, target, move, ctx) {
  target.graceCount++;
  target.graceFlash = 1.2;
  attacker.chain.reset('graced');
  bus.emit(EV.STUMBLE, { fighter: target, grace: true, by: attacker });
  bus.emit(EV.SLOWMO, TUNE.graceSlowmo);
  bus.emit(EV.CROWD_REACT, { level: 'peak' });
  bus.emit(EV.UI_STATE, { announce: 'DRUNKEN GRACE' });
  bus.emit(EV.SFX, { name: 'whoosh', position: target.position, drunk: target.drunk01 });
  ctx?.director?.addHype?.(TUNE.graceHype * buzzTier(target.drunk).hype);
  return 'grace';
}

function parry(attacker, target, move, ctx) {
  attacker.stun = Math.max(attacker.stun, TUNE.parryStun);
  attacker.attacking = null;
  attacker.chain.reset('parried');
  target.chain.refresh();
  target.parryCount++;
  target.guard = Math.min(TUNE.guardMax, target.guard + 22);
  bus.emit(EV.PARRY, { fighter: target, attacker, move, point: _pt });
  bus.emit(EV.HITSTOP, 0.12);
  bus.emit(EV.CAMERA_SHAKE, 0.45);
  bus.emit(EV.SFX, { name: 'parry', position: target.position });
  bus.emit(EV.UI_STATE, { announce: 'PARRY' });
  return 'parry';
}

function blocked(attacker, target, move, hurt, dmg, ctx, counter) {
  const chip = dmg * TUNE.chipMul;
  target.health = Math.max(0, target.health - chip);
  target.parts[hurt.part] = Math.max(0, target.parts[hurt.part] - chip * 0.6);
  target.stamina = Math.max(0, target.stamina - dmg * TUNE.blockStamPerDamage);
  // A low attack eats guard twice as fast: blocking everything standing up is
  // not meant to be a strategy.
  target.guard -= dmg * (move.guard === 'low' ? 2.2 : 1.2);
  target.stun = Math.max(target.stun, 0.11);

  knockback(attacker, target, move, 0.35);
  bus.emit(EV.HIT_BLOCKED, {
    attacker, target, cfg: move, move, part: hurt.part, zone: hurt.zone,
    damage: chip, point: _pt, counter
  });
  bus.emit(EV.SFX, { name: 'block', position: target.position });

  if (target.guard <= 0) {
    target.guard = TUNE.guardMax * 0.35;
    target.blocking = false;
    target.stun = TUNE.guardBreakStun;
    target.guardBreaks++;
    attacker.chain.refresh();
    // No GUARD_BREAK in the core EV table, so the announcement rides UI_STATE
    // and the crowd hears it through CROWD_REACT.
    bus.emit(EV.UI_STATE, { announce: 'GUARD BREAK' });
    bus.emit(EV.CROWD_REACT, { level: 'roar' });
    bus.emit(EV.CAMERA_SHAKE, 0.8);
    bus.emit(EV.HITSTOP, 0.1);
    bus.emit('combat:guardBreak', { fighter: target, by: attacker });
    ctx?.director?.addHype?.(10);
    return 'guardBreak';
  }
  return 'block';
}

function clean(attacker, target, move, hurt, dmg, counter, ctx) {
  const lv = levelOf(move);

  target.health = Math.max(0, target.health - dmg);
  target.parts[hurt.part] = Math.max(0, target.parts[hurt.part] - dmg * TUNE.partDamageMul);
  // Getting hit burns the buzz off: the drunk tank sobers up as it takes the
  // beating, which is what stops a high-buzz lead from snowballing.
  target.drunk = Math.max(0, target.drunk - dmg * TUNE.buzzBurnPerHit);
  target.chain.reset('hurt');
  target.blockPressT = -99;

  const stun = clamp(0.15 + dmg * TUNE.hitstunPerDamage, 0.14, 0.55) * lv.stun;
  target.stun = Math.max(target.stun, stun);
  target.attacking = null;
  knockback(attacker, target, move, 1);

  const count = attacker.chain.connect(move.name, counter);
  attacker.lastHitZone = hurt.zone;

  bus.emit(EV.HIT_LANDED, {
    attacker, target, cfg: move, move, part: hurt.part, zone: hurt.zone,
    damage: dmg, point: _pt, counter, combo: count
  });
  bus.emit(EV.HITSTOP, clamp(0.045 + dmg * 0.004, 0.045, 0.18));
  bus.emit(EV.CAMERA_SHAKE, clamp(0.16 + dmg * 0.02, 0.16, 0.95) * lv.shake);
  bus.emit(EV.SFX, { name: hurt.part === 'head' ? 'hitHead' : 'hitBody', position: _pt, power: dmg });

  if (counter) {
    bus.emit(EV.UI_STATE, { announce: 'COUNTER' });
    bus.emit(EV.CROWD_REACT, { level: 'roar' });
    ctx?.director?.addHype?.(TUNE.counterHype * buzzTier(attacker.drunk).hype);
  }

  if (target.health <= 0) {
    target.dead = true;
    target.goDown(4.5, 'ko');
    bus.emit(EV.KO, { fighter: target, by: attacker });
    bus.emit(EV.SLOWMO, { duration: 1.9, scale: 0.22 });
    bus.emit(EV.CAMERA_SHAKE, 1.4);
    return 'ko';
  }

  // Knockdown. A battered head is what turns a clean cross into a flash
  // knockdown, which is the whole point of tracking limbs separately.
  const headWeak = 1 - clamp01(target.parts.head / 100);
  const legsWeak = 1 - clamp01(target.parts.legs / 100);
  let p = dmg * TUNE.knockdownPerDamage * lv.down;
  if (hurt.part === 'head') p += headWeak * TUNE.headKnockdownBias;
  if (hurt.part === 'legs') p += legsWeak * 0.18;
  p *= 1 + (1 - buzzTier(target.drunk).balance) * 0.9;
  if (target.parts.head <= 0 || target.parts.legs <= 0 || rng.chance(clamp01(p))) {
    target.parts.head = Math.max(10, target.parts.head);
    target.parts.legs = Math.max(10, target.parts.legs);
    target.goDown(1.5, 'knockdown');
    bus.emit(EV.KNOCKDOWN, { fighter: target, by: attacker });
    bus.emit(EV.CAMERA_SHAKE, 1.1);
    return 'knockdown';
  }
  return 'hit';
}

export function knockback(attacker, target, move, scale) {
  _dir.copy(target.position).sub(attacker.position).setY(0);
  if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, 1);
  _dir.normalize();
  const mass = target.spec?.bulk ?? 1;
  const lv = levelOf(move);
  // The shove rides its own decay rather than velocity, which a stunned
  // target's footing damped to nothing in a couple of frames: strings then
  // walked the attacker into the defender instead of driving them back.
  const out = target.shove || target.velocity;
  out.addScaledVector(_dir, (move.push * lv.push * scale) / mass);
  // Same beat as the reaction pose: the body stays on the fist for the
  // frozen contact frame, then goes.
  if (target.shove) target.shoveHold = TUNE.shoveOnset;
}

// Per-limb consequences, read by the fighter every frame. Kept here so the
// damage rules and the rules for what damage does live together.
export function limbEffects(f, out) {
  const head = clamp01(f.parts.head / 100);
  const body = clamp01(f.parts.body / 100);
  const legs = clamp01(f.parts.legs / 100);
  out.speedMul = TUNE.legsSpeedFloor + (1 - TUNE.legsSpeedFloor) * legs;
  out.swayMul = 1 + (1 - legs) * TUNE.legsSwayGain;
  out.staminaMul = TUNE.bodyStamFloor + (1 - TUNE.bodyStamFloor) * body;
  out.costMul = 1 + (1 - body) * 0.6;
  out.flashRisk = (1 - head) * TUNE.headFlashGain;
  return out;
}
