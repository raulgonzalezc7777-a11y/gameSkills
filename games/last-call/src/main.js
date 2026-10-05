import * as THREE from 'three';
import { createRenderer } from './render/renderer.js';
import { buildEnvironment } from './render/env.js';
import { PostFX } from './render/postfx.js';
import { Match } from './game/match.js';
import { HUD } from './ui/hud.js';
import { TouchControls, wantsTouch } from './ui/touch.js';
import { Menu } from './ui/menu.js';
import { SaveStore } from './meta/save.js';
import { Progress, BoutTracker } from './meta/progress.js';
import { OUTFIT_BY_ID, applyFighterStats, applyDrink } from './meta/catalog.js';
import { levelByN, levelMatchOpts, applyFighterMods } from './meta/levels.js';
import { ReplayRecorder, ReplayPlayer } from './game/replay.js';
import { ClipMaker, shareFile } from './game/clip.js';
import { captionFor } from './game/captions.js';
import { Coach } from './ui/coach.js';
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
// Phones and tablets are the main target: they boot on the phone preset and
// get the on-screen controls, everything else boots high and steps down.
const isTouch = wantsTouch() || qsBoot.has('touch');
const bootName = QUALITY_PRESETS[qsBoot.get('q')] ? qsBoot.get('q') : (isTouch ? 'phone' : 'high');
const quality = QUALITY_PRESETS[bootName];
if (quality.shadowMapSize) CFG.render.shadowMapSize = quality.shadowMapSize;
const ctx = { scene, renderer, camera, quality };

const match = new Match(ctx);
// A thumb on glass is slower and less exact than a keyboard, so the bartender
// who fights you on a phone is a touch slower to react and to swing.
const easeForTouch = (brain) => {
  if (!isTouch || !brain) return;
  brain.reaction += 0.06;
  brain.aggression *= 0.85;
};
easeForTouch(match.brain);
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
const touch = new TouchControls().mount(document.getElementById('ui-root'), {
  onPause: () => { if (fighting) hud.setPaused(!hud.paused); }
});

// Progress lives in this browser only (see meta/save.js).
const store = new SaveStore();
const progress = new Progress(store);
let fighting = false;       // a bout is on screen (menus are closed)
let tracker = null, bout = null;
let touchMode = isTouch;
const markTouch = () => document.documentElement.classList.add('touch-device');
if (touchMode) markTouch();
// A buzz in the hand for every blow: short when you land one, longer when
// you take one, a long rumble for a knockout.
const buzz = (p) => { if (touchMode && store.data.settings.vibrate) try { navigator.vibrate?.(p); } catch { /* unsupported */ } };
bus.on(EV.HIT_LANDED, (p) => {
  if (p.target === match.player) buzz(p.damage >= 9 ? 45 : 25);
  else if (p.attacker === match.player) buzz(p.damage >= 9 ? 22 : 10);
});
bus.on(EV.KO, () => buzz([80, 40, 140]));
window.addEventListener('touchstart', () => { if (!touchMode) { touchMode = true; markTouch(); if (fighting) touch.show(true); } }, { passive: true });

// Effects listen to the event bus, so combat never calls them directly.
const vfx = new VFX({ scene, camera, renderer, quality, floorY: match.arena.floorY });
installVFXListeners(vfx);
vfx.trackFighter(match.player);
vfx.trackFighter(match.cpu);
// Each rebuilt pair of fighters gets its trails; the old pair lets go of them.
match.onFighters = (a, b, old) => {
  if (old) { for (const f of old) vfx.trails?.untrack?.(f); return; }
  vfx.trackFighter(a); vfx.trackFighter(b);
};
// No soft-particle depth: particles are drawn inside the scene pass, and the
// only depth texture is the one that pass is writing. Sampling it there is a
// framebuffer feedback loop, which WebGL answers by dropping the draw, so the
// sparks, glass and beer never appeared at all. Without depth they fade on
// their own ramps and render every time.
vfx.setDepthTexture(null, camera.near, camera.far);

