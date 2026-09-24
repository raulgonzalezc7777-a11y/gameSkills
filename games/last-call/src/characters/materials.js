import * as THREE from 'three';
import { fbm2D, valueNoise2D } from '../render/texlib.js';
import { makeRng } from '../core/rng.js';

// Fighter surfacing. Every map is painted here at boot from noise; the
// foundry in render/texlib.js only supplies the noise functions.
//
// Skin is the part that decides whether a fighter reads as a person or as a
// painted statue, so it gets its own lighting model on top of the standard
// one (see SKIN_DIRECT). Cloth gets fabric maps whose finest detail is kept
// well above the texel pitch: a weave near Nyquist is what used to crawl as
// moire stripes across the vest at gameplay distance.

// Skin UV atlas. Every skin vertex lands in one of these rects, which is what
// lets damage.js paint a cut on a cheekbone without touching a calf.
// The head takes the full width of the upper half because u runs all the way
// around the skull; the head grid then spends most of that width on the face.
export const SKIN_ATLAS = {
  head: [0.010, 0.515, 0.990, 0.990],
  body: [0.010, 0.010, 0.300, 0.500],
  armL: [0.320, 0.265, 0.545, 0.500],
  armR: [0.320, 0.010, 0.545, 0.245],
  legL: [0.565, 0.265, 0.790, 0.500],
  legR: [0.565, 0.010, 0.790, 0.245],
  spare: [0.810, 0.010, 0.990, 0.500]
};

const cache = new Map();
const memo = (key, fn) => { if (!cache.has(key)) cache.set(key, fn()); return cache.get(key); };

function canvas(w, h = w, readback = false) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, ctx: c.getContext('2d', readback ? { willReadFrequently: true } : undefined) };
}

