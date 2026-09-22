// The animation state machine. It owns two things: which base pose the body is
// playing (the locomotion blendspace or a full body clip) and which one shot
// rides on the additive channels above it. Every transition has an explicit
// blend time, and a state can only be cut short by something with at least its
// priority, which is what stops a jab from eating a knockdown.
import { CLIPS } from './clips.js';

// kind 'loco' keeps the blendspace as the base and only drives an additive
// channel; kind 'full' replaces the base with a clip.
const S = (name, d) => ({
  name,
  kind: d.kind || 'loco',
  clip: d.clip || null,           // base clip for kind 'full'
  upper: d.upper || null,         // additive clip name
  channel: d.channel || 'upper',  // which additive channel it rides on
  mask: d.mask || 'upper',
  prio: d.prio ?? 0,
  blendIn: d.blendIn ?? 0.18,
  layerIn: d.layerIn ?? d.blendIn ?? 0.09,
  layerOut: d.layerOut ?? 0.14,
  dur: d.dur ?? (d.clip ? CLIPS[d.clip].duration : d.upper ? CLIPS[d.upper].duration : 0),
  hold: !!d.hold,                 // park on the last frame instead of ending
  loop: !!d.loop,
  next: d.next || null,
  label: d.label || name
});

export const STATES = {
  idle:       S('idle', { prio: 0, blendIn: 0.26, label: 'IDLE' }),
  locomotion: S('locomotion', { prio: 0, blendIn: 0.20, label: 'LOCOMOTION' }),

  jab:      S('jab', { prio: 5, upper: 'jab', blendIn: 0.05, layerIn: 0.045, layerOut: 0.11, next: 'auto', label: 'ATTACK jab' }),
  cross:    S('cross', { prio: 5, upper: 'cross', blendIn: 0.05, layerIn: 0.05, layerOut: 0.13, next: 'auto', label: 'ATTACK cross' }),
  hook:     S('hook', { prio: 5, upper: 'hook', blendIn: 0.06, layerIn: 0.055, layerOut: 0.15, next: 'auto', label: 'ATTACK hook' }),
  uppercut: S('uppercut', { prio: 5, upper: 'uppercut', blendIn: 0.07, layerIn: 0.06, layerOut: 0.16, next: 'auto', label: 'ATTACK uppercut' }),
  kick:     S('kick', { prio: 5, upper: 'kick', mask: 'kick', blendIn: 0.07, layerIn: 0.06, layerOut: 0.17, next: 'auto', label: 'ATTACK body kick' }),

  blocking: S('blocking', { prio: 3, upper: 'block', hold: true, blendIn: 0.08, layerIn: 0.10, layerOut: 0.16, label: 'BLOCK' }),
  blockHit: S('blockHit', { prio: 6, upper: 'blockHit', channel: 'hit', mask: 'hit', layerIn: 0.02, layerOut: 0.12, next: 'auto', label: 'BLOCK impact' }),
  parry:    S('parry', { prio: 6, upper: 'parry', layerIn: 0.02, layerOut: 0.10, next: 'auto', label: 'PARRY' }),

  hitLight: S('hitLight', { prio: 7, upper: 'flinchLight', channel: 'hit', mask: 'hit', layerIn: 0.02, layerOut: 0.13, next: 'auto', label: 'HIT STUN light' }),
  hitHeavy: S('hitHeavy', { prio: 7, upper: 'flinchHeavy', channel: 'hit', mask: 'hit', layerIn: 0.02, layerOut: 0.18, next: 'auto', label: 'HIT STUN heavy' }),

  stagger:  S('stagger', { kind: 'full', clip: 'stagger', prio: 8, blendIn: 0.10, next: 'auto', label: 'STAGGER' }),
  downedBack: S('downedBack', { kind: 'full', clip: 'knockdownBack', prio: 9, blendIn: 0.07, hold: true, label: 'DOWNED back' }),
  downedFwd:  S('downedFwd', { kind: 'full', clip: 'knockdownForward', prio: 9, blendIn: 0.07, hold: true, label: 'DOWNED forward' }),
  gettingUp:  S('gettingUp', { kind: 'full', clip: 'getUp', prio: 9, blendIn: 0.16, next: 'auto', label: 'GETTING UP' }),
  ko:         S('ko', { kind: 'full', clip: 'koCollapse', prio: 11, blendIn: 0.08, hold: true, label: 'KO' }),
  victory:    S('victory', { kind: 'full', clip: 'victory', prio: 10, blendIn: 0.35, loop: true, label: 'VICTORY' }),

  taunt:    S('taunt', { prio: 2, upper: 'taunt', blendIn: 0.14, layerIn: 0.12, layerOut: 0.22, next: 'auto', label: 'TAUNT' }),
  drinking: S('drinking', { prio: 2, upper: 'drink', blendIn: 0.14, layerIn: 0.12, layerOut: 0.20, next: 'auto', label: 'DRINKING' })
};

