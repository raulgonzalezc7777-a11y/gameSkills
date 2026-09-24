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

    // The ring: the crowd shoves you back in. Twenty-eight tall boxes on a
    // circle just outside the lit floor, with a lot of bounce, so a knockout
    // blow sends a body into the punters and it comes back like a pinball.
    const R = (arena?.radius ?? 5.7) + 0.55;
    const N = 28;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const b = new CANNON.Body({ mass: 0, material: this.matFloor, collisionFilterGroup: GROUP.WORLD, collisionFilterMask: -1 });
      b.addShape(new CANNON.Box(new CANNON.Vec3(0.2, 1.6, (Math.PI * R) / N + 0.08)));
      b.position.set(Math.cos(a) * (R + 0.2), floorY + 1.6, Math.sin(a) * (R + 0.2));
      b.quaternion.setFromEuler(0, -a, 0);
      w.addBody(b);
    }
    this.ringRadius = R;
    this.floorY = floorY;
  }

  step(dt) { this.world.step(dt); }
}