function fill(w, h, fn) {
  const { c, ctx } = canvas(w, h);
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const col = fn(x / w, y / h, x, y);
      d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = col[3] ?? 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Tangent space normals from a height field sampled on a wrapped grid.
function normalCanvas(w, h, H, strength) {
  return fill(w, h, (u, v, x, y) => {
    const xl = (x - 1 + w) % w, xr = (x + 1) % w, yu = (y - 1 + h) % h, yd = (y + 1) % h;
    const nx = (H[y * w + xl] - H[y * w + xr]) * strength;
    const ny = (H[yd * w + x] - H[yu * w + x]) * strength;
    const l = Math.hypot(nx, ny, 1);
    return [(nx / l * 0.5 + 0.5) * 255, (ny / l * 0.5 + 0.5) * 255, (1 / l * 0.5 + 0.5) * 255];
  });
}

function tex(c, { srgb = false, repeat = [1, 1], wrap = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

// THREE.Color holds linear components once colour management is on, and every
// canvas here is authored in sRGB, so hex colours are read back out in sRGB.
// Reading .r .g .b straight into a canvas darkens and oversaturates the tone,
// which is what turned every fighter into orange vinyl.
const _srgb = { r: 0, g: 0, b: 0 };
const rgbOf = (hex) => { new THREE.Color(hex).getRGB(_srgb, THREE.SRGBColorSpace); return [_srgb.r * 255, _srgb.g * 255, _srgb.b * 255]; };

// ------------------------------------------------------------------ skin ----

// The per-fighter albedo canvas. Base tone with two scales of mottling: broad
// patches of redder and sallower skin, and a fine grain that stops a flat area
// from reading as paint. Contrast is deliberately low: real skin is far more
// uniform than a noise texture wants to be.
export function makeSkinCanvas(tone, seed, size = 1024) {
  const base = rgbOf(tone);
  const lum = (base[0] * 0.3 + base[1] * 0.59 + base[2] * 0.11) / 255;
  const broad = fbm2D(seed * 13 + 1, 4, 5, 0.55);
  const red = fbm2D(seed * 13 + 7, 3, 4, 0.5);
  const grain = fbm2D(seed * 13 + 3, 3, 48, 0.5);
  // Darker skin carries less visible redness; pale skin shows the blood.
  const redAmt = 0.10 + 0.16 * lum;
  const varCanvas = fill(256, 256, (u, v) => {
    const b = (broad(u, v) - 0.5) * 0.10;
    const r = Math.max(0, red(u, v) - 0.46) * 2 * redAmt;
    return [
      base[0] * (1 + b) * (1 + r * 0.18),
      base[1] * (1 + b) * (1 - r * 0.22),
      base[2] * (1 + b) * (1 - r * 0.18)
    ];
  });
  const grainCanvas = fill(256, 256, (u, v) => {
    const g = 128 + (grain(u, v) - 0.5) * 70;
    return [g, g, g];
  });
  const { c, ctx } = canvas(size);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(varCanvas, 0, 0, size, size);
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 0.18;
  for (let y = 0; y < size; y += 256) for (let x = 0; x < size; x += 256) ctx.drawImage(grainCanvas, x, y);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  return { canvas: c, ctx, size };
}

// Per-fighter surface maps painted in the same atlas as the albedo: a height
// canvas for everything a 4 mm mesh cannot hold (lid creases, the nasolabial
// line, forehead and crow's feet wrinkles, brow hair, scar ridges) and a
// roughness canvas, because a face is not one material: the T-zone and lips
// shine, the cheeks and a stubbled jaw are matte. face.js paints both.
export function makeSkinSurfaceCanvases(seed, size = 1024) {
  // Read back once to bake normals, so it is kept on the CPU.
  const h = canvas(size, size, true);
  h.ctx.fillStyle = 'rgb(128,128,128)';
  h.ctx.fillRect(0, 0, size, size);
  // Roughness lives in green, as three reads it. A slow drift over the whole
  // body keeps a highlight from sliding across a shoulder like a mannequin's.
  const rs = size >> 1;
  const drift = fbm2D(seed * 7 + 83, 3, 6, 0.6);
  const r = canvas(rs);
  r.ctx.drawImage(fill(128, 128, (u, v) => { const g = (0.60 + (drift(u, v) - 0.5) * 0.12) * 255; return [g, g, g]; }), 0, 0, rs, rs);
  return { height: { canvas: h.c, ctx: h.ctx, size }, rough: { canvas: r.c, ctx: r.ctx, size: rs } };
}

// Height canvas to a tangent space normal canvas. Atlas edges clamp instead of
// wrapping: the rects are separate islands and must not borrow from each other.
// Only rows [y0, y1) carry any relief; the rest is written flat.
function heightToNormal(src, strength, y0 = 0, y1 = src.height) {
  const w = src.width, h = src.height;
  const data = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d');
  const img = octx.createImageData(w, h);
  const d = img.data;
  const flat = [128, 128, 255, 255];
  for (let i = 0; i < w * h; i++) { d[i * 4] = flat[0]; d[i * 4 + 1] = flat[1]; d[i * 4 + 2] = flat[2]; d[i * 4 + 3] = 255; }
  const k = strength / 255;
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
    const yu = y > 0 ? y - 1 : y, yd = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const xl = x > 0 ? x - 1 : x, xr = x < w - 1 ? x + 1 : x;
      const nx = (data[(y * w + xl) * 4] - data[(y * w + xr) * 4]) * k;
      // Canvas rows run down while texture v runs up, so the row below is
      // the lower v.
      const ny = (data[(yd * w + x) * 4] - data[(yu * w + x) * 4]) * k;
      const il = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const o = (y * w + x) * 4;
      d[o] = (nx * il * 0.5 + 0.5) * 255; d[o + 1] = (ny * il * 0.5 + 0.5) * 255; d[o + 2] = (il * 0.5 + 0.5) * 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

// Called once the face painter is done: bakes the height canvas to normals and
// hands both maps to the material.
export function finishSkinSurface(mat, surf) {
  const hh = surf.height.canvas.height;
  // Relief is only painted on the head's slice of the atlas.
  const n = tex(heightToNormal(surf.height.canvas, 4.0, Math.floor((1 - SKIN_ATLAS.head[3]) * hh) - 2, Math.ceil((1 - SKIN_ATLAS.head[1]) * hh) + 2), { wrap: false });
  const r = tex(surf.rough.canvas, { wrap: false });
  if (mat.normalMap) mat.normalMap.dispose();
  if (mat.roughnessMap) mat.roughnessMap.dispose();
  mat.normalMap = n;
  mat.roughnessMap = r;
  mat.needsUpdate = true;
}

// The pore tile: dimpled pores on a jittered lattice, the fine criss-cross of
// skin lines between them, and a soft grain. Sampled triplanar in bind space
// (see SKIN_PORE), so a pore is the same size on a nose and on a thigh
// whatever the atlas is doing there. Blue carries cavity for the specular.
function poreTile() {
  return memo('pore-tile', () => {
    const N = 256, CELLS = 22;
    const rng = makeRng(7101);
    const pts = new Float32Array(CELLS * CELLS * 3);
    for (let i = 0; i < CELLS * CELLS; i++) { pts[i * 3] = rng(); pts[i * 3 + 1] = rng(); pts[i * 3 + 2] = 0.55 + rng() * 0.6; }
    const grain = fbm2D(73, 3, 32, 0.5);
    const warp = fbm2D(91, 2, 6, 0.5);
    const Hh = new Float32Array(N * N), cav = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N;
      const gx = u * CELLS, gy = v * CELLS;
      const cx = Math.floor(gx), cy = Math.floor(gy);
      let pore = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const ix = (cx + i + CELLS) % CELLS, iy = (cy + j + CELLS) % CELLS;
        const k = (iy * CELLS + ix) * 3;
        const dx = gx - (cx + i + pts[k]), dy = gy - (cy + j + pts[k + 1]);
        const r = Math.hypot(dx, dy) / (0.16 * pts[k + 2]);
        if (r < 1) pore = Math.max(pore, (1 - r * r) * (1 - r * r));
      }
      // Skin lines: two families of shallow grooves crossing at an angle,
      // warped so they wander like the real diamond pattern. Integer
      // frequencies keep the tile seamless.
      const w = (warp(u, v) - 0.5) * 2.2;
      const s1 = Math.abs(Math.sin(Math.PI * (13 * u + 7 * v) + w));
      const s2 = Math.abs(Math.sin(Math.PI * (7 * u - 13 * v) - w * 0.8));
      const groove = Math.min(1, Math.max(0, 1 - s1 / 0.18) ** 2 + Math.max(0, 1 - s2 / 0.18) ** 2) * (0.4 + 0.6 * warp(v, u));
      Hh[y * N + x] = -pore * 0.85 - groove * 0.18 + grain(u, v) * 0.35;
      cav[y * N + x] = 1 - pore * 0.6;
    }
    const out = fill(N, N, (u, v, x, y) => {
      const xl = (x - 1 + N) % N, xr = (x + 1) % N, yu = (y - 1 + N) % N, yd = (y + 1) % N;
      const nx = (Hh[y * N + xl] - Hh[y * N + xr]) * 2.2;
      const ny = (Hh[yd * N + x] - Hh[yu * N + x]) * 2.2;
      const l = Math.hypot(nx, ny, 1);
      return [(nx / l * 0.5 + 0.5) * 255, (ny / l * 0.5 + 0.5) * 255, cav[y * N + x] * 255];
    });
    return out;
  });
}

// Pieces of shader, joined into the standard program by onBeforeCompile.
const SKIN_VERT_PARS = [
  'attribute vec2 aux;',
  'varying float vWetZone;',
  'varying vec2 vAux;',
  'varying vec3 vBindPos;',
  'varying vec3 vBindN;',
  'varying vec3 vPoreT;'
].join('\n');

// The pore layer needs a tangent that rides the skinning, so one is built from
// the bind normal and pushed through the same skin matrix as the normal.
const SKIN_VERT = [
  '#include <begin_vertex>',
  'vAux = aux;',
  'vBindPos = position;',
  'vBindN = normal;',
  '{',
  '  vec3 pt = normalize( cross( normal, abs( normal.y ) < 0.95 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 ) ) );',
  '  #ifdef USE_SKINNING',
  '    pt = ( skinMatrix * vec4( pt, 0.0 ) ).xyz;',
  '  #endif',
  '  vPoreT = normalize( ( modelViewMatrix * vec4( pt, 0.0 ) ).xyz );',
  '}',
  'vWetZone = clamp( smoothstep( 0.50, 1.40, position.y ) * 0.80',
  '  + smoothstep( 1.74, 1.86, position.y ) * 0.55, 0.0, 1.0 );'
].join('\n');

const SKIN_FRAG_PARS = [
  'uniform float uSweat;',
  'uniform vec3 uSSSColor;',
  'uniform float uSSSIntensity;',
  'uniform vec3 uWrap;',
  'uniform sampler2D uPoreMap;',
  'uniform float uPoreFreq;',
  'uniform float uPoreScale;',
  'uniform float uSheen;',
  'varying float vWetZone;',
  'varying vec2 vAux;',
  'varying vec3 vBindPos;',
  'varying vec3 vBindN;',
  'varying vec3 vPoreT;',
  'float wetMask;',
  'float poreCavity = 1.0;'
].join('\n');

// Triplanar pores, applied on top of the atlas normal. Each plane's sample is a
// slope in that plane's two axes; the blend is taken as an object space slope,
// flattened onto the surface, and carried to view space through the skinned
// tangent frame.
const SKIN_PORE = [
  '#include <normal_fragment_maps>',
  '{',
  '  vec3 bn = normalize( vBindN );',
  '  vec3 tw = pow( abs( bn ), vec3( 4.0 ) );',
  '  tw /= ( tw.x + tw.y + tw.z );',
  '  vec3 P = vBindPos * uPoreFreq;',
  '  vec3 sx = texture2D( uPoreMap, P.zy ).xyz;',
  '  vec3 sy = texture2D( uPoreMap, P.xz + 0.37 ).xyz;',
  '  vec3 sz = texture2D( uPoreMap, P.xy + 0.71 ).xyz;',
  '  vec2 gx = sx.xy * 2.0 - 1.0, gy = sy.xy * 2.0 - 1.0, gz = sz.xy * 2.0 - 1.0;',
  '  vec3 g = tw.x * vec3( 0.0, gx.y, gx.x ) + tw.y * vec3( gy.x, 0.0, gy.y ) + tw.z * vec3( gz.x, gz.y, 0.0 );',
  '  poreCavity = dot( tw, vec3( sx.z, sy.z, sz.z ) );',
  '  vec3 t0 = normalize( cross( bn, abs( bn.y ) < 0.95 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 ) ) );',
  '  vec3 b0 = cross( bn, t0 );',
  '  vec2 d = vec2( dot( g, t0 ), dot( g, b0 ) ) * uPoreScale * ( 1.0 + 0.6 * vAux.y );',
  '  vec3 tv = normalize( vPoreT - normal * dot( vPoreT, normal ) );',
  '  vec3 bv = cross( normal, tv );',
  '  normal = normalize( normal + d.x * tv + d.y * bv );',
  '}'
].join('\n');

// Skin is lit through, not off. Per channel wrap lighting, so red light reaches
// past the terminator further than green and blue and the shadow edge goes
// warm instead of grey; a back light term on thin parts (ears, nostril wings)
// weighted by aux.x. Specular is two lobes: a broad one for the sheen of the
// skin and a tight one for the oil film, which is what gives a cheekbone a
// crisp highlight inside a soft one. Pore cavities hold less of either.
const SKIN_DIRECT = [
  '#include <lights_physical_pars_fragment>',
  'void RE_Direct_Skin( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {',
  '  float ndl = dot( geometryNormal, directLight.direction );',
  '  float dotNL = saturate( ndl );',
  '  vec3 irradiance = dotNL * directLight.color;',
  '  PhysicalMaterial tight = material;',
  '  tight.roughness = max( 0.12, material.roughness * 0.52 );',
  '  vec3 spec = mix( BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material ),',
  '    BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, tight ), 0.15 );',
  '  reflectedLight.directSpecular += irradiance * spec * material.multiScatteringCompensation * mix( 0.55, 1.0, poreCavity );',
  '  vec3 wrapNL = pow( saturate( ( vec3( ndl ) + uWrap ) / ( 1.0 + uWrap ) ), vec3( 1.0 ) + uWrap );',
  '  vec3 halfDir = normalize( directLight.direction + geometryViewDir );',
  '  vec3 F = F_Schlick( material.specularColor, material.specularF90, saturate( dot( geometryViewDir, halfDir ) ) );',
  '  reflectedLight.directDiffuse += wrapNL * directLight.color * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );',
  '  float back = pow( saturate( dot( geometryViewDir, - directLight.direction ) ), 3.0 ) * vAux.x;',
  '  reflectedLight.directDiffuse += directLight.color * uSSSColor * material.diffuseContribution * back * 0.55;',
  // Fine vellus hair and the dead outer layer scatter a soft grazing sheen
  // that does not take the colour of the skin under it. On a dark face that
  // sheen, not the diffuse, is what shows the form.
  '  float ndv = saturate( dot( geometryNormal, geometryViewDir ) );',
  '  reflectedLight.directSpecular += directLight.color * dotNL * pow( 1.0 - ndv, 4.0 ) * uSheen;',
  '}',
  '#undef RE_Direct',
  '#define RE_Direct RE_Direct_Skin'
].join('\n');

// Oily zones (forehead, nose, shoulders) are a little glossier, and sweat
// pushes everything toward wet. Both only move roughness; the albedo keeps its
// colour because oil does not change what colour skin is.
const SKIN_ROUGH = [
  '#include <roughnessmap_fragment>',
  'roughnessFactor = mix( roughnessFactor, roughnessFactor * 0.86, vAux.y );',
  'wetMask = clamp( uSweat * max( vWetZone, vAux.y ) * 1.1, 0.0, 1.0 );',
  'roughnessFactor = mix( roughnessFactor, 0.24, wetMask );'
].join('\n');

// Skin F0 is about 0.028. Wet skin darkens because water fills the micro
// relief that scattered light back out. The standard program feeds
// diffuseContribution, not diffuseColor, to the lighting, so that is the one
// darkened. Grazing reflectance is held under the mirror limit: a rough,
// scattering surface never reaches it.
const SKIN_SPEC = [
  '#include <lights_physical_fragment>',
  'material.specularColor = vec3( mix( 0.028, 0.045, wetMask ) );',
  'material.specularF90 = mix( 0.55, 0.85, wetMask );',
  'material.specularColorBlended = material.specularColor;',
  'material.diffuseContribution *= mix( 1.0, 0.80, wetMask );'
].join('\n');

const SKIN_INDIRECT = [
  '#include <lights_fragment_end>',
  'float skinNdv = saturate( dot( normal, geometryViewDir ) );',
  'reflectedLight.indirectDiffuse *= vec3( 1.03, 0.99, 0.98 );',
  'reflectedLight.indirectDiffuse += uSSSColor * ( pow( 1.0 - skinNdv, 3.0 ) * uSSSIntensity ) * material.diffuseContribution;',
  'reflectedLight.indirectSpecular *= mix( 0.6, 1.0, poreCavity );'
].join('\n');

export function makeSkinMaterial(skinTexture, opts = {}) {
  const tone = new THREE.Color(opts.tone ?? '#c08055');
  // Luminance of the sRGB tone, the way a person would judge light or dark.
  const t = rgbOf(opts.tone ?? '#c08055');
  const L = (t[0] * 0.3 + t[1] * 0.59 + t[2] * 0.11) / 255;
  const dark = 1 - Math.min(1, Math.max(0, (L - 0.30) / 0.35));
  const mat = new THREE.MeshStandardMaterial({
    map: skinTexture,
    roughness: 1.0,
    metalness: 0.0,
    // Dark skin reflects exactly as much as pale skin does; it only looks
    // shinier because less diffuse light competes with the reflection. Cutting
    // the reflection on dark skin is what used to turn Dez's face into a hole.
    envMapIntensity: opts.envMapIntensity ?? (0.62 + 0.10 * dark)
  });
  mat.name = 'skin';
  const pore = tex(poreTile());
  mat.userData.poreMap = pore;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSweat = { value: mat.userData.sweat ?? 0 };
    shader.uniforms.uSSSColor = { value: new THREE.Color(opts.sss ?? '#b8442a') };
    shader.uniforms.uSSSIntensity = { value: opts.sssIntensity ?? (0.24 + 0.10 * dark) };
    shader.uniforms.uWrap = { value: new THREE.Vector3(0.50, 0.22, 0.14) };
    shader.uniforms.uPoreMap = { value: pore };
    shader.uniforms.uPoreFreq = { value: 1 / 0.024 };
    shader.uniforms.uPoreScale = { value: opts.poreScale ?? 0.22 };
    shader.uniforms.uSheen = { value: 0.02 + 0.04 * dark };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + SKIN_VERT_PARS)
      .replace('#include <begin_vertex>', SKIN_VERT);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + SKIN_FRAG_PARS)
      .replace('#include <lights_physical_pars_fragment>', SKIN_DIRECT)
      .replace('#include <roughnessmap_fragment>', SKIN_ROUGH)
      .replace('#include <normal_fragment_maps>', SKIN_PORE)
      .replace('#include <lights_physical_fragment>', SKIN_SPEC)
      .replace('#include <lights_fragment_end>', SKIN_INDIRECT);
    mat.userData.shader = shader;
  };
  mat.customProgramCacheKey = () => 'fighter-skin-v3';
  void tone;
  return mat;
}

