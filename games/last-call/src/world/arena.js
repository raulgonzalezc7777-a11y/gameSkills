import * as THREE from 'three';
import { MAT, spillMask, disposeMaterials } from './materials.js';
import { Lighting } from './lighting.js';
import { Crowd } from './crowd.js';
import { TEX, applyPBR } from '../render/texlib.js';
import { rng } from '../core/rng.js';
import { CFG } from '../core/config.js';
import { bus, EV } from '../core/events.js';
import { clamp01, TAU } from '../core/math.js';

// EL GARITO: a rectangular dive bar, not a stage. The room is authored around
// one idea, that the fight happens on the dance floor while the venue keeps
// running around it, so every element points inward at the centre.
const ROOM = { hx: 9.6, hz: 7.4, h: 4.7 };
const FLOOR_R = 5.7;          // the lit dance floor, which is also the fight area
const BEATS_PER_SEC = 126 / 60;

const PINK = 0xff2a6d, CYAN = 0x05d9e8, GOLD = 0xf9c80e, VIOLET = 0x9d4edd;
const TILE_BED = new THREE.Color(0x1b1424);

export class Arena {
  constructor(ctx = {}) {
    this.group = new THREE.Group();
    this.group.name = 'arena';
    this.room = ROOM;
    this.floorY = 0;
    this.radius = FLOOR_R;
    this.quality = ctx.quality ?? {};
    this.colliders = [];
    this.props = [];
    this.spawnPoints = [new THREE.Vector3(-1.6, 0, 0.3), new THREE.Vector3(1.6, 0, -0.3)];

    this.beat = 0;
    this.pulse = 0;
    this.energy = 0.3;

    this._buildShell();
    this._buildFloor();
    this._buildBar();
    this._buildStage();
    this._buildTruss();
    this._buildSigns();
    this._buildProps();

    this._buildBlobs();

    this.crowd = new Crowd(this.group, {
      count: this.quality.crowd ?? 170,
      placer: (n) => this._crowdSlots(n)
    });
    this.lighting = new Lighting(this.group, ROOM, this.quality);

    this._offs = [
      bus.on(EV.CROWD_REACT, (p) => { this.energy = Math.min(1, this.energy + (p?.level === 'peak' ? 0.4 : 0.12)); })
    ];
  }

  // ------------------------------------------------------------ geometry ---

