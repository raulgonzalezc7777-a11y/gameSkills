import * as THREE from 'three';
import { bus, EV } from '../core/events.js';
import { rng } from '../core/rng.js';
import { MOVES, TUNE } from './moves.js';
import { resolveContact } from './damage.js';

// Bottles, glasses and stools. The arena owns the meshes and only promises
// 'arena.props' as an array of { mesh, type, position }; everything here
// degrades to a no-op when that array is missing, because the arena is another
// owner's file and it is allowed to change under us.

const _v = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _dir = new THREE.Vector3();
const GRAVITY = -11.5;

const THROW_MOVE = { glass: 'glassThrow', bottle: 'bottleThrow', stool: 'stoolThrow' };
// Heavy prop swings destroy the prop on contact. A jab with a pint glass does
// not, which is what makes the light prop moves worth keeping.
const BREAKS_ON_HIT = new Set(['glassSmash', 'bottleSwing', 'bottleSmash', 'stoolSlam']);

const SYSTEMS = new WeakMap();

export function getPropSystem(arena) {
  if (!arena || !Array.isArray(arena.props)) return null;
  let s = SYSTEMS.get(arena);
  if (!s) { s = new PropSystem(arena); SYSTEMS.set(arena, s); }
  return s;
}

export function throwMoveFor(type) { return MOVES[THROW_MOVE[type] || 'bottleThrow']; }
export function breaksOnHit(moveName) { return BREAKS_ON_HIT.has(moveName); }

class PropSystem {
  constructor(arena) {
    this.arena = arena;
    this.flying = [];
    this.pending = [];
    this.frame = -1;
    for (const p of arena.props) {
      if (!p.mesh) continue;
      p.home = p.mesh.position.clone();
      p.homeParent = p.mesh.parent;
      p.homeQuat = p.mesh.quaternion.clone();
      p.state = 'free';
    }
  }

