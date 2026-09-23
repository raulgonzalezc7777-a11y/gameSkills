import * as THREE from 'three';
import { smooth01, bump } from './mesh.js';

// The head, sculpted as a signed distance field and then sampled onto a grid.
//
// Lofting horizontal rings gives an egg with bumps pushed into it, and that is
// what read as alien: no occiput, no jaw corner, no chin shelf, eyes painted on
// a smooth front. A distance field lets the head be described the way a
// sculptor blocks one in (cranium, occiput, jaw, cheekbones, brow, nose, lips,
// lids) with smooth unions doing the blending, and every one of those masses is
// a few numbers a build can push around.
//
// The grid is cast from one point inside the skull, so every row is a latitude
// and every column a longitude around that point. Columns bunch up at the front
// and rows bunch up between the chin and the brow: the face gets most of the
// vertices and most of the texture, the back of the skull gets what it needs.
// The first few rows slide their origin down the neck and flatten out, so the
// bottom ring lands exactly on the torso's top ring and the two weld.

const TAU = Math.PI * 2;
export const HEAD_C = new THREE.Vector3(0, 1.765, -0.005);

// ------------------------------------------------------------ sdf kit -----

function sdEll(x, y, z, cx, cy, cz, rx, ry, rz) {
  const px = (x - cx) / rx, py = (y - cy) / ry, pz = (z - cz) / rz;
  const k0 = Math.sqrt(px * px + py * py + pz * pz);
  const k1 = Math.sqrt(px * px / (rx * rx) + py * py / (ry * ry) + pz * pz / (rz * rz));
  return k1 > 1e-9 ? k0 * (k0 - 1) / k1 : -Math.min(rx, ry, rz);
}

function sdCap(x, y, z, ax, ay, az, bx, by, bz, ra, rb) {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const pax = x - ax, pay = y - ay, paz = z - az;
  let h = (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz);
  h = h < 0 ? 0 : h > 1 ? 1 : h;
  const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - (ra + (rb - ra) * h);
}

function sdEll2(x, z, a, b) {
  const px = x / a, pz = z / b;
  const k0 = Math.sqrt(px * px + pz * pz);
  const k1 = Math.sqrt(px * px / (a * a) + pz * pz / (b * b));
  return k1 > 1e-9 ? k0 * (k0 - 1) / k1 : -Math.min(a, b);
}

const smin = (a, b, k) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
const smax = (a, b, k) => -smin(-a, -b, k);
const lerp = (a, b, t) => a + (b - a) * t;

// Eyeball placement in canonical head space. Exported so the builder can put
// the eyeball exactly where the lids were cut for it.
export const EYE = { x: 0.0315, y: 1.770, z: 0.0595, r: 0.0122 };

// The palpebral fissure in angles around the eyeball centre: 'al' runs toward
// the temple, 'ay' up. The upper lid peaks a little toward the nose and the
// outer corner sits higher than the inner one, which is what stops an almond
// from reading as a lemon.
const AP_TURN = 0.14, AP_C = 0.12, AP_HW = 1.12;
export function apertureUp(xi) {
  const e = Math.max(0, 1 - xi * xi);
  return 0.43 * Math.pow(e, 0.55) * (1 - 0.16 * xi) + 0.07 * xi;
}
export function apertureLo(xi) {
  const e = Math.max(0, 1 - xi * xi);
  return -0.37 * Math.pow(e, 0.75) * (1 + 0.12 * xi) + 0.07 * xi;
}

// Point on the lid margin for side s, xi in -1..1 across the eye, upper or
// lower lid, pushed out to radius r from the eyeball centre. Canonical space.
export function lidPoint(s, xi, upper, r) {
  const al = AP_C + xi * AP_HW;
  const ay = upper ? apertureUp(xi) : apertureLo(xi);
  const lx = Math.sin(al) * Math.cos(ay), lz = Math.cos(al) * Math.cos(ay), ly = Math.sin(ay);
  const ca = Math.cos(AP_TURN), sa = Math.sin(AP_TURN);
  // Inverse of the rotation used in the lid field.
  const vx = (lx * ca + lz * sa) * s;
  const vz = -lx * sa + lz * ca;
  return new THREE.Vector3(s * EYE.x + vx * r, EYE.y + ly * r, EYE.z + vz * r);
}

