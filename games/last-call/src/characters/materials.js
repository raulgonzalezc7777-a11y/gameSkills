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

function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, ctx: c.getContext('2d') };
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

const rgbOf = (hex) => { const c = new THREE.Color(hex); return [c.r * 255, c.g * 255, c.b * 255]; };

// ------------------------------------------------------------------ skin ----

// The per-fighter albedo canvas. Base tone with two scales of mottling: broad
// patches of redder and sallower skin, and a fine grain that stops a flat area
// from reading as paint. Contrast is deliberately low: real skin is far more
// uniform than a noise texture wants to be, and the saturation of the roster
// colour is kept rather than washed toward grey.
export function makeSkinCanvas(tone, seed, size = 1024) {
  const base = rgbOf(tone);
  const lum = (base[0] * 0.3 + base[1] * 0.59 + base[2] * 0.11) / 255;
  const broad = fbm2D(seed * 13 + 1, 4, 5, 0.55);
  const red = fbm2D(seed * 13 + 7, 3, 4, 0.5);
  const grain = fbm2D(seed * 13 + 3, 3, 48, 0.5);
  // Darker skin carries less visible redness and more sheen variation; pale
  // skin shows the blood under it.
  const redAmt = 0.10 + 0.14 * lum;
  const varCanvas = fill(256, 256, (u, v) => {
    const b = (broad(u, v) - 0.5) * 0.11;
    const r = Math.max(0, red(u, v) - 0.48) * 2 * redAmt;
    return [
      base[0] * (1 + b) * (1 + r * 0.25),
      base[1] * (1 + b) * (1 - r * 0.35),
      base[2] * (1 + b) * (1 - r * 0.30)
    ];
  });
  const grainCanvas = fill(256, 256, (u, v) => {
    const g = 128 + (grain(u, v) - 0.5) * 90;
    return [g, g, g];
  });
  const { c, ctx } = canvas(size);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(varCanvas, 0, 0, size, size);
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 0.22;
  for (let y = 0; y < size; y += 256) for (let x = 0; x < size; x += 256) ctx.drawImage(grainCanvas, x, y);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  return { canvas: c, ctx, size };
}

// Fine surface detail shared by every fighter: pore dimples and a soft
// isotropic grain in the normal, and a slow roughness drift so a highlight
// breaks up across a shoulder instead of sliding over it like on a mannequin.
// Nothing here is directional: ridged noise in a skin normal shows up in every
// highlight as brushed metal.
function skinDetail() {
  return memo('skin-detail', () => {
    const N = 512;
    const pore = valueNoise2D(71, 128);
    const grain = fbm2D(73, 3, 32, 0.5);
    const fine = fbm2D(79, 2, 160, 0.5);
    const H = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N;
      const p = pore(u, v);
      H[y * N + x] = -Math.pow(Math.max(0, p - 0.66) * 3.0, 2) * 0.7 + grain(u, v) * 0.35 + fine(u, v) * 0.3;
    }
    const normal = normalCanvas(N, N, H, 1.3);
    const drift = fbm2D(83, 3, 3, 0.6);
    const orm = fill(256, 256, (u, v) => [255, (0.86 + drift(u, v) * 0.14) * 255, 0]);
    return { normal, orm };
  });
}

// Pieces of shader, joined into the standard program by onBeforeCompile.
const SKIN_VERT_PARS = [
  'attribute vec2 aux;',
  'varying float vWetZone;',
  'varying vec2 vAux;'
].join('\n');

const SKIN_VERT = [
  '#include <begin_vertex>',
  'vAux = aux;',
  'vWetZone = clamp( smoothstep( 0.50, 1.40, position.y ) * 0.80',
  '  + smoothstep( 1.74, 1.86, position.y ) * 0.55, 0.0, 1.0 );'
].join('\n');

const SKIN_FRAG_PARS = [
  'uniform float uSweat;',
  'uniform vec3 uSSSColor;',
  'uniform float uSSSIntensity;',
  'uniform vec3 uWrap;',
  'varying float vWetZone;',
  'varying vec2 vAux;',
  'float wetMask;'
].join('\n');

