import * as THREE from 'three';
import { fbm2D, paint } from './texlib.js';
import { clamp01, lerp, smoothstep } from '../core/math.js';

// Without an environment map every PBR material in the room falls back to pure
// black wherever a light does not directly reach it, which is most of a
// nightclub. This builds an equirectangular sky from the venue's own palette,
// runs it through PMREM, and hands back a prefiltered cubemap. It costs one
// texture and it is the difference between "dark and moody" and "broken".
const PALETTE = [
  { y: 0.00, c: [0.030, 0.026, 0.042] },  // floor bounce, near black violet
  { y: 0.34, c: [0.085, 0.040, 0.105] },  // the room, lit by the bar
  { y: 0.50, c: [0.140, 0.055, 0.130] },  // horizon: where the neon lives
  { y: 0.62, c: [0.060, 0.090, 0.135] },  // cool upper wall
  { y: 1.00, c: [0.018, 0.022, 0.038] }   // ceiling
];

function sampleRamp(y) {
  for (let i = 1; i < PALETTE.length; i++) {
    if (y <= PALETTE[i].y) {
      const a = PALETTE[i - 1], b = PALETTE[i];
      const t = smoothstep((y - a.y) / Math.max(1e-5, b.y - a.y));
      return [lerp(a.c[0], b.c[0], t), lerp(a.c[1], b.c[1], t), lerp(a.c[2], b.c[2], t)];
    }
  }
  return PALETTE[PALETTE.length - 1].c;
}

// Four bright bands around the horizon stand in for the neon strips, the bar
// back-light and the stage. Chrome and the bar top pick these up as streaks,
// which is what makes a metal read as metal in a dark room.
const SOURCES = [
  { u: 0.08, w: 0.05, c: [3.2, 0.5, 1.3] },   // pink
  { u: 0.33, w: 0.04, c: [0.3, 2.2, 2.9] },   // cyan
  { u: 0.56, w: 0.07, c: [2.6, 1.9, 0.5] },   // gold, the bar
  { u: 0.81, w: 0.035, c: [1.6, 0.5, 2.8] }   // violet
];

export function buildEnvironment(renderer) {
  const W = 256, H = 128;
  const grime = fbm2D(4242, 4, 5, 0.6);

  const canvas = paint(W, (u, v) => {
    // paint() is square, so the vertical coordinate is remapped to the
    // equirect latitude below when the texture is sampled with repeat.
    const y = 1 - v;
    const base = sampleRamp(y);
    let r = base[0], g = base[1], b = base[2];

    // Horizon glow bands.
    const band = Math.exp(-Math.pow((y - 0.5) / 0.12, 2));
    for (const s of SOURCES) {
      let du = Math.abs(u - s.u);
      if (du > 0.5) du = 1 - du;
      const falloff = Math.exp(-Math.pow(du / s.w, 2));
      const k = falloff * band;
      r += s.c[0] * k; g += s.c[1] * k; b += s.c[2] * k;
    }

    // A little mottling so a mirror does not reflect perfectly flat colour.
    const n = 0.85 + grime(u * 2, v * 2) * 0.3;
    r *= n; g *= n; b *= n;

    // The canvas is 8 bit, so the bright sources are tone-mapped down here and
    // scaled back up by envMapIntensity on the materials.
    const enc = (x) => Math.round(clamp01(x / (1 + x)) * 255);
    return [enc(r), enc(g), enc(b)];
  });

  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const rt = pmrem.fromEquirectangular(tex);
  pmrem.dispose();
  tex.dispose();
  return rt.texture;
}