// Everything is synthesized, so there is nothing to preload. The context
// still cannot start before a gesture, which init() handles on its own.
const audio = new AudioEngine();
installAudioListeners(audio);
audio.setListener(camera);

// Live quality. Everything the post stack does can be switched per frame, and
// render resolution is the biggest lever of all, so a player on a laptop is
// never stuck with a preset chosen for a desktop card.
const QUALITY_ORDER = isTouch ? ['low', 'phone', 'medium', 'high', 'cinematic'] : ['low', 'medium', 'high', 'cinematic'];
let qualityName = bootName;
// Dynamic resolution: a multiplier on the preset's pixel ratio that the
// frame-rate governor in the loop moves between 0.55 and 1.
let resScale = 1;
let basePixelRatio = 1;
const autoQuality = !qsBoot.has('q');

function applyQuality(name) {
  const q = QUALITY_PRESETS[name];
  if (!q) return;
  qualityName = name;
  post.q.ssao = q.ssao && !off.has('ssao');
  post.q.ssr = q.ssr && !off.has('ssr');
  post.q.dof = q.dof && !off.has('dof');
  post.q.motionBlur = q.motionBlur && !off.has('mb');
  post.q.bloom = q.bloom !== false && !off.has('bloom');
  basePixelRatio = q.pixelRatio ?? 1;
  CFG.render.maxPixelRatio = q.pixelRatio ?? 1;
  CFG.render.physicsIters = q.physicsIters ?? 14;
  if (match.brawl) match.brawl.physics.world.solver.iterations = CFG.render.physicsIters;
  match.arena.lighting?.setLean?.(!!q.lean);
  resScale = 1;
  onResize();
  basePixelRatio = q.pixelRatio ?? 1;
  hud.setQuality?.(name, autoQuality);
}
window.__setQuality = applyQuality;

let autoPicked = autoQuality;
hud.onQualityPick((q) => {
  // 'auto' keeps the step-down watchdog on; a manual pick turns it off, since
  // the player has just told us what they want.
  autoPicked = q === 'auto';
  applyQualityFromMenu(q === 'auto' ? (isTouch ? 'phone' : 'high') : q);
});
function applyQualityFromMenu(name) {
  applyQuality(name);
  hud.setQuality(name, autoPicked);
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  // On an upright phone the controls own the bottom third of the glass, so
  // the picture's centre is lifted to sit in the part the thumbs leave clear.
  if (isTouch && w < h) camera.setViewOffset(w, h, 0, Math.round(h * 0.1), w, h);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
  resize(w, h);
  post.setSize(w, h);
}
window.addEventListener('resize', onResize);
// Compile every shader now, off the critical path where the browser allows
// it, so the first punch, spark or replay does not stall a frame on a phone.
setTimeout(() => { try { (renderer.compileAsync?.(scene, camera) ?? Promise.resolve(renderer.compile(scene, camera))).catch(() => {}); } catch { /* compiled lazily instead */ } }, 0);
onResize();
applyQuality(qualityName);

let started = false;
let autoAcc = 0, autoFrames = 0;

// ---------------------------------------------------------------- flow ---
// title -> menu -> bout -> results -> menu. The venue and the camera keep
// running behind every menu; only the fighters are rebuilt between bouts.
const menu = new Menu(document.getElementById('ui-root'), {
  progress, store,
  onPlay: (opts) => startBout(opts),
  onSettings: (g) => applySettings(g)
});

function applyAudioSettings() {
  const m = audio.mixer;
  if (!m?.buses) return;
  const g = store.data.settings;
  for (const [k, b] of Object.entries(m.buses)) {
    if (b._base === undefined) b._base = b.gain.value;
    b.gain.value = b._base * (k === 'music' ? (g.music ? 1 : 0) : (g.sfx ? 1 : 0));
  }
}
function applySettings(g) {
  applyAudioSettings();
  if (g.quality === 'auto') { autoPicked = autoQuality; applyQualityFromMenu(isTouch ? 'phone' : 'high'); }
  else if (QUALITY_PRESETS[g.quality]) { autoPicked = false; applyQualityFromMenu(g.quality); }
}