// ---------------------------------------------------------- the sculpt ----

// f: { H, NK, jaw, brow, cheek, nose, noseBreak, chin, lips, neckBase }
// neckBase is the torso's last loft node, so the neck field starts from the
// exact ellipse the torso ends on.
export function makeSculpt(f) {
  const H = f.H ?? 1, NK = f.NK ?? 1;
  const J = f.jaw ?? 1, BR = f.brow ?? 1, CK = f.cheek ?? 1, NS = f.nose ?? 1;
  const NB = f.noseBreak ?? 0, CH = f.chin ?? 1, LP = f.lips ?? 1;
  const nb = f.neckBase;
  const Cy = HEAD_C.y, Cz = HEAD_C.z;
  const top = { y: 1.748, w: 0.056 * NK, d: 0.052 * NK, z: -0.026 };
  const jw = Math.sqrt(J);

  function lid(x, y, z, s) {
    const vx = x - s * EYE.x, vy = y - EYE.y, vz = z - EYE.z;
    const r = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (r < 1e-6) return -EYE.r;
    const ca = Math.cos(AP_TURN), sa = Math.sin(AP_TURN);
    const lx = s * vx * ca - vz * sa;
    const lz = s * vx * sa + vz * ca;
    let open = -0.2;
    if (lz > 0) {
      const al = Math.atan2(lx, lz);
      const ay = Math.asin(Math.max(-1, Math.min(1, vy / r)));
      const xi = (al - AP_C) / AP_HW;
      if (Math.abs(xi) < 1) {
        open = Math.min(apertureUp(xi) - ay, ay - apertureLo(xi), (1 - Math.abs(xi)) * 0.4);
      }
    }
    // Outside the fissure the lid is a skin shell just proud of the eyeball;
    // inside it the shell sinks below the eyeball so the eye shows through.
    // The recession is a ramp, not a step, so the lid margin comes out of
    // interpolation as a smooth curve rather than a staircase of cells.
    const upperBoost = vy > 0 ? 0.0009 : 0.0;
    const lidR = EYE.r + 0.0022 + upperBoost - 0.0070 * smooth01(open / 0.05);
    return r - lidR;
  }

  function head(x, y, z) {
    // Cranium, forehead plane and the occipital shelf that makes the back of
    // a real skull overhang the neck.
    let d = sdEll(x, y, z, 0, 1.793, -0.012, 0.0745, 0.090, 0.099);
    // Parietal breadth: the top of a real skull is broad and flat-ish, not
    // the point of an egg.
    d = smin(d, sdEll(x, y, z, 0, 1.826, -0.022, 0.071, 0.052, 0.080), 0.02);
    d = smin(d, sdEll(x, y, z, 0, 1.816, 0.030, 0.062, 0.055, 0.061), 0.02);
    d = smin(d, sdEll(x, y, z, 0, 1.776, -0.060, 0.058, 0.058, 0.052), 0.022);
    // Mid face: maxilla and the zygomatic arch.
    d = smin(d, sdEll(x, y, z, 0, 1.738, 0.030, 0.058 * jw, 0.050, 0.062), 0.024);
    for (let s = -1; s <= 1; s += 2) {
      d = smin(d, sdEll(x, y, z, s * 0.048, 1.759, 0.044, 0.021 * CK, 0.012, 0.022), 0.02);
      // Lower cheek: buccal fat over the masseter, so the muzzle runs into
      // the jaw as one surface instead of a ball stuck on a skull.
      d = smin(d, sdEll(x, y, z, s * 0.041, 1.721, 0.030, 0.022 * CK, 0.029, 0.034), 0.02);
      // Arch running back from the cheekbone toward the ear.
      d = smin(d, sdCap(x, y, z, s * 0.050, 1.760, 0.040, s * 0.060, 1.757, -0.004, 0.008, 0.006), 0.012);
    }
    // Mandible: ramus down from under the ear, body forward to the chin.
    for (let s = -1; s <= 1; s += 2) {
      const gx = s * (0.050 + 0.028 * (J - 1));
      d = smin(d, sdCap(x, y, z, s * 0.056, 1.745, -0.021, gx, 1.692, -0.013, 0.012, 0.0145), 0.018);
      d = smin(d, sdCap(x, y, z, gx, 1.692, -0.013, s * 0.021 * CH, 1.668, 0.071, 0.0145, 0.013), 0.02);
    }
    d = smin(d, sdEll(x, y, z, 0, 1.6745, 0.072, 0.025 * CH, 0.0185, 0.019), 0.016);
    // Muzzle over the teeth, then lips and the parting line between them.
    d = smin(d, sdEll(x, y, z, 0, 1.710, 0.048, 0.040, 0.032, 0.048), 0.026);
    d = smin(d, sdEll(x, y, z, 0, 1.7125, 0.0858, 0.0235, 0.0066 * LP, 0.0115), 0.008);
    d = smin(d, sdEll(x, y, z, 0, 1.6995, 0.0838, 0.0205, 0.0074 * LP, 0.0115), 0.008);
    d = smax(d, -sdEll(x, y, z, 0, 1.7058, 0.0985, 0.0225, 0.0010, 0.0135), 0.0022);
    // Chin furrow under the lower lip.
    d = smax(d, -sdEll(x, y, z, 0, 1.6885, 0.094, 0.016, 0.0035, 0.008), 0.006);
    // Brow ridge, heavier on a heavier fighter, with a notch over the nose.
    d = smin(d, sdEll(x, y, z, 0, 1.7965, 0.0725, 0.057, 0.0120 * BR, 0.021 + 0.003 * BR), 0.012);
    d = smax(d, -sdEll(x, y, z, 0, 1.786, 0.0925, 0.009, 0.006, 0.006), 0.006);
    // Nose: bridge to tip, a break in the bridge for anyone who has been hit
    // there enough, then the wings.
    const nt = 0.111 + 0.004 * (NS - 1);
    d = smin(d, sdCap(x, y, z, 0, 1.789, 0.0835, 0, 1.745, nt - 0.003, 0.0068, 0.0088 * NS), 0.012);
    if (NB > 0) d = smin(d, sdEll(x, y, z, NB * 0.0015, 1.772, 0.0955, 0.006, 0.006, 0.004 + 0.002 * NB), 0.004);
    d = smin(d, sdEll(x, y, z, 0, 1.7405, nt - 0.004, 0.0092 * NS, 0.0086, 0.0100), 0.008);
    for (let s = -1; s <= 1; s += 2) {
      d = smin(d, sdEll(x, y, z, s * 0.0112 * NS, 1.7380, 0.0970, 0.0072, 0.0068, 0.0088), 0.009);
    }
    // Eye sockets, then the lids that sit in them.
    for (let s = -1; s <= 1; s += 2) {
      d = smax(d, -sdEll(x, y, z, s * 0.0320, 1.7725, 0.076, 0.0190, 0.0135, 0.016), 0.008);
    }
    for (let s = -1; s <= 1; s += 2) d = smin(d, lid(x, y, z, s), 0.0035);
    // Temples hollow in where the jaw muscle attaches.
    for (let s = -1; s <= 1; s += 2) {
      d = smax(d, -sdEll(x, y, z, s * 0.076, 1.792, 0.034, 0.007, 0.018, 0.018), 0.012);
    }
    return d;
  }

  // Neck and the top of the shoulders. The base is the torso's last ring as a
  // column with a rounded cap; the neck column rises out of it and the upper
  // trapezius runs from the skull base down to the shoulder on each side, so
  // the neck sits in a ramp of muscle instead of standing on a shelf.
  const SH = f.SH ?? 1, MU = f.mu ?? 1;
  function neck(x, y, z) {
    const t = Math.max(0, Math.min(1, (y - 1.52) / (top.y - 1.52)));
    const w = lerp(0.066 * NK, top.w, t), dd = lerp(0.061 * NK, top.d, t);
    const zc = lerp(-0.004, top.z, t);
    let r = Math.max(sdEll2(x, z - zc, w, dd), y - (top.y + 0.03));
    const slab = y <= nb.y ? sdEll2(x, z - nb.push, nb.w, nb.d)
      : sdEll(x, y, z, 0, nb.y, nb.push, nb.w, 0.022, nb.d);
    r = smin(r, slab, 0.035);
    const tr = Math.sqrt(MU);
    for (let s = -1; s <= 1; s += 2) {
      // Upper trapezius in two runs: down the back of the neck from the skull,
      // then out to the shoulder. Seen from the front that makes the concave
      // sweep from neck to shoulder, with the neck column standing in front
      // of it, instead of a straight cone from shoulder to jaw.
      const kx = s * 0.047 * NK, ky = 1.585, kz = -0.046;
      r = smin(r, sdCap(x, y, z, s * 0.020 * NK, 1.712, -0.056, kx, ky, kz, 0.018 * NK * tr, 0.023 * NK * tr), 0.022);
      r = smin(r, sdCap(x, y, z, kx, ky, kz, s * 0.128 * SH, 1.506, -0.022, 0.023 * NK * tr, 0.020 * tr), 0.03);
      // Sternocleidomastoids: the V from behind the ear to the collarbone
      // notch is the single cue that says 'thick neck' rather than 'tube'.
      r = smin(r, sdCap(x, y, z, s * 0.046 * NK, 1.736, -0.028, s * 0.016, nb.y - 0.004,
        nb.push + nb.d * 0.80, 0.0125 * NK, 0.009 * NK), 0.018);
    }
    return r;
  }

  const sdf = (x, y, z) => {
    const qx = x / H, qy = Cy + (y - Cy) / H, qz = Cz + (z - Cz) / H;
    return smin(neck(x, y, z), head(qx, qy, qz) * H, 0.028);
  };
  sdf.H = H;
  return sdf;
}