// ----------------------------------------------------------------- cloth ----

// Fabric maps by kind. The finest repeating structure in any of them is eight
// texels or more across, so mipmapping resolves it to a flat tone at distance
// instead of beating against the screen grid.
//   jersey  knit cotton: soft vertical wales, slub noise, matte
//   satin   fight shorts: near flat, faint crinkle, glossy with a sheen lobe
//   rib     elastic waistband: strong vertical ribs
//   wrap    hand tape: overlapping diagonal passes with raised edges
//   knit    sneaker upper
function fabricBundle(color, kind, seed) {
  return memo('fab:' + color + ':' + kind + ':' + seed, () => {
    const N = 256;
    const base = rgbOf(color);
    const slub = fbm2D(seed + 11, 3, 8, 0.5);
    const blot = fbm2D(seed + 19, 3, 3, 0.6);
    const fuzz = fbm2D(seed + 29, 2, 64, 0.5);
    const H = new Float32Array(N * N);
    const A = new Float32Array(N * N);
    let strength = 2.0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N;
      let h = 0, a = 1;
      if (kind === 'jersey') {
        const wale = Math.sin(u * 32 * Math.PI * 2) * 0.5 + 0.5;
        h = wale * 0.35 + slub(u, v) * 0.45 + fuzz(u, v) * 0.2;
        a = 0.95 + (slub(u, v) - 0.5) * 0.08 - wale * 0.03;
        strength = 1.6;
      } else if (kind === 'satin') {
        h = slub(u, v) * 0.6 + fuzz(u, v) * 0.15;
        a = 0.97 + (blot(u, v) - 0.5) * 0.06;
        strength = 0.9;
      } else if (kind === 'rib') {
        const rib = Math.sin(u * 24 * Math.PI * 2) * 0.5 + 0.5;
        h = rib + fuzz(u, v) * 0.15;
        a = 0.88 + rib * 0.12;
        strength = 2.2;
      } else if (kind === 'wrap') {
        // Diagonal passes of tape, each overlapping the last: a ramp that
        // resets at every edge gives a raised lip and a shadow line.
        const s = (v * 5 + u * 1.0) % 1;
        const edge = Math.pow(s, 3);
        h = edge * 0.9 + fuzz(u, v) * 0.25 + slub(u, v) * 0.2;
        a = 0.90 + edge * 0.10 - (s < 0.04 ? 0.18 : 0) + (slub(u, v) - 0.5) * 0.08;
        strength = 2.4;
      } else {
        const cell = Math.sin(u * 20 * Math.PI * 2) * Math.sin(v * 20 * Math.PI * 2);
        h = cell * 0.4 + fuzz(u, v) * 0.3 + slub(u, v) * 0.3;
        a = 0.93 + cell * 0.04 + (slub(u, v) - 0.5) * 0.06;
        strength = 1.8;
      }
      H[y * N + x] = h;
      A[y * N + x] = a * (1 + (blot(u, v) - 0.5) * 0.08);
    }
    const map = fill(N, N, (u, v, x, y) => {
      const k = A[y * N + x];
      return [base[0] * k, base[1] * k, base[2] * k];
    });
    const normal = normalCanvas(N, N, H, strength);
    const rough = kind === 'satin' ? 0.46 : kind === 'wrap' ? 0.92 : kind === 'rib' ? 0.85 : 0.88;
    const orm = fill(64, 64, (u, v) => [255, Math.min(1, rough + (slub(u, v) - 0.5) * 0.1) * 255, 0]);
    return { map, normal, orm };
  });
}