  nearest(position, reach) {
    let best = null, bestD = reach * reach;
    for (const p of this.arena.props) {
      if (!p.mesh || p.state !== 'free' || !p.mesh.visible) continue;
      p.mesh.getWorldPosition(_v);
      const d = _v.distanceToSquared(position);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  grab(fighter, prop) {
    const hand = fighter.rig?.bones?.handR;
    if (!hand || !prop?.mesh) return false;
    prop.state = 'held';
    prop.holder = fighter;
    hand.add(prop.mesh);
    prop.mesh.position.set(0.06, 0, 0);
    prop.mesh.quaternion.identity();
    prop.mesh.visible = true;
    fighter.prop = prop;
    bus.emit(EV.SFX, { name: 'grab', position: fighter.position });
    return true;
  }

  // Put the mesh back where the arena built it, which is also how the bar
  // restocks between rounds.
  restore(prop) {
    if (!prop.mesh) return;
    (prop.homeParent || this.arena.group)?.add(prop.mesh);
    prop.mesh.position.copy(prop.home);
    prop.mesh.quaternion.copy(prop.homeQuat);
    prop.mesh.visible = true;
    prop.state = 'free';
    prop.holder = null;
  }

  drop(fighter) {
    const prop = fighter.prop;
    if (!prop) return;
    fighter.prop = null;
    prop.holder = null;
    this.pending.push({ prop, t: 1.2 });
    if (prop.mesh) prop.mesh.visible = false;
    prop.state = 'gone';
  }

  launch(fighter, prop, dirX, dirZ, speed) {
    if (!prop?.mesh) return;
    const root = this.arena.group || prop.homeParent;
    prop.mesh.getWorldPosition(_v);
    root?.add(prop.mesh);
    root?.worldToLocal(_v);
    prop.mesh.position.copy(_v);
    prop.state = 'flying';
    prop.holder = null;
    fighter.prop = null;
    this.flying.push({
      prop, owner: fighter, move: throwMoveFor(prop.type),
      vel: new THREE.Vector3(dirX * speed, 2.2, dirZ * speed),
      prev: new THREE.Vector3().copy(prop.mesh.getWorldPosition(_pt)),
      life: 3.2
    });
    bus.emit(EV.SFX, { name: 'throw', position: fighter.position });
  }

  // Called once per frame by whichever fighter gets there first.
  update(dt, frame, fighters, ctx) {
    if (frame === this.frame) return;
    this.frame = frame;

    for (let i = this.pending.length - 1; i >= 0; i--) {
      const r = this.pending[i];
      r.t -= dt;
      if (r.t <= 0) { this.restore(r.prop); this.pending.splice(i, 1); }
    }

    for (let i = this.flying.length - 1; i >= 0; i--) {
      const f = this.flying[i];
      const mesh = f.prop.mesh;
      f.life -= dt;
      f.vel.y += GRAVITY * dt;
      mesh.getWorldPosition(_pt);
      f.prev.copy(_pt);
      mesh.position.x += f.vel.x * dt;
      mesh.position.y += f.vel.y * dt;
      mesh.position.z += f.vel.z * dt;
      mesh.rotation.x += dt * 9; mesh.rotation.z += dt * 6;
      mesh.getWorldPosition(_v);

      let hitSomething = null, victim = null;
      for (const t of fighters) {
        if (!t || t === f.owner || t.dead || !t.hurtboxes) continue;
        if (t.syncBones) t.syncBones(frame); else t.hurtboxes.refresh(frame);
        const hurt = t.hurtboxes.query(f.prev, _v, 0.07, _pt);
        if (hurt) { hitSomething = hurt; victim = t; break; }
      }

      if (hitSomething) {
        resolveContact(f.owner, victim, f.move, hitSomething, _pt, ctx);
        this.shatter(f.prop, _pt, f.vel, ctx);
        this.flying.splice(i, 1);
        continue;
      }
      if (_v.y <= 0.09 || f.life <= 0 || Math.hypot(_v.x, _v.z) > (this.arena.radius ?? 9.5) + 3) {
        _v.y = Math.max(_v.y, 0.06);
        this.shatter(f.prop, _v, f.vel, ctx);
        this.flying.splice(i, 1);
      }
    }
  }

  shatter(prop, position, velocity, ctx) {
    prop.state = 'gone';
    if (prop.mesh) prop.mesh.visible = false;
    // VFX already listens for this shape, so the glass and beer burst is free.
    bus.emit(EV.PROP_BREAK, {
      position: { x: position.x, y: position.y, z: position.z },
      velocity: { x: velocity.x, y: velocity.y, z: velocity.z },
      type: prop.type
    });
    bus.emit(EV.SFX, { name: 'glassBreak', position });
    ctx?.director?.addHype?.(TUNE.propHype);
    this.pending.push({ prop, t: TUNE.propRestock * rng.range(0.8, 1.25) });
  }
}

// The fighter side of the interface, so fighter.js never pokes the system's
// internals and the whole feature disappears cleanly on an arena without props.
export function tryGrabOrThrow(fighter, opponent, ctx) {
  const sys = fighter.propSys;
  if (!sys) return false;
  if (fighter.prop) {
    _dir.set(Math.sin(fighter.facing), 0, Math.cos(fighter.facing));
    if (opponent) {
      _v.copy(opponent.position).sub(fighter.position).setY(0);
      if (_v.lengthSq() > 1e-4) _dir.copy(_v).normalize();
    }
    const move = throwMoveFor(fighter.prop.type);
    fighter.startScripted(move, () => {
      const p = fighter.prop;
      if (p) sys.launch(fighter, p, _dir.x, _dir.z, TUNE.propThrowSpeed);
    });
    return true;
  }
  const prop = sys.nearest(fighter.position, TUNE.propReach);
  if (!prop) return false;
  return sys.grab(fighter, prop);
}

export function breakInHand(fighter, position, ctx) {
  const sys = fighter.propSys, prop = fighter.prop;
  if (!sys || !prop) return;
  fighter.prop = null;
  sys.shatter(prop, position, _v.set(0, 1.5, 0), ctx);
}
