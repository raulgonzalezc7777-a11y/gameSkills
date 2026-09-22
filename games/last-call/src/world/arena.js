import * as THREE from 'three';
import { rng } from '../core/rng.js';
import { CFG } from '../core/config.js';

// Version 1 club: a round dance floor, a bar, a truss with neon, and a ring of
// crowd silhouettes. The WORLD owner replaces this with the full venue.
export class Arena {
  constructor(ctx) {
    this.group = new THREE.Group();
    this.floorY = 0;
    this.radius = 9.5;
    this.colliders = [{ type: 'cylinder', x: 0, z: 0, r: this.radius, inside: true }];
    this.spawnPoints = [new THREE.Vector3(-2.2, 0, 0), new THREE.Vector3(2.2, 0, 0)];
    this._build(ctx);
  }

  _build(ctx) {
    const G = this.group;

    // Floor: dark lacquered wood with a subtle checker of emissive tiles.
    const floorGeo = new THREE.CircleGeometry(this.radius, 96);
    floorGeo.rotateX(-Math.PI / 2);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x14161d, roughness: 0.22, metalness: 0.35
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.receiveShadow = true;
    G.add(floor);

    // Emissive dance tiles.
    const tileGeo = new THREE.PlaneGeometry(0.92, 0.92);
    tileGeo.rotateX(-Math.PI / 2);
    const tileMat = new THREE.MeshStandardMaterial({
      color: 0x000000, emissive: 0xff2a6d, emissiveIntensity: 1.6,
      roughness: 0.3, metalness: 0.1, transparent: true, opacity: 0.85
    });
    const tiles = new THREE.InstancedMesh(tileGeo, tileMat, 96);
    const m = new THREE.Matrix4(); const col = new THREE.Color();
    let i = 0;
    for (let x = -5; x <= 5; x++) {
      for (let z = -5; z <= 5; z++) {
        if (i >= 96) break;
        if ((x + z) % 2 !== 0) continue;
        if (Math.hypot(x, z) > 5.2) continue;
        m.makeTranslation(x, 0.012, z);
        tiles.setMatrixAt(i, m);
        col.setHSL((i * 0.11) % 1, 0.85, 0.55);
        tiles.setColorAt(i, col);
        i++;
      }
    }
    tiles.count = i;
    tiles.instanceMatrix.needsUpdate = true;
    this.tiles = tiles;
    G.add(tiles);

    // Perimeter wall.
    const wallGeo = new THREE.CylinderGeometry(this.radius + 0.4, this.radius + 0.4, 6, 64, 1, true);
    const wall = new THREE.Mesh(wallGeo, new THREE.MeshStandardMaterial({
      color: 0x0b0c11, roughness: 0.95, metalness: 0.0, side: THREE.BackSide
    }));
    wall.position.y = 3;
    wall.receiveShadow = true;
    G.add(wall);

    // Bar counter.
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(6.4, 1.05, 0.9),
      new THREE.MeshStandardMaterial({ color: 0x3a2318, roughness: 0.35, metalness: 0.15 })
    );
    bar.position.set(0, 0.525, -7.6);
    bar.castShadow = true; bar.receiveShadow = true;
    G.add(bar);
    this.colliders.push({ type: 'box', x: 0, z: -7.6, hx: 3.2, hz: 0.45 });

    // Bottle wall behind the bar.
    const bottleGeo = new THREE.CylinderGeometry(0.035, 0.045, 0.3, 8);
    const bottleMat = new THREE.MeshStandardMaterial({
      color: 0x6fe3a0, roughness: 0.08, metalness: 0.0,
      transparent: true, opacity: 0.75, emissive: 0x1a5c3a, emissiveIntensity: 0.4
    });
    const bottles = new THREE.InstancedMesh(bottleGeo, bottleMat, 120);
    let bi = 0;
    for (let row = 0; row < 4; row++) {
      for (let c = 0; c < 30; c++) {
        if (bi >= 120) break;
        m.makeTranslation(-3.0 + c * 0.21, 1.4 + row * 0.42, -8.3);
        bottles.setMatrixAt(bi, m);
        col.setHSL(rng.range(0.08, 0.45), 0.7, 0.55);
        bottles.setColorAt(bi, col);
        bi++;
      }
    }
    bottles.count = bi;
    bottles.instanceMatrix.needsUpdate = true;
    G.add(bottles);