export function makeClothMaterial(color, opts = {}) {
  const kind = opts.kind ?? 'jersey';
  const b = fabricBundle(color, kind, opts.seed ?? 9);
  const rep = opts.repeat ?? [4, 4];
  const r = Array.isArray(rep) ? rep : [rep, rep];
  const mat = new THREE.MeshPhysicalMaterial({
    map: tex(b.map, { srgb: true, repeat: r }),
    normalMap: tex(b.normal, { repeat: r }),
    roughnessMap: tex(b.orm, { repeat: r }),
    roughness: 1.0,
    metalness: 0.0,
    sheen: opts.sheen ?? 0.55,
    sheenRoughness: opts.sheenRoughness ?? 0.6,
    // Fibre backscatter takes the colour of the fibre: a white sheen lobe
    // over red cotton reads as grey dust, not as cloth.
    sheenColor: new THREE.Color(opts.sheenColor ?? color).lerp(new THREE.Color('#ffffff'), opts.sheenColor ? 0 : 0.2),
    envMapIntensity: opts.envMapIntensity ?? 0.75,
    // Matte fibres scatter what a smooth dielectric would mirror at grazing.
    specularIntensity: kind === 'satin' ? 0.85 : 0.45
  });
  mat.normalScale.set(opts.normalScale ?? 0.6, opts.normalScale ?? 0.6);
  mat.name = opts.name ?? 'cloth';
  return mat;
}

