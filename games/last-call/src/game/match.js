import * as THREE from 'three';

const _focus = new THREE.Vector3();
const _camA = new THREE.Vector3(), _camB = new THREE.Vector3();
import { Fighter } from '../combat/fighter.js';
import { Brain } from '../ai/brain.js';
import { Arena } from '../world/arena.js';
import { TPCamera } from '../camera/tpcamera.js';
import { CFG } from '../core/config.js';
import { input } from '../core/input.js';
import { time } from '../core/time.js';
import { bus, EV } from '../core/events.js';
import { clamp01, expDamp } from '../core/math.js';
import { ROSTER as CARD } from '../characters/roster.js';
import { Director, PHASE } from './director.js';
import { Brawl } from '../brawl/index.js';
import { FIGHTER_BY_ID } from '../meta/catalog.js';

const _fwd = new THREE.Vector3();

// The card lives with the characters, because a spec is character data.
export { ROSTER } from '../characters/roster.js';

export class Match {
  constructor(ctx, spec0 = 0, spec1 = 1) {
    this.scene = ctx.scene;
    this.ctx = ctx;
    this.arena = new Arena(ctx);
    this.scene.add(this.arena.group);
    this.tpcam = new TPCamera(ctx.camera, { arena: this.arena });
    this.tpcam.setTargets(_camA, _camB);
    this._offRound = bus.on(EV.ROUND_START, () => this.resetPositions());
    this.onFighters = null;   // main hooks the effects up to each new pair
    this.setup({ player: spec0, cpu: spec1 });
  }

  // Builds (or rebuilds) everything that depends on who is fighting: the two
  // fighters, their ragdolls and the junk in the ring, the CPU's brain and
  // the director. The venue, camera and post stack are kept, so changing
  // fighters or starting a rematch takes a moment instead of a page reload.
  //   opts.player / opts.cpu   roster index or id
  //   opts.outfit              colour overrides for the player's kit
  //   opts.difficulty          0..1 for the CPU brain
  //   opts.rounds, opts.roundSeconds
  //   opts.mods                level modifiers (see meta/levels.js)
  setup(opts = {}) {
    this.teardown();
    this.opts = opts;
    const pick = (v, d) => (typeof v === 'number' ? CARD[v] : CARD.find((c) => c.id === v)) || CARD[d];
    const a = { ...pick(opts.player, 0), ...(opts.outfit || {}) };
    let bSpec = pick(opts.cpu, 1);
    // A mirror match gets the rival in a different kit so the two read apart.
    if (bSpec.id === a.id) bSpec = { ...bSpec, tank: '#e8e4d8', trunks: '#2a2f38', shoe: '#e8e4d8' };
    this.player = new Fighter({ ...a, isPlayer: true, facing: 0 }, { arena: this.arena });
    this.cpu = new Fighter({ ...bSpec, facing: Math.PI }, { arena: this.arena });
    this.player.position.copy(this.arena.spawnPoints[0]);
    this.cpu.position.copy(this.arena.spawnPoints[1]);
    this.cpu.facing = Math.PI;
    this.scene.add(this.player.object, this.cpu.object);

    // Physics comedy: both fighters become active ragdolls in one world.
    this.brawl = new Brawl(this.arena, [this.player, this.cpu], opts.mods);
    this.brawl.debris.camera = this.ctx.camera;

    this.brain = new Brain(this.cpu, this.player, opts.difficulty ?? 0.65);

    // The director owns pacing: hype, Last Call, knockdown counts and rounds.
    this.director = new Director([this.player, this.cpu], { rounds: opts.rounds, roundSeconds: opts.roundSeconds });
    // Combat reaches the director through each fighter's ctx: the Borrachera
    // pays for itself from the hype meter and counters and props feed it.
    // Without this link the super never spent the meter and could be chained.
    for (const f of [this.player, this.cpu]) { f.director = this.director; f.ctx.director = this.director; }
    this.ghost = { l: 100, r: 100 };
    this.running = false;
    this.onFighters?.(this.player, this.cpu);
  }

  teardown() {
    if (!this.player) return;
    this.onFighters?.(null, null, [this.player, this.cpu]);
    this.brawl?.dispose();
    this.director?.dispose();
    for (const f of [this.player, this.cpu]) {
      if (f.prop && f.propSys) try { f.propSys.drop(f); } catch { /* already gone */ }
      this.scene.remove(f.object);
      f.dispose();
    }
    this.player = this.cpu = null;
  }

  get round() { return this.director.round; }
  get clock() { return this.director.clock; }

  begin() {
    this.running = true;
    this.director.phase = PHASE.INTRO;
    this.director.phaseTimer = 1.4;
    bus.emit(EV.ROUND_START, { round: this.director.round });
  }

  // Every round starts from the corners: the fighters go back to their
  // spawn points facing each other, and their bodies are put back on their
  // feet in one step instead of being hauled across the ring by the muscles.
  resetPositions() {
    const sp = this.arena.spawnPoints;
    this.player.position.copy(sp[0]); this.player.facing = 0;
    this.cpu.position.copy(sp[1]); this.cpu.facing = Math.PI;
    for (const f of [this.player, this.cpu]) {
      f.velocity?.set(0, 0, 0);
      f.downed = 0;
      f.ragdoll?.requestSnap();
    }
  }

