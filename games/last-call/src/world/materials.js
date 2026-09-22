import * as THREE from 'three';
import { TEX, applyPBR, paint, normalFromHeight, packORM, fbm2D, worley2D } from '../render/texlib.js';
import { clamp01, lerp, smoothstep } from '../core/math.js';

// The venue's material library. Everything is generated once at boot and shared
// by reference, because a dive bar is built from six surfaces repeated fifty
// times: painted brick, grimy plaster, dark lacquered wood, dull brass, black
// speaker vinyl and glass. Sharing them keeps the draw-call state changes low.

const cache = new Map();
const memo = (key, fn) => {
  let v = cache.get(key);
  if (!v) { v = fn(); cache.set(key, v); }
  return v;
};

function tex(cv, repeat = 1, srgb = false, aniso = 8) {
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = aniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const rgb = (h) => { const c = new THREE.Color(h); return [c.r * 255, c.g * 255, c.b * 255]; };

// Cheap deterministic 2D hash, used to give each brick its own tone without
// burning an rng stream that other systems also draw from.
function hash2(x, y) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ------------------------------------------------------------------ brick ---

// Running-bond brickwork with mortar, per-brick tone variation, soot creeping
// up from the floor and nicotine staining. Walls are half the screen in a
// third-person fight, so they get the most authored texture of anything here.
export function brickBundle(size = 512, rows = 14, cols = 7, seed = 41) {
  return memo(`brick:${size}:${rows}:${cols}:${seed}`, () => {
    const grit = fbm2D(seed + 3, 3, 48, 0.5);
    const grime = fbm2D(seed + 17, 5, 3, 0.58);
    const chip = worley2D(seed + 29, 14);

    const brickCoord = (u, v) => {
      const ry = v * rows;
      const row = Math.floor(ry);
      const fy = ry - row;
      const rx = u * cols + (row % 2 === 0 ? 0 : 0.5);
      const col = Math.floor(rx);
      const fx = rx - col;
      return { row, col, fx, fy };
    };
    const mortarMask = (u, v) => {
      const { fx, fy } = brickCoord(u, v);
      const mx = smoothstep(Math.min(fx, 1 - fx) / 0.055);
      const my = smoothstep(Math.min(fy, 1 - fy) / 0.13);
      return 1 - Math.min(mx, my);
    };
    const height = (u, v) => {
      const m = mortarMask(u, v);
      const { row, col } = brickCoord(u, v);
      const nudge = hash2(col, row) * 0.12;
      const c = 1 - smoothstep(chip(u, v) * 9);
      return (1 - m) * (0.78 + nudge) - c * 0.35 + grit(u, v) * 0.1;
    };

    const dark = rgb('#241b1a');
    const mortar = rgb('#3b3833');
    const map = tex(paint(size, (u, v) => {
      const { row, col } = brickCoord(u, v);
      const h = hash2(col, row);
      const h2 = hash2(col + 91, row + 17);
      // Fired clay reads as a family of muddy reds and greys, never one colour.
      let base = mix3(rgb('#5e2b26'), rgb('#3a2b2c'), h);
      base = mix3(base, rgb('#6b3a24'), h2 * 0.5);
      const m = mortarMask(u, v);
      let col3 = mix3(base, mortar, m);
      // Soot rises from the floor, nicotine settles from the ceiling.
      col3 = mix3(col3, dark, clamp01(1.25 - v * 1.7) * 0.55 * (0.5 + grime(u, v)));
      col3 = mix3(col3, rgb('#6a5a38'), clamp01(grime(u * 0.7, v * 0.7) - 0.5) * 0.3);
      const g = 0.84 + grit(u, v) * 0.3;
      return [col3[0] * g, col3[1] * g, col3[2] * g];
    }), 1, true);

    const normal = tex(normalFromHeight(size, height, 2.6));
    const orm = tex(packORM(size,
      (u, v) => 0.45 + (1 - mortarMask(u, v)) * 0.55,
      (u, v) => 0.74 + grit(u, v) * 0.22 + mortarMask(u, v) * 0.04,
      () => 0));
    return { map, normal, orm };
  });
}

// --------------------------------------------------------------- wet mask ---

// A single greyscale mask reused by the floor shader: high values are spilled
// beer, low values are dry board. Worley blobs give puddles an edge that a
// plain fbm never produces.
export function spillMask(size = 512, seed = 77) {
  return memo(`spill:${size}:${seed}`, () => {
    const blobs = worley2D(seed, 5);
    const blobs2 = worley2D(seed + 13, 9);
    const warp = fbm2D(seed + 5, 4, 4, 0.6);
    const speck = fbm2D(seed + 61, 3, 28, 0.5);
    const t = tex(paint(size, (u, v) => {
      const w = (warp(u, v) - 0.5) * 0.16;
      const a = 1 - smoothstep((blobs(u + w, v - w) - 0.05) * 3.1);
      const b = (1 - smoothstep((blobs2(u - w, v + w) - 0.02) * 4.4)) * 0.6;
      const wet = clamp01(Math.max(a, b) * (0.55 + speck(u, v) * 0.9));
      return [wet * 255, wet * 255, wet * 255];
    }));
    return t;
  });
}

// ------------------------------------------------------------- factory ------

function std(bundle, repeat, props) {
  const m = new THREE.MeshStandardMaterial(props);
  applyPBR(m, bundle, repeat);
  return m;
}

// Every accessor is memoised, so `MAT.brass()` in five different prop builders
// still yields one material and one program.
export const MAT = {
  brick: () => memo('m:brick', () => std(brickBundle(), 3.0, { color: 0xffffff, roughness: 1, metalness: 0 })),

  plaster: () => memo('m:plaster', () => std(TEX.concrete('#20222b', 23), 2.4,
    { color: 0xffffff, roughness: 1, metalness: 0 })),

  ceiling: () => memo('m:ceiling', () => std(TEX.concrete('#0e0f14', 91), 5.0,
    { color: 0xffffff, roughness: 1, metalness: 0, side: THREE.BackSide })),

  // Bar top: the one piece of wood in the room that still has a shine on it.
  barTop: () => memo('m:barTop', () => std(TEX.wood('#4a2c18', 17, 512, 4), 2.0,
    { color: 0xffffff, roughness: 0.34, metalness: 0.06, envMapIntensity: 1.2 })),

  darkWood: () => memo('m:darkWood', () => std(TEX.wood('#2e1d12', 53, 512, 7), 2.2,
    { color: 0xffffff, roughness: 0.62, metalness: 0.04 })),

  panelWood: () => memo('m:panelWood', () => std(TEX.wood('#241710', 71, 512, 3), 1.4,
    { color: 0xffffff, roughness: 0.7, metalness: 0.03 })),

  brass: () => memo('m:brass', () => std(TEX.metal('#c9a227', 31, 512, true), 1.0,
    { color: 0xffffff, roughness: 0.28, metalness: 1.0 })),

  steel: () => memo('m:steel', () => std(TEX.metal('#70757e', 37, 512, true), 1.0,
    { color: 0xffffff, roughness: 0.42, metalness: 1.0 })),

  chrome: () => memo('m:chrome', () => std(TEX.metal('#cfd6e0', 43, 512, false), 1.0,
    { color: 0xffffff, roughness: 0.12, metalness: 1.0 })),

  blackMetal: () => memo('m:blackMetal', () => std(TEX.metal('#2b2e34', 47, 512, true), 1.0,
    { color: 0xffffff, roughness: 0.55, metalness: 0.9 })),

  // Speaker grille cloth: dense weave, no sheen, eats light like a hole.
  grille: () => memo('m:grille', () => std(TEX.fabric('#0d0e11', 9, 512, 220), 4.0,
    { color: 0xffffff, roughness: 1, metalness: 0 })),

  vinyl: () => memo('m:vinyl', () => std(TEX.fabric('#5a1220', 23, 512, 40), 2.0,
    { color: 0xffffff, roughness: 0.48, metalness: 0.02 })),

  rubber: () => memo('m:rubber', () => new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.92 })),

  glass: (color = 0x9fe8c8, opacity = 0.42) => memo(`m:glass:${color}:${opacity}`, () =>
    new THREE.MeshPhysicalMaterial({
      color, roughness: 0.06, metalness: 0, transmission: 0, opacity,
      transparent: true, ior: 1.45, clearcoat: 1, clearcoatRoughness: 0.05,
      side: THREE.DoubleSide, depthWrite: false
    })),

  liquid: (color = 0xb5651d) => memo(`m:liq:${color}`, () =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.12, metalness: 0, emissive: color, emissiveIntensity: 0.18 })),

  // Emissive-only surface for neon tubes and light strips. Colour lives in
  // `emissive` so the bloom pass has something above threshold to grab. Not
  // memoised: each tube pulses on its own phase and needs its own material.
  neon: (color, intensity = 6) => new THREE.MeshStandardMaterial({
    color: 0x07070a, emissive: color, emissiveIntensity: intensity,
    roughness: 0.35, metalness: 0
  })
};

export function disposeMaterials() {
  for (const v of cache.values()) {
    if (v?.dispose) v.dispose();
    else if (v) Object.values(v).forEach((t) => t?.dispose?.());
  }
  cache.clear();
}
