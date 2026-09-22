import { rng } from '../core/rng.js';
import { clamp01 } from '../core/math.js';

// Utility AI. Scores a handful of intents every decision tick and commits to
// the winner for a short dwell time so the opponent reads as deliberate rather
// than twitchy. The AI owner extends this with personalities and adaptation.
export class Brain {
  constructor(fighter, opponent, difficulty = 0.6) {
    this.f = fighter; this.o = opponent;
    this.diff = difficulty;
    this.intent = { moveX: 0, moveY: 0, block: false, sprint: false, action: null };
    this.dwell = 0;
    this.reaction = 0.34 - difficulty * 0.18;
    this.aggression = rng.range(0.4, 0.85);
  }

  update(dt) {
    const f = this.f, o = this.o;
    this.dwell -= dt;
    const dx = o.position.x - f.position.x;
    const dz = o.position.z - f.position.z;
    const dist = Math.hypot(dx, dz);
    const inRange = dist < 1.55;

    if (this.dwell > 0) return this.intent;
    this.dwell = 0.16 + rng.range(0, 0.22) * (1 - this.diff);

    const drunkNoise = (f.drunk ?? 0) / 100;
    const i = this.intent;
    i.action = null;
    i.block = false;

    // Drunk fighters commit to bad ideas.
    const wantAttack = this.aggression + (inRange ? 0.5 : -0.3) + drunkNoise * 0.35 + rng.range(-0.25, 0.25);
    const wantBlock = (o.attacking ? 0.9 * this.diff : 0.05) - drunkNoise * 0.5 + rng.range(-0.2, 0.2);
    const wantClose = clamp01((dist - 1.3) * 0.9);

    if (wantBlock > wantAttack && wantBlock > 0.4) {
      i.block = true; i.moveX = 0; i.moveY = -0.4;
    } else if (inRange && wantAttack > 0.55) {
      i.action = rng.pick(['jab', 'jab', 'cross', 'hook', 'uppercut']);
      i.moveX = rng.range(-0.3, 0.3); i.moveY = 0.2;
    } else {
      // Circle and close.
      const strafe = rng.chance(0.5) ? 1 : -1;
      i.moveX = strafe * 0.55 * (1 - wantClose);
      i.moveY = wantClose;
      i.sprint = dist > 3.5;
    }
    // Drunkenness corrupts the stick.
    if (drunkNoise > 0.1) {
      i.moveX += rng.gauss(0, 0.35 * drunkNoise);
      i.moveY += rng.gauss(0, 0.25 * drunkNoise);
    }
    return i;
  }
}
