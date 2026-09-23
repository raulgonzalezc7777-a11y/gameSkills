import * as THREE from 'three';
import { buildFighter } from '../characters/builder.js';
import { RigPoser } from '../anim/rigposer.js';
import { CFG } from '../core/config.js';
import { clamp, clamp01, expDamp, dampAngle } from '../core/math.js';
import { bus, EV } from '../core/events.js';
import { rng } from '../core/rng.js';

import { MOVES, ATTACKS, PARTS, STRIKES, TUNE, moveFor, buzzTier } from './moves.js';
import { HurtboxSet, HitboxDebug } from './hitbox.js';
import { Chain } from './combo.js';
import { resolveContact, limbEffects } from './damage.js';
import { canClinch, startClinch, breakClinch, updateClinch } from './grapple.js';
import { getPropSystem, tryGrabOrThrow, breaksOnHit, breakInHand } from './props.js';
import { Borrachera } from './borrachera.js';

export { ATTACKS, MOVES, PARTS, STRIKES, TUNE };

// The fighter entity. It owns state and sequencing; the rules live in the
// sibling modules. Read it top to bottom as a frame: timers, intent, movement,
// the attack timeline, then pose, then hit detection against the pose that was
// just committed.

const _v = new THREE.Vector3(), _w = new THREE.Vector3();
const _tip = new THREE.Vector3(), _point = new THREE.Vector3(), _anchor = new THREE.Vector3();
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3();
const _foot = new THREE.Vector3();
const _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const EMPTY_INTENT = Object.freeze({
  moveX: 0, moveY: 0, sprint: false, block: false, action: null,
  dodge: false, grab: false, taunt: false, special: false, drink: false
});

// The rig poser only knows a handful of punch shapes, so every move maps onto
// one of them. A richer poser can read move.name off the fighter instead.
const POSE_KIND = {
  jab: 'jab', cross: 'cross', hook: 'hook', uppercut: 'uppercut', kick: 'hook',
  knee: 'uppercut', toss: 'hook',
  glassJab: 'jab', glassSmash: 'hook', bottleJab: 'jab', bottleSwing: 'hook',
  bottleSmash: 'uppercut', stoolSwing: 'hook', stoolSlam: 'uppercut',
  glassThrow: 'cross', bottleThrow: 'cross', stoolThrow: 'hook',
  borraRush: 'jab', borraSmack: 'cross', borraHead: 'uppercut',
  borraSpin: 'hook', borraFinish: 'uppercut'
};

