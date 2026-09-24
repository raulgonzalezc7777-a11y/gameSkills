import * as THREE from 'three';
import { createRenderer } from './render/renderer.js';
import { buildEnvironment } from './render/env.js';
import { PostFX } from './render/postfx.js';
import { Match } from './game/match.js';
import { HUD } from './ui/hud.js';
import { VFX, installVFXListeners } from './vfx/index.js';
import { AudioEngine, installAudioListeners } from './audio/index.js';
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
hud.bindWorld(camera, match);
hud._debug = qsBoot.has('debug');

// Effects listen to the event bus, so combat never calls them directly.
const vfx = new VFX({ scene, camera, renderer, quality, floorY: match.arena.floorY });
installVFXListeners(vfx);
vfx.trackFighter(match.player);
vfx.trackFighter(match.cpu);
// Soft particles need the scene depth, which only the post stack owns.
vfx.setDepthTexture(post.sceneRT.depthTexture, camera.near, camera.far);

// Everything is synthesized, so there is nothing to preload. The context
// still cannot start before a gesture, which init() handles on its own.
const audio = new AudioEngine();
installAudioListeners(audio);
audio.setListener(camera);

// Live quality. Everything the post stack does can be switched per frame, and
// render resolution is the biggest lever of all, so a player on a laptop is
// never stuck with a preset chosen for a desktop card.
const QUALITY_ORDER = ['low', 'medium', 'high', 'cinematic'];
let qualityName = QUALITY_PRESETS[qsBoot.get('q')] ? qsBoot.get('q') : 'high';
const autoQuality = !qsBoot.has('q');

function applyQuality(name) {
  const q = QUALITY_PRESETS[name];
  if (!q) return;
  qualityName = name;
  post.q.ssao = q.ssao && !off.has('ssao');
  post.q.ssr = q.ssr && !off.has('ssr');
  post.q.dof = q.dof && !off.has('dof');
  post.q.motionBlur = q.motionBlur && !off.has('mb');
  CFG.render.maxPixelRatio = q.pixelRatio ?? 1;
  onResize();
  hud.setQuality?.(name, autoQuality);
}
window.__setQuality = applyQuality;

let autoPicked = autoQuality;
hud.onQualityPick((q) => {
  // 'auto' keeps the step-down watchdog on; a manual pick turns it off, since
  // the player has just told us what they want.
  autoPicked = q === 'auto';
  applyQualityFromMenu(q === 'auto' ? 'high' : q);
});
function applyQualityFromMenu(name) {
  applyQuality(name);
  hud.setQuality(name, autoPicked);
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  resize(w, h);
  post.setSize(w, h);
}
window.addEventListener('resize', onResize);
onResize();
applyQuality(qualityName);

let started = false;
let autoAcc = 0, autoFrames = 0;
function start(fromGesture) {
  if (started) return;
  started = true;
  hud.start();
  match.begin();
  // Pointer lock only ever succeeds inside a real user gesture. Asking for it
  // anywhere else throws, which would pollute every automated capture log with
  // an error that is not a bug.
  // Inside a sandboxed iframe pointer lock can be refused; the game is fully
  // playable on the keyboard without it, so a refusal is not an error.
  if (fromGesture) Promise.resolve().then(() => input.requestLock(canvas)).catch(() => {});
  // Audio only exists once a real gesture has happened. An automated capture
  // run stays silent, which is exactly what it wants.
  if (fromGesture) audio.init().then(() => audio.music.start()).catch(() => {});
}
document.getElementById('title').addEventListener('click', () => start(true));
window.addEventListener('keydown', (e) => { if (e.code === 'Enter') start(true); });

// The review harness and demo links boot straight into the fight.
const qs = qsBoot;
const noPost = qs.has('nopost');
if (qs.has('auto')) setTimeout(() => start(false), 120);
window.__start = start;
canvas.addEventListener('click', () => { try { const r = canvas.requestPointerLock?.(); r?.catch?.(() => {}); } catch { /* no lock available */ } });

input.attach();

// The simulation runs on a fixed timestep. This is not a nicety: the
// procedural animation is built on springs, and a spring integrated at the
// clock's 0.1 second ceiling has a growth factor above one, so it diverges
// exponentially and throws the fighters out of the room. Stepping at a fixed
// 60 Hz makes the whole game framerate independent, which is also what any
// deterministic replay would need.
const FIXED_DT = 1 / 60;
const MAX_STEPS = 4;          // beyond this, drop the backlog rather than spiral
let accumulator = 0;

function frame(nowMs) {
  requestAnimationFrame(frame);
  const dt = time.tick(nowMs);
  input.update(time.rawDt);

  accumulator += dt;
  let steps = 0;
  if (hud.paused) accumulator = 0;
  while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
    match.update(FIXED_DT);
    accumulator -= FIXED_DT;
    steps++;
  }
  if (steps === MAX_STEPS) accumulator = 0;
  // Effects are presentation, not simulation, so they take the wall time that
  // was actually consumed and never run more than once per displayed frame.
  vfx.update(Math.min(dt, MAX_STEPS * FIXED_DT), camera.position);
  audio.update(time.rawDt);
  audio.setDrunk(match.player.drunk01);
  audio.setHype(match.director.hype / 100);
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
  // Automatic quality: after the fight starts, if the machine cannot hold a
  // playable frame rate, step down a preset and measure again. It only ever
  // steps down, so it cannot oscillate, and it never runs when the URL chose
  // a preset explicitly, which is how the capture harness stays deterministic.
  if (autoQuality && autoPicked && started) {
    autoAcc += time.rawDt; autoFrames++;
    if (autoAcc >= 3.5) {
      const fps = autoFrames / autoAcc;
      autoAcc = 0; autoFrames = 0;
      const i = QUALITY_ORDER.indexOf(qualityName);
      if (fps < 38 && i > 0) applyQuality(QUALITY_ORDER[i - 1]);
    }
  }

  // Review harness hook: the screenshot tool waits on this.
  window.__frameCount = (window.__frameCount || 0) + 1;
  window.__ready = window.__frameCount > 20;
}
requestAnimationFrame(frame);

// Expose for the automated visual review harness and for debugging.
window.__game = { scene, camera, renderer, match, post, hud, vfx, audio, time, CFG, THREE };
