// Central tuning surface. Everything a designer would want to touch lives here
// so no subsystem hides a magic number in its own file.
export const CFG = {
  render: {
    targetFps: 60,
    exposure: 1.32,
    shadowMapSize: 2048,
    maxPixelRatio: 2,
    anisotropy: 8,
    fogDensity: 0.021
  },
  post: {
    bloom: { strength: 0.9, radius: 0.78, threshold: 1.05 },
    ssao: { radius: 0.55, intensity: 1.15, bias: 0.028 },
    dof: { focusDistance: 5.0, aperture: 0.0022, maxBlur: 0.007, focusRange: 1.6, nearRange: 2.6, farRange: 16.0 },
    motionBlur: { strength: 0.62, samples: 12 },
    grain: 0.026,
    vignette: 0.38,
    chromatic: 0.0021,
    grading: { lift: 0.008, gamma: 1.0, gain: 1.02, saturation: 0.94, temperature: 0.05 }
  },
  camera: {
    fov: 44,
    fovSprint: 52,
    distance: 4.6,
    height: 0.35,
    pitch: 0.2,
    shoulder: 0,
    orbitOffset: 1.22,       // radians off the line behind the player: nearly side-on
    damping: 11.0,
    collisionRadius: 0.32
  },
  fighter: {
    walkSpeed: 3.3,
    runSpeed: 5.4,
    strafeMul: 0.95,
    backMul: 0.85,
    turnRate: 9.5,
    mass: 82,
    height: 1.82,
    radius: 0.31,
    maxHealth: 100,
    maxStamina: 100,
    staminaRegen: 13.5,
    // Drunkenness is the core mechanic: it buffs power and pain tolerance but
    // wrecks accuracy, balance and camera stability.
    drunk: {
      max: 100,
      start: 35,
      decayPerSec: 0.55,
      perSip: 14,
      powerBonusAt100: 0.55,
      accuracyPenaltyAt100: 0.42,
      swayAt100: 0.65,
      stumbleThreshold: 72
    }
  },
  match: { rounds: 3, roundSeconds: 99, ko: { countSeconds: 10 } },
  time: { hitstopMax: 0.18, slowmoScale: 0.22 },
  audio: { master: 0.85, music: 0.5, sfx: 0.9, crowd: 0.55 }
};

// The physics comedy. Every number here is a dial on how silly the fight is.
export const BRAWL = {
  whiffSpin: 2.2, burpLean: 26,
  drunkWeakness: 0.62,     // share of muscle lost at full buzz
  looseLimbs: 0.55,        // arms and head run softer, so they swing and bobble
  punchTense: 4.2,         // how hard the striking arm tenses for the punch
  punchPull: 420,          // how hard a live punch drags the fist at its target
  staggerStrength: 0.22,   // muscle left while reeling from a clean hit
  wobble: 1.9,             // drunk sway torque
  rootSpring: 90,          // how hard the hips chase the animation
  chestSpring: 45,         // keeps a sagging drunk from folding in half
  hiccup: 55,              // upward jolt of a hiccup, newton seconds
  fallTilt: 0.8,          // chest tilt in radians that ends in a fall
  hitImpulse: 11,         // impulse per point of damage on the part hit
  launchPerDamage: 0.42,   // whole-body velocity per point on heavy blows
  heavyHit: 9,            // damage above which a blow launches the body
  knockdownLaunch: [6, 5],   // horizontal, vertical metres per second
  koLaunch: [8.5, 7]
};

export const QUALITY_PRESETS = {
  // pixelRatio caps the render resolution relative to the screen, which is the
  // single biggest lever on cost: the post stack is a dozen fullscreen passes.
  cinematic: { pixelRatio: 2, shadowMapSize: 4096, ssao: true, ssr: true, motionBlur: true, dof: true, particleBudget: 20000, crowd: 160 },
  high:      { pixelRatio: 1.5, shadowMapSize: 2048, ssao: true, ssr: true, motionBlur: true, dof: true, particleBudget: 12000, crowd: 190 },
  medium:    { pixelRatio: 1, shadowMapSize: 1024, ssao: true, ssr: true, motionBlur: false, dof: true, particleBudget: 6000, crowd: 120 },
  // Phones: a sharp picture (the screen is small and close to the eye) with
  // every fullscreen pass that costs a phone its frame rate turned off.
  phone:     { pixelRatio: 1.5, shadowMapSize: 1024, ssao: false, ssr: false, motionBlur: false, dof: false, particleBudget: 3000, crowd: 70 },
  low:       { pixelRatio: 0.75, shadowMapSize: 512,  ssao: false, ssr: false, motionBlur: false, dof: false, particleBudget: 2500, crowd: 24 }
};
