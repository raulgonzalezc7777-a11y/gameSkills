import * as THREE from 'three';
import { CFG } from '../core/config.js';

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,          // handled by the post stack (SMAA/TAA-ish)
    powerPreference: 'high-performance',
    stencil: false,
    depth: true,
    alpha: false,
    preserveDrawingBuffer: true // needed for photo mode and review captures
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CFG.render.maxPixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping; // post stack owns tonemapping
  renderer.toneMappingExposure = CFG.render.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = true;
  renderer.info.autoReset = false;

  const resize = (w, h) => {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CFG.render.maxPixelRatio));
    renderer.setSize(w, h, false);
  };
  resize(window.innerWidth, window.innerHeight);
  return { renderer, resize };
}

export function maxAnisotropy(renderer) {
  return Math.min(CFG.render.anisotropy, renderer.capabilities.getMaxAnisotropy());
}