export function makeRubberMaterial(color, opts = {}) {
  const b = fabricBundle(color, 'knit', opts.seed ?? 21);
  const mat = new THREE.MeshStandardMaterial({
    map: tex(b.map, { srgb: true, repeat: [3, 3] }),
    roughness: 0.78,
    metalness: 0.0,
    envMapIntensity: 0.6
  });
  mat.name = 'sole';
  return mat;
}

// ------------------------------------------------------------------ hair ----

// Hair is a shell that fades out strand by strand. The map's alpha is not
// opacity: it is a per texel threshold, equalised to a flat distribution, and
// a fragment survives only where the vertex coverage beats it. Coverage 0.5 is
// then half the strands, which is what a hairline or a buzz cut actually is.
// It stays in the opaque pass on purpose: the post stack drops anything
// transparent from its normal prepass, and a fighter with a transparent part
// would lose its ambient occlusion.
function hairBundle(color, seed, style) {
  return memo('hair:' + color + ':' + seed + ':' + style, () => {
    const N = 256;
    const base = rgbOf(color);
    const rng = makeRng(seed * 7 + 5);
    const along = style === 'afro' ? 24 : 6;
    const strand = valueNoise2D(seed + 3, 96);
    const clump = fbm2D(seed + 9, 3, 12, 0.5);
    const coil = fbm2D(seed + 17, 3, 20, 0.55);
    const V = new Float32Array(N * N), H = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N;
      let s;
      if (style === 'afro') {
        const c = coil(u, v);
        s = Math.abs(c - 0.5) * 2;
        s = 1 - s * 0.8 + rng() * 0.25;
      } else {
        // Strands stretched along v: sample the lattice at a squashed v. The
        // threshold is mostly clump and strand, with very little per texel
        // noise: a hairline or a beard edge then thins out in tufts a couple
        // of millimetres across, which holds still under FXAA, instead of a
        // pixel dither that crawls.
        const cw = style === 'beard' ? 0.14 : 0.28;
        s = strand(u, (v / along) % 1) * (0.90 - cw) + clump(u, v) * cw + rng() * 0.10;
      }
      V[y * N + x] = s;
      H[y * N + x] = s;
    }
    // Rank equalise so coverage maps linearly onto strand density.
    const idx = Array.from({ length: N * N }, (_, i) => i).sort((a, b) => V[a] - V[b]);
    const T = new Float32Array(N * N);
    for (let r = 0; r < idx.length; r++) T[idx[r]] = r / (idx.length - 1);
    const map = fill(N, N, (u, v, x, y) => {
      const s = H[y * N + x];
      // A few strands catch light well above the base tone; black hair is
      // never one flat black.
      // Beard hair is coarser and lighter at the tips than the head's, and
      // a near black beard still shows brown and grey where it catches light.
      const stray = rng() < 0.06 ? 0.9 : 0;
      const bd = style === 'beard';
      const k = (bd ? 0.95 : 0.70) + s * (bd ? 0.75 : 0.55) + stray;
      const lift = bd ? 14 : 6;
      return [Math.min(255, base[0] * k + lift), Math.min(255, base[1] * k + lift * 0.85), Math.min(255, base[2] * k + lift * 0.7), T[y * N + x] * 255];
    });
    const normal = normalCanvas(N, N, H, style === 'afro' ? 3.0 : 2.4);
    return { map, normal };
  });
}