  _buildShell() {
    const { hx, hz, h } = ROOM;

    // Walls as four inward-facing planes rather than an inverted box, so each
    // wall can carry its own UV scale and its own dressing.
    const wallMat = MAT.brick();
    const mkWall = (w, rotY, x, z) => {
      const g = new THREE.PlaneGeometry(w, h, 1, 1);
      g.setAttribute('uv2', g.attributes.uv);
      const m = new THREE.Mesh(g, wallMat);
      m.position.set(x, h / 2, z);
      m.rotation.y = rotY;
      m.receiveShadow = true;
      this.group.add(m);
      return m;
    };
    mkWall(hx * 2, 0, 0, -hz);              // back
    mkWall(hx * 2, Math.PI, 0, hz);         // front
    mkWall(hz * 2, Math.PI / 2, -hx, 0);    // left
    mkWall(hz * 2, -Math.PI / 2, hx, 0);    // right

    // Plaster band above head height: the upper half of a bar is always a
    // different, cheaper material than the lower half.
    const bandGeo = new THREE.PlaneGeometry(hx * 2, 1.5);
    bandGeo.setAttribute('uv2', bandGeo.attributes.uv);
    for (const [rotY, x, z] of [[0, 0, -hz + 0.01], [Math.PI, 0, hz - 0.01]]) {
      const m = new THREE.Mesh(bandGeo, MAT.plaster());
      m.position.set(x, h - 0.78, z);
      m.rotation.y = rotY;
      this.group.add(m);
    }

    const ceilGeo = new THREE.PlaneGeometry(hx * 2, hz * 2);
    ceilGeo.rotateX(Math.PI / 2);
    const ceil = new THREE.Mesh(ceilGeo, MAT.ceiling());
    ceil.position.y = h;
    this.group.add(ceil);

    // Exposed ducting, because a low ceiling with nothing on it reads as a box.
    const duct = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.34, hx * 1.9, 14, 1, true),
      MAT.steel()
    );
    duct.rotation.z = Math.PI / 2;
    duct.position.set(0, h - 0.42, -3.1);
    duct.castShadow = true;
    this.group.add(duct);
    const duct2 = duct.clone();
    duct2.position.z = 3.4;
    this.group.add(duct2);

    // The room is closed, so nothing can walk out of it.
    this.colliders.push(
      { type: 'box', x: 0, z: -hz - 0.5, hx, hz: 0.5 },
      { type: 'box', x: 0, z: hz + 0.5, hx, hz: 0.5 },
      { type: 'box', x: -hx - 0.5, z: 0, hx: 0.5, hz },
      { type: 'box', x: hx + 0.5, z: 0, hx: 0.5, hz }
    );
  }

  _buildFloor() {
    const { hx, hz } = ROOM;

    // Base floor: dark boards, wet in patches. The spill mask drives roughness
    // only, so a puddle reads purely as a change in how light bounces.
    const floorGeo = new THREE.PlaneGeometry(hx * 2, hz * 2, 1, 1);
    floorGeo.rotateX(-Math.PI / 2);
    floorGeo.setAttribute('uv2', floorGeo.attributes.uv);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x8f8074, roughness: 0.6, metalness: 0.0, envMapIntensity: 1.35
    });
    applyPBR(floorMat, TEX.wood('#2c1b11', 17, 512, 8), 13);
    const spill = spillMask(512, 77);
    spill.repeat.set(1.6, 1.6);
    floorMat.roughnessMap = spill;
    floorMat.onBeforeCompile = (sh) => {
      // Invert the spill mask into roughness: wet floor is smooth floor.
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness;
         vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );
         // Wet wood is a gloss change, not a black hole. Taken all the way to
         // mirror smooth, the puddles reflected the dark ceiling and read as
         // spilled oil; held at satin they pick up the neon instead.
         roughnessFactor *= mix( 1.0, 0.42, texelRoughness.g * 0.8 );`
      );
    };
    floorMat.customProgramCacheKey = () => 'lastcall-floor';
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.receiveShadow = true;
    this.group.add(floor);
    this.floorMat = floorMat;

    // No light-up disco floor. A checkerboard of glowing panels is the one
    // object in the room that says "game" before anything else does, and in
    // every review frame it was the brightest, most saturated thing on screen,
    // so the eye landed on the floor instead of on the fight. A real dive bar
    // has worn, wet boards; the music lives in an LED strip sunk into them.
    const ledGeo = new THREE.TorusGeometry(FLOOR_R - 0.06, 0.018, 6, 160);
    ledGeo.rotateX(Math.PI / 2);
    const ledMat = new THREE.MeshStandardMaterial({
      color: 0x050507, emissive: PINK, emissiveIntensity: 2.2, roughness: 0.3
    });
    const led = new THREE.Mesh(ledGeo, ledMat);
    led.position.y = 0.006;
    this.group.add(led);
    this.ledMat = ledMat;
    this._ledA = new THREE.Color(PINK);
    this._ledB = new THREE.Color(CYAN);

    // A brass trim ring around the dance floor: it catches every light in the
    // room and draws the eye to where the fight is.
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(FLOOR_R + 0.08, 0.045, 8, 96),
      MAT.brass()
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.045;
    this.group.add(ring);
  }

  _buildBar() {
    const { hx, hz, h } = ROOM;
    const bx = -hx + 1.15;   // the bar runs down the left wall

    const top = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.09, hz * 1.55), MAT.barTop());
    top.position.set(bx, 1.08, -0.4);
    top.castShadow = true; top.receiveShadow = true;
    this.group.add(top);

    const front = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.04, hz * 1.55), MAT.panelWood());
    front.position.set(bx + 0.02, 0.52, -0.4);
    front.castShadow = true; front.receiveShadow = true;
    this.group.add(front);

    // Brass foot rail: the detail that makes a bar read as a bar.
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, hz * 1.5, 10), MAT.brass());
    rail.rotation.x = Math.PI / 2;
    rail.position.set(bx + 0.52, 0.19, -0.4);
    this.group.add(rail);

    this.colliders.push({ type: 'box', x: bx, z: -0.4, hx: 0.6, hz: hz * 0.78 });

    // Back bar: shelves of bottles lit from behind, the brightest thing in the
    // room after the neon, and the reason the left wall is never black.
    const shelfMat = MAT.darkWood();
    const bottleGeo = new THREE.CylinderGeometry(0.036, 0.048, 0.29, 7, 1);
    const bottleN = 150;
    const bottles = new THREE.InstancedMesh(bottleGeo, MAT.glass(0xffffff, 0.62), bottleN);
    const m = new THREE.Matrix4(), c = new THREE.Color();
    let bi = 0;
    for (let row = 0; row < 4; row++) {
      const y = 1.42 + row * 0.5;
      const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.035, hz * 1.4), shelfMat);
      shelf.position.set(-hx + 0.28, y - 0.16, -0.4);
      shelf.castShadow = true;
      this.group.add(shelf);

      // A strip light under each shelf, as emissive geometry only.
      const strip = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, 0.025, hz * 1.35),
        MAT.neon(row % 2 ? CYAN : PINK, 4.2)
      );
      strip.position.set(-hx + 0.38, y - 0.2, -0.4);
      this.group.add(strip);

      for (let k = 0; k < 38 && bi < bottleN; k++) {
        const z = -0.4 - hz * 0.68 + k * (hz * 1.36 / 38) + rng.range(-0.012, 0.012);
        m.makeTranslation(-hx + 0.3 + rng.range(-0.04, 0.04), y, z);
        bottles.setMatrixAt(bi, m);
        c.setHSL(rng.range(0.06, 0.42), rng.range(0.5, 0.9), rng.range(0.45, 0.62));
        bottles.setColorAt(bi, c);
        bi++;
      }
    }
    bottles.count = bi;
    bottles.instanceMatrix.needsUpdate = true;
    bottles.instanceColor.needsUpdate = true;
    this.group.add(bottles);

    // Stools along the bar.
    for (let i = 0; i < 6; i++) {
      const z = -4.6 + i * 1.7;
      this.group.add(this._stool(bx + 1.05, z));
    }
  }

  _stool(x, z) {
    const g = new THREE.Group();
    const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.07, 14), MAT.vinyl());
    seat.position.y = 0.72; seat.castShadow = true;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.72, 8), MAT.chrome());
    post.position.y = 0.36; post.castShadow = true;
    const foot = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.018, 6, 14), MAT.chrome());
    foot.rotation.x = Math.PI / 2; foot.position.y = 0.22;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.23, 0.03, 14), MAT.blackMetal());
    base.position.y = 0.015;
    g.add(seat, post, foot, base);
    g.position.set(x, 0, z);
    g.rotation.y = rng.range(-0.6, 0.6);
    return g;
  }

  _buildStage() {
    const { hx, hz } = ROOM;

    // DJ booth on the back wall, raised, so there is a focal point behind the
    // fight instead of a flat plane.
    const deck = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.34, 1.5), MAT.blackMetal());
    deck.position.set(2.6, 0.17, -hz + 0.9);
    deck.castShadow = true; deck.receiveShadow = true;
    this.group.add(deck);
    this.colliders.push({ type: 'box', x: 2.6, z: -hz + 0.9, hx: 1.8, hz: 0.75 });

    const console_ = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.16, 0.62), MAT.steel());
    console_.position.set(2.6, 1.02, -hz + 0.95);
    console_.castShadow = true;
    this.group.add(console_);
    const stand = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.68, 0.5), MAT.panelWood());
    stand.position.set(2.6, 0.62, -hz + 0.95);
    this.group.add(stand);

    // Deck lights, tiny but they read.
    for (let i = 0; i < 6; i++) {
      const led = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.012, 0.05),
        MAT.neon(i % 2 ? GOLD : CYAN, 7)
      );
      led.position.set(2.0 + i * 0.24, 1.105, -hz + 0.78);
      this.group.add(led);
    }

    // Speaker stacks flanking the booth.
    for (const side of [-1, 1]) {
      const x = 2.6 + side * 2.5;
      for (let i = 0; i < 2; i++) {
        const cab = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.95, 0.66), MAT.panelWood());
        cab.position.set(x, 0.48 + i * 0.96, -hz + 0.7);
        cab.castShadow = true; cab.receiveShadow = true;
        this.group.add(cab);
        const grille = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.82), MAT.grille());
        grille.position.set(x, 0.48 + i * 0.96, -hz + 1.035);
        this.group.add(grille);
        const cone = new THREE.Mesh(new THREE.CircleGeometry(0.24, 18), MAT.rubber());
        cone.position.set(x, 0.42 + i * 0.96, -hz + 1.04);
        this.group.add(cone);
      }
      this.colliders.push({ type: 'box', x, z: -hz + 0.7, hx: 0.45, hz: 0.35 });
    }
  }

  _buildTruss() {
    const { hx, h } = ROOM;
    const barGeo = new THREE.CylinderGeometry(0.035, 0.035, hx * 1.95, 7);
    const mk = (z, y) => {
      const t = new THREE.Mesh(barGeo, MAT.steel());
      t.rotation.z = Math.PI / 2;
      t.position.set(0, y, z);
      this.group.add(t);
      return t;
    };
    for (const z of [-4.4, 4.4]) {
      mk(z, h - 0.5);
      mk(z, h - 0.82);
      // Diagonal bracing, which is what makes a truss look like a truss.
      for (let i = -8; i <= 8; i++) {
        const br = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.44, 5), MAT.steel());
        br.position.set(i * 1.1, h - 0.66, z);
        br.rotation.x = (i % 2 ? 1 : -1) * 0.72;
        this.group.add(br);
      }
    }

    // Disco ball: a faceted sphere of small chrome plates.
    const ballGeo = new THREE.IcosahedronGeometry(0.33, 2);
    const ball = new THREE.Mesh(ballGeo, new THREE.MeshStandardMaterial({
      color: 0xdfe6f0, roughness: 0.08, metalness: 1.0, flatShading: true, envMapIntensity: 2.2
    }));
    ball.position.set(-1.2, h - 1.15, 0.6);
    ball.castShadow = true;
    this.group.add(ball);
    this.discoBall = ball;
    const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.52, 5), MAT.chrome());
    chain.position.set(-1.2, h - 0.62, 0.6);
    this.group.add(chain);

    // Fairy lights strung across the ceiling: cheap, and the single fastest way
    // to make a room feel like a party.
    // Small, warm and dim. At full neon intensity the bloom pass turned every
    // bulb into a white ball the size of a fist.
    const bulbGeo = new THREE.SphereGeometry(0.016, 6, 5);
    const strandColors = [0xffc98a, 0xffb487, 0xffd6a8];
    for (let s = 0; s < 3; s++) {
      const bulbs = new THREE.InstancedMesh(bulbGeo, MAT.neon(strandColors[s], 1.8), 26);
      const m = new THREE.Matrix4();
      const z0 = -5.2 + s * 3.6;
      for (let i = 0; i < 26; i++) {
        const t = i / 25;
        const x = -hx + 0.6 + t * (hx * 2 - 1.2);
        const sag = Math.sin(t * Math.PI) * 0.42;
        m.makeTranslation(x, h - 0.18 - sag, z0 + Math.sin(t * 3.1) * 0.5);
        bulbs.setMatrixAt(i, m);
      }
      bulbs.instanceMatrix.needsUpdate = true;
      this.group.add(bulbs);
    }
  }

  _buildSigns() {
    const { hx, hz } = ROOM;
    // The venue name in neon tubing, bent from torus and box segments. Built
    // as glowing geometry so the bloom pass does the work.
    const sign = new THREE.Group();
    const tube = (w, x, y, rot = 0, color = PINK) => {
      const t = new THREE.Mesh(new THREE.CapsuleGeometry(0.028, w, 4, 8), MAT.neon(color, 9));
      t.position.set(x, y, 0);
      t.rotation.z = rot + Math.PI / 2;
      sign.add(t);
      return t;
    };
    // A stylised wordmark rather than real letterforms: five vertical strokes
    // and two horizontals read as signage at gameplay distance.
    const letters = [-1.5, -0.9, -0.3, 0.3, 0.9, 1.5];
    letters.forEach((x, i) => tube(0.42, x, 0, 0, i % 2 ? CYAN : PINK));
    tube(2.9, 0, 0.26, Math.PI / 2, GOLD);
    tube(2.9, 0, -0.26, Math.PI / 2, GOLD);
    const box = new THREE.Mesh(new THREE.BoxGeometry(3.3, 0.9, 0.09), MAT.blackMetal());
    box.position.z = -0.07;
    sign.add(box);
    sign.position.set(-3.4, 2.75, -hz + 0.1);
    this.group.add(sign);
    this.sign = sign;

    // A second sign over the bar, a simple glowing bar rail.
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, hz * 1.4), MAT.neon(VIOLET, 7));
    rail.position.set(-hx + 0.75, 2.42, -0.4);
    this.group.add(rail);
  }

  _buildProps() {
    // Tables around the edge of the dance floor, each with glassware. These are
    // also the physics props, exposed so combat can pick them up later.
    const spots = [[-6.4, 4.6], [-3.2, 5.9], [1.4, 6.2], [5.4, 4.9], [7.6, 1.2], [7.4, -3.4]];
    for (const [x, z] of spots) {
      const g = new THREE.Group();
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.05, 18), MAT.darkWood());
      top.position.y = 0.74; top.castShadow = true; top.receiveShadow = true;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.74, 8), MAT.blackMetal());
      post.position.y = 0.37;
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.32, 0.03, 16), MAT.blackMetal());
      base.position.y = 0.015;
      g.add(top, post, base);
      g.position.set(x, 0, z);
      this.group.add(g);
      this.colliders.push({ type: 'cylinder', x, z, r: 0.42, inside: false });

      for (let k = 0; k < rng.int(1, 3); k++) {
        const a = rng.range(0, TAU), r = rng.range(0, 0.26);
        const glass = new THREE.Mesh(
          new THREE.CylinderGeometry(0.037, 0.03, 0.13, 10, 1, true),
          MAT.glass(0xdff3ff, 0.34)
        );
        glass.position.set(x + Math.cos(a) * r, 0.83, z + Math.sin(a) * r);
        this.group.add(glass);
        const beer = new THREE.Mesh(
          new THREE.CylinderGeometry(0.033, 0.027, 0.09, 10),
          MAT.liquid(0xd08a24)
        );
        beer.position.copy(glass.position).setY(0.805);
        this.group.add(beer);
        this.props.push({ mesh: glass, type: 'glass', position: glass.position });
      }
    }

    // Loose bottles on the bar, the throwable stock.
    for (let i = 0; i < 7; i++) {
      const z = -4.8 + i * 1.45;
      const b = new THREE.Mesh(
        new THREE.CylinderGeometry(0.036, 0.046, 0.27, 9),
        MAT.glass(rng.pick([0x6fe3a0, 0x8a5a2a, 0x3f6fa8]), 0.58)
      );
      b.position.set(-ROOM.hx + 1.15, 1.26, z);
      b.castShadow = true;
      this.group.add(b);
      this.props.push({ mesh: b, type: 'bottle', position: b.position });
    }
  }

  // Soft contact shadows. The dance floor emits light, so a shadow map alone
  // never plants a fighter on it: a blob under the feet is what sells weight,
  // and it is the read a player notices without ever noticing it.
  _buildBlobs() {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.85)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.5)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;

    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.blobs = [];
    for (let i = 0; i < 4; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false, opacity: 0.7,
        blending: THREE.NormalBlending, color: 0x000000, toneMapped: false
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 5;
      mesh.visible = false;
      mesh.position.y = this.floorY + 0.026;
      this.group.add(mesh);
      this.blobs.push({ mesh, mat, active: false });
    }
  }

  // Called once per fighter per frame with where they stand and how tall they
  // are off the ground: a jumping fighter's shadow shrinks and fades.
  setBlob(index, x, z, radius = 0.5, lift = 0) {
    const b = this.blobs[index];
    if (!b) return;
    const fade = Math.max(0, 1 - lift * 0.9);
    b.mesh.position.set(x, this.floorY + 0.026, z);
    const r = radius * (1 + lift * 0.5);
    b.mesh.scale.set(r * 2, 1, r * 2);
    b.mat.opacity = 0.72 * fade;
    b.active = fade > 0.02;
    b.mesh.visible = b.active;
  }

  // Crowd stands outside the dance floor ring and along the walls, facing in.
  _crowdSlots(n) {
    const { hx, hz } = ROOM;
    const slots = [];
    let guard = 0;
    while (slots.length < n && guard++ < n * 40) {
      const x = rng.range(-hx + 0.7, hx - 0.7);
      const z = rng.range(-hz + 0.7, hz - 0.7);
      const d = Math.hypot(x, z);
      if (d < FLOOR_R + 0.5) continue;                 // never inside the fight
      if (x < -hx + 2.3 && Math.abs(z) < hz * 0.8) continue;  // not inside the bar
      if (z < -hz + 1.9 && x > 0.4) continue;          // not on the DJ booth
      slots.push({ x, z, y: 0, face: Math.atan2(-x, -z) + rng.gauss(0, 0.3) });
    }
    // Front row presses right up against the brass ring.
    for (let i = 0; i < Math.min(34, slots.length); i++) {
      const a = (i / 34) * TAU + rng.gauss(0, 0.05);
      const r = FLOOR_R + rng.range(0.55, 1.0);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (Math.abs(x) > hx - 0.6 || Math.abs(z) > hz - 0.6) continue;
      slots[i] = { x, z, y: 0, face: Math.atan2(-x, -z) + rng.gauss(0, 0.16) };
    }
    return slots;
  }

  // --------------------------------------------------------------- frame ---

  // The match hands the arena the point the fight is at, so the follow spot
  // and the back light can track it.
  setFocus(v) {
    this.lighting?.setFocus?.(v.x, 1.0, v.z);
  }

  update(dt, t = 0) {
    this.beat += dt * BEATS_PER_SEC;
    // A sharp attack and a slow tail: this is the shape of a kick drum, and
    // every light in the room is driven from it.
    this.pulse = Math.pow(Math.max(0, Math.sin(this.beat * Math.PI)), 7);
    this.energy = Math.max(0.22, this.energy - dt * 0.35);

    if (this.ledMat) {
      // The strip breathes with the kick and drifts between the room's two
      // colours over a phrase, which is all the beat needs to be felt.
      const mixT = 0.5 + 0.5 * Math.sin(this.beat * Math.PI / 8);
      this.ledMat.emissive.copy(this._ledA).lerp(this._ledB, mixT);
      this.ledMat.emissiveIntensity = 1.2 + this.pulse * 2.6 + this.energy * 0.8;
    }
    // Contact shadows. The dance floor is a light source, so a shadow map is
    // only half the story: a soft blob under each fighter is what actually
    // plants them on it. Driven from the match, which owns where they are.
    for (let i = 0; i < this.blobs.length; i++) {
      const b = this.blobs[i];
      if (!b.active) b.mesh.visible = false;
      b.active = false;
    }
    if (this.discoBall) this.discoBall.rotation.y += dt * 0.55;
    if (this.sign) {
      // Neon signs flicker. A dying tube in the wordmark is free character.
      const flick = rng.chance(0.004) ? 0.15 : 1;
      this.sign.children.forEach((c, i) => {
        if (c.material?.emissiveIntensity !== undefined && i === 2) {
          c.material.emissiveIntensity = 9 * flick;
        }
      });
    }

    this.lighting.update(dt, t, this.beat, this.pulse, this.energy);
    this.crowd.update(dt, t, this.beat, this.energy);
  }

  dispose() {
    this._offs.forEach((o) => o());
    this.crowd.dispose();
    this.lighting.dispose();
    this.group.traverse((o) => o.geometry?.dispose?.());
    disposeMaterials();
  }
}
