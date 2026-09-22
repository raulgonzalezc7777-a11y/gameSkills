// Central tuning surface. Everything a designer would want to touch lives here
// so no subsystem hides a magic number in its own file.
export const CFG = {
  render: {
    targetFps: 60,
    exposure: 1.05,
    shadowMapSize: 2048,
    maxPixelRatio: 2,
    anisotropy: 8,
    fogDensity: 0.021
  },
  post: {
    bloom: { strength: 0.85, radius: 0.72, threshold: 0.78 },
    ssao: { radius: 0.55, intensity: 1.15, bias: 0.028 },
    dof: { focusDistance: 6.0, aperture: 0.0022, maxBlur: 0.009 },
    motionBlur: { strength: 0.62, samples: 12 },
    grain: 0.055,
    vignette: 0.55,
    chromatic: 0.0021,
    grading: { lift: 0.012, gamma: 0.98, gain: 1.04, saturation: 1.12, temperature: 0.06 }
  },
  camera: {
    fov: 48,
    fovSprint: 56,
    distance: 4.35,
    height: 1.62,
    shoulder: 0.42,
    damping: 11.0,
    collisionRadius: 0.32
  },
  fighter: {
    walkSpeed: 2.05,
    runSpeed: 4.35,
    strafeMul: 0.78,
    backMul: 0.62,
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

export const QUALITY_PRESETS = {
  cinematic: { shadowMapSize: 4096, ssao: true, ssr: true, motionBlur: true, dof: true, particleBudget: 20000, crowd: 160 },
  high:      { shadowMapSize: 2048, ssao: true, ssr: true, motionBlur: true, dof: true, particleBudget: 12000, crowd: 110 },
  medium:    { shadowMapSize: 1024, ssao: true, ssr: false, motionBlur: false, dof: false, particleBudget: 6000, crowd: 60 },
  low:       { shadowMapSize: 512,  ssao: false, ssr: false, motionBlur: false, dof: false, particleBudget: 2500, crowd: 24 }
};
