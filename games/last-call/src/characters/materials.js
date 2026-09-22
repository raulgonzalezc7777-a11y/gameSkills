import * as THREE from 'three';
import { TEX } from '../render/texlib.js';

// Fighter surfacing. Every map comes out of the procedural foundry in
// render/texlib.js; this module only decides how a fighter wears them.
//
// Two things here are not stock Three.js. Skin gets an onBeforeCompile pass
// that adds a fresnel subsurface term (a face lit only from behind still reads
// as flesh rather than as a silhouette) and a 'uSweat' uniform that drops
// roughness and raises specular where a body actually sweats. Cloth gets a
// physical sheen lobe, which is the cheap stand-in for the fibre backscatter
// that separates a cotton vest from painted plastic.

// Skin UV atlas. Every skin vertex lands in one of these rects, which is what
// lets damage.js paint a cut on a cheekbone without touching a calf.
export const SKIN_ATLAS = {
  body: [0.015, 0.015, 0.485, 0.985],   // torso and head, one continuous loft
  armL: [0.515, 0.760, 0.985, 0.985],
  armR: [0.515, 0.515, 0.985, 0.740],
  legL: [0.515, 0.260, 0.985, 0.485],
  legR: [0.515, 0.015, 0.985, 0.240]
};

// Declared once and shared by every skin material, so the program cache sees a
// single variant no matter how many fighters exist.
const SKIN_PARS = [
  'uniform float uSweat;',
  'uniform vec3 uSSSColor;',
  'uniform float uSSSIntensity;',
  'uniform float uSSSPower;',
  'varying float vWetZone;',
  'float wetMask;'
].join('\n');

const SKIN_WET = [
  '#include <roughnessmap_fragment>',
  'wetMask = uSweat * vWetZone;',
  '#ifdef USE_ROUGHNESSMAP',
  '  wetMask *= 0.45 + 0.55 * texture2D( roughnessMap, vRoughnessMapUv ).g * 2.0;',
  '#endif',
  'wetMask = clamp( wetMask, 0.0, 1.0 );',
  'roughnessFactor = mix( roughnessFactor, 0.085, wetMask );'
].join('\n');

// Wet skin is darker and far more specular. Both halves matter: raising gloss
// alone gives a plastic doll, darkening alone gives dirt.
const SKIN_SPEC = [
  '#include <lights_physical_fragment>',
  'material.specularColor = mix( material.specularColor, vec3( 0.20 ), wetMask );',
  'material.diffuseColor *= mix( 1.0, 0.78, wetMask );'
].join('\n');

const SKIN_SSS = [
  '#include <lights_fragment_end>',
  'float ndv = clamp( dot( normalize( normal ), normalize( vViewPosition ) ), 0.0, 1.0 );',
  'float fres = pow( 1.0 - ndv, uSSSPower );',
  'reflectedLight.indirectDiffuse += uSSSColor * ( fres * uSSSIntensity ) * diffuseColor.rgb;'
].join('\n');

const SKIN_ZONE = [
  '#include <begin_vertex>',
  'vWetZone = clamp( smoothstep( 0.50, 1.40, position.y ) * 0.80',
  '  + smoothstep( 1.74, 1.86, position.y ) * 0.55, 0.0, 1.0 );'
].join('\n');

function cloneTex(t, repeat) {
  const c = t.clone();
  c.wrapS = c.wrapT = THREE.RepeatWrapping;
  c.repeat.set(repeat, repeat);
  c.needsUpdate = true;
  return c;
}

// Copy the foundry's tileable skin canvas into a per-fighter canvas at a
// higher resolution. The base is smooth blotch noise so the upscale costs
// nothing visually, and the extra pixels are what make a painted cut or a
// tattoo crisp instead of mushy.
export function makeSkinCanvas(bundle, size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: false });
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(bundle.map.image, 0, 0, size, size);
  return { canvas: c, ctx, size };
}