function start(fromGesture) {
  if (started) return;
  started = true;
  hud.hideTitle();
  // On a phone, take the whole screen if the page is allowed to. Embedded
  // pages often are not, and the game plays the same either way.
  if (fromGesture && touchMode) {
    try { document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })?.catch?.(() => {}); } catch { /* not allowed here */ }
  }
  // Audio only exists once a real gesture has happened. An automated capture
  // run stays silent, which is exactly what it wants.
  if (fromGesture) audio.init().then(() => { applyAudioSettings(); audio.music.start(); }).catch(() => {});
  if (store.data.settings.quality !== 'auto' && !qsBoot.has('q')) applySettings(store.data.settings);
  // Test and demo links can jump straight into a quick bout.
  if (qsBoot.has('quick') || qsBoot.has('auto')) startBout({ mode: 'quick', cpu: 'dez', difficulty: 0.6 });
  // A first-time player is punching one tap after the title, with a coach
  // showing the ropes; the menus can wait until they have had some fun.
  else if (store.data.stats.matches === 0 && !qsBoot.has('menu')) startBout({ mode: 'level', level: 1, cpu: 'dez', difficulty: 0.3, tutorial: true });
  else menu.show('home');
}

// Builds the bout the menu asked for and rings the bell.
let recorder = null, replayer = null, clip = null, replaying = false, lastDown = null, lastHit = null;
const coach = new Coach(document.getElementById('ui-root'));
function startBout(opts) {
  const s = store.data;
  const level = opts.level ? levelByN(opts.level) : null;
  const lvOpts = level ? levelMatchOpts(level) : {};
  const drink = progress.consumeDrink();
  bout = { ...opts, drink, replay: { ...opts, tutorial: false } };
  match.setup({
    player: s.sel.fighter,
    outfit: OUTFIT_BY_ID[s.sel.outfit]?.colors || null,
    cpu: opts.cpu,
    difficulty: opts.difficulty,
    mods: lvOpts.mods || [],
    roundSeconds: lvOpts.roundSeconds
  });
  easeForTouch(match.brain);
  applyFighterStats(match.player, match.player.spec.id);
  applyFighterStats(match.cpu, match.cpu.spec.id);
  applyFighterMods(match, lvOpts.mods);
  if (drink) applyDrink(match.player, match.director, drink);
  tracker?.dispose();
  tracker = new BoutTracker(match);
  recorder = new ReplayRecorder(match);
  replayer = new ReplayPlayer(recorder, camera);
  lastDown = lastHit = null;
  menu.hide();
  hud.enterFight();
  touch.show(touchMode);
  fighting = true;
  match.begin();
  if (opts.tutorial) coach.start(match, touchMode); else coach.stop();
  if (!touchMode) Promise.resolve().then(() => input.requestLock(canvas)).catch(() => {});
}

// What the replay caption needs to know about the finish.
bus.on(EV.HIT_LANDED, (p) => { lastHit = { move: p.move?.name || '', target: p.target, t: performance.now() }; });
bus.on('borrachera:start', (p) => { if (lastHit) lastHit.super = p.fighter; else lastHit = { super: p.fighter, t: performance.now() }; });
bus.on(EV.KO, (p) => { lastDown = { fighter: p.fighter, t: performance.now() }; });
bus.on(EV.KNOCKDOWN, (p) => { lastDown = { fighter: p.fighter, t: performance.now() }; });
bus.on('brawl:ropes', (p) => { if (lastHit && p.fighter === lastHit.target) lastHit.ropes = true; });

