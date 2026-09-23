export { PhysicsWorld } from './world.js';
export { Ragdoll } from './ragdoll.js';
export { BallSocket } from './constraints.js';
export { Body, Sphere, Capsule, Box } from './body.js';

import { PhysicsWorld } from './world.js';

// One call builds a world that matches the arena, so integration is two lines.
export function createPhysicsForArena(arena, opts = {}) {
  const world = new PhysicsWorld({
    floorY: arena?.floorY ?? 0,
    arenaRadius: (arena?.room ? Math.max(arena.room.hx, arena.room.hz) + 0.6 : arena?.radius ?? 0),
    ...opts
  });
  if (arena?.colliders) world.addArenaColliders(arena.colliders);
  return world;
}
