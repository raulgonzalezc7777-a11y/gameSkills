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
