import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GROUP } from './world.js';
import { bus, EV } from '../core/events.js';
import { rng } from '../core/rng.js';
import { MOVES } from '../combat/moves.js';
import { resolveContact } from '../combat/damage.js';

// Loose junk on the dance floor: bar stools, crates and beer bottles, all real
// rigid bodies in the brawl world. Nobody picks them up; they are in the way.
// A body that crashes through a stool sends it flying, a bottle that hits
// something hard enough shatters, and a flying stool that the other fighter
// sent your way hurts like one.

const _v = new THREE.Vector3(), _pt = new THREE.Vector3(), _prev = new THREE.Vector3();

// Where things start. Angles around the ring and a radius, so the centre stays
// clear for the fight and the junk collects where a stagger ends up.
const LAYOUT = [
  { type: 'stool', a: 0.55, r: 3.9 }, { type: 'stool', a: 2.45, r: 4.3 }, { type: 'stool', a: 4.05, r: 3.7 },
  { type: 'crate', a: 1.45, r: 4.6 }, { type: 'crate', a: 5.25, r: 4.4 },
  // A pyramid of bottles on the first crate is the skittle the whole bar is
  // waiting for someone to fall into.
  { type: 'bottle', a: 1.45, r: 4.6, on: 3, dx: -0.1, dz: -0.08 },
  { type: 'bottle', a: 1.45, r: 4.6, on: 3, dx: 0.1, dz: -0.08 },
  { type: 'bottle', a: 1.45, r: 4.6, on: 3, dx: 0, dz: 0.1 },
  { type: 'bottle', a: 0.75, r: 3.4 }, { type: 'bottle', a: 0.9, r: 3.6 }, { type: 'bottle', a: 2.2, r: 3.8 },
  { type: 'bottle', a: 3.4, r: 3.3 }, { type: 'bottle', a: 3.55, r: 3.45 }, { type: 'bottle', a: 5.0, r: 3.6 },
  { type: 'bottle', a: 5.9, r: 3.9 }
];

const SPEC = {
  bottle: { mass: 0.45, move: 'bottleThrow', breakAt: 6.5, clink: 'bottleclink' },
  stool: { mass: 4.5, move: 'stoolThrow', breakAt: Infinity, clink: 'bodyfall' },
  crate: { mass: 7, move: 'stoolThrow', breakAt: Infinity, clink: 'bodyfall' }
};

function plankTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#7a4a22'; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 4; i++) {
    const y = i * 32;
    g.fillStyle = i % 2 ? '#8c5a2c' : '#6f4220'; g.fillRect(2, y + 2, 124, 28);
    g.strokeStyle = 'rgba(40,20,5,.35)';
    for (let k = 0; k < 6; k++) { g.beginPath(); g.moveTo(0, y + 6 + k * 4); g.bezierCurveTo(40, y + 4 + k * 4, 80, y + 9 + k * 4, 128, y + 5 + k * 4); g.stroke(); }
  }
  g.fillStyle = '#3a2210'; g.fillRect(0, 0, 128, 6); g.fillRect(0, 122, 128, 6); g.fillRect(0, 0, 6, 128); g.fillRect(122, 0, 6, 128);
  g.fillStyle = '#e8e2d0'; g.font = 'bold 22px sans-serif'; g.fillText('CERVEZA', 20, 72);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildMeshes() {
  const M = {
    glassG: new THREE.MeshStandardMaterial({ color: 0x2f6b2a, roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.86 }),
    glassB: new THREE.MeshStandardMaterial({ color: 0x6b3a12, roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.88 }),
    label: new THREE.MeshStandardMaterial({ color: 0xf2e6c4, roughness: 0.6 }),
    vinyl: new THREE.MeshStandardMaterial({ color: 0xc0182f, roughness: 0.35, metalness: 0.05 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xd8dde4, roughness: 0.18, metalness: 1 }),
    wood: new THREE.MeshStandardMaterial({ map: plankTexture(), roughness: 0.78 })
  };
  const pts = [[0, 0], [0.036, 0], [0.04, 0.01], [0.04, 0.17], [0.03, 0.2], [0.015, 0.235], [0.013, 0.28], [0.016, 0.285], [0, 0.285]]
    .map(([x, y]) => new THREE.Vector2(x, y - 0.1425));
  const G = {
    bottle: new THREE.LatheGeometry(pts, 12),
    label: new THREE.CylinderGeometry(0.0405, 0.0405, 0.07, 12, 1, true),
    seat: new THREE.CylinderGeometry(0.2, 0.19, 0.08, 20),
    column: new THREE.CylinderGeometry(0.025, 0.025, 0.62, 8),
    ring: new THREE.TorusGeometry(0.14, 0.012, 6, 20),
    base: new THREE.CylinderGeometry(0.2, 0.22, 0.03, 20),
    crate: new THREE.BoxGeometry(0.6, 0.6, 0.6)
  };
  const make = {
    bottle(i) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(G.bottle, i % 3 === 0 ? M.glassB : M.glassG);
      const label = new THREE.Mesh(G.label, M.label);
      label.position.y = -0.03;
      g.add(body, label);
      return g;
    },
    stool() {
      const g = new THREE.Group();
      const seat = new THREE.Mesh(G.seat, M.vinyl); seat.position.y = 0.33;
      const col = new THREE.Mesh(G.column, M.chrome); col.position.y = 0;
      const ring = new THREE.Mesh(G.ring, M.chrome); ring.rotation.x = Math.PI / 2; ring.position.y = -0.08;
      const base = new THREE.Mesh(G.base, M.chrome); base.position.y = -0.32;
      g.add(seat, col, ring, base);
      return g;
    },
    crate() { return new THREE.Group().add(new THREE.Mesh(G.crate, M.wood)); }
  };
  return { M, G, make };
}