// The bout is over. Pay out straight away (so nothing can be lost to a
// closed tab during the replay), then replay a knockout finish, then show
// the results.
function endBout({ quit = false, winner = 1, wins = [0, 0] } = {}) {
  if (!fighting) return;
  fighting = false;
  coach.stop();
  const won = !quit && winner === 0;
  const settle = progress.settle(tracker, {
    won, quit, level: bout?.level || null,
    roundsLost: tracker.c.roundsLost, healthLeft: match.player.health
  });
  tracker.dispose(); tracker = null;
  touch.show(false);
  try { document.exitPointerLock?.(); } catch { /* not locked */ }
  if (quit) { match.running = false; hud.leaveFight(); menu.show('home'); return; }
  const result = { won, score: `${wins[0]} - ${wins[1]}`, settle, level: bout?.level || null, replay: bout.replay };
  const byKO = lastDown && performance.now() - lastDown.t < 2500;
  if (!byKO) {
    setTimeout(() => showResults(result), 2600);
    return;
  }
  const loser = won ? match.cpu : match.player, winnerF = won ? match.player : match.cpu;
  result.caption = captionFor({
    playerWon: won,
    move: lastHit?.move,
    super: !!lastHit?.super && lastHit.super === winnerF,
    ropes: !!lastHit?.ropes,
    winnerDrunk: winnerF.drunk01 ?? 0
  });
  result.sub = `${plainName(winnerF.spec.name)} vs ${plainName(loser.spec.name)}`;
  // Let the body land, then roll the replay.
  setTimeout(() => playReplay(result, true), 1500);
}

const plainName = (n) => String(n).replace(/\s*"[^"]*"\s*/g, ' ').replace(/\s+/g, ' ').trim();

function playReplay(result, record) {
  match.running = false;
  // No thumbs on screen during the replay, so the picture uses all of it.
  camera.clearViewOffset(); camera.updateProjectionMatrix();
  hud.leaveFight();
  hud.showReplay(result.caption, result.sub, () => replayer.stop());
  replaying = true;
  if (record) {
    clip = new ClipMaker(canvas, audio);
    clip.begin(result.caption, result.sub);
  }
  audio.surgeCrowd?.('big', 1.4);
  replayer.start({
    onEnd: async () => {
      replaying = false;
      onResize();
      hud.hideReplay();
      if (record && clip) { await clip.end(); result.clip = clip; }
      showResults(result);
    }
  });
}

function showResults(result) {
  match.running = false;
  hud.leaveFight();
  menu.show('home');
  menu.go('results', {
    ...result,
    share: result.clip ? {
      video: !!result.clip.video,
      photo: !!result.clip.photo,
      shareVideo: () => shareFile(result.clip.video.blob, `last-call-ko.${result.clip.video.ext}`, `${result.caption} 🍺🥊 #LastCall`),
      sharePhoto: () => shareFile(result.clip.photo, 'last-call-ko.jpg', `${result.caption} 🍺🥊 #LastCall`),
      watchAgain: () => { menu.hide(); playReplay(result, false); }
    } : null
  });
}
bus.on(EV.MATCH_END, (p) => endBout(p));
hud.onQuit = () => { hud.setPaused(false); endBout({ quit: true }); };

document.getElementById('title').addEventListener('click', () => start(true));
window.addEventListener('keydown', (e) => { if (e.code === 'Enter' && !started) start(true); });

// The review harness and demo links boot straight into the fight.
const qs = qsBoot;
const noPost = qs.has('nopost');
if (qs.has('auto')) setTimeout(() => start(false), 120);
window.__start = start;
canvas.addEventListener('click', () => { if (!fighting || touchMode) return; try { const r = canvas.requestPointerLock?.(); r?.catch?.(() => {}); } catch { /* no lock available */ } });

input.attach();

