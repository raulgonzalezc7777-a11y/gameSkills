import * as THREE from 'three';

const _focus = new THREE.Vector3();
import { Fighter } from '../combat/fighter.js';
import { Brain } from '../ai/brain.js';
import { Arena } from '../world/arena.js';
import { TPCamera } from '../camera/tpcamera.js';
import { CFG } from '../core/config.js';
import { input } from '../core/input.js';
import { time } from '../core/time.js';
import { bus, EV } from '../core/events.js';
import { clamp01, expDamp } from '../core/math.js';
import { Director, PHASE } from './director.js';

export const ROSTER = [
  { name: 'DIEGO "EL TANQUE"', skin: '#b87c52', shirt: '#c0392b', pants: '#1c2233', bulk: 1.22 },
  { name: 'KAI KOMATSU',       skin: '#e0b28a', shirt: '#1f6f8b', pants: '#14181f', bulk: 1.02 },
  { name: 'BRONWYN HALE',      skin: '#f0c9a6', shirt: '#7d3cff', pants: '#22182e', bulk: 0.94 },
  { name: 'MALIK OSEI',        skin: '#7a4c33', shirt: '#f2c14e', pants: '#1a1d27', bulk: 1.12 }
];

export class Match {
  constructor(ctx) {
    this.scene = ctx.scene;
    this.arena = new Arena(ctx);
    this.scene.add(this.arena.group);

    const [a, b] = [ROSTER[0], ROSTER[1]];
    this.player = new Fighter({ ...a, isPlayer: true, facing: 0 }, { arena: this.arena });
    this.cpu = new Fighter({ ...b, facing: Math.PI }, { arena: this.arena });
    this.player.position.copy(this.arena.spawnPoints[0]);
    this.cpu.position.copy(this.arena.spawnPoints[1]);
    this.cpu.facing = Math.PI;
    this.scene.add(this.player.object, this.cpu.object);

    this.brain = new Brain(this.cpu, this.player, 0.65);
    this.tpcam = new TPCamera(ctx.camera, { arena: this.arena });
    this.tpcam.setTargets(this.player.position, this.cpu.position);

    // The director owns pacing: hype, Last Call, knockdown counts and rounds.
    this.director = new Director([this.player, this.cpu]);
    this.ghost = { l: 100, r: 100 };
    this.running = false;
  }

  get round() { return this.director.round; }
  get clock() { return this.director.clock; }

  begin() {
    this.running = true;
    this.director.phase = PHASE.INTRO;
    this.director.phaseTimer = 1.4;
  }

  update(dt) {
    // Light the fight, not the middle of the room.
    _focus.copy(this.player.position).lerp(this.cpu.position, 0.5);
    this.arena.setFocus(_focus);
    this.arena.update(dt, time.elapsed);
    this.tpcam.drunk = this.player.drunk01;

    if (!this.running) {
      // Attract mode: orbit the empty ring so the title screen is alive.
      this.tpcam.yaw += dt * 0.12;
      this.tpcam.update(dt, { x: 0, y: 0 });
      this.player.update(dt, { moveX: 0, moveY: 0 }, this.cpu);
      this.cpu.update(dt, { moveX: 0, moveY: 0 }, this.player);
      return;
    }

    this.director.update(dt);
    const fighting = this.director.phase === PHASE.FIGHT || this.director.phase === PHASE.KNOCKDOWN;

    const now = performance.now() / 1000;
    const action = input.consumeBuffered(['jab', 'cross', 'hook', 'uppercut', 'kick'], now);
    // The full intent shape. Combat reads the optional fields defensively, so
    // a mechanic can land here before it lands there without breaking a build.
    const intent = {
      moveX: fighting ? input.state.moveX : 0,
      moveY: fighting ? input.state.moveY : 0,
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
    if (!fighting) { cpuIntent.moveX = 0; cpuIntent.moveY = 0; cpuIntent.action = null; }
    this.player.update(dt, intent, this.cpu);
    this.cpu.update(dt, cpuIntent, this.player);

    this.ghost.l = expDamp(this.ghost.l, this.player.health, 1.6, dt);
    this.ghost.r = expDamp(this.ghost.r, this.cpu.health, 1.6, dt);

    this.tpcam.update(dt, { x: input.state.lookX, y: input.state.lookY });
  }

  // Distance between the fighters is what the depth of field should focus on.
  get focusDistance() {
    const c = this.tpcam.camera.position;
    const t = this.tpcam.look;
    return Math.max(1.2, c.distanceTo(t));
  }

  hudState() {
    return {
      l: { name: this.player.spec.name, health: this.player.health, ghost: this.ghost.l, stamina: this.player.stamina, drunk: this.player.drunk },
      r: { name: this.cpu.spec.name, health: this.cpu.health, ghost: this.ghost.r, stamina: this.cpu.stamina, drunk: this.cpu.drunk },
      clock: this.clock, round: this.round,
      wins: this.director.wins, hype: this.director.hype,
      lastCall: this.director.lastCall, phase: this.director.phase
    };
  }
}
