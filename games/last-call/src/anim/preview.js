// Animation test harness. One fighter on a lit stage, an automatic tour of
// every clip, every locomotion blend and a drunk sweep, with the current state
// named on screen. Time advances a fixed step per rendered frame, so frame N of
// a capture is always the same pose: that is what makes a screenshot diff mean
// something in an environment that renders at about one frame per second.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildFighter } from '../characters/builder.js';
import { RigPoser } from './rigposer.js';
import { CLIPS } from './clips.js';
import { bus, EV } from '../core/events.js';
import { clamp01, lerp, smoothstep } from '../core/math.js';

const qs = new URLSearchParams(location.search);
const SUBSTEPS = +(qs.get('sub') || 5);
const DT = 1 / 60;

const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#0a0b10');
scene.fog = new THREE.FogExp2('#0a0b10', 0.045);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;

const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 80);

// --- stage -----------------------------------------------------------------
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(9, 64),
  new THREE.MeshStandardMaterial({ color: '#15171f', roughness: 0.52, metalness: 0.15 })
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// A ring of floor markers, so foot sliding is obvious against a fixed grid.
const markGeo = new THREE.RingGeometry(0.48, 0.5, 48);
for (let i = 1; i <= 4; i++) {
  const m = new THREE.Mesh(markGeo, new THREE.MeshBasicMaterial({ color: '#232838', side: THREE.DoubleSide }));
  m.scale.setScalar(i * 1.6);
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.002;
  scene.add(m);
}

scene.add(new THREE.HemisphereLight('#3d4c72', '#0b0c12', 0.55));
const key = new THREE.DirectionalLight('#ffe0bd', 2.6);
key.position.set(2.8, 4.6, 2.6);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.5; key.shadow.camera.far = 16;
key.shadow.camera.left = -3; key.shadow.camera.right = 3;
key.shadow.camera.top = 4; key.shadow.camera.bottom = -1;
key.shadow.bias = -0.0009;
key.shadow.normalBias = 0.022;
scene.add(key);
const rim = new THREE.DirectionalLight('#6fa8ff', 1.5);
rim.position.set(-3.2, 2.6, -3.4);
scene.add(rim);
const fill = new THREE.DirectionalLight('#ff7a5a', 0.7);
fill.position.set(-2.2, 1.4, 3.0);
scene.add(fill);

// --- fighter ---------------------------------------------------------------
const rig = buildFighter({ name: 'PREVIEW', build: 'athletic', tank: '#d9d2c4', trunks: '#28304a' });
const holder = new THREE.Group();
holder.add(rig.group);
scene.add(holder);
rig.group.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) { o.castShadow = true; o.receiveShadow = true; } });
const poser = new RigPoser(rig);

// The opponent stand in: where the fighter looks and where the punches aim.
const target = new THREE.Mesh(
  new THREE.SphereGeometry(0.115, 20, 14),
  new THREE.MeshStandardMaterial({ color: '#ff5470', emissive: '#4a0f1c', roughness: 0.4 })
);
target.position.set(0, 1.52, 1.02);
scene.add(target);

// --- the tour --------------------------------------------------------------
const S = (label, dur, o = {}) => Object.assign({ label, dur }, o);
const SEGMENTS = [
  S('IDLE guard', 3.2),
  S('LOCO walk forward', 3.6, { speed: 2.0, dir: [0, 1] }),
  S('LOCO run forward', 3.0, { speed: 4.3, dir: [0, 1] }),
  S('LOCO backstep', 2.8, { speed: 1.5, dir: [0, -1] }),
  S('LOCO strafe left', 2.8, { speed: 1.6, dir: [-1, 0] }),
  S('LOCO strafe right', 2.8, { speed: 1.6, dir: [1, 0] }),
  S('LOCO diagonal', 2.6, { speed: 2.2, dir: [0.7, 0.7] }),
  S('UPPER additive over walk', 4.6, { speed: 1.9, dir: [0, 1], attacks: ['jab', 'cross', 'hook'] }),
  S('ATTACK jab', 1.1, { play: 'jab' }),
  S('ATTACK cross', 1.3, { play: 'cross' }),
  S('ATTACK hook', 1.4, { play: 'hook' }),
  S('ATTACK uppercut', 1.5, { play: 'uppercut' }),
  S('ATTACK body kick', 1.6, { play: 'kick' }),
  S('BLOCK hold', 1.8, { block: true }),
  S('BLOCK impact', 1.4, { block: true, play: 'blockHit' }),
  S('PARRY', 1.3, { play: 'parry' }),
  S('FLINCH light', 1.2, { play: 'flinchLight' }),
  S('FLINCH heavy', 1.6, { play: 'flinchHeavy' }),
  S('STAGGER', 2.0, { play: 'stagger' }),
  S('KNOCKDOWN back', 2.2, { downed: true }),
  S('GET UP', 2.2, { keep: true }),
  S('KNOCKDOWN forward', 2.2, { downed: true, fwd: true }),
  S('GET UP', 2.2, { keep: true }),
  S('KO collapse', 2.8, { ko: true }),
  S('TAUNT', 2.4, { play: 'taunt' }),
  S('DRINK', 2.4, { play: 'drink' }),
  S('VICTORY', 2.4, { play: 'victory' }),
  S('FATIGUE stamina 5 percent', 3.0, { stamina: 0.05, health: 0.22 }),
  S('DRUNK sweep idle', 11.0, { drunkSweep: [0, 1] }),
  S('DRUNK sweep walking', 9.0, { speed: 1.8, dir: [0, 1], drunkSweep: [1, 0.15] }),
  S('DRUNK combat', 5.0, { drunk: 0.85, attacks: ['jab', 'cross'] })
];
let TOTAL = 0;
for (const s of SEGMENTS) { s.t0 = TOTAL; TOTAL += s.dur; }