const HAIR_VERT = [
  '#include <begin_vertex>',
  'vHairCover = aux.x;'
].join('\n');
// Coverage also thins toward the silhouette by uFuzz, which is what turns an
// afro from a clay cap into something with a soft edge against the light.
const HAIR_FRAG = [
  '#include <map_fragment>',
  'float hairEdge = 1.0 - abs( dot( normalize( vNormal ), normalize( vViewPosition ) ) );',
  'float hairCov = vHairCover * ( 1.0 - uFuzz * hairEdge * hairEdge );',
  'if ( hairCov <= texture2D( map, vMapUv ).a * 0.985 + 0.01 ) discard;',
  'diffuseColor.a = 1.0;'
].join('\n');

export function makeHairMaterial(color, seed, style = 'short') {
  const b = hairBundle(color, seed, style);
  const rep = style === 'afro' ? [5, 3] : [4, 2];
  const lift = new THREE.Color(color).lerp(new THREE.Color('#6a5040'), 0.25);
  const mat = new THREE.MeshPhysicalMaterial({
    map: tex(b.map, { srgb: true, repeat: rep }),
    normalMap: tex(b.normal, { repeat: rep }),
    roughness: style === 'afro' ? 0.72 : style === 'beard' ? 0.48 : 0.5,
    metalness: 0.0,
    sheen: style === 'afro' ? 0.22 : 0.4,
    sheenRoughness: 0.45,
    sheenColor: lift,
    envMapIntensity: 0.45,
    // Coiled hair traps light between strands; a straight crop still has a
    // sheen but nothing like a mirror.
    specularIntensity: style === 'afro' ? 0.35 : 0.65,
    // A small pull toward the camera keeps the thinnest part of the shell,
    // where it lies almost on the scalp, from fighting the skin for depth.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2
  });
  mat.normalScale.set(0.8, 0.8);
  mat.name = 'hair';
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aux;\nvarying float vHairCover;')
      .replace('#include <begin_vertex>', HAIR_VERT);
    shader.uniforms.uFuzz = { value: style === 'afro' ? 0.9 : style === 'beard' ? 0.3 : 0.15 };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vHairCover;\nuniform float uFuzz;')
      .replace('#include <map_fragment>', HAIR_FRAG);
  };
  mat.customProgramCacheKey = () => 'fighter-hair-v3';
  return mat;
}