// First surface crossing along a ray that starts inside the field.
export function cast(sdf, ox, oy, oz, dx, dy, dz, off = 0, t0 = 0.03) {
  const step = 0.0022;
  let t = t0, prev = t0;
  let v = sdf(ox + dx * t, oy + dy * t, oz + dz * t) - off;
  if (v > 0) t = prev = 0.004;
  for (let i = 0; i < 180; i++) {
    const tt = t + step;
    const vv = sdf(ox + dx * tt, oy + dy * tt, oz + dz * tt) - off;
    prev = t; t = tt;
    if (vv > 0) break;
  }
  let a = prev, b = t;
  for (let i = 0; i < 14; i++) {
    const m = (a + b) * 0.5;
    if (sdf(ox + dx * m, oy + dy * m, oz + dz * m) - off > 0) b = m; else a = m;
  }
  const r = (a + b) * 0.5;
  return new THREE.Vector3(ox + dx * r, oy + dy * r, oz + dz * r);
}

// Monotone remap of [0,1] onto an angle range with a chosen sample density.
// fwd places grid lines, inv answers where an angle landed in texture space.
function makeWarp(lo, hi, density, n = 4096) {
  const cdf = new Float64Array(n + 1);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const a = lo + (hi - lo) * (i + 0.5) / n;
    acc += density(a);
    cdf[i + 1] = acc;
  }
  for (let i = 0; i <= n; i++) cdf[i] /= acc;
  const fwd = (t) => {
    let a = 0, b = n;
    while (b - a > 1) { const m = (a + b) >> 1; if (cdf[m] <= t) a = m; else b = m; }
    const k = cdf[b] > cdf[a] ? (t - cdf[a]) / (cdf[b] - cdf[a]) : 0;
    return lo + (hi - lo) * (a + k) / n;
  };
  const inv = (ang) => {
    const x = Math.max(0, Math.min(n - 1e-6, (ang - lo) / (hi - lo) * n));
    const i = Math.floor(x);
    return cdf[i] + (cdf[i + 1] - cdf[i]) * (x - i);
  };
  return { fwd, inv };
}