  // The stick is read in screen space: right is right on the screen, up is
  // into the screen. The fighter moves in its own frame (forward is toward
  // the opponent), so the stick is turned into that frame here. With a side-on
  // camera a fighter-relative stick would make 'right' mean 'into the screen'.
  screenMove(mx, my) {
    const out = this._move || (this._move = { x: 0, y: 0 });
    if (!mx && !my) { out.x = 0; out.y = 0; return out; }
    const cam = this.tpcam.camera;
    cam.getWorldDirection(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    const wx = -_fwd.z * mx + _fwd.x * my;   // camera right is (-fz, fx)
    const wz = _fwd.x * mx + _fwd.z * my;
    const f = this.player.facing;
    const fx = Math.sin(f), fz = Math.cos(f);
    out.y = wx * fx + wz * fz;
    out.x = wx * fz - wz * fx;
    return out;
  }

  update(dt) {
    // Light the fight, not the middle of the room.
    _focus.copy(this.player.position).lerp(this.cpu.position, 0.5);
    this.arena.setFocus(_focus);
    // Plant both fighters on the floor. Radius follows their build so the
    // heavy one casts a wider pool than the lean one.
    this.arena.setBlob(0, this.player.position.x, this.player.position.z,
      0.42 + (this.player.rig?.height ?? 1.85) * 0.06, Math.max(0, this.player.position.y));
    this.arena.setBlob(1, this.cpu.position.x, this.cpu.position.z,
      0.42 + (this.cpu.rig?.height ?? 1.85) * 0.06, Math.max(0, this.cpu.position.y));
    this.arena.update(dt, time.elapsed);
    this.tpcam.drunk = this.player.drunk01;
    // The camera frames the bodies, not the gameplay roots.
    for (const [f, v] of [[this.player, _camA], [this.cpu, _camB]]) {
      if (f.ragdoll?.built) f.ragdoll.pelvisPosition(v); else v.copy(f.position).setY(0.95);
    }

    if (!this.running) {
      // Attract mode: orbit the empty ring so the title screen is alive.
      this.tpcam.yaw += dt * 0.12;
      this.tpcam.update(dt, { x: 0, y: 0 });
      this.arena.crowd?.uniforms?.uCam?.value.copy(this.tpcam.camera.position);
      this.player.update(dt, { moveX: 0, moveY: 0 }, this.cpu);
      this.cpu.update(dt, { moveX: 0, moveY: 0 }, this.player);
      this.brawl.step(dt);
      return;
    }

    this.director.update(dt);
    const fighting = this.director.phase === PHASE.FIGHT || this.director.phase === PHASE.KNOCKDOWN;

    const now = performance.now() / 1000;
    const action = input.consumeBuffered(['jab', 'cross', 'hook', 'uppercut', 'kick'], now);
    // The full intent shape. Combat reads the optional fields defensively, so
    // a mechanic can land here before it lands there without breaking a build.
    const move = this.screenMove(input.state.moveX, input.state.moveY);
    const intent = {
      moveX: fighting ? move.x : 0,
      moveY: fighting ? move.y : 0,
      sprint: input.state.sprint,
      block: fighting && input.state.block,
      action: fighting ? action : null,
      dodge: fighting && input.pressed('dodge'),
      grab: fighting && input.pressed('grapple'),
      taunt: fighting && input.pressed('taunt'),
      drink: fighting && input.pressed('drink'),
      special: fighting && input.pressed('special') && this.director.borracheraReady
    };
    // Until combat owns drinking, the match still services the input so the
    // core mechanic is never dead.
    if (intent.drink && typeof this.player.drink === 'function' && !this.player._ownsDrink) this.player.drink();

    const cpuIntent = this.brain.update(dt);
    if (!fighting) { cpuIntent.moveX = 0; cpuIntent.moveY = 0; cpuIntent.action = null; cpuIntent.drink = false; cpuIntent.special = false; }
    this.player.update(dt, intent, this.cpu);
    this.cpu.update(dt, cpuIntent, this.player);
    this.brawl.step(dt);

    this.ghost.l = expDamp(this.ghost.l, this.player.health, 1.6, dt);
    this.ghost.r = expDamp(this.ghost.r, this.cpu.health, 1.6, dt);

    this.tpcam.update(dt, { x: input.state.lookX, y: input.state.lookY });
    this.arena.crowd?.uniforms?.uCam?.value.copy(this.tpcam.camera.position);
  }

  // Distance between the fighters is what the depth of field should focus on.
  get focusDistance() {
    const c = this.tpcam.camera.position;
    const t = this.tpcam.look;
    return Math.max(1.2, c.distanceTo(t));
  }

  hudState() {
    return {
      l: { name: this.player.spec.name, nick: FIGHTER_BY_ID[this.player.spec.id]?.nick, accent: this.player.spec.tank, health: this.player.health, ghost: this.ghost.l, stamina: this.player.stamina, drunk: this.player.drunk },
      r: { name: this.cpu.spec.name, nick: FIGHTER_BY_ID[this.cpu.spec.id]?.nick, accent: this.cpu.spec.tank, health: this.cpu.health, ghost: this.ghost.r, stamina: this.cpu.stamina, drunk: this.cpu.drunk },
      clock: this.clock, round: this.round,
      wins: this.director.wins, hype: this.director.hype,
      lastCall: this.director.lastCall, phase: this.director.phase
    };
  }
}
