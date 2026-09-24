import * as CANNON from 'cannon-es';

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
    w.allowSleep = false;
    w.solver.iterations = 14;
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

    // The ropes. A thick wall of boxes whose inner faces sit on the rope
    // line: thick, so a body launched at knockout speed cannot tunnel through
    // between two steps, and tall, so nothing sails over. Bouncy, so a body
    // that hits them comes back into the fight like a wrestler off the ropes.
    this.matRope = new CANNON.Material('rope');
    w.addContactMaterial(new CANNON.ContactMaterial(this.matBody, this.matRope, { friction: 0.2, restitution: 0.55 }));
    const R = arena?.ropeRadius ?? ((arena?.radius ?? 5.7) + 0.22);
    const N = 32, T = 0.6;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const b = new CANNON.Body({ mass: 0, material: this.matRope, collisionFilterGroup: GROUP.WORLD, collisionFilterMask: -1 });
      b.addShape(new CANNON.Box(new CANNON.Vec3(T, 3, (Math.PI * (R + T)) / N + 0.1)));
      b.position.set(Math.cos(a) * (R + T), floorY + 3, Math.sin(a) * (R + T));
      b.quaternion.setFromEuler(0, -a, 0);
      w.addBody(b);
    }
    this.ringRadius = R;
    this.floorY = floorY;
  }

  step(dt) { this.world.step(dt); }

  // The guarantee behind the wall: whatever the solver did this step, no
  // body's centre ends up past the ropes. One that tried is put back on the
  // rope line with its outward speed reflected, which reads as a bounce.
  // Returns the hardest outward speed it caught, so the ropes can flash.
  contain(body, margin) {
    const p = body.position, lim = this.ringRadius - margin;
    const r = Math.hypot(p.x, p.z);
    if (r <= lim) return 0;
    const nx = p.x / r, nz = p.z / r;
    p.x = nx * lim; p.z = nz * lim;
    const v = body.velocity, vr = v.x * nx + v.z * nz;
    if (vr > 0) { v.x -= 1.5 * vr * nx; v.z -= 1.5 * vr * nz; }
    return Math.max(0, vr);
  }
}