const PHI1 = -1.05, PHI2 = 1.50;
const ROWS_NECK = 8, ROWS_HEAD = 38;

// torsoTop: the torso's last ring (uniform angles). neckBase: its node.
export function buildHeadGrid(sdf, torsoTop, neckBase) {
  const nu = torsoTop.length;
  const colWarp = makeWarp(-Math.PI, Math.PI, (th) => 1 + 1.55 * Math.exp(-((th / 0.78) ** 2))
    + 0.35 * Math.exp(-(((Math.abs(th) - 1.6) / 0.35) ** 2)));
  const rowWarp = makeWarp(PHI1, PHI2, (ph) => 1 + 1.9 * Math.exp(-(((ph + 0.10) / 0.52) ** 2)));
  const C = HEAD_C;
  const rings = [];
  const dirs = [];     // [th, ph] per ring per column, for painting fields
  const nRows = ROWS_NECK + ROWS_HEAD + 1;

  for (let k = 0; k < nRows; k++) {
    const ring = new Array(nu);
    const dr = new Array(nu);
    let ox, oy, oz, el, w;
    if (k < ROWS_NECK) {
      w = k / ROWS_NECK;
      const ws = smooth01(w);
      ox = 0;
      oy = lerp(neckBase.y, C.y, w);
      oz = lerp(neckBase.push, C.z, w);
      el = PHI1 * w;
      for (let i = 0; i < nu; i++) {
        const thU = -Math.PI + (i / nu) * TAU;
        const thW = colWarp.fwd(i / nu);
        const th = lerp(thU, thW, ws);
        if (k === 0) { ring[i] = torsoTop[i].clone(); dr[i] = [thU, 0]; continue; }
        const ce = Math.cos(el);
        ring[i] = cast(sdf, ox, oy, oz, Math.sin(th) * ce, Math.sin(el), Math.cos(th) * ce);
        dr[i] = [th, el];
      }
    } else {
      const t = (k - ROWS_NECK) / ROWS_HEAD;
      el = rowWarp.fwd(t);
      const ce = Math.cos(el), se = Math.sin(el);
      for (let i = 0; i < nu; i++) {
        const th = colWarp.fwd(i / nu);
        ring[i] = cast(sdf, C.x, C.y, C.z, Math.sin(th) * ce, se, Math.cos(th) * ce);
        dr[i] = [th, el];
      }
    }
    rings.push(ring);
    dirs.push(dr);
  }

  // Texture coordinate of any point on the face or scalp, in the unit square
  // the grid is laid into. Valid above the neck rows, which is everywhere
  // anything gets painted.
  const uvOf = (x, y, z) => {
    const dx = x - C.x, dy = y - C.y, dz = z - C.z;
    const th = Math.atan2(dx, dz);
    const ph = Math.atan2(dy, Math.hypot(dx, dz));
    const u = colWarp.inv(th);
    const row = ROWS_NECK + rowWarp.inv(Math.max(PHI1, Math.min(PHI2, ph))) * ROWS_HEAD;
    return [u, row / (nRows - 1)];
  };
  return { rings, dirs, uvOf, nu, nRows };
}

