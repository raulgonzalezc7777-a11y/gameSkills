import * as THREE from 'three';
import { makeRng, hashString } from '../core/rng.js';
import { clamp01, lerp, smoothstep } from '../core/math.js';

// Procedural texture foundry. Everything the game draws is generated here at
// boot: there are no image files to ship. Results are cached by key so two
// materials asking for the same map share one GPU upload.
const cache = new Map();

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return { c, ctx: c.getContext('2d', { willReadFrequently: true }) };
}

function makeTexture(cv, { repeat = 1, srgb = false, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = aniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------- noise ----

// Classic value-noise lattice with smootherstep interpolation. Tileable,
// because every lattice lookup wraps on 'period'.
export function valueNoise2D(seed = 1, period = 8) {
  const rng = makeRng(seed);
  const grid = new Float32Array(period * period);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  const at = (x, y) => grid[((y % period) + period) % period * period + (((x % period) + period) % period)];
  return (u, v) => {
    const x = u * period, y = v * period;
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const sx = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const sy = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const n00 = at(xi, yi), n10 = at(xi + 1, yi), n01 = at(xi, yi + 1), n11 = at(xi + 1, yi + 1);
    return lerp(lerp(n00, n10, sx), lerp(n01, n11, sx), sy);
  };
}

export function fbm2D(seed = 1, octaves = 5, basePeriod = 4, gain = 0.5, lacunarity = 2) {
  const layers = [];
  let p = basePeriod, amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    layers.push({ n: valueNoise2D(seed + o * 7919, Math.max(2, Math.round(p))), amp });
    norm += amp; amp *= gain; p *= lacunarity;
  }
  return (u, v) => {
    let s = 0;
    for (const l of layers) s += l.n(u, v) * l.amp;
    return s / norm;
  };
}

// Worley / cellular noise, tileable. Returns F1 distance in 0..1.
export function worley2D(seed = 1, cells = 8) {
  const rng = makeRng(seed);
  const pts = [];
  for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) pts.push([(x + rng()) / cells, (y + rng()) / cells]);
  return (u, v) => {
    let best = 1e9;
    for (const p of pts) {
      let dx = Math.abs(u - p[0]); if (dx > 0.5) dx = 1 - dx;
      let dy = Math.abs(v - p[1]); if (dy > 0.5) dy = 1 - dy;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    return clamp01(Math.sqrt(best) * cells * 0.9);
  };
}

// --------------------------------------------------------------- writers ---

// Fill a canvas from a per-pixel callback returning [r,g,b] in 0..255.
export function paint(size, fn) {
  const { c, ctx } = canvas(size);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const col = fn(x / size, y / size, x, y);
      d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = col[3] ?? 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Derive a tangent-space normal map from a height callback via central
// differences. 'strength' scales the slope.
export function normalFromHeight(size, heightFn, strength = 2.0) {
  const e = 1 / size;
  return paint(size, (u, v) => {
    const hL = heightFn(u - e, v), hR = heightFn(u + e, v);
    const hD = heightFn(u, v - e), hU = heightFn(u, v + e);
    let nx = (hL - hR) * strength, ny = (hD - hU) * strength, nz = 1;
    const len = Math.hypot(nx, ny, nz);
    nx /= len; ny /= len; nz /= len;
    return [(nx * 0.5 + 0.5) * 255, (ny * 0.5 + 0.5) * 255, (nz * 0.5 + 0.5) * 255];
  });
}

// Pack roughness into G and metalness into B, the glTF convention Three.js
// reads when the same texture is used for both maps.
export function packORM(size, aoFn, roughFn, metalFn) {
  return paint(size, (u, v) => [
    clamp01(aoFn(u, v)) * 255,
    clamp01(roughFn(u, v)) * 255,
    clamp01(metalFn(u, v)) * 255
  ]);
}

// ------------------------------------------------------------- libraries ---

const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const hex = (h) => { const c = new THREE.Color(h); return [c.r * 255, c.g * 255, c.b * 255]; };

export const TEX = {
  // Human skin: base tone with blotchy subdermal variation and pore detail.
  skin(color = '#c98d6b', seed = 3, size = 512) {
    const key = `skin:${color}:${seed}:${size}`;
    if (cache.has(key)) return cache.get(key);
    const base = hex(color);
    const blotch = fbm2D(seed, 4, 3, 0.55);
    const pores = fbm2D(seed + 101, 3, 42, 0.5);
    const veins = fbm2D(seed + 55, 3, 7, 0.6);
    const map = makeTexture(paint(size, (u, v) => {
      const b = blotch(u, v);
      const p = pores(u, v);
      let col = mix(base, mix(base, hex('#8c4a3a'), 0.55), smoothstep((b - 0.45) * 2.4));
      col = mix(col, hex('#d9a988'), smoothstep((0.55 - b) * 1.8) * 0.35);
      col = mix(col, hex('#6f4b6e'), clamp01(veins(u, v) - 0.72) * 0.5);
      const sh = 1 - (p - 0.5) * 0.14;
      return [col[0] * sh, col[1] * sh, col[2] * sh];
    }), { srgb: true, repeat: 1 });
    const h = (u, v) => pores(u, v) * 0.55 + blotch(u, v) * 0.45;
    const normal = makeTexture(normalFromHeight(size, h, 1.5));
    const rough = fbm2D(seed + 7, 3, 6, 0.5);
    const orm = makeTexture(packORM(size, (u, v) => 0.82 + blotch(u, v) * 0.18,
      (u, v) => 0.38 + rough(u, v) * 0.30, () => 0));
    const out = { map, normal, orm };
    cache.set(key, out);
    return out;
  },

  // Woven cloth: a visible warp/weft plus fibre fuzz.
  fabric(color = '#2b3a55', seed = 9, size = 512, weave = 128) {
    const key = `fabric:${color}:${seed}:${size}:${weave}`;
    if (cache.has(key)) return cache.get(key);
    const base = hex(color);
    const fuzz = fbm2D(seed, 4, 24, 0.55);
    const wear = fbm2D(seed + 31, 4, 3, 0.6);
    const weaveFn = (u, v) => {
      const a = Math.sin(u * weave * Math.PI) * 0.5 + 0.5;
      const b = Math.sin(v * weave * Math.PI) * 0.5 + 0.5;
      return (a * 0.5 + b * 0.5);
    };
    const map = makeTexture(paint(size, (u, v) => {
      const w = weaveFn(u, v);
      const f = fuzz(u, v);
      const shade = 0.78 + w * 0.28 + (f - 0.5) * 0.18;
      const faded = mix(base, [base[0] * 1.35 + 20, base[1] * 1.35 + 20, base[2] * 1.35 + 20],
        clamp01((wear(u, v) - 0.62) * 2.2) * 0.5);
      return [faded[0] * shade, faded[1] * shade, faded[2] * shade];
    }), { srgb: true });
    const normal = makeTexture(normalFromHeight(size, (u, v) => weaveFn(u, v) * 0.7 + fuzz(u, v) * 0.3, 2.6));
    const orm = makeTexture(packORM(size, (u, v) => 0.72 + weaveFn(u, v) * 0.28,
      (u, v) => 0.80 + fuzz(u, v) * 0.18, () => 0));
    const out = { map, normal, orm };
    cache.set(key, out);
    return out;
  },

  // Bar-top hardwood: grain rings, plank seams, lacquer sheen.
  wood(color = '#5b3a22', seed = 17, size = 512, planks = 5) {
    const key = `wood:${color}:${seed}:${size}`;
    if (cache.has(key)) return cache.get(key);
    const base = hex(color);
    const warp = fbm2D(seed, 4, 3, 0.6);
    const fine = fbm2D(seed + 13, 3, 30, 0.5);
    const grain = (u, v) => {
      const plank = Math.floor(v * planks);
      const off = (plank * 0.37) % 1;
      const w = warp(u * 0.6 + off, v * 3) * 0.35;
      return Math.abs(Math.sin((u * 9 + w * 6 + off * 5) * Math.PI)) * 0.7 + fine(u * 2, v * 8) * 0.3;
    };
    const seam = (u, v) => {
      const f = (v * planks) % 1;
      return smoothstep(Math.min(f, 1 - f) * 28);
    };
    const map = makeTexture(paint(size, (u, v) => {
      const g = grain(u, v);
      const s = seam(u, v);
      let col = mix(mix(base, hex('#2a1a10'), 0.62), base, g);
      col = mix(hex('#120a06'), col, 0.25 + s * 0.75);
      return col;
    }), { srgb: true });
    const normal = makeTexture(normalFromHeight(size, (u, v) => grain(u, v) * 0.5 + seam(u, v) * 0.5, 1.8));
    const orm = makeTexture(packORM(size, (u, v) => 0.7 + seam(u, v) * 0.3,
      (u, v) => 0.18 + grain(u, v) * 0.22, () => 0.05));
    const out = { map, normal, orm };
    cache.set(key, out);
    return out;
  },

  // Scuffed painted concrete for walls and the venue floor.
  concrete(color = '#1a1c24', seed = 23, size = 512) {
    const key = `concrete:${color}:${seed}:${size}`;
    if (cache.has(key)) return cache.get(key);
    const base = hex(color);
    const blob = fbm2D(seed, 5, 4, 0.55);
    const grit = fbm2D(seed + 77, 3, 64, 0.5);
    const cracks = worley2D(seed + 5, 6);
    const map = makeTexture(paint(size, (u, v) => {
      const b = blob(u, v), g = grit(u, v);
      const c = 1 - smoothstep(cracks(u, v) * 7);
      let col = mix(base, mix(base, hex('#43464f'), 0.8), b);
      col = mix(col, hex('#07080b'), c * 0.55);
      const sh = 0.86 + g * 0.26;
      return [col[0] * sh, col[1] * sh, col[2] * sh];
    }), { srgb: true, repeat: 1 });
    const normal = makeTexture(normalFromHeight(size,
      (u, v) => blob(u, v) * 0.5 + grit(u, v) * 0.3 - (1 - smoothstep(cracks(u, v) * 7)) * 0.5, 2.2));
    const orm = makeTexture(packORM(size, (u, v) => 0.6 + blob(u, v) * 0.4,
      (u, v) => 0.72 + grit(u, v) * 0.24, () => 0.0));
    const out = { map, normal, orm };
    cache.set(key, out);
    return out;
  },

  // Brushed or polished metal for the truss, speakers and bar rail.
  metal(color = '#8d9199', seed = 31, size = 512, brushed = true) {
    const key = `metal:${color}:${seed}:${size}:${brushed}`;
    if (cache.has(key)) return cache.get(key);
    const base = hex(color);
    const streak = fbm2D(seed, 3, 96, 0.5);
    const dirt = fbm2D(seed + 91, 4, 5, 0.6);
    const h = (u, v) => (brushed ? streak(u * 0.06, v * 3) : streak(u, v)) * 0.6 + dirt(u, v) * 0.4;
    const map = makeTexture(paint(size, (u, v) => {
      const s = brushed ? streak(u * 0.06, v * 3) : streak(u, v);
      const d = dirt(u, v);
      const sh = 0.78 + s * 0.34;
      let col = mix(base, hex('#20232a'), clamp01((d - 0.62) * 2.4) * 0.6);
      return [col[0] * sh, col[1] * sh, col[2] * sh];
    }), { srgb: true });
    const normal = makeTexture(normalFromHeight(size, h, 1.3));
    const orm = makeTexture(packORM(size, () => 1.0,
      (u, v) => 0.18 + dirt(u, v) * 0.42, () => 0.95));
    const out = { map, normal, orm };
    cache.set(key, out);
    return out;
  },

  // Soft radial sprite used by every particle system and light bloom card.
  glow(size = 128, hardness = 2.4) {
    const key = `glow:${size}:${hardness}`;
    if (cache.has(key)) return cache.get(key);
    const { c, ctx } = canvas(size);
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      g.addColorStop(t, `rgba(255,255,255,${Math.pow(1 - t, hardness)})`);
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    cache.set(key, t);
    return t;
  },

  // Generic splat used for sweat droplets, blood and beer.
  droplet(size = 64) {
    const key = `droplet:${size}`;
    if (cache.has(key)) return cache.get(key);
    const { c, ctx } = canvas(size);
    ctx.clearRect(0, 0, size, size);
    const g = ctx.createRadialGradient(size * 0.42, size * 0.38, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.85)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(size / 2, size / 2, size * 0.42, size * 0.48, 0, 0, Math.PI * 2);
    ctx.fill();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    cache.set(key, t);
    return t;
  }
};

// Apply a TEX bundle to a MeshStandardMaterial in one call.
export function applyPBR(mat, bundle, repeat = 1, aniso = 8) {
  if (!bundle) return mat;
  const setRepeat = (t) => { if (t) { t.repeat.set(repeat, repeat); t.anisotropy = aniso; t.needsUpdate = true; } };
  mat.map = bundle.map; mat.normalMap = bundle.normal;
  mat.roughnessMap = bundle.orm; mat.metalnessMap = bundle.orm; mat.aoMap = bundle.orm;
  [mat.map, mat.normalMap, mat.roughnessMap].forEach(setRepeat);
  mat.needsUpdate = true;
  return mat;
}

export function clearTextureCache() {
  for (const v of cache.values()) {
    if (v.dispose) v.dispose();
    else Object.values(v).forEach((t) => t.dispose?.());
  }
  cache.clear();
}