// play() takes clip names as well as state names, because combat/fighter.js
// calls poser.play('jab') and the preview walks the whole clip roster.
export const CLIP_TO_STATE = {
  idleGuard: 'idle', idleDrunk: 'idle', walk: 'locomotion', run: 'locomotion',
  backstep: 'locomotion', strafeL: 'locomotion', strafeR: 'locomotion',
  block: 'blocking', flinchLight: 'hitLight', flinchHeavy: 'hitHeavy',
  knockdownBack: 'downedBack', knockdownForward: 'downedFwd',
  getUp: 'gettingUp', koCollapse: 'ko', drink: 'drinking',
  bodyKick: 'kick', punch: 'jab', straight: 'cross'
};

export class StateMachine {
  constructor(initial = 'idle') {
    this.cur = STATES[initial];
    this.prev = null;
    this.t = 0;          // time in the current state
    this.prevT = 0;      // the outgoing base keeps running during the crossfade
    this.blend = 1;      // 0 at the cut, 1 when the crossfade is done
    this.blendDur = 0.0001;
    this.onEnter = null; // rigposer hooks the additive channels here
    this.locked = 0;     // seconds the current state refuses to be replaced
  }

  get label() { return this.cur.label; }
  get done() {
    const d = this.cur;
    if (d.loop || d.hold) return false;
    return d.dur > 0 ? this.t >= d.dur : true;
  }

  // Returns true when the transition was taken.
  go(name, force = false) {
    const def = STATES[name];
    if (!def || def === this.cur) return false;
    if (!force && def.prio < this.cur.prio && !this.done) return false;
    if (!force && this.locked > 0 && def.prio <= this.cur.prio) return false;
    this.prev = this.cur;
    this.prevT = this.t;
    this.cur = def;
    this.t = 0;
    this.blend = 0;
    this.blendDur = Math.max(0.0001, def.blendIn);
    if (this.onEnter) this.onEnter(def, this.prev);
    return true;
  }

  // The context driven choice, lowest priority first so the last match wins.
  desired(ctx) {
    if (ctx.ko) return 'ko';
    if (ctx.downed) return ctx.downedForward ? 'downedFwd' : 'downedBack';
    if (this.cur.name === 'downedBack' || this.cur.name === 'downedFwd') return 'gettingUp';
    if (ctx.stagger) return 'stagger';
    if (ctx.stun > 0 && this.cur.prio < 6) return ctx.blocking ? 'blockHit' : (ctx.stun > 0.3 ? 'hitHeavy' : 'hitLight');
    if (ctx.blocking) return 'blocking';
    return ctx.speed > 0.22 ? 'locomotion' : 'idle';
  }

  update(dt, ctx) {
    this.t += dt;
    this.prevT += dt;
    this.locked = Math.max(0, this.locked - dt);
    if (this.blend < 1) this.blend = Math.min(1, this.blend + dt / this.blendDur);

    const want = this.desired(ctx);
    const wantDef = STATES[want];
    const cur = this.cur;

    // A finished one shot falls back to whatever the context asks for.
    if (this.done) {
      this.go(cur.next === 'auto' || !cur.next ? want : cur.next, true);
      return;
    }
    // A held state (block, downed) releases the moment its condition clears.
    if (cur.hold && cur.name === 'blocking' && !ctx.blocking) { this.go(want, true); return; }
    if (wantDef && wantDef !== cur && wantDef.prio >= cur.prio) this.go(want);
  }
}