// Skin is lit through, not off. Three cheap terms stand in for scattering:
// per channel wrap lighting, so red light reaches past the terminator further
// than green and blue and the shadow edge goes warm instead of grey; a back
// light term on thin parts (ears, nostril wings) weighted by aux.x; and a
// shallow red lift in the indirect light. None of them adds energy on a face
// lit straight on, which is where plastic comes from.
const SKIN_DIRECT = [
  '#include <lights_physical_pars_fragment>',
  'void RE_Direct_Skin( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {',
  '  float ndl = dot( geometryNormal, directLight.direction );',
  '  float dotNL = saturate( ndl );',
  '  vec3 irradiance = dotNL * directLight.color;',
  '  reflectedLight.directSpecular += irradiance * BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material ) * material.multiScatteringCompensation;',
  '  vec3 wrapNL = pow( saturate( ( vec3( ndl ) + uWrap ) / ( 1.0 + uWrap ) ), vec3( 1.0 ) + uWrap );',
  '  vec3 halfDir = normalize( directLight.direction + geometryViewDir );',
  '  vec3 F = F_Schlick( material.specularColor, material.specularF90, saturate( dot( geometryViewDir, halfDir ) ) );',
  '  reflectedLight.directDiffuse += wrapNL * directLight.color * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );',
  '  float back = pow( saturate( dot( geometryViewDir, - directLight.direction ) ), 3.0 ) * vAux.x;',
  '  reflectedLight.directDiffuse += directLight.color * uSSSColor * material.diffuseContribution * back * 0.55;',
  '}',
  '#undef RE_Direct',
  '#define RE_Direct RE_Direct_Skin'
].join('\n');

// Oily zones (forehead, nose, shoulders) are a little glossier, and sweat
// pushes everything toward wet. Both only move roughness; the albedo keeps its
// colour because oil does not change what colour skin is.
const SKIN_ROUGH = [
  '#include <roughnessmap_fragment>',
  'roughnessFactor = mix( roughnessFactor, roughnessFactor * 0.88, vAux.y );',
  'wetMask = uSweat * max( vWetZone, vAux.y );',
  '#ifdef USE_ROUGHNESSMAP',
  '  wetMask *= 0.55 + 0.45 * texture2D( roughnessMap, vRoughnessMapUv ).g;',
  '#endif',
  'wetMask = clamp( wetMask, 0.0, 1.0 );',
  'roughnessFactor = mix( roughnessFactor, 0.24, wetMask );'
].join('\n');

// Skin F0 is about 0.028, a touch under the standard dielectric 0.04. Wet skin
// darkens because water fills the micro relief that scattered light back out.
// The standard program feeds diffuseContribution, not diffuseColor, to the
// lighting, so that is the one that has to be darkened.
// Grazing reflectance is held well under the mirror limit: a rough, scattering
// surface never reaches it, and on dark skin under coloured lights a full F90
// rim is what turns a face into chrome.
const SKIN_SPEC = [
  '#include <lights_physical_fragment>',
  'material.specularColor = vec3( mix( 0.028, 0.045, wetMask ) );',
  'material.specularF90 = mix( 0.5, 0.85, wetMask );',
  'material.specularColorBlended = material.specularColor;',
  'material.diffuseContribution *= mix( 1.0, 0.80, wetMask );'
].join('\n');

const SKIN_INDIRECT = [
  '#include <lights_fragment_end>',
  'float skinNdv = saturate( dot( normal, geometryViewDir ) );',
  'reflectedLight.indirectDiffuse *= vec3( 1.03, 0.99, 0.98 );',
  'reflectedLight.indirectDiffuse += uSSSColor * ( pow( 1.0 - skinNdv, 3.0 ) * uSSSIntensity ) * material.diffuseContribution;'
].join('\n');

