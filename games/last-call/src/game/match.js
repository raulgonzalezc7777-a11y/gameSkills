import * as THREE from 'three';
import { Fighter } from '../combat/fighter.js';
import { Brain } from '../ai/brain.js';
import { Arena } from '../world/arena.js';
import { TPCamera } from '../camera/tpcamera.js';
import { CFG } from '../core/config.js';
import { input } from '../core/input.js';
import { time } from '../core/time.js';
import { bus, EV } from '../core/events.js';
import { clamp01, expDamp } from '../core/math.js';

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

    this.round = 1;
    this.clock = CFG.match.roundSeconds;
    this.state = 'intro';
    this.ghost = { l: 100, r: 100 };
    this.running = false;
  }

  begin() {
    this.running = true;
    this.state = 'fight';
    bus.emit(EV.ROUND_START, { round: this.round });
  }

  update(dt) {
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

    this.clock = Math.max(0, this.clock - dt);

    const now = performance.now() / 1000;
    const action = input.consumeBuffered(['jab', 'cross', 'hook', 'uppercut', 'kick'], now);
    if (input.pressed('drink')) this.player.drink();
    const intent = {
      moveX: input.state.moveX, moveY: input.state.moveY,
      sprint: input.state.sprint, block: input.state.block, action
    };

    const cpuIntent = this.brain.update(dt);
    this.player.update(dt, intent, this.cpu);
    this.cpu.update(dt, cpuIntent, this.player);

    this.ghost.l = expDamp(this.ghost.l, this.player.health, 1.6, dt);
    this.ghost.r = expDamp(this.ghost.r, this.cpu.health, 1.6, dt);

    this.tpcam.update(dt, { x: input.state.lookX, y: input.state.lookY });
  }

  hudState() {
    return {
      l: { name: this.player.spec.name, health: this.player.health, ghost: this.ghost.l, stamina: this.player.stamina, drunk: this.player.drunk },
      r: { name: this.cpu.spec.name, health: this.cpu.health, ghost: this.ghost.r, stamina: this.cpu.stamina, drunk: this.cpu.drunk },
      clock: this.clock, round: this.round
    };
  }
}