    // Neon strips on the truss.
    this.neons = [];
    const neonColors = [0xff2a6d, 0x05d9e8, 0xd1f7ff, 0xf9c80e, 0x9d4edd];
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      const strip = new THREE.Mesh(
        new THREE.BoxGeometry(3.2, 0.09, 0.09),
        new THREE.MeshStandardMaterial({
          color: 0x000000, emissive: neonColors[k], emissiveIntensity: 5.5, roughness: 0.4
        })
      );
      strip.position.set(Math.cos(a) * 6.2, 4.3, Math.sin(a) * 6.2);
      strip.rotation.y = -a;
      G.add(strip);
      const pl = new THREE.PointLight(neonColors[k], 22, 16, 2);
      pl.position.copy(strip.position).setY(4.0);
      G.add(pl);
      this.neons.push({ strip, light: pl, phase: rng.range(0, 6.28), base: 5.5 });
    }

    // Crowd ring: instanced silhouettes that bob to the beat.
    const bodyGeo = new THREE.CapsuleGeometry(0.19, 0.9, 4, 8);
    const crowdMat = new THREE.MeshStandardMaterial({ color: 0x090a0f, roughness: 1.0 });
    const count = ctx?.quality?.crowd ?? 110;
    const crowd = new THREE.InstancedMesh(bodyGeo, crowdMat, count);
    crowd.castShadow = true;
    this.crowdData = [];
    for (let c = 0; c < count; c++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(this.radius - 0.6, this.radius + 2.6);
      const d = { a, r, phase: rng.range(0, 6.28), amp: rng.range(0.05, 0.16), h: rng.range(0.9, 1.12) };
      this.crowdData.push(d);
      m.makeTranslation(Math.cos(a) * r, 0.75 * d.h, Math.sin(a) * r);
      crowd.setMatrixAt(c, m);
    }
    crowd.instanceMatrix.needsUpdate = true;
    this.crowd = crowd;
    G.add(crowd);

    // Lighting rig.
    const key = new THREE.DirectionalLight(0xfff2e0, 2.6);
    key.position.set(4, 9, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(CFG.render.shadowMapSize, CFG.render.shadowMapSize);
    key.shadow.camera.near = 1; key.shadow.camera.far = 30;
    key.shadow.camera.left = -12; key.shadow.camera.right = 12;
    key.shadow.camera.top = 12; key.shadow.camera.bottom = -12;
    key.shadow.bias = -0.0009;
    key.shadow.normalBias = 0.022;
    G.add(key);
    this.key = key;

    const rim = new THREE.DirectionalLight(0x4e7bff, 1.4);
    rim.position.set(-6, 5, -7);
    G.add(rim);

    G.add(new THREE.HemisphereLight(0x2a3050, 0x0a0a10, 0.55));

    // Spot from the truss onto the fighters.
    const spot = new THREE.SpotLight(0xffffff, 120, 22, 0.55, 0.45, 1.6);
    spot.position.set(0, 7.5, 0);
    spot.target.position.set(0, 1, 0);
    spot.castShadow = true;
    spot.shadow.mapSize.set(1024, 1024);
    G.add(spot); G.add(spot.target);
    this.spot = spot;

    this.beat = 0;
  }

  update(dt, t = 0) {
    this.beat += dt * 2.1; // ~126 bpm
    const pulse = Math.pow(Math.max(0, Math.sin(this.beat * Math.PI)), 6);
    for (const n of this.neons) {
      n.strip.material.emissiveIntensity = n.base * (0.55 + pulse * 1.1) + Math.sin(t * 3 + n.phase) * 0.6;
      n.light.intensity = 14 + pulse * 26;
    }
    if (this.tiles) this.tiles.material.emissiveIntensity = 0.8 + pulse * 2.4;

    // Crowd bob.
    const m = new THREE.Matrix4();
    for (let i = 0; i < this.crowdData.length; i++) {
      const d = this.crowdData[i];
      const y = 0.75 * d.h + Math.abs(Math.sin(this.beat * Math.PI + d.phase)) * d.amp;
      m.makeTranslation(Math.cos(d.a) * d.r, y, Math.sin(d.a) * d.r);
      this.crowd.setMatrixAt(i, m);
    }
    this.crowd.instanceMatrix.needsUpdate = true;
  }
}