export function makeSkinMaterial(skinTexture, opts = {}) {
  const det = skinDetail();
  const rep = opts.poreRepeat ?? 16;
  // Environment reflection scales with tone: on dark skin the diffuse term is
  // small, so the same reflection that reads as a sheen on pale skin turns a
  // dark face into chrome under coloured club lights.
  const tone = new THREE.Color(opts.tone ?? '#c08055');
  const L = tone.r * 0.3 + tone.g * 0.59 + tone.b * 0.11;
  const baseRough = opts.roughness ?? 0.62;
  const mat = new THREE.MeshStandardMaterial({
    map: skinTexture,
    normalMap: tex(det.normal, { repeat: [rep, rep] }),
    roughnessMap: tex(det.orm, { repeat: [3, 3] }),
    roughness: baseRough,
    metalness: 0.0,
    envMapIntensity: opts.envMapIntensity ?? (0.45 + 0.25 * Math.min(1, L / 0.6))
  });
  mat.normalScale.set(0.14, 0.14);
  mat.name = 'skin';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSweat = { value: mat.userData.sweat ?? 0 };
    shader.uniforms.uSSSColor = { value: new THREE.Color(opts.sss ?? '#b8442a') };
    shader.uniforms.uSSSIntensity = { value: opts.sssIntensity ?? 0.22 };
    shader.uniforms.uWrap = { value: new THREE.Vector3(0.52, 0.24, 0.16) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + SKIN_VERT_PARS)
      .replace('#include <begin_vertex>', SKIN_VERT);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + SKIN_FRAG_PARS)
      .replace('#include <lights_physical_pars_fragment>', SKIN_DIRECT)
      .replace('#include <roughnessmap_fragment>', SKIN_ROUGH)
      .replace('#include <lights_physical_fragment>', SKIN_SPEC)
      .replace('#include <lights_fragment_end>', SKIN_INDIRECT);
    mat.userData.shader = shader;
  };
  mat.customProgramCacheKey = () => 'fighter-skin-v2';
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
        // Strands stretched along v: sample the lattice at a squashed v.
        s = strand(u, (v / along) % 1) * 0.7 + clump(u, v) * 0.3 + rng() * 0.15;
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
      const stray = rng() < 0.06 ? 0.9 : 0;
      const k = 0.70 + s * 0.55 + stray;
      return [Math.min(255, base[0] * k + 6), Math.min(255, base[1] * k + 5), Math.min(255, base[2] * k + 4), T[y * N + x] * 255];
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

// One sphere per eye, textured from its forward pole: pupil, an iris with
// radial fibres and a dark limbal ring, then a sclera that warms toward the
// corners. The clearcoat is the wet cornea.
export function makeEyeMaterial(irisColor = '#3a2a1c', seed = 1) {
  const c = memo('eye:' + irisColor + ':' + seed, () => {
    const W = 256, Hh = 128;
    const iris = rgbOf(irisColor);
    const fib = valueNoise2D(seed + 41, 64);
    const fleck = valueNoise2D(seed + 43, 24);
    return fill(W, Hh, (u, v) => {
      const ang = v * 180;                      // degrees from the forward pole
      const phi = u * Math.PI * 2;
      // World up on the eyeball once its pole is turned forward. The eye never
      // rotates against its lids, so the shadow the upper lid and lashes throw
      // across the top of the eyeball can be baked right here.
      const up = -Math.sin(phi) * Math.sin(ang * Math.PI / 180);
      const lidShade = 1 - 0.55 * Math.min(1, Math.max(0, (up + 0.05) / 0.45)) - 0.2 * Math.min(1, Math.max(0, (-up - 0.30) / 0.3));
      let col;
      if (ang < 9) col = [6, 5, 5];
      else if (ang < 29) {
        // Radial fibres, a lighter collarette ring round the pupil and a dark
        // limbal ring at the edge: the three things that make an iris read as
        // an iris and not a painted disc.
        const r = (ang - 9) / 20;
        const f = fib(u * 4 % 1, r * 0.3);
        const coll = Math.exp(-(((r - 0.22) / 0.12) ** 2)) * 0.35;
        const k = (1.15 + (f - 0.5) * 0.9 + coll + (fleck(u, r) - 0.5) * 0.3) * (1 - Math.pow(Math.max(0, r - 0.78) / 0.22, 1.5) * 0.75);
        // Roster eye colours are the tone a person reads at a glance; the iris
        // itself sits in the socket's shadow, so its albedo runs well above it.
        col = [Math.min(255, iris[0] * k * 2.3), Math.min(255, iris[1] * k * 2.3), Math.min(255, iris[2] * k * 2.3)];
      } else {
        const t = Math.min(1, (ang - 29) / 45);
        const limbal = Math.max(0, 1 - (ang - 29) / 4) * 0.3;
        col = [(176 - t * 46) * (1 - limbal), (164 - t * 64) * (1 - limbal), (154 - t * 66) * (1 - limbal)];
      }
      return [col[0] * lidShade, col[1] * lidShade, col[2] * lidShade];
    });
  });
  const t = tex(c, { srgb: true, wrap: false });
  const mat = new THREE.MeshPhysicalMaterial({
    map: t,
    roughness: 0.4,
    metalness: 0.0,
    clearcoat: 0.7,
    clearcoatRoughness: 0.08,
    envMapIntensity: 0.5
  });
  mat.name = 'eye';
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
