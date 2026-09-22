# LAST CALL — Architecture Contract

Third-person drunken party brawler. Three.js r186, ES modules, Vite. No build
step is required to read the code: every file is a plain ES module under `src/`.

## Golden rules (every contributor, every file)

1. **The game must never stop running.** After any edit, `node tools/shot.mjs
   http://localhost:5199/ out.png 1600 900 9000` must produce a non-black frame
   and log zero `[pageerror]` lines. A beautiful module that throws is worth
   nothing.
2. **Own your files.** Do not edit files outside your assignment. If you need
   something from another subsystem, go through `bus` (`src/core/events.js`) or
   the documented interface below. If an interface is genuinely missing, add it
   to your own file and document it here.
3. **No new npm dependencies.** Three.js and the browser are the whole toolbox.
   Every shader, every particle system, every sound is authored here.
4. **Allocation discipline.** Nothing allocates inside `update(dt)`. Scratch
   vectors/quaternions are module-level constants reused every frame.
5. **Everything is procedural.** There are no binary assets to load: geometry,
   textures, materials, animation and audio are generated in code at boot.
   This is a hard constraint, and it is what makes the look cohesive.
6. **No em dashes in prose.** Comments and docs use commas, colons or periods.

## Module graph (acyclic, top imports bottom)

```
main.js
  game/match.js        match flow, rounds, scoring, spawn
    combat/fighter.js  the fighter entity: state, movement, combat
      anim/*           pose the skeleton
      physics/*        bodies, ragdoll, collision
      combat/*         hitboxes, combos, damage
    world/arena.js     the club: geometry, crowd, props, lights
    camera/tpcamera.js third-person camera
    ai/brain.js        opponent controller
    vfx/*              particles, decals, trails
    audio/*            music + sfx
    ui/hud.js          HUD and menus
  render/renderer.js   WebGLRenderer + render targets
  render/postfx.js     full post stack
  core/*               math, rng, events, config, input, time
```

## Core services (already written, treat as stable API)

- `core/math.js` — `clamp clamp01 lerp damp expDamp smoothstep smootherstep
  wrapAngle lerpAngle dampAngle spring remap moveTowards TAU DEG`
- `core/rng.js` — `makeRng(seed)` returns `r()` plus `.range .int .pick .chance
  .gauss .sign`. Module singleton `rng`. Use it, never `Math.random()`, so
  screenshots are reproducible.
- `core/events.js` — `bus.on/once/off/emit`, and the `EV` name table. Read the
  table before inventing a new event name.
- `core/config.js` — `CFG` tuning tree and `QUALITY_PRESETS`. Put tunables here.
- `core/input.js` — `input.state {moveX,moveY,lookX,lookY,sprint,block,magnitude}`,
  `input.down(action)`, `input.pressed(action)`, `input.consumeBuffered([...], now)`.
- `core/time.js` — `time.dt` (scaled), `time.rawDt`, `time.elapsed`, `time.raw`,
  `time.scale`, `time.fps`. Emit `EV.HITSTOP` (seconds) and `EV.SLOWMO`
  (`{duration, scale}`) instead of touching the clock yourself.

## Subsystem interfaces

Each subsystem exports a class with this shape unless noted:

```js
class Thing {
  constructor(ctx)        // ctx = { scene, renderer, camera, world, quality, rng }
  update(dt, ctx)         // per frame, scaled dt
  dispose()               // free GPU resources
}
```

### render/renderer.js  (owner: RENDER)
`createRenderer(canvas) -> { renderer, resize(w,h) }`. Owns tone mapping,
shadow config, color space. Exposes `renderer.info` for the HUD.

### render/postfx.js  (owner: RENDER)
`class PostFX { constructor(renderer, scene, camera, quality); setSize(w,h);
render(dt); dispose(); params }` — must implement, as hand-written GLSL passes:
depth prepass + normals, SSAO, bloom, screen-space reflections on the floor,
motion blur (velocity buffer), DOF, chromatic aberration, film grain, vignette,
ACES tonemap + color grading, and a `drunk` uniform (0..1) driving barrel warp
and double vision. Read `CFG.post`.

### world/arena.js  (owner: WORLD)
`class Arena { constructor(ctx); update(dt); readonly colliders; readonly
spawnPoints; readonly floorY; group }` — the nightclub: floor, bar, stage,
speakers, truss, neon, crowd, props. `colliders` is an array of
`{type:'box'|'cylinder', ...}` consumed by physics.

### characters/builder.js  (owner: CHARACTER)
`buildFighter(spec) -> { group, skinnedMeshes[], skeleton, bones{}, materials{},
setDamage(part, amount), setSweat(v) }`. `bones` maps canonical names
(`hips spine chest neck head shoulderL upperArmL forearmL handL ... footR`) to
THREE.Bone. Animation only ever touches `bones`.

### anim/rigposer.js  (owner: ANIM)
`class RigPoser { constructor(fighterRig); play(clipName, opts); update(dt,
state); setLayerWeight(name, w) }` where `state` carries
`{speed, strafe, drunk, stance, grounded, health}`. Procedural only: no
imported clips.

### physics/world.js  (owner: PHYSICS)
`class PhysicsWorld { addBody(desc); removeBody(b); step(dt); raycast(o,d,max);
capsuleSweep(...) }` plus `physics/ragdoll.js` `class Ragdoll { constructor(bones,
mass); activate(impulse, point); update(dt); blendTo(poser, t) }`.

### combat/fighter.js  (owner: COMBAT)
The entity. Reads `input` (player) or `ai/brain.js` (CPU), drives
`RigPoser`, resolves hits through `combat/hitbox.js`, emits `EV.HIT_LANDED`
etc. Owns `health[part]`, `stamina`, `drunk`.

### camera/tpcamera.js  (owner: CAMERA)
`class TPCamera { constructor(camera, ctx); setTargets(a, b); update(dt) }`.
Duel framing (keeps both fighters in shot), collision, shake, FOV kicks,
drunk sway feeding `PostFX.params.drunk`.

### vfx/particles.js  (owner: VFX)
`class VFX { emit(type, position, dir, opts); update(dt) }` — GPU instanced.
Types: `sweat blood beer confetti spark dust smoke glass shockwave`.

### audio/engine.js  (owner: AUDIO)
`class AudioEngine { init(); play(name, opts); setDrunk(v); music.start() }`.
All synthesized with WebAudio nodes. Must not autoplay before a user gesture.

### ui/hud.js  (owner: UI)
`class HUD { mount(root); update(dt, state); show(screen) }` + `hud.css`.

### ai/brain.js  (owner: AI)
`class Brain { constructor(fighter, opponent, difficulty); update(dt) -> intent }`
where `intent` mirrors the shape of `input.state` plus `action`.

## Quality bar

The reference is a current-gen AAA fighter. Concretely, a frame must show:
physically plausible lighting with real shadow contact, material response that
separates skin/cloth/metal/liquid, no flat untextured polygons, silhouettes that
read at a glance, depth cues (fog, DOF, parallax), and motion that has weight.
Grey boxes, default `MeshBasicMaterial`, and untextured primitives are failures.
