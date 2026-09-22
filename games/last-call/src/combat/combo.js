import { TUNE } from './moves.js';
import { bus, EV } from '../core/events.js';

// The chain. Not a fixed string table: any attack cancels into any other
// inside the cancel window, and the cost of doing so climbs. A nine-hit drunk
// combo is legal and is usually how you end up on the floor with no stamina.
//
// 'base' is the link the current cost curve is measured from. A counter hit
// moves the base up to the current count, which is what "refreshes the chain
// budget" means: the combo keeps counting for the crowd, but the stamina and
// accuracy tax starts over.
export class Chain {
  constructor(owner) {
    this.owner = owner;
    this.count = 0;
    this.base = 0;
    this.timer = 0;
    this.last = null;
    this.best = 0;
  }

  get links() { return Math.max(0, this.count - this.base); }
  get staminaMul() { return 1 + TUNE.chainStamMul * this.links; }
  get accuracyMul() { return Math.pow(TUNE.chainAccMul, this.links); }
  get damageScale() { return Math.max(TUNE.chainDmgFloor, 1 - TUNE.chainDmgScale * Math.max(0, this.count - 1)); }

  connect(moveName, counter) {
    this.count++;
    this.last = moveName;
    this.timer = TUNE.chainTimeout;
    if (counter) this.base = this.count - 1; // the counter link itself stays cheap
    if (this.count > this.best) this.best = this.count;
    if (this.count > 1) bus.emit(EV.COMBO, { fighter: this.owner, count: this.count, move: moveName });
    return this.count;
  }

  // A parry hands the defender a free chain: the count survives, the tax does
  // not, so the punish combo starts from full stamina efficiency.
  refresh() { this.base = this.count; this.timer = TUNE.chainTimeout; }

  reset(reason) {
    if (this.count > 0 && reason) this.lastReset = reason;
    this.count = 0; this.base = 0; this.timer = 0; this.last = null;
  }

  update(dt) {
    if (this.count === 0) return;
    this.timer -= dt;
    if (this.timer <= 0) this.reset('timeout');
  }
}