const state = {
  speed: 0, drunk: 0, blocking: false, downed: false, ko: false, stun: 0,
  stamina: 1, health: 1, grounded: true, floorY: 0, facing: 0,
  velocity: new THREE.Vector3(), target
};

let clock = 0;
let segIndex = -1;
let attackTimer = 0;
let attackIdx = 0;
let downPitch = 0;
let stumbles = 0, steps = 0;
bus.on(EV.STUMBLE, () => { stumbles++; });
bus.on(EV.FOOTSTEP, () => { steps++; });

const forceClip = qs.get('clip');
const forceDrunk = qs.get('drunk');

function enterSegment(i) {
  const s = SEGMENTS[i];
  segIndex = i;
  attackTimer = 0.55;
  attackIdx = 0;
  if (s.keep) return;
  poser.sm.go(s.downed || s.ko ? 'idle' : 'idle', true);
  if (s.play) poser.play(s.play, { force: true });
}

function step(dt) {
  clock += dt;
  if (clock >= TOTAL) clock -= TOTAL;
  let i = 0;
  while (i < SEGMENTS.length - 1 && clock >= SEGMENTS[i].t0 + SEGMENTS[i].dur) i++;
  if (i !== segIndex) enterSegment(i);
  const s = SEGMENTS[i];
  const k = clamp01((clock - s.t0) / s.dur);

  state.speed = s.speed || 0;
  const d = s.dir || [0, 1];
  state.velocity.set(d[0] * state.speed, 0, d[1] * state.speed);
  state.blocking = !!s.block;
  state.downed = !!s.downed;
  state.downedForward = !!s.fwd;
  state.ko = !!s.ko;
  state.stamina = s.stamina ?? 1;
  state.health = s.health ?? 1;
  state.drunk = s.drunkSweep ? lerp(s.drunkSweep[0], s.drunkSweep[1], k) : (s.drunk || 0);
  if (forceDrunk !== null) state.drunk = +forceDrunk;

  // Chained attacks, to prove the upper body additive rides over locomotion.
  if (s.attacks) {
    attackTimer -= dt;
    if (attackTimer <= 0) {
      poser.play(s.attacks[attackIdx % s.attacks.length]);
      attackIdx++;
      attackTimer = 1.25;
    }
  }
  if (forceClip) poser.play(forceClip, { force: poser.sm.cur.name === 'idle' });

  poser.update(dt, state);

  // combat/fighter.js owns the group pitch while a fighter is on the floor, so
  // the preview reproduces it: the clips only carry the shape of the fall.
  const wantPitch = state.ko ? -1.35 : state.downed ? -1.25 : 0;
  downPitch = lerp(downPitch, wantPitch, 1 - Math.exp(-6 * dt));
  rig.group.rotation.x = downPitch;
  rig.group.position.y = downPitch * 0.42;
}

const elState = document.getElementById('state');
const elSeg = document.getElementById('seg');
const elInfo = document.getElementById('info');
const bDrunk = document.getElementById('bDrunk');
const bSpeed = document.getElementById('bSpeed');
const bHealth = document.getElementById('bHealth');

function hud() {
  elState.textContent = poser.label;
  elSeg.textContent = (segIndex + 1) + '/' + SEGMENTS.length + '  ' + SEGMENTS[segIndex].label;
  elInfo.textContent = 't ' + clock.toFixed(1) + 's   buzz ' + state.drunk.toFixed(2) +
    '   steps ' + steps + '   stumbles ' + stumbles;
  bDrunk.style.width = (state.drunk * 100).toFixed(0) + '%';
  bSpeed.style.width = (clamp01(state.speed / 4.35) * 100).toFixed(0) + '%';
  bHealth.style.width = (state.health * 100).toFixed(0) + '%';
}

// Seek, so a capture can land on an exact pose without waiting for the tour.
const seek = +(qs.get('t') || 0);
if (seek > 0) { for (let i = 0; i < Math.round(seek / DT); i++) step(DT); }

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

window.__frameCount = 0;
function frame() {
  for (let i = 0; i < SUBSTEPS; i++) step(DT);
  // A slow orbit, so a run of captures sees the rig from several angles.
  const az = 0.62 + Math.sin(clock * 0.085) * 0.62;
  const rad = 3.85;
  camera.position.set(Math.sin(az) * rad, 1.62 + Math.sin(clock * 0.05) * 0.25, Math.cos(az) * rad + 0.35);
  camera.lookAt(0, 1.02 + downPitch * 0.35, 0.15);
  hud();
  renderer.render(scene, camera);
  window.__frameCount++;
  requestAnimationFrame(frame);
}
frame();

window.__anim = { poser, rig, state, SEGMENTS, CLIPS, step };