let FRAME = 0;

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

    this.arena = ctx?.arena ?? null;
    this.director = ctx?.director ?? null;
    this.physics = ctx?.physics ?? null;
    this.ctx = { arena: this.arena, director: this.director, physics: this.physics };
    this.propSys = getPropSystem(this.arena);

    // Frozen contract fields.
    this.health = CFG.fighter.maxHealth;
    this.parts = { head: 100, body: 100, legs: 100 };
    this.stamina = CFG.fighter.maxStamina;
    this.drunk = CFG.fighter.drunk.start;
    this.blocking = false;
    this.attacking = null;
    this.dead = false;
    this.downed = 0;
    this.combo = 0;
    this.speed = 0;

    // Combat state.
    this.chain = new Chain(this);
    this.hurtboxes = new HurtboxSet(this.rig);
    this.borrachera = new Borrachera(this);
    this.clock = 0;
    this.stun = 0;
    this.guard = TUNE.guardMax;
    this.iFrames = 0;
    this.invuln = 0;
    this.dodging = false;
    this.lurching = false;
    this.dodgeT = 0;
    this.lurchT = 0;
    this.lurchCd = 0;
    this.blockPressT = -99;
    this.clinch = null;
    this.prop = null;
    this.comboTimer = 0;
    this.drinkLock = 0;
    this.graceCount = 0;
    this.parryCount = 0;
    this.guardBreaks = 0;
    this.graceFlash = 0;
    this.lastHitZone = null;
    this.isPlayer = !!spec.isPlayer;
    this.debugHitboxes = false;
    this.debug = null;
    this.moveUsage = Object.create(null);

    this._lm = { speedMul: 1, swayMul: 1, staminaMul: 1, costMul: 1, flashRisk: 0 };
    this._tipPrev = new THREE.Vector3();
    this._tipLimb = null;
    this._boneFrame = -1;
    this._wasBlocking = false;
    this._wasDead = false;
    this._wasDowned = false;
    this._stepPhase = 0;
    this._sweatShown = -1;
    this._dmgShown = { head: 0, body: 0, legs: 0 };
    this._phase = rng.range(0, 10);
  }

  get drunk01() { return clamp01(this.drunk / CFG.fighter.drunk.max); }
  get tier() { return buzzTier(this.drunk); }
  get attackPhase() { return this.attacking ? this.attacking.phase : 'idle'; }

  // What the preview readout and the balance harness print. Frame numbers are
  // 60 Hz frames into the move, which is how frame data is argued about.
  frameState() {
    const a = this.attacking;
    if (!a) return { move: '-', phase: 'idle', frame: 0, total: 0 };
    const m = a.move;
    return {
      move: a.name, phase: a.phase,
      frame: Math.round(a.t * 60),
      total: m.startupF + m.activeF + m.recoverF,
      startup: m.startupF, active: m.activeF, recover: m.recoverF,
      cancelable: a.contact >= 0 && this.clock - a.contact <= m.cancel
    };
  }

  poseSafe(kind) {
    try { this.poser?.play?.(POSE_KIND[kind] || kind || 'jab'); } catch { /* poser is another owner's file */ }
  }

  noteMove(name) { this.moveUsage[name] = (this.moveUsage[name] || 0) + 1; }

  // Bones are only valid after the object matrix is current, and both fighters
  // query each other, so this is the one door to the hurtbox set.
  syncBones(frame) {
    if (this._boneFrame !== frame) {
      this._boneFrame = frame;
      this.object.updateMatrixWorld(true);
      this.hurtboxes.refresh(frame);
    }
    return this.hurtboxes;
  }

  // ---------------------------------------------------------------- actions

  attack(action, opponent) {
    if (this.dead || this.downed > 0 || this.stun > 0 || this.borrachera.active || this.clinch) return false;
    const move = moveFor(action, this.prop?.type);
    if (!move) return false;

    if (this.attacking) {
      const a = this.attacking;
      // Cancels are only bought by contact. A whiff commits you to the
      // recovery, which is the entire reason spacing matters.
      const open = a.contact >= 0 && this.clock - a.contact <= a.move.cancel;
      if (!open) return false;
    }

    const cost = move.stam * this.chain.staminaMul * this._lm.costMul;
    if (this.stamina < cost * 0.5) return false;
    this.stamina = Math.max(0, this.stamina - cost);

    const acc = this.tier.accuracy * this.chain.accuracyMul;
    const err = (1 - acc) * 0.62;
    this.attacking = {
      name: move.name, move, cfg: move, t: 0, phase: 'startup', hit: false,
      contact: -99, done: false, script: null,
      aimX: err > 0 ? rng.gauss(0, err) : 0,
      aimY: err > 0 ? rng.gauss(0, err * 0.55) : 0
    };
    this._tipLimb = null; // force a fresh sweep origin for the new limb
    this.noteMove(move.name);
    this.poseSafe(move.name);
    bus.emit(EV.SFX, { name: 'whoosh', position: this.position, drunk: this.drunk01 });
    return true;
  }

  // A move that fires a callback instead of a hitbox: throwing a prop.
  startScripted(move, onActive) {
    if (this.attacking || this.stun > 0 || this.downed > 0) return false;
    this.attacking = {
      name: move.name, move, cfg: move, t: 0, phase: 'startup', hit: true,
      contact: -99, done: false, script: onActive, aimX: 0, aimY: 0
    };
    this.noteMove(move.name);
    this.poseSafe(move.name);
    return true;
  }

  drink() {
    if (this.attacking || this.downed > 0 || this.dead || this.drinkLock > 0) return false;
    this.drunk = Math.min(CFG.fighter.drunk.max, this.drunk + TUNE.drinkBuzz);
    this.stamina = Math.min(CFG.fighter.maxStamina, this.stamina + TUNE.drinkStam);
    this.health = Math.min(CFG.fighter.maxHealth, this.health + TUNE.drinkHeal);
    this.drinkLock = TUNE.drinkLock;
    this.stun = Math.max(this.stun, TUNE.drinkLock * 0.6); // wide open while you drink
    bus.emit(EV.DRINK, { fighter: this });
    bus.emit(EV.SFX, { name: 'gulp', position: this.position });
    return true;
  }

  taunt(ctx) {
    if (this.attacking || this.downed > 0 || this.dead) return false;
    this.stun = Math.max(this.stun, TUNE.tauntLock);
    this.poseSafe('hook');
    (ctx?.director ?? this.director)?.addHype?.(TUNE.tauntHype * this.tier.hype);
    bus.emit(EV.CROWD_REACT, { level: 'roar' });
    bus.emit(EV.SFX, { name: 'taunt', position: this.position });
    return true;
  }

  startDodge(mx, my) {
    if (this.stamina < TUNE.dodgeStam || this.dodgeT > 0 || this.stun > 0 || this.downed > 0) return false;
    this.stamina -= TUNE.dodgeStam;
    this.dodgeT = TUNE.dodgeDuration;
    this.dodging = true;
    this.attacking = null;
    const fx = Math.sin(this.facing), fz = Math.cos(this.facing);
    let dx = fx * (my || -1) + fz * (mx || 0);
    let dz = fz * (my || -1) - fx * (mx || 0);
    const l = Math.hypot(dx, dz) || 1;
    this.velocity.x += (dx / l) * TUNE.dodgeSpeed;
    this.velocity.z += (dz / l) * TUNE.dodgeSpeed;
    bus.emit(EV.SFX, { name: 'dodge', position: this.position });
    return true;
  }

  // The lurch is not a dodge: the fighter did not ask for it and cannot aim
  // it. Everything good about it is decided by whether an attack happens to be
  // arriving, which is what DRUNKEN GRACE scores.
  startLurch() {
    if (this.lurchT > 0 || this.lurchCd > 0 || this.downed > 0 || this.dead) return false;
    this.lurchT = TUNE.lurchDuration;
    this.lurchCd = TUNE.lurchCooldown;
    this.lurching = true;
    const a = rng.range(0, Math.PI * 2);
    this.velocity.x += Math.cos(a) * 3.1;
    this.velocity.z += Math.sin(a) * 3.1;
    bus.emit(EV.STUMBLE, { fighter: this, grace: false });
    return true;
  }

  goDown(duration, reason) {
    this.downed = Math.max(this.downed, duration);
    this.stun = 0;
    this.attacking = null;
    this.blocking = false;
    this.chain.reset(reason);
    this.dodgeT = 0; this.lurchT = 0; this.iFrames = 0;
    this.dodging = false; this.lurching = false;
    if (this.clinch) breakClinch(this, reason);
    if (this.prop && this.propSys) this.propSys.drop(this);
  }

  // Scripted knockdown and knockout, for the capture harness and any future
  // replay or tutorial. The old takeHit() entry point was removed when combat
  // moved to swept hitboxes, and the shot list kept calling it: its money
  // shots silently threw and photographed two fighters standing up.
  forceDown(kind = 'knockdown', by = null) {
    if (kind === 'ko') {
      this.health = 0;
      this.dead = true;
      this.goDown(4.5, 'ko');
      bus.emit(EV.KO, { fighter: this, by });
      bus.emit(EV.SLOWMO, { duration: 1.9, scale: 0.22 });
      bus.emit(EV.CAMERA_SHAKE, 1.4);
    } else {
      this.goDown(2.1, 'knockdown');
      bus.emit(EV.KNOCKDOWN, { fighter: this, by });
      bus.emit(EV.CAMERA_SHAKE, 1.1);
    }
  }

  // The director resets health between rounds but knows nothing about guard,
  // chains or what is in your hand, so the fighter notices the new round.
  resetForRound() {
    this.chain.reset('round');
    this.guard = TUNE.guardMax;
    this.stun = 0; this.iFrames = 0; this.invuln = 0;
    this.dodgeT = 0; this.lurchT = 0; this.lurchCd = 0;
    this.dodging = false; this.lurching = false;
    this.borrachera.stop();
    if (this.clinch) breakClinch(this, 'round');
    if (this.prop && this.propSys) this.propSys.drop(this);
    this.velocity.set(0, 0, 0);
  }

  // ----------------------------------------------------------------- update

  update(dt, intent, opponent) {
    const I = intent || EMPTY_INTENT;
    const frame = ++FRAME;
    const D = CFG.fighter;
    this.clock += dt;

    if (this._wasDead && !this.dead) this.resetForRound();
    this._wasDead = this.dead;

    // Timers.
    this.stun = Math.max(0, this.stun - dt);
    this.downed = Math.max(0, this.downed - dt);
    this.lurchCd = Math.max(0, this.lurchCd - dt);
    this.drinkLock = Math.max(0, (this.drinkLock || 0) - dt);
    this.invuln = Math.max(0, this.invuln - dt);
    this.graceFlash = Math.max(0, this.graceFlash - dt);
    this.chain.update(dt);
    this.combo = this.chain.count;
    this.comboTimer = this.chain.timer;

    if (this._wasDowned && this.downed <= 0 && !this.dead) bus.emit(EV.GET_UP, { fighter: this });
    this._wasDowned = this.downed > 0;

    // Dodge and lurch windows, and the i-frames they carry.
    this.iFrames = 0;
    if (this.dodgeT > 0) {
      this.dodgeT = Math.max(0, this.dodgeT - dt);
      const e = TUNE.dodgeDuration - this.dodgeT;
      if (e >= TUNE.dodgeIFrames[0] && e <= TUNE.dodgeIFrames[1]) this.iFrames = dt;
      this.dodging = this.dodgeT > 0;
    }
    if (this.lurchT > 0) {
      this.lurchT = Math.max(0, this.lurchT - dt);
      const e = TUNE.lurchDuration - this.lurchT;
      if (e >= TUNE.lurchIFrames[0] && e <= TUNE.lurchIFrames[1]) this.iFrames = dt;
      this.lurching = this.lurchT > 0;
    }

    const tier = this.tier;
    const lm = limbEffects(this, this._lm);

    // Buzz decays on its own. Everything that raises it is a choice.
    this.drunk = Math.max(0, this.drunk - D.drunk.decayPerSec * dt);

    // Stamina. A battered body regenerates worse, which is the body damage
    // consequence the design doc asks for.
    if (!this.attacking && this.downed <= 0) {
      const regen = D.staminaRegen * lm.staminaMul * (this.blocking ? 0.35 : 1);
      this.stamina = Math.min(D.maxStamina, this.stamina + regen * dt);
    }
    if (this.guard < TUNE.guardMax && !this.blocking) {
      this.guard = Math.min(TUNE.guardMax, this.guard + TUNE.guardRegen * dt);
    }

    const locked = this.stun > 0 || this.downed > 0 || this.dead;

    // Blocking, and the press instant that a parry is measured against.
    const wantBlock = !!I.block && !locked && !this.attacking && this.stamina > 2 && !this.borrachera.active;
    if (wantBlock && !this._wasBlocking) this.blockPressT = this.clock;
    this.blocking = wantBlock;
    this._wasBlocking = wantBlock;
    if (this.blocking) this.stamina = Math.max(0, this.stamina - 6 * dt);

    // The super owns the fighter outright while it runs.
    const superActive = this.borrachera.update(dt, opponent, frame, this.ctx);

    // Clinch owns the turn next.
    const clinched = !superActive && updateClinch(this, dt, I, this.ctx);

    if (!superActive && !clinched && !locked) {
      if (I.special) this.borrachera.start(opponent, this.ctx);
      if (I.drink) this.drink();
      if (I.taunt) this.taunt(this.ctx);
      if (I.dodge) this.startDodge(I.moveX || 0, I.moveY || 0);
      if (I.grab) this.handleGrab(opponent);
    }

    // A high buzz lurches on its own. This is the only randomness the player
    // is asked to enjoy rather than fight.
    if (!locked && !superActive && !clinched && tier.stumble > 0 && rng.chance(tier.stumble * dt)) {
      this.startLurch();
    }

    // Facing, with the drunk error folded in as an aim wobble.
    if (opponent) {
      _v.copy(opponent.position).sub(this.position);
      const sway = (1 - tier.balance) * lm.swayMul * 0.30;
      const want = Math.atan2(_v.x, _v.z) + Math.sin(this.clock * 0.9 + this._phase) * sway;
      this.facing = dampAngle(this.facing, want, locked ? 4 : 11 * (0.6 + 0.4 * tier.balance), dt);
    }

    this.move(dt, I, opponent, tier, lm, locked || superActive || clinched);

    // Attack timeline. The hitbox test waits until after the pose below.
    if (this.attacking) {
      const a = this.attacking, m = a.move;
      const prevPhase = a.phase;
      a.t += dt;
      a.phase = a.t < m.startup ? 'startup' : a.t < m.startup + m.active ? 'active' : 'recovery';
      a.done = a.t >= m.total;
      if (a.phase === 'active' && prevPhase === 'startup' && a.script) { a.script(); a.script = null; }
      // A whiffed move drops the chain the moment the active window closes.
      if (prevPhase === 'active' && a.phase !== 'active' && !a.hit) this.onWhiff(tier);
      // Recovery is over: free the slot now so a buffered input is not eaten.
      if (a.done) this.attacking = null;
    }
    // Outside the timeline, because a cancel starts a new move while the old
    // one is still running.
    if (!locked && !superActive && !clinched && I.action) this.attack(I.action, opponent);

    // Pose, commit the transform, then measure the world from the bones.
    this.object.rotation.y = this.facing;
    try {
      this.poser.update(dt, {
        speed: this.speed, strafe: 0, drunk: this.drunk01, stance: this.blocking ? 'block' : 'fight',
        grounded: true, health: this.health / CFG.fighter.maxHealth,
        blocking: this.blocking, downed: this.downed > 0, stun: this.stun,
        attacking: this.attacking ? this.attacking.name : null
      });
    } catch { /* the poser belongs to ANIM, never let it stop the fight */ }
    this.knockdownPose(dt);
    this._boneFrame = -1;
    this.syncBones(frame);

    if (this.attacking && this.attacking.phase === 'active' && !this.attacking.hit && opponent) {
      this.testHit(opponent, frame);
    }

    if (this.propSys) this.propSys.update(dt, frame, opponent ? [this, opponent] : [this], this.ctx);

    this.feedRig(dt);
    this.footsteps(dt);
    if (this.debug) this.drawDebug(opponent, frame);
  }

  handleGrab(opponent) {
    if (this.prop || (this.propSys && this.propSys.nearest(this.position, TUNE.propReach))) {
      if (tryGrabOrThrow(this, opponent, this.ctx)) return;
    }
    if (canClinch(this, opponent)) startClinch(this, opponent);
  }

  onWhiff(tier) {
    this.chain.reset('whiff');
    bus.emit(EV.HIT_WHIFF, { fighter: this });
    // Legless fighters fall over on a whiff, exactly as advertised.
    if (tier.whiffFall > 0 && rng.chance(tier.whiffFall)) {
      this.goDown(1.5, 'whiffFall');
      bus.emit(EV.STUMBLE, { fighter: this, grace: false, fell: true });
      bus.emit(EV.KNOCKDOWN, { fighter: this, by: null, self: true });
    }
  }

  move(dt, I, opponent, tier, lm, locked) {
    const D = CFG.fighter;
    let mx = locked ? 0 : (I.moveX || 0);
    let my = locked ? 0 : (I.moveY || 0);
    if (this.attacking) { mx *= 0.15; my *= 0.15; }
    if (this.blocking) { mx *= 0.5; my *= 0.5; }

    // Drunk feet do not go exactly where they are sent.
    if (!locked && tier.balance < 1) {
      const wob = (1 - tier.balance) * lm.swayMul;
      mx += Math.sin(this.clock * 1.7 + this._phase) * 0.34 * wob;
      my += Math.sin(this.clock * 1.13 + this._phase * 2) * 0.24 * wob;
    }

    const sprint = I.sprint && this.stamina > 12 && !this.blocking && !locked;
    const base = (sprint ? D.runSpeed : D.walkSpeed) * lm.speedMul;
    const fx = Math.sin(this.facing), fz = Math.cos(this.facing);
    const rx = fz, rz = -fx;
    const wantVx = (fx * my * (my < 0 ? D.backMul : 1) + rx * mx * D.strafeMul) * base;
    const wantVz = (fz * my * (my < 0 ? D.backMul : 1) + rz * mx * D.strafeMul) * base;

    // Delayed footing: the drunker you are, the slower the feet answer.
    const lambda = 12 * (0.45 + 0.55 * tier.balance);
    this.velocity.x = expDamp(this.velocity.x, wantVx, lambda, dt);
    this.velocity.z = expDamp(this.velocity.z, wantVz, lambda, dt);
    if (sprint) this.stamina = Math.max(0, this.stamina - 11 * dt);

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.velocity.multiplyScalar(Math.exp(-2.2 * dt));

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
  }

  // The hitbox. One end is the attacking limb's bone, so it follows the pose;
  // the other is authored in fighter space from the move's reach and height,
  // so a move has the range the table promises whatever the poser is doing
  // this week. The capsule is then swept against where it was last frame.
  hitCapsule(move, anchor, tip) {
    const bones = this.rig?.bones || {};
    const bone = bones[move.limb] || bones.handR || bones.chest || bones.hips;
    if (bone) bone.matrixWorld.decompose(anchor, _q, _s);
    else anchor.set(this.position.x, move.hitY, this.position.z);
    _fwd.set(Math.sin(this.facing), 0, Math.cos(this.facing));
    _right.set(_fwd.z, 0, -_fwd.x);
    tip.set(this.position.x, move.hitY, this.position.z);
    tip.addScaledVector(_fwd, move.reach * TUNE.reachScale + move.extend);
    const a = this.attacking;
    if (a) { tip.addScaledVector(_right, a.aimX); tip.y += a.aimY; }
    return tip;
  }

  testHit(opponent, frame) {
    const a = this.attacking, move = a.move;
    this.hitCapsule(move, _anchor, _tip);
    if (this._tipLimb !== move.limb) { this._tipPrev.copy(_tip); this._tipLimb = move.limb; }

    const set = opponent.syncBones ? opponent.syncBones(frame) : opponent.hurtboxes;
    // The limb capsule first, then the sweep, so a fast punch between two
    // frames still registers instead of teleporting through a head.
    let hurt = set ? set.query(_anchor, _tip, move.hitR, _point) : null;
    if (!hurt && set) hurt = set.query(this._tipPrev, _tip, move.hitR, _point);
    this._tipPrev.copy(_tip);
    if (!hurt) return;

    a.hit = true;
    a.contact = this.clock;
    const res = resolveContact(this, opponent, move, hurt, _point, this.ctx);
    if (res === 'parry') { this.attacking = null; return; }
    if (res === 'dodge' || res === 'grace') return;
    if (this.prop && breaksOnHit(move.name)) breakInHand(this, _point, this.ctx);
  }

  knockdownPose(dt) {
    const down = clamp01(this.downed / 2.0);
    const g = this.rig.group;
    g.rotation.x += ((down * -1.25) - g.rotation.x) * Math.min(1, dt * 11);
    g.position.y += ((-down * 0.55) - g.position.y) * Math.min(1, dt * 11);
  }

  // Visual feedback the CHARACTER owner exposes. Only pushed when it moves, so
  // a material update is not queued every frame.
  feedRig(dt) {
    const rig = this.rig;
    if (rig.setDamage) {
      for (let i = 0; i < PARTS.length; i++) {
        const p = PARTS[i];
        const v = clamp01(1 - this.parts[p] / 100);
        if (Math.abs(v - this._dmgShown[p]) > 0.02) { this._dmgShown[p] = v; rig.setDamage(p, v); }
      }
    }
    if (rig.setSweat) {
      const sweat = clamp01(0.1 + this.drunk01 * 0.55 + (1 - this.stamina / CFG.fighter.maxStamina) * 0.5);
      if (Math.abs(sweat - this._sweatShown) > 0.03) { this._sweatShown = sweat; rig.setSweat(sweat); }
    }
  }

  footsteps(dt) {
    if (this.downed > 0 || this.speed < 0.4) return;
    this._stepPhase += this.speed * dt * 1.15;
    if (this._stepPhase < 1) return;
    this._stepPhase = 0;
    _foot.set(this.position.x, 0.02, this.position.z);
    bus.emit(EV.FOOTSTEP, { fighter: this, position: _foot, intensity: clamp01(this.speed / 4) });
  }

  // --------------------------------------------------------------- debugging

  setDebug(scene, on) {
    this.debugHitboxes = !!on;
    if (on && !this.debug) this.debug = new HitboxDebug(scene, 24);
    if (this.debug) this.debug.setVisible(!!on);
  }

  drawDebug(opponent, frame) {
    const d = this.debug;
    if (!d || !this.debugHitboxes) return;
    d.begin();
    d.addHurtboxes(this.syncBones(frame));
    const a = this.attacking;
    if (a) {
      this.hitCapsule(a.move, _anchor, _w);
      d.addHitbox(_anchor, _w, a.move.hitR, a.phase === 'active');
      if (a.phase === 'active') d.addHitbox(this._tipPrev, _w, a.move.hitR * 0.6, true);
    }
    d.commit();
  }

  dispose() {
    this.debug?.dispose();
    this.rig?.dispose?.();
  }
}
