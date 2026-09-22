import * as THREE from 'three';
import { createRenderer } from './render/renderer.js';
import { buildEnvironment } from './render/env.js';
import { PostFX } from './render/postfx.js';
import { Match } from './game/match.js';
import { HUD } from './ui/hud.js';
import { input } from './core/input.js';
import { time } from './core/time.js';
import { CFG, QUALITY_PRESETS } from './core/config.js';
import { bus, EV } from './core/events.js';

const canvas = document.getElementById('stage');
const { renderer, resize } = createRenderer(canvas);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x04050a);
scene.fog = new THREE.FogExp2(0x05060c, CFG.render.fogDensity);
// Ambient reflection for every PBR material in the venue. Built once at boot
// from the same palette the lighting rig uses, so it never fights the lights.
scene.environment = buildEnvironment(renderer);
scene.environmentIntensity = 1.0;

const camera = new THREE.PerspectiveCamera(CFG.camera.fov, window.innerWidth / window.innerHeight, 0.1, 120);
camera.position.set(0, 2.2, 7);

// Quality is selectable from the URL so the automated review harness can
// capture the same scene at a cost software rendering can actually afford.
const qsBoot = new URLSearchParams(location.search);
const quality = QUALITY_PRESETS[qsBoot.get('q')] || QUALITY_PRESETS.high;
if (quality.shadowMapSize) CFG.render.shadowMapSize = quality.shadowMapSize;
const ctx = { scene, renderer, camera, quality };

const match = new Match(ctx);
// Individual passes can be switched off from the URL (?off=ssao,ssr,dof,mb,bloom)
// so a bad frame can be bisected instead of guessed at.
const off = new Set((qsBoot.get('off') || '').split(',').filter(Boolean));
const post = new PostFX(renderer, scene, camera, {
  ...quality,
  ssao: quality.ssao && !off.has('ssao'),
  ssr: quality.ssr && !off.has('ssr'),
  dof: quality.dof && !off.has('dof'),
  motionBlur: quality.motionBlur && !off.has('mb'),
  bloom: !off.has('bloom')
});
const hud = new HUD().mount(document.getElementById('ui-root'));

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  resize(w, h);
  post.setSize(w, h);
}
window.addEventListener('resize', onResize);
onResize();

let started = false;
function start() {
  if (started) return;
  started = true;
  hud.start();
  match.begin();
  // Pointer lock is a nice-to-have, and it throws outside a real user gesture,
  // which is exactly the case in the automated capture runs.
  try { input.requestLock(canvas); } catch { /* no gesture, keep playing */ }
}
document.getElementById('title').addEventListener('click', start);
window.addEventListener('keydown', (e) => { if (e.code === 'Enter') start(); });

// The review harness and demo links boot straight into the fight.
const qs = qsBoot;
const noPost = qs.has('nopost');
if (qs.has('auto')) setTimeout(start, 120);
window.__start = start;

input.attach();

function frame(nowMs) {
  requestAnimationFrame(frame);
  const dt = time.tick(nowMs);
  input.update(time.rawDt);
  match.update(dt);
  post.params.drunk = match.player.drunk01 * 0.85;
  renderer.info.reset();
  // ?nopost renders the lit scene straight to the screen. When a frame looks
  // wrong this is the first question: is the lighting broken, or the stack?
  if (noPost) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = CFG.render.exposure;
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  } else {
    post.render(time.rawDt);
  }
  hud.update(dt, { ...match.hudState(), fps: time.fps, tris: renderer.info.render.triangles + ' tris' });
  input.lateUpdate();
  // Review harness hook: the screenshot tool waits on this.
  window.__frameCount = (window.__frameCount || 0) + 1;
  window.__ready = window.__frameCount > 20;
}
requestAnimationFrame(frame);

// Expose for the automated visual review harness and for debugging.
window.__game = { scene, camera, renderer, match, post, hud, time, CFG, THREE };