// ------------------------------------------------------------- shells -----

// A shell over the skull (hair, beard): rays from the head centre between a
// per-column lower and upper elevation, pushed off the skin by 'thick'.
// Returns rings plus a per-vertex coverage that the hair shader dithers
// against, so the edge thins out hair by hair instead of ending in a lip.
export function buildShell(sdf, o) {
  const cols = o.cols, rows = o.rows;
  const C = HEAD_C;
  const rings = [], cover = [];
  for (let k = 0; k < rows; k++) {
    const t = Math.pow(k / (rows - 1), o.rowPow ?? 1);
    const ring = new Array(cols), cv = new Array(cols);
    for (let i = 0; i < cols; i++) {
      const th = o.th0 + (o.th1 - o.th0) * (i / (o.closed === false ? cols - 1 : cols));
      const lo = o.lo(th), hi = o.hi(th);
      const el = lo + (hi - lo) * t;
      const ce = Math.cos(el);
      const thick = o.thick(th, el, t);
      ring[i] = cast(sdf, C.x, C.y, C.z, Math.sin(th) * ce, Math.sin(el), Math.cos(th) * ce, thick);
      cv[i] = o.cover(th, el, t, ring[i]);
    }
    rings.push(ring);
    cover.push(cv);
  }
  return { rings, cover };
}

