// The single source of truth for frame data, the buzz curve and the combat
// tunables. Nothing else in src/combat hard-codes a number that a designer
// would want to move.
//
// Frame data is authored in 60 Hz frames because that is how a fighting game
// designer thinks, and converted to seconds once at module load. 'startup' is
// the wind-up, 'active' is the window where the hitbox is live, 'recovery' is
// the tail you are punishable in. 'cancel' is how long after contact the move
// can be cancelled into another one.

const F = 1 / 60;

// limb: which bone drives the hitbox and anchors its capsule. extend is the
// slack past the bone. hitR is the capsule radius. level picks the reaction.
// The far end of the capsule is authored in fighter space (reach, hitY) the way
// a fighting game authors hitboxes, so the move has the range the table says
// even while another owner is rewriting the poser under us.
const RAW = {
  // name        st  ac  rc   dmg  stam reach push level     limb     extend hitR cancel guard  type     hitY
  jab:        [  5,  3,  9,   5.5,  5,  1.30, 1.2, 'light',  'handL', 0.16, 0.11, 0.30, 'high', 'strike', 1.52],
  cross:      [  8,  4, 13,  10.0,  9,  1.45, 2.4, 'mid',    'handR', 0.18, 0.12, 0.26, 'high', 'strike', 1.52],
  hook:       [ 10,  5, 17,  13.5, 12,  1.28, 3.0, 'heavy',  'handL', 0.20, 0.14, 0.22, 'high', 'strike', 1.46],
  uppercut:   [ 13,  6, 21,  17.0, 16,  1.15, 3.6, 'launch', 'handR', 0.20, 0.15, 0.20, 'high', 'strike', 1.40],
  kick:       [ 12,  6, 19,  14.0, 14,  1.70, 3.2, 'mid',    'footR', 0.24, 0.15, 0.18, 'low',  'strike', 1.05],

  // Clinch tools. Reached through G, not through the attack buttons.
  knee:       [  7,  4, 11,   9.0,  8,  0.95, 1.0, 'mid',    'footL', 0.14, 0.13, 0.24, 'mid',  'grapple', 1.05],
  toss:       [ 11,  5, 26,  12.0, 20,  1.00, 6.4, 'slam',   'handR', 0.16, 0.18, 0.00, 'mid',  'grapple', 1.15],

  // Prop movesets. A weapon in hand trades speed for reach and damage, and the
  // prop itself is consumed by the heavy ones.
  glassJab:   [  5,  3, 10,   7.0,  5,  1.34, 1.3, 'light',  'handR', 0.18, 0.11, 0.28, 'high', 'prop', 1.50],
  glassSmash: [  9,  4, 18,  13.0, 10,  1.36, 2.2, 'heavy',  'handR', 0.20, 0.14, 0.20, 'high', 'prop', 1.46],
  bottleJab:  [  6,  3, 11,   8.0,  6,  1.48, 1.6, 'light',  'handR', 0.26, 0.12, 0.28, 'high', 'prop', 1.50],
  bottleSwing:[ 10,  5, 16,  15.0, 11,  1.52, 3.0, 'heavy',  'handR', 0.28, 0.15, 0.22, 'high', 'prop', 1.46],
  bottleSmash:[ 14,  6, 24,  21.0, 15,  1.46, 4.0, 'launch', 'handR', 0.28, 0.17, 0.16, 'high', 'prop', 1.50],
  stoolSwing: [ 15,  7, 25,  22.0, 19,  1.78, 5.2, 'heavy',  'handR', 0.42, 0.20, 0.14, 'mid',  'prop', 1.36],
  stoolSlam:  [ 20,  8, 33,  28.0, 26,  1.62, 6.0, 'slam',   'handR', 0.40, 0.22, 0.00, 'high', 'prop', 1.58],
  // Throws. 'active' is the release frame, the damage number is what the prop
  // does when it connects downrange.
  glassThrow: [  8,  2, 14,   9.0,  6,  9.00, 2.0, 'light',  'handR', 0.10, 0.09, 0.00, 'high', 'throw', 1.35],
  bottleThrow:[  9,  2, 16,  13.0,  7, 11.00, 2.6, 'mid',    'handR', 0.10, 0.10, 0.00, 'high', 'throw', 1.35],
  stoolThrow: [ 14,  3, 24,  19.0, 12,  9.00, 4.0, 'heavy',  'handR', 0.12, 0.12, 0.00, 'mid',  'throw', 1.35],

  // Borrachera beats. Scripted, so startup is short and they never whiff for
  // spacing reasons, only because the target is already on the floor.
  borraRush:  [  6,  6, 10,   9.0,  0,  2.10, 2.0, 'mid',    'handL', 0.24, 0.20, 0.40, 'high', 'super', 1.50],
  borraSmack: [  5,  5,  9,  11.0,  0,  1.90, 2.6, 'heavy',  'handR', 0.24, 0.20, 0.40, 'high', 'super', 1.50],
  borraHead:  [  7,  6, 12,  14.0,  0,  1.60, 3.4, 'heavy',  'head',  0.18, 0.22, 0.40, 'high', 'super', 1.56],
  borraSpin:  [  6,  8, 12,  12.0,  0,  2.00, 3.0, 'heavy',  'footR', 0.30, 0.24, 0.40, 'low',  'super', 1.02],
  borraFinish:[ 10,  8, 30,  26.0,  0,  2.00, 8.0, 'slam',   'handR', 0.30, 0.26, 0.00, 'high', 'super', 1.50]
};