export function makeSkinMaterial(skinTexture, bundle, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    map: skinTexture,
    normalMap: cloneTex(bundle.normal, opts.poreRepeat ?? 4),
    roughnessMap: cloneTex(bundle.orm, opts.poreRepeat ?? 4),
    roughness: 1.0,
    metalness: 0.0,
    envMapIntensity: opts.envMapIntensity ?? 1.0
  });
  mat.normalScale.set(0.85, 0.85);
  mat.name = 'skin';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSweat = { value: 0 };
    shader.uniforms.uSSSColor = { value: new THREE.Color(opts.sss ?? '#b8442a') };
    shader.uniforms.uSSSIntensity = { value: opts.sssIntensity ?? 0.55 };
    shader.uniforms.uSSSPower = { value: opts.sssPower ?? 2.6 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vWetZone;')
      .replace('#include <begin_vertex>', SKIN_ZONE);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + SKIN_PARS)
      .replace('#include <roughnessmap_fragment>', SKIN_WET)
      .replace('#include <lights_physical_fragment>', SKIN_SPEC)
      .replace('#include <lights_fragment_end>', SKIN_SSS);
    mat.userData.shader = shader;
  };
  mat.customProgramCacheKey = () => 'fighter-skin-v1';
  return mat;
}

// Cotton, denim and canvas all come from the same weave generator; the weave
// count and the sheen lobe are what tell them apart.
export function makeClothMaterial(color, opts = {}) {
  const bundle = TEX.fabric(color, opts.seed ?? 9, 512, opts.weave ?? 128);
  const rep = opts.repeat ?? 4;
  const mat = new THREE.MeshPhysicalMaterial({
    map: cloneTex(bundle.map, rep),
    normalMap: cloneTex(bundle.normal, rep),
    roughnessMap: cloneTex(bundle.orm, rep),
    roughness: 1.0,
    metalness: 0.0,
    sheen: opts.sheen ?? 0.55,
    sheenRoughness: opts.sheenRoughness ?? 0.75,
    sheenColor: new THREE.Color(opts.sheenColor ?? '#ffffff'),
    envMapIntensity: opts.envMapIntensity ?? 0.8
  });
  mat.normalScale.set(opts.normalScale ?? 1.1, opts.normalScale ?? 1.1);
  mat.name = opts.name ?? 'cloth';
  return mat;
}

export function makeRubberMaterial(color, opts = {}) {
  const bundle = TEX.fabric(color, opts.seed ?? 21, 512, 220);
  const mat = new THREE.MeshStandardMaterial({
    map: cloneTex(bundle.map, opts.repeat ?? 7),
    normalMap: cloneTex(bundle.normal, opts.repeat ?? 7),
    roughness: 0.82,
    metalness: 0.0,
    envMapIntensity: 0.6
  });
  mat.normalScale.set(0.7, 0.7);
  mat.name = 'sole';
  return mat;
}

// Hair borrows the brushed-metal normal: its streaks run the same way strands
// do, so a lofted shell picks up an anisotropic-looking highlight for free.
export function makeHairMaterial(color, seed) {
  const bundle = TEX.metal(color, seed, 256, true);
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color),
    normalMap: cloneTex(bundle.normal, 3),
    roughness: 0.42,
    metalness: 0.0,
    sheen: 0.9,
    sheenRoughness: 0.35,
    sheenColor: new THREE.Color('#6b5544'),
    envMapIntensity: 0.9
  });
  mat.normalScale.set(1.6, 1.6);
  mat.name = 'hair';
  return mat;
}

export function makeEyeMaterial() {
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#d9d4cc'),
    roughness: 0.16,
    metalness: 0.0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.04,
    envMapIntensity: 1.4
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

export function makeMetalMaterial(color, seed) {
  const bundle = TEX.metal(color, seed, 256, true);
  const mat = new THREE.MeshStandardMaterial({
    map: cloneTex(bundle.map, 2),
    normalMap: cloneTex(bundle.normal, 2),
    roughnessMap: cloneTex(bundle.orm, 2),
    metalnessMap: cloneTex(bundle.orm, 2),
    roughness: 1.0,
    metalness: 1.0,
    envMapIntensity: 1.2
  });
  mat.name = 'trim';
  return mat;
}

// One call drives every skin material a fighter owns. Writing straight into
// the cached shader uniform avoids a material recompile per frame.
export function makeSweatSetter(materials) {
  const skins = Object.values(materials).filter((m) => m.name === 'skin');
  let current = -1;
  return (v) => {
    const w = v < 0 ? 0 : v > 1 ? 1 : v;
    if (w === current) return;
    current = w;
    for (let i = 0; i < skins.length; i++) {
      const sh = skins[i].userData.shader;
      if (sh) sh.uniforms.uSweat.value = w;
    }
  };
}