// Smooth interpolation through (angle, value) keys on |th|, used for
// hairlines, beard lines and necklines so each can be tuned as a handful of
// numbers. Catmull-Rom rather than smoothstep per span: smoothstep flattens
// at every key and turns a curved neckline into a row of little plateaus.
export function profile(keys) {
  const n = keys.length;
  const slope = (i) => {
    const a = keys[Math.max(0, i - 1)], c = keys[Math.min(n - 1, i + 1)];
    return c[0] > a[0] ? (c[1] - a[1]) / (c[0] - a[0]) : 0;
  };
  return (th) => {
    const a = Math.abs(th);
    if (a <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < n; i++) {
      if (a <= keys[i][0]) {
        const k0 = keys[i - 1], k1 = keys[i];
        const h = k1[0] - k0[0], t = (a - k0[0]) / h;
        const t2 = t * t, t3 = t2 * t;
        return (2 * t3 - 3 * t2 + 1) * k0[1] + (t3 - 2 * t2 + t) * h * slope(i - 1)
          + (-2 * t3 + 3 * t2) * k1[1] + (t3 - t2) * h * slope(i);
      }
    }
    return keys[n - 1][1];
  };
}

// ---------------------------------------------------------------- ear -----

// An ear with a helix rim, a bowl, a lobe and real thickness, angled off the
// skull so there is air behind the back edge. Returned as rings for the
// builder: outer face from the centre out, round the rim, back face in.
export function buildEar(s, H) {
  const n = new THREE.Vector3(s * Math.cos(0.30), 0.0, Math.sin(0.30)).normalize();
  const upv = new THREE.Vector3(0, Math.cos(0.22), -Math.sin(0.22));
  upv.addScaledVector(n, -upv.dot(n)).normalize();
  const fw = new THREE.Vector3().crossVectors(upv, n);
  if (fw.z < 0) fw.negate();
  const c = new THREE.Vector3(s * 0.0712 * H, HEAD_C.y + (1.761 - HEAD_C.y) * H, HEAD_C.z + (-0.0100 - HEAD_C.z) * H);
  const A = 0.0315 * H, B = 0.0175 * H;
  const sides = 18;
  const outline = (ps) => {
    // Wider at the top, pinched to a lobe at the bottom.
    const ca = Math.cos(ps), sa = Math.sin(ps);
    const lobe = ca < 0 ? 1 - 0.30 * Math.pow(-ca, 1.5) : 1 + 0.06 * ca;
    return [A * ca, B * sa * lobe];
  };
  const outer = [0.08, 0.22, 0.38, 0.52, 0.64, 0.74, 0.82, 0.89, 0.95, 0.99];
  const back = [0.97, 0.88, 0.70, 0.45, 0.18];
  const rings = [];
  const surf = (rho, ps, face) => {
    const [a0, b0] = outline(ps);
    const a = a0 * rho, b = b0 * rho;
    // Stand-off: flush at the front edge, well off the skull at the back.
    const back01 = smooth01((-b / B + 1) * 0.5);
    let h = 0.0028 * H + back01 * 0.0150 * H;
    if (face === 'out') {
      h += 0.0028 * H * bump((rho - 0.90) / 0.12);                           // helix
      h += 0.0012 * H * bump((rho - 0.62) / 0.12) * smooth01((a0 + A * 0.2) / (A * 0.8)); // antihelix
      const ca = (a - (-0.004 * H)) / (0.011 * H), cb = (b - 0.004 * H) / (0.010 * H);
      h -= 0.0045 * H * Math.max(0, 1 - Math.sqrt(ca * ca + cb * cb)) ** 1.5;  // concha
      h -= 0.0025 * H * (1 - rho) * smooth01((a0 + A * 0.4) / (A * 0.6));    // scapha dip in the upper half
    } else if (face === 'rim') {
      h -= 0.0016 * H;
    } else {
      h = h * 0.62 - 0.0040 * H;
    }
    return new THREE.Vector3().copy(c).addScaledVector(upv, a).addScaledVector(fw, b).addScaledVector(n, h);
  };
  const ringAt = (rho, face) => {
    const r = new Array(sides);
    for (let i = 0; i < sides; i++) {
      const ps = (s > 0 ? 1 : -1) * (i / sides) * TAU;
      r[i] = surf(rho, ps, face);
    }
    return r;
  };
  for (const rho of outer) rings.push(ringAt(rho, 'out'));
  rings.push(ringAt(1.0, 'rim'));
  for (const rho of back) rings.push(ringAt(rho, 'back'));
  return rings;
}
