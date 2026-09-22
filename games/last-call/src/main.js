import * as THREE from 'three';
import { createRenderer } from './render/renderer.js';
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

const camera = new THREE.PerspectiveCamera(CFG.camera.fov, window.innerWidth / window.innerHeight, 0.1, 120);
camera.position.set(0, 2.2, 7);

const quality = QUALITY_PRESETS.high;
const ctx = { scene, renderer, camera, quality };

const match = new Match(ctx);
const post = new PostFX(renderer, scene, camera);
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
  input.requestLock(canvas);
}
document.getElementById('title').addEventListener('click', start);
window.addEventListener('keydown', (e) => { if (e.code === 'Enter') start(); });

// The review harness and demo links boot straight into the fight.
const qs = new URLSearchParams(location.search);
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
  post.render(time.rawDt);
  hud.update(dt, { ...match.hudState(), fps: time.fps, tris: renderer.info.render.triangles + ' tris' });
  input.lateUpdate();
  // Review harness hook: the screenshot tool waits on this.
  window.__frameCount = (window.__frameCount || 0) + 1;
  window.__ready = window.__frameCount > 20;
}
requestAnimationFrame(frame);

// Expose for the automated visual review harness and for debugging.
window.__game = { scene, camera, renderer, match, post, hud, time, CFG, THREE };
