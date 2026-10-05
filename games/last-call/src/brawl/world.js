import * as CANNON from 'cannon-es';
import { CFG } from '../core/config.js';

// The physics world for the comedy brawl. One cannon-es world holds both
// fighters' ragdolls, the floor, an invisible ring of crowd that bounces a
// launched body back into the fight, and the static furniture.
//
// Collision groups: the world, each fighter, and loose props. A fighter never
// collides with itself (the joints own that), but collides with the other
// fighter, which is what makes a clinch a shove and a flying body a skittle.
export const GROUP = { WORLD: 1, A: 2, B: 4, PROP: 8 };

export class BrawlWorld {
  constructor(arena, opts = {}) {
    const w = new CANNON.World({ gravity: new CANNON.Vec3(0, opts.gravity ?? -14, 0) });
    w.broadphase = new CANNON.SAPBroadphase(w);
    // Props at rest sleep (no solver work until something hits them); the
    // fighters' bodies opt out in ragdoll.js because muscles drive them.
    w.allowSleep = true;
    // Fewer iterations on phones (quality.physicsIters): the ragdolls stay
    // together at 8, and the solver is the biggest CPU cost in the game.
    w.solver.iterations = CFG.render.physicsIters ?? 14;
    w.solver.tolerance = 0.0005;
    this.world = w;

    this.matBody = new CANNON.Material('body');
    this.matFloor = new CANNON.Material('floor');
    w.addContactMaterial(new CANNON.ContactMaterial(this.matBody, this.matFloor, { friction: 0.55, restitution: 0.08 }));
    w.addContactMaterial(new CANNON.ContactMaterial(this.matBody, this.matBody, { friction: 0.35, restitution: 0.15 }));

    const floorY = arena?.floorY ?? 0;
    const floor = new CANNON.Body({ mass: 0, material: this.matFloor, collisionFilterGroup: GROUP.WORLD, collisionFilterMask: -1 });
    floor.addShape(new CANNON.Plane());
    floor.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    floor.position.set(0, floorY, 0);
    w.addBody(floor);

    // The ropes. No physical wall: contain() below holds every body inside
    // the rope line each step and bounces it back, which is exact (nothing
    // can tunnel) and costs a few multiplies instead of thirty-two boxes in
    // the collision tests. ropeBounce is the restitution (Cuerdas locas
    // turns it up past 1).
    const R = arena?.ropeRadius ?? ((arena?.radius ?? 5.7) + 0.22);
    this.ropeBounce = 0.55;
    this.ringRadius = R;
    this.ceiling = floorY + ((arena?.room?.h ?? 4.7) - 0.6);
    this.floorY = floorY;
  }

  step(dt) { this.world.step(dt); }

  // The guarantee behind the wall: whatever the solver did this step, no
  // body's centre ends up past the ropes. One that tried is put back on the
  // rope line with its outward speed reflected, which reads as a bounce.
  // Returns the hardest outward speed it caught, so the ropes can flash.
  contain(body, margin) {
    const p = body.position, lim = this.ringRadius - margin;
    // Floor and ceiling too: nothing sinks through the boards, and nothing
    // sails up through the roof when the gravity is turned down.
    const v0 = body.velocity;
    if (p.y < this.floorY + 0.03) { p.y = this.floorY + 0.03; if (v0.y < 0) v0.y *= -0.3; }
    if (p.y > this.ceiling) { p.y = this.ceiling; if (v0.y > 0) v0.y *= -0.4; }
    const r = Math.hypot(p.x, p.z);
    if (r <= lim) return 0;
    const nx = p.x / r, nz = p.z / r;
    p.x = nx * lim; p.z = nz * lim;
    const v = body.velocity, vr = v.x * nx + v.z * nz;
    if (vr > 0) { const k = 1 + this.ropeBounce; v.x -= k * vr * nx; v.z -= k * vr * nz; }
    return Math.max(0, vr);
  }
}
