import { bus, EV } from '../core/events.js';
import { CFG } from '../core/config.js';
import { clamp, clamp01, expDamp } from '../core/math.js';

// The fight director owns pacing: crowd hype, the Last Call escalation, and the
// round state machine. It deliberately knows nothing about rendering, so the
// same logic drives a replay or a headless balance run.
export const PHASE = {
  INTRO: 'intro', FIGHT: 'fight', KNOCKDOWN: 'knockdown',
  ROUND_END: 'roundEnd', MATCH_END: 'matchEnd'
};

export class Director {
  constructor(fighters, opts = {}) {
    this.fighters = fighters;
    this.rounds = opts.rounds ?? CFG.match.rounds;
    this.roundSeconds = opts.roundSeconds ?? CFG.match.roundSeconds;
    this.round = 1;
    this.clock = this.roundSeconds;
    this.phase = PHASE.INTRO;
    this.phaseTimer = 2.6;
    this.wins = fighters.map(() => 0);
    this.knockdowns = fighters.map(() => 0);

    // Hype is shared: the crowd reacts to the fight, not to a player.
    this.hype = 0;
    // Hype has to be earned: in playtests it sat at the ceiling within ten
    // seconds, which made the Borrachera a default rather than a reward.
    this.hypeDecay = 4.6;
    this.lastCall = false;
    this.damageMul = 1;

    this._unsub = [
      bus.on(EV.HIT_LANDED, (p) => this.onHit(p)),
      bus.on(EV.COMBO, (p) => this.addHype(1.5 + p.count * 1.4)),
      bus.on(EV.KNOCKDOWN, (p) => this.onKnockdown(p)),
      bus.on(EV.PARRY, () => this.addHype(9)),
      bus.on(EV.STUMBLE, () => this.addHype(2)),
      bus.on(EV.PROP_BREAK, () => this.addHype(6)),
      bus.on(EV.KO, (p) => this.onKO(p))
    ];
  }

  addHype(amount) {
    this.hype = clamp(this.hype + amount, 0, 100);
    if (this.hype >= 100) bus.emit(EV.CROWD_REACT, { level: 'peak' });
  }

  onHit({ attacker, damage }) {
    // A drunk fighter landing a heavy shot is the crowd's favourite thing.
    const drunkBonus = 1 + (attacker.drunk01 ?? 0) * 1.6;
    this.addHype(damage * 0.12 * drunkBonus);
    bus.emit(EV.CROWD_REACT, { level: damage > 12 ? 'roar' : 'ooh' });
  }

  onKnockdown({ fighter }) {
    const i = this.fighters.indexOf(fighter);
    if (i >= 0) this.knockdowns[i]++;
    this.addHype(12);
    this.phase = PHASE.KNOCKDOWN;
    this.phaseTimer = 2.4;
    // Three knockdowns in a round ends it, the way a real referee would.
    if (i >= 0 && this.knockdowns[i] >= 3) this.endRound(1 - i);
  }

  onKO({ fighter }) {
    const i = this.fighters.indexOf(fighter);
    this.addHype(40);
    this.endRound(i === 0 ? 1 : 0);
  }

  endRound(winnerIndex) {
    if (this.phase === PHASE.ROUND_END || this.phase === PHASE.MATCH_END) return;
    this.wins[winnerIndex]++;
    bus.emit(EV.ROUND_END, { round: this.round, winner: winnerIndex, wins: [...this.wins] });
    const needed = Math.ceil(this.rounds / 2);
    if (this.wins[winnerIndex] >= needed || this.round >= this.rounds) {
      this.phase = PHASE.MATCH_END;
      this.phaseTimer = 6;
      bus.emit(EV.MATCH_END, { winner: winnerIndex, wins: [...this.wins] });
    } else {
      this.phase = PHASE.ROUND_END;
      this.phaseTimer = 3.4;
    }
  }

  nextRound() {
    this.round++;
    this.clock = this.roundSeconds;
    this.lastCall = false;
    this.damageMul = 1;
    this.knockdowns = this.fighters.map(() => 0);
    for (const f of this.fighters) {
      f.health = Math.min(CFG.fighter.maxHealth, f.health + 38);
      f.parts.head = Math.min(100, f.parts.head + 40);
      f.parts.body = Math.min(100, f.parts.body + 40);
      f.parts.legs = Math.min(100, f.parts.legs + 40);
      f.stamina = CFG.fighter.maxStamina;
      f.drunk *= 0.6;   // the buzz carries over, mostly
      f.dead = false;
      f.downed = 0;
      f.combo = 0;
    }
    this.phase = PHASE.INTRO;
    this.phaseTimer = 2.2;
    bus.emit(EV.ROUND_START, { round: this.round });
  }

  update(dt) {
    this.hype = Math.max(0, this.hype - this.hypeDecay * dt);
    this.phaseTimer -= dt;

    switch (this.phase) {
      case PHASE.INTRO:
        if (this.phaseTimer <= 0) { this.phase = PHASE.FIGHT; bus.emit(EV.ROUND_START, { round: this.round }); }
        break;

      case PHASE.FIGHT: {
        this.clock = Math.max(0, this.clock - dt);
        // Last Call: the final stretch escalates on purpose, so every round
        // peaks instead of petering out.
        if (!this.lastCall && this.clock <= 20) {
          this.lastCall = true;
          this.damageMul = 1.35;
          for (const f of this.fighters) f.drunk = Math.min(CFG.fighter.drunk.max, f.drunk + 20);
          this.addHype(25);
          bus.emit(EV.CROWD_REACT, { level: 'lastCall' });
          bus.emit(EV.UI_STATE, { announce: 'LAST CALL' });
        }
        if (this.clock <= 0) {
          const [a, b] = this.fighters;
          this.endRound(a.health >= b.health ? 0 : 1);
        }
        break;
      }

      case PHASE.KNOCKDOWN:
        // The round clock keeps running through a knockdown, as it does in a
        // real bout; freezing it let a knockdown-heavy round last forever.
        this.clock = Math.max(0, this.clock - dt);
        if (this.phaseTimer <= 0) this.phase = PHASE.FIGHT;
        break;

      case PHASE.ROUND_END:
        if (this.phaseTimer <= 0) this.nextRound();
        break;

      case PHASE.MATCH_END:
        break;
    }
  }

  get borracheraReady() { return this.hype >= 100; }

  spendHype(amount) {
    if (this.hype < amount) return false;
    this.hype -= amount;
    return true;
  }

  dispose() { this._unsub.forEach((u) => u()); }
}