// The simulation runs on a fixed timestep. This is not a nicety: the
// procedural animation is built on springs, and a spring integrated at the
// clock's 0.1 second ceiling has a growth factor above one, so it diverges
// exponentially and throws the fighters out of the room. Stepping at a fixed
// 60 Hz makes the whole game framerate independent, which is also what any
// deterministic replay would need.
const FIXED_DT = 1 / 60;
const MAX_STEPS = 2;          // beyond this, drop the backlog rather than spiral
let accumulator = 0;

function frame(nowMs) {
  requestAnimationFrame(frame);
  const dt = time.tick(nowMs);
  input.update(time.rawDt);

  accumulator += dt;
  let steps = 0;
  if (hud.paused) accumulator = 0;
  if (replaying) { replayer.update(dt); accumulator = 0; }
  while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
    match.update(FIXED_DT);
    tracker?.tick(FIXED_DT, match.director.phase === 'fight');
    if (match.running) recorder?.record(FIXED_DT);
    coach.update(FIXED_DT);
    accumulator -= FIXED_DT;
    steps++;
  }
  if (steps === MAX_STEPS) accumulator = 0;
  // Effects are presentation, not simulation, so they take the wall time that
  // was actually consumed and never run more than once per displayed frame.
  vfx.update(Math.min(dt, MAX_STEPS * FIXED_DT), camera.position);
  audio.update(time.rawDt);
  audio.setDrunk(fighting ? match.player.drunk01 : 0);
  audio.setHype(match.director.hype / 100);
  post.params.drunk = fighting ? match.player.drunk01 * 0.85 : 0;
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
  // The clip is drawn from the frame just rendered, in the same task, which
  // is the only time a WebGL canvas can be read without keeping its buffer.
  if (replaying && clip?.live && replayer?.active) {
    clip.draw(replayer.t / replayer.dur, replayer.src >= replayer.peak);
  }
  touch.update(match.director.borracheraReady);
  hud.update(dt, { ...match.hudState(), fps: time.fps, tris: renderer.info.render.triangles + ' tris' });
  input.lateUpdate();
  // Automatic quality: after the fight starts, if the machine cannot hold a
  // playable frame rate, step down a preset and measure again. It only ever
  // steps down, so it cannot oscillate, and it never runs when the URL chose
  // a preset explicitly, which is how the capture harness stays deterministic.
  if (autoQuality && autoPicked && started) {
    autoAcc += time.rawDt; autoFrames++;
    if (autoAcc >= 1.5) {
      const fps = autoFrames / autoAcc;
      autoAcc = 0; autoFrames = 0;
      // First lever: resolution, in small steps, both ways. Only when that
      // is spent does the preset itself step down (lights, effects).
      let next = resScale;
      if (fps < 45) next = Math.max(0.55, resScale * 0.85);
      else if (fps > 57 && resScale < 1) next = Math.min(1, resScale * 1.08);
      if (Math.abs(next - resScale) > 0.01) {
        resScale = next;
        // Never below 0.65 CSS pixels: past that a phone screen turns to mush.
        CFG.render.maxPixelRatio = Math.max(0.65, basePixelRatio * resScale);
        onResize();
      } else if (fps < 30 && resScale <= 0.56) {
        const i = QUALITY_ORDER.indexOf(qualityName);
        if (i > 0) applyQuality(QUALITY_ORDER[i - 1]);
      }
    }
  }

  // Review harness hook: the screenshot tool waits on this.
  window.__frameCount = (window.__frameCount || 0) + 1;
  window.__ready = window.__frameCount > 20;
}
requestAnimationFrame(frame);

// Expose for the automated visual review harness and for debugging.
// The debug handle is for development and the test harness only. A shipped
// page does not hand every visitor a console shortcut to the save and the
// wallet (it cannot stop a determined cheat on a client-side game, but it
// does not make it one line either).
if (import.meta.env?.DEV || qsBoot.has('test')) {
  window.__game = { scene, camera, renderer, match, post, hud, vfx, audio, time, CFG, THREE, input, store, progress, menu, get tracker() { return tracker; } };
}