function buildBody(type, mat) {
  const s = SPEC[type];
  const b = new CANNON.Body({
    mass: s.mass, material: mat, linearDamping: 0.05, angularDamping: 0.12,
    collisionFilterGroup: GROUP.PROP, collisionFilterMask: -1
  });
  if (type === 'bottle') {
    b.addShape(new CANNON.Cylinder(0.02, 0.04, 0.285, 8));
  } else if (type === 'stool') {
    // Seat on top, a column, a heavy foot: it rocks and topples like a stool.
    b.addShape(new CANNON.Cylinder(0.2, 0.19, 0.08, 10), new CANNON.Vec3(0, 0.33, 0));
    b.addShape(new CANNON.Box(new CANNON.Vec3(0.03, 0.31, 0.03)), new CANNON.Vec3(0, 0, 0));
    b.addShape(new CANNON.Cylinder(0.2, 0.22, 0.03, 10), new CANNON.Vec3(0, -0.32, 0));
  } else {
    b.addShape(new CANNON.Box(new CANNON.Vec3(0.3, 0.3, 0.3)));
  }
  return b;
}

const HALF_H = { bottle: 0.1425, stool: 0.335, crate: 0.3 };

export class Debris {
  constructor(physics, arena, fighters, opts = {}) {
    this.rain = !!opts.rain;
    this.rainT = 3;
    this.physics = physics;
    this.fighters = fighters;
    this.floorY = physics.floorY;
    this.group = new THREE.Group();
    this.group.name = 'debris';
    arena?.group?.add(this.group);
    this.kit = buildMeshes();
    this.mat = new CANNON.Material('prop');
    const w = physics.world;
    w.addContactMaterial(new CANNON.ContactMaterial(this.mat, physics.matFloor, { friction: 0.4, restitution: 0.32 }));
    w.addContactMaterial(new CANNON.ContactMaterial(this.mat, physics.matBody, { friction: 0.3, restitution: 0.25 }));
    w.addContactMaterial(new CANNON.ContactMaterial(this.mat, this.mat, { friction: 0.3, restitution: 0.3 }));
    this.items = [];
    this.clock = 0;
    this.frame = 0;
    this._breaks = [];
    this._hits = [];

    LAYOUT.forEach((spec, i) => {
      const mesh = this.kit.make[spec.type](i);
      // Each item owns its materials so it can fade on its own when it sits
      // between the camera and the fight (see fade()).
      mesh.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true; o.receiveShadow = true;
        o.material = o.material.clone();
        o.material.transparent = true;
        o.material.userData.baseOpacity = o.material.opacity;
      });
      this.group.add(mesh);
      const body = buildBody(spec.type, this.mat);
      const item = { i, spec, type: spec.type, mesh, body, alive: true, respawn: 0, toucher: null, touchT: -9, hitCd: 0, clinkT: 0, prev: new THREE.Vector3() };
      body.item = item;
      body.addEventListener('collide', (e) => this.onCollide(item, e));
      this.items.push(item);
      this.place(item, spec);
      w.addBody(body);
    });

    this._off = bus.on(EV.ROUND_START, () => this.reset());
  }

  place(item, spec, drop = 0) {
    const b = item.body;
    let y = this.floorY + HALF_H[item.type] + 0.002 + drop;
    if (spec.on != null) y += 0.6;
    b.position.set(Math.cos(spec.a) * spec.r + (spec.dx || 0), y, Math.sin(spec.a) * spec.r + (spec.dz || 0));
    b.quaternion.setFromEuler(0, rng.range(0, Math.PI * 2), 0);
    b.velocity.setZero(); b.angularVelocity.setZero();
    b.force.setZero(); b.torque.setZero();
    item.alive = true;
    item.toucher = null;
    item.mesh.visible = true;
    if (!b.world) this.physics.world.addBody(b);
    this.sync(item);
  }

  reset() { for (const it of this.items) this.place(it, it.spec); }

  sync(item) {
    const b = item.body;
    item.mesh.position.set(b.position.x, b.position.y, b.position.z);
    item.mesh.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
  }

  // Collisions are only recorded here: cannon is mid-step, so removing a body
  // or dealing damage waits for postStep.
  onCollide(item, e) {
    if (!item.alive) return;
    const other = e.body;
    const impact = Math.abs(e.contact.getImpactVelocityAlongNormal());
    const f = other?.fighter;
    if (f) {
      // A fighter walking into it claims it; a thrown one landing on the
      // other fighter is a hit, credited to whoever sent it.
      const speed = item.body.velocity.length();
      if (item.toucher === 'crowd' && speed > 3 && item.hitCd <= 0) {
        this._hits.push({ item, victim: f, by: null, speed });
        item.hitCd = 0.8;
      } else if (item.toucher && item.toucher !== f && speed > 4 && this.clock - item.touchT < 2.5 && item.hitCd <= 0) {
        this._hits.push({ item, victim: f, by: item.toucher, speed });
        item.hitCd = 0.8;
      } else if (impact > 1.2 || speed < 1.5) {
        item.toucher = f; item.touchT = this.clock;
      }
    }
    if (impact > 2.2 && this.clock - item.clinkT > 0.12) {
      item.clinkT = this.clock;
      bus.emit(EV.SFX, { name: SPEC[item.type].clink, position: item.body.position, volume: Math.min(1, impact / 8) * (item.type === 'bottle' ? 0.8 : 0.55) });
    }
    if (impact > SPEC[item.type].breakAt) this._breaks.push(item);
  }

  postStep(dt) {
    this.clock += dt;
    this.frame++;
    if (this.rain) this.rainStep(dt);
    for (const it of this.items) {
      if (it.hitCd > 0) it.hitCd -= dt;
      if (!it.alive) {
        it.respawn -= dt;
        // Broken bottles come back the way everything comes back at a bar
        // fight: someone lobs a fresh one in from the crowd.
        if (it.respawn <= 0) {
          const a = rng.range(0, Math.PI * 2);
          this.place(it, { a, r: rng.range(2.6, 4.2) }, 1.2);
          it.body.velocity.set(-Math.cos(a) * 1.5, 1, -Math.sin(a) * 1.5);
          it.body.angularVelocity.set(rng.range(-6, 6), rng.range(-6, 6), rng.range(-6, 6));
        }
        continue;
      }
      if (it.toucher === 'crowd' && it.body.velocity.lengthSquared() < 1) it.toucher = null;
      _prev.copy(it.mesh.position);
      this.sync(it);
      it.prev.copy(_prev);
      // Anything that escapes the ring is quietly put back.
      const p = it.body.position;
      if (p.y < this.floorY - 2 || Math.hypot(p.x, p.z) > this.physics.ringRadius + 1.5) this.place(it, it.spec, 1.5);
    }

    if (this.camera) this.fade(dt);
    for (const h of this._hits) this.hit(h);
    this._hits.length = 0;
    for (const it of this._breaks) this.shatter(it);
    this._breaks.length = 0;
  }

  // A stool a metre from the lens fills half a phone screen. Anything close
  // to the camera turns to glass so it never hides the fight.
  fade(dt) {
    const c = this.camera.position;
    for (const it of this.items) {
      if (!it.alive) continue;
      const d = it.mesh.position.distanceTo(c);
      const want = Math.min(1, Math.max(0.12, (d - 2.2) / 1.6));
      it.alpha = it.alpha === undefined ? want : it.alpha + (want - it.alpha) * Math.min(1, dt * 8);
      if (Math.abs((it._shownAlpha ?? -1) - it.alpha) < 0.01) continue;
      it._shownAlpha = it.alpha;
      it.mesh.traverse((o) => {
        if (!o.isMesh) return;
        o.material.opacity = o.material.userData.baseOpacity * it.alpha;
        o.material.depthWrite = it.alpha > 0.95;
        o.castShadow = it.alpha > 0.5;
      });
    }
  }

  // Bottle rain: the crowd lobs a bottle at a random fighter every few
  // seconds. Anyone can be hit; it stings and staggers but never knocks out.
  rainStep(dt) {
    this.rainT -= dt;
    if (this.rainT > 0) return;
    this.rainT = rng.range(2.2, 4);
    const bottles = this.items.filter((i) => i.type === 'bottle');
    const it = bottles.find((i) => !i.alive) || rng.pick(bottles);
    const target = rng.pick(this.fighters.filter((f) => !f.dead));
    if (!it || !target) return;
    const a = rng.range(0, Math.PI * 2), R = this.physics.ringRadius - 0.4;
    this.place(it, { a, r: R }, 1.9);
    const b = it.body, t = 0.75;
    const tx = target.position.x + rng.range(-0.3, 0.3), tz = target.position.z + rng.range(-0.3, 0.3);
    b.velocity.set((tx - b.position.x) / t, (1.4 - b.position.y) / t + 0.5 * 14 * t, (tz - b.position.z) / t);
    b.angularVelocity.set(rng.range(-9, 9), rng.range(-9, 9), rng.range(-9, 9));
    it.toucher = 'crowd';
    it.hitCd = 0;
    bus.emit('brawl:rain', { position: { x: b.position.x, y: b.position.y, z: b.position.z } });
  }

  hit({ item, victim, by, speed }) {
    if (victim.dead || !victim.hurtboxes) return;
    if (!by) {
      victim.health = Math.max(1, victim.health - 3);
      victim.ragdoll?.hurt?.(0.4);
      bus.emit('brawl:clonk', { fighter: victim, type: item.type, point: item.mesh.position.clone(), speed });
      if (item.type === 'bottle') this.shatter(item);
      return;
    }
    const frame = 1e6 + this.frame;
    const hb = victim.syncBones ? victim.syncBones(frame) : victim.hurtboxes.refresh(frame);
    _v.set(item.body.position.x, item.body.position.y, item.body.position.z);
    const hurt = (hb || victim.hurtboxes).query(item.prev, _v, item.type === 'bottle' ? 0.12 : 0.3, _pt);
    const move = MOVES[SPEC[item.type].move];
    if (hurt && move) {
      resolveContact(by, victim, move, hurt, _pt, by.ctx);
    } else {
      victim.ragdoll?.hurt?.(0.35);
    }
    bus.emit('brawl:clonk', { fighter: victim, type: item.type, point: _v.clone(), speed });
    if (item.type === 'bottle') this.shatter(item);
  }

  shatter(item) {
    if (!item.alive || item.type !== 'bottle') return;
    item.alive = false;
    item.respawn = rng.range(6, 10);
    item.mesh.visible = false;
    const b = item.body;
    bus.emit(EV.PROP_BREAK, {
      position: { x: b.position.x, y: b.position.y, z: b.position.z },
      velocity: { x: b.velocity.x, y: b.velocity.y, z: b.velocity.z },
      type: 'bottle'
    });
    this.physics.world.removeBody(b);
  }

  dispose() {
    this._off?.();
    for (const it of this.items) if (it.body.world) this.physics.world.removeBody(it.body);
    this.group.removeFromParent();
  }
}
