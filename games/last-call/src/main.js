import * as THREE from 'three';
import { createRenderer } from './render/renderer.js';
import { buildEnvironment } from './render/env.js';
import { PostFX } from './render/postfx.js';
import { Match } from './game/match.js';
import { HUD } from './ui/hud.js';
import { VFX, installVFXListeners } from './vfx/index.js';
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

// Effects listen to the event bus, so combat never calls them directly.
const vfx = new VFX({ scene, camera, renderer, quality, floorY: match.arena.floorY });
installVFXListeners(vfx);
vfx.trackFighter(match.player);
vfx.trackFighter(match.cpu);
// Soft particles need the scene depth, which only the post stack owns.
vfx.setDepthTexture(post.sceneRT.depthTexture, camera.near, camera.far);

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
function start(fromGesture) {
  if (started) return;
  started = true;
  hud.start();
  match.begin();
  // Pointer lock only ever succeeds inside a real user gesture. Asking for it
  // anywhere else throws, which would pollute every automated capture log with
  // an error that is not a bug.
  if (fromGesture) input.requestLock(canvas);
}
document.getElementById('title').addEventListener('click', () => start(true));
window.addEventListener('keydown', (e) => { if (e.code === 'Enter') start(true); });

// The review harness and demo links boot straight into the fight.
const qs = qsBoot;
const noPost = qs.has('nopost');
if (qs.has('auto')) setTimeout(() => start(false), 120);
window.__start = start;
canvas.addEventListener('click', () => input.requestLock(canvas));

input.attach();

function frame(nowMs) {
  requestAnimationFrame(frame);
  const dt = time.tick(nowMs);
  input.update(time.rawDt);
  match.update(dt);
  vfx.update(dt, camera.position);
  post.params.drunk = match.player.drunk01 * 0.85;
  post.params.focusDistance = match.focusDistance;
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
window.__game = { scene, camera, renderer, match, post, hud, vfx, time, CFG, THREE };