function build() {
  const out = {};
  for (const [name, r] of Object.entries(RAW)) {
    const startupF = r[0], activeF = r[1], recoverF = r[2];
    out[name] = {
      name,
      startupF, activeF, recoverF,
      startup: startupF * F,
      active: activeF * F,
      recover: recoverF * F,
      total: (startupF + activeF + recoverF) * F,
      dmg: r[3],
      stam: r[4],
      reach: r[5],
      push: r[6],
      level: r[7],
      limb: r[8],
      extend: r[9],
      hitR: r[10],
      cancel: r[11],
      guard: r[12],
      type: r[13],
      // Authored hitbox height in metres off the floor. The capsule runs from
      // the limb bone to a point at this height, 'reach' metres ahead, which is
      // how a body kick hits the body while the foot is down at ankle height.
      hitY: r[14],
      // Kept for the old call sites that read cfg.part directly.
      part: r[12] === 'low' ? 'legs' : r[12] === 'mid' ? 'body' : 'head'
    };
  }
  return out;
}

export const MOVES = build();

// The five attack buttons, in the order the HUD and the AI name them.
export const STRIKES = ['jab', 'cross', 'hook', 'uppercut', 'kick'];

// Frozen export: fighter.js used to own this table and match.js/ai read it.
export const ATTACKS = MOVES;

export const PARTS = ['head', 'body', 'legs'];

// A prop in hand swaps the whole button layout. Anything missing here falls
// through to the bare-handed move.
export const PROP_MOVES = {
  glass: { jab: 'glassJab', cross: 'glassJab', hook: 'glassSmash', uppercut: 'glassSmash' },
  bottle: { jab: 'bottleJab', cross: 'bottleSwing', hook: 'bottleSwing', uppercut: 'bottleSmash' },
  stool: { jab: 'stoolSwing', cross: 'stoolSwing', hook: 'stoolSwing', uppercut: 'stoolSlam', kick: 'stoolSwing' }
};

export function moveFor(action, propType) {
  const swap = propType && PROP_MOVES[propType] && PROP_MOVES[propType][action];
  return MOVES[swap || action] || null;
}

// The buzz curve, straight off the design table. Bands are exact rather than
// interpolated: a designer who writes "+32% at Lit" wants +32% at Lit, and the
// step is something the player can feel and learn.
//
// power    damage multiplier
// accuracy fraction of the aim that survives, the rest becomes spatial error
// balance  1 = perfect footing, 0 = falling over
// pain     incoming damage is divided by this
// hype     crowd hype generated is multiplied by this
export const BUZZ_TIERS = [
  { upTo: 25,  name: 'SOBER',   power: 1.00, accuracy: 1.00, balance: 1.00, pain: 1.00, hype: 0.70, stumble: 0.00, whiffFall: 0.00 },
  { upTo: 50,  name: 'LOOSE',   power: 1.15, accuracy: 0.92, balance: 0.88, pain: 1.08, hype: 1.00, stumble: 0.00, whiffFall: 0.00 },
  { upTo: 72,  name: 'LIT',     power: 1.32, accuracy: 0.78, balance: 0.70, pain: 1.16, hype: 1.45, stumble: 0.00, whiffFall: 0.00 },
  { upTo: 90,  name: 'WASTED',  power: 1.45, accuracy: 0.66, balance: 0.50, pain: 1.22, hype: 1.85, stumble: 0.46, whiffFall: 0.05 },
  { upTo: 1e9, name: 'LEGLESS', power: 1.55, accuracy: 0.58, balance: 0.30, pain: 1.28, hype: 2.30, stumble: 0.85, whiffFall: 0.22 }
];

export function buzzTier(buzz) {
  for (let i = 0; i < BUZZ_TIERS.length; i++) if (buzz < BUZZ_TIERS[i].upTo) return BUZZ_TIERS[i];
  return BUZZ_TIERS[BUZZ_TIERS.length - 1];
}