// ------------------------------------------------------------------- eyes ---

// Eyeball texture coordinates: u runs round the forward pole starting at the
// top (so the seam hides under the upper lid), v is the angle from the pole,
// remapped so the iris gets half the rows. builder.js lays its eyeball out the
// same way through eyeUV.
export const EYE_LIMBUS = 29 * Math.PI / 180;
export const EYE_ANG_MAX = 118 * Math.PI / 180;
export const eyeV = (ang) => (ang <= EYE_LIMBUS ? 0.5 * ang / EYE_LIMBUS
  : 0.5 + 0.5 * (ang - EYE_LIMBUS) / (EYE_ANG_MAX - EYE_LIMBUS));

// The eyeball, painted for the right eye and mirrored for the left. Pupil, an
// iris with radial fibres, crypts, a paler collarette and a dark limbal ring,
// then a sclera that is never white: warm, greyer toward the corners, pink at
// them, with a few vessels. The eye never turns against its lids, so the
// shadow the upper lid and lashes throw across it, and the soft occlusion at
// every margin, is baked here from the exact aperture the sculpt cut. That
// occlusion is most of what makes an eye sit in a skull instead of on it.
// ap: { up(xi), lo(xi), turn, c, hw, key }
export function makeEyeMaterial(irisColor = '#3a2a1c', seed = 1, ap = null) {
  const c = memo('eye:' + irisColor + ':' + seed + ':' + (ap ? ap.key : ''), () => {
    const W = 512, Hh = 256;
    const iris = rgbOf(irisColor);
    const rng = makeRng(seed * 131 + 7);
    const fib = valueNoise2D(seed + 41, 96);
    const fib2 = valueNoise2D(seed + 47, 160);
    const crypt = valueNoise2D(seed + 43, 22);
    const vein = fbm2D(seed + 53, 3, 12, 0.5);
    const ca = Math.cos(ap ? ap.turn : 0.14), sa = Math.sin(ap ? ap.turn : 0.14);
    const img = fill(W, Hh, (u, v) => {
      const ang = v <= 0.5 ? (v / 0.5) * EYE_LIMBUS : EYE_LIMBUS + ((v - 0.5) / 0.5) * (EYE_ANG_MAX - EYE_LIMBUS);
      const phi = u * Math.PI * 2;
      // Direction in the eye frame: +y up, +x toward the temple, +z out.
      const sx = Math.sin(ang) * Math.sin(phi), sy = Math.sin(ang) * Math.cos(phi), sz = Math.cos(ang);
      // Into head space: the builder turns the pole 0.03 toward the nose.
      const th = -0.03;
      const vx = sx * Math.cos(th) + sz * Math.sin(th), vz = -sx * Math.sin(th) + sz * Math.cos(th), vy = sy;
      let occ = 1, corner = 0;
      if (ap) {
        const lx = vx * ca - vz * sa, lz = vx * sa + vz * ca;
        const al = Math.atan2(lx, lz), ay = Math.asin(Math.max(-1, Math.min(1, vy)));
        const xi = (al - ap.c) / ap.hw;
        const xc = Math.max(-1, Math.min(1, xi));
        const dUp = ap.up(xc) - ay, dLo = ay - ap.lo(xc);
        const out = Math.max(0, Math.abs(xi) - 1) * ap.hw;
        occ = (1 - 0.62 * Math.exp(-Math.max(0, dUp) / 0.15)) * (1 - 0.25 * Math.exp(-Math.max(0, dUp) / 0.45))
          * (1 - 0.38 * Math.exp(-Math.max(0, dLo) / 0.10)) * (1 - 0.25 * corner);
        if (dUp < 0 || dLo < 0 || out > 0) occ *= 0.35;
        corner = Math.min(1, Math.max(0, (Math.abs(xi) - 0.45) / 0.55));
      }
      let col;
      const PUP = 8.5 * Math.PI / 180;
      if (ang < PUP) col = [5, 4, 4];
      else if (ang < EYE_LIMBUS) {
        const r = (ang - PUP) / (EYE_LIMBUS - PUP);
        // Fibres run radially: noise that varies fast round the iris and slowly
        // along its radius.
        const f = fib(u * 6 % 1, r * 0.25) * 0.6 + fib2(u * 9 % 1, r * 0.4) * 0.4;
        const cr = Math.max(0, 0.42 - crypt(u * 3 % 1, r)) * 2.2;
        const coll = Math.exp(-(((r - 0.30) / 0.09) ** 2)) * 0.30;
        const ruff = Math.exp(-((r / 0.05) ** 2)) * 0.45;
        const limb = Math.pow(Math.max(0, r - 0.72) / 0.28, 1.4) * 0.72;
        const k = (1.25 + (f - 0.5) * 0.95 + coll - cr * 0.5 - ruff) * (1 - limb);
        col = [iris[0] * k * 1.5 + 4, iris[1] * k * 1.45 + 3, iris[2] * k * 1.35 + 2];
      } else {
        const t = Math.min(1, (ang - EYE_LIMBUS) / (40 * Math.PI / 180));
        // A soft grey ring just outside the limbus, where the sclera goes thin
        // over the iris root.
        const limbal = Math.exp(-(((ang - EYE_LIMBUS) / (3.2 * Math.PI / 180)) ** 2)) * 0.30;
        const red = corner * 0.8 * (0.6 + 0.4 * vein(u, v));
        col = [
          (214 - t * 22 - red * 14) * (1 - limbal),
          (204 - t * 30 - red * 48) * (1 - limbal),
          (190 - t * 30 - red * 42) * (1 - limbal)
        ];
      }
      return [Math.min(255, col[0] * occ), Math.min(255, col[1] * occ), Math.min(255, col[2] * occ)];
    });
    // Vessels: a few thin wandering lines from each corner toward the iris.
    const g = img.getContext('2d');
    g.lineCap = 'round';
    for (const side of [0.25, 0.75]) {
      for (let n = 0; n < 7; n++) {
        let uu = side + (rng() - 0.5) * 0.10, vv = 0.95 - rng() * 0.2;
        g.strokeStyle = 'rgba(150,40,40,' + (0.12 + rng() * 0.16).toFixed(3) + ')';
        g.lineWidth = 0.6 + rng() * 0.7;
        g.beginPath();
        g.moveTo(uu * W, vv * Hh);
        const steps = 5 + Math.floor(rng() * 5);
        for (let k = 0; k < steps; k++) {
          uu += (rng() - 0.5) * 0.03 + (0.5 - side) * 0.004;
          vv -= 0.03 + rng() * 0.03;
          if (vv < 0.56) break;
          g.lineTo(uu * W, vv * Hh);
        }
        g.stroke();
      }
    }
    return img;
  });
  const t = tex(c, { srgb: true, wrap: false });
  t.wrapS = THREE.RepeatWrapping;
  const mat = new THREE.MeshStandardMaterial({
    map: t,
    roughness: 0.55,
    metalness: 0.0,
    // The tear film shell carries the reflection; the eyeball under it only
    // scatters.
    envMapIntensity: 0.15
  });
  mat.name = 'eye';
  return mat;
}

