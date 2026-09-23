# LAST CALL

A third-person drunken party brawler that runs entirely in a browser. Two
fighters, one dive bar at closing time, and a buzz meter that makes you hit
harder and aim worse.

Built on Three.js with no art assets: every texture, mesh, animation, particle
and sound is generated in code at boot.

```sh
npm install
npm run dev      # http://localhost:5199
```

Add `?auto` to the URL to skip the title screen and drop straight into a fight.

## Controls

`WASD` move, `Shift` sprint, `J` jab, `K` cross, `U` hook, `I` uppercut,
`L` body kick, `Space` block, `C` dodge, `G` grab, `E` drink, `T` taunt,
`F` Borrachera.

## What is here

| Path | What it is |
|---|---|
| `src/core/` | math, deterministic rng, event bus, config, input, clock with hitstop |
| `src/render/` | renderer, post processing stack, procedural texture foundry |
| `src/world/` | the venue: architecture, lighting design, props, crowd |
| `src/characters/` | procedural skinned fighters, materials, damage |
| `src/anim/` | clips authored in code, layered blending, IK, the drunk layer |
| `src/physics/` | rigid bodies, collision, constraint ragdoll |
| `src/combat/` | the fighter entity, hitboxes, combos, per-limb damage |
| `src/camera/` | duel framing, shake, cinematic beats |
| `src/vfx/` | particles, decals, trails, impacts |
| `src/audio/` | synthesized sfx, reactive crowd, generated club track |
| `src/ui/` | HUD and menus |
| `src/game/` | match flow, the fight director, hype and Last Call |

Design notes are in [docs/GAMEPLAY.md](docs/GAMEPLAY.md); the module contract
every contributor works to is [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Review harness

```sh
node tools/shotlist.mjs REVIEW/shots/run-01 run01     # eight scripted beats
node tools/compare.mjs a.png b.png out.png key.json   # blind A/B composite
```

The bar every frame is scored against is [REVIEW/RUBRIC.md](REVIEW/RUBRIC.md).

Diagnostic pages, each isolating one subsystem so a defect can be judged
without the rest of the game in the way:

| Page | What it isolates |
|---|---|
| `char-preview.html` | the fighters, on a neutral stage, with a head close-up |
| `anim-preview.html` | every clip and blend, with a live state readout |
| `combat-preview.html` | hitboxes, frame state, chains and buzz |
| `guard-lab.html` | three candidate poses side by side, for dialling in angles |
| `audio-preview.html` | oscilloscope, FFT and per-bus meters |
| `vfx-preview.html` | every effect firing on a loop |

Useful URL flags on the game itself: `?auto` skips the title, `?q=low|medium|high|cinematic`
picks a quality preset, `?nopost` renders the lit scene straight to the screen,
and `?off=ssao,ssr,dof,mb,bloom` disables individual post passes. Between them a
bad frame can be bisected instead of guessed at.