// Everything the combat modules tune against. Lives here rather than in
// core/config.js because combat owns these files and nothing else reads them.
export const TUNE = {
  // Hitboxes
  reachScale: 0.78,        // authored point sits this far along 'reach'

  // Chains
  chainWindow: 0.28,        // matches input.bufferWindow, the buffer is the window
  chainTimeout: 0.85,       // a chain that goes quiet resets
  chainStamMul: 0.30,       // each link costs this much more, compounding
  chainAccMul: 0.90,        // each link multiplies accuracy by this
  chainDmgScale: 0.075,     // damage scaling per link, standard fighter practice
  chainDmgFloor: 0.50,
  counterMul: 1.6,          // hitting during the opponent's startup
  counterHype: 8,

  // Defence
  blockReduction: 0.78,     // the design doc number
  blockStamPerDamage: 1.35,
  guardMax: 100,
  guardRegen: 16,
  guardBreakStun: 0.95,
  parryWindow: 0.12,        // block pressed this recently when contact lands
  parryStun: 0.62,
  parryHype: 9,
  dodgeDuration: 0.42,
  dodgeIFrames: [0.05, 0.27],
  dodgeStam: 17,
  dodgeSpeed: 6.4,

  // The signature mechanic. A lurch is cheap, a lurch that saves you is not.
  lurchDuration: 0.5,
  lurchIFrames: [0.06, 0.34],
  lurchCooldown: 1.6,
  graceHype: 16,
  graceSlowmo: { duration: 0.75, scale: 0.34 },

  // Damage. Tuned from a keyboard playtest, not from the table: at the old
  // values the player lost three quarters of their health in eight seconds and
  // the head pool emptied so fast that nearly every clean shot was a knockdown.
  damageScale: 0.46,        // one global lever, so a round lasts about a minute
  partDamageMul: 1.05,      // per-limb pools drain faster than the health bar
  knockdownPerDamage: 0.0042,
  headKnockdownBias: 0.14,
  hitstunPerDamage: 0.011,
  chipMul: 0.22,

  // Per-limb consequences, straight from the design doc
  legsSpeedFloor: 0.55,
  legsSwayGain: 0.85,
  bodyStamFloor: 0.40,
  headFlashGain: 0.45,

  // Resources
  drinkBuzz: 14, drinkStam: 18, drinkHeal: 4, drinkLock: 0.55,
  tauntLock: 0.8, tauntHype: 12,
  buzzBurnPerHit: 0.20,     // a clean hit sobers you a little
  exhaustedDmg: 0.72,

  // Grapple
  clinchRange: 1.15,
  clinchMax: 2.2,
  clinchBreak: 0.55,

  // Props
  propReach: 2.4,
  propThrowSpeed: 13.5,
  propRestock: 7.0,
  propHype: 6,

  // Borrachera
  borracheraCost: 100,
  borracheraFloor: 0.96   // the top of the meter counts as full, see borrachera.js
};

// Hitbox and hurtbox geometry. Radii are metres, zones name what was struck.
// bias makes a clean head or body hit win over a graze on the arm that happens
// to be marginally closer, which is how a human reads the same frame.
export const HURTBOXES = [
  { zone: 'head',  part: 'head', a: 'neck',      b: 'head',     r: 0.145, up: 0.12, dmg: 1.35, bias: 0.06 },
  { zone: 'torso', part: 'body', a: 'hips',      b: 'chest',    r: 0.250, up: 0.06, dmg: 1.00, bias: 0.04 },
  { zone: 'armL',  part: 'body', a: 'upperArmL', b: 'forearmL', r: 0.095, up: 0,    dmg: 0.50, bias: -0.03 },
  { zone: 'foreL', part: 'body', a: 'forearmL',  b: 'handL',    r: 0.085, up: 0,    dmg: 0.42, bias: -0.03 },
  { zone: 'armR',  part: 'body', a: 'upperArmR', b: 'forearmR', r: 0.095, up: 0,    dmg: 0.50, bias: -0.03 },
  { zone: 'foreR', part: 'body', a: 'forearmR',  b: 'handR',    r: 0.085, up: 0,    dmg: 0.42, bias: -0.03 },
  { zone: 'thighL', part: 'legs', a: 'thighL',   b: 'shinL',    r: 0.115, up: 0,    dmg: 0.80, bias: 0 },
  { zone: 'shinL', part: 'legs', a: 'shinL',     b: 'footL',    r: 0.090, up: 0,    dmg: 0.70, bias: 0 },
  { zone: 'thighR', part: 'legs', a: 'thighR',   b: 'shinR',    r: 0.115, up: 0,    dmg: 0.80, bias: 0 },
  { zone: 'shinR', part: 'legs', a: 'shinR',     b: 'footR',    r: 0.090, up: 0,    dmg: 0.70, bias: 0 }
];