// The wet layer over the eye: cornea bulging over the iris, tear film over the
// sclera. Black and additive, so it contributes nothing but its reflection:
// the catchlight that makes an eye look alive, sharp because the film is
// mirror smooth. Kept out of the depth and normal passes by being transparent.
export function makeCorneaMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#000000'),
    roughness: 0.07,
    metalness: 0.0,
    // Enough of the room to wet the eye, not so much that a bright sky
    // glazes a brown iris grey; the lights give the catchlight.
    envMapIntensity: 0.35,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  mat.name = 'cornea';
  return mat;
}

// Lashes: near black, matte, barely reflective. A lash fringe is a porous
// tangle of hairs, not a surface, so it must never throw back the room.
export function makeLashMaterial(hairColor) {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(hairColor).lerp(new THREE.Color('#000000'), 0.55),
    roughness: 0.9,
    metalness: 0.0,
    envMapIntensity: 0.15
  });
  mat.name = 'lash';
  return mat;
}

export function makeDarkMaterial(color) {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness: 0.55,
    metalness: 0.0,
    envMapIntensity: 0.7
  });
  mat.name = 'dark';
  return mat;
}

export function makeMetalMaterial(color) {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness: 0.32,
    metalness: 1.0,
    envMapIntensity: 1.2
  });
  mat.name = 'trim';
  return mat;
}

// One call drives every skin material a fighter owns. Writing straight into
// the cached shader uniform avoids a material recompile per frame; the value
// is also parked on userData so a program compiled later starts from it.
export function makeSweatSetter(materials) {
  const skins = Object.values(materials).filter((m) => m.name === 'skin');
  let current = -1;
  return (v) => {
    const w = v < 0 ? 0 : v > 1 ? 1 : v;
    if (w === current) return;
    current = w;
    for (let i = 0; i < skins.length; i++) {
      skins[i].userData.sweat = w;
      const sh = skins[i].userData.shader;
      if (sh) sh.uniforms.uSweat.value = w;
    }
  };
}
