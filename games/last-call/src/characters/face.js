import * as THREE from 'three';
import { HEAD_C, lidPoint, EYE } from './head.js';

// Everything painted onto the head's slice of the skin atlas at boot, in three
// layers that share one set of shapes:
//   albedo     tone zones (the blood in nose, cheeks and lips, the darker skin
//              round the eyes, a shaved man's blue-grey beard shadow), brows
//              hair by hair, lash lines, the wet pink of the waterline and the
//              caruncle, lips, nostrils, stubble, scars, moles and freckles
//   height     everything finer than the 2 to 4 mm the mesh can carry: lid
//              creases, the nasolabial line, forehead and frown lines, crow's
//              feet, lip lines, raised brow hair and scar ridges
//   roughness  the T-zone and lips shine, cheeks and a stubbled jaw are matte,
//              the waterline is wet
//
// Shapes are authored in metres on the canonical head. A point given without a
// depth is dropped straight back onto the sculpted surface, so a crease drawn
// at the corner of an eye lands on the lid and not on the cheek a centimetre
// behind it. Broad washes go through a field image with one texel per grid
// vertex: the grid is regular in uv, so that image is exactly aligned with the
// mesh and costs a few thousand texels.

// Colours are mixed in linear space and written to the canvas in sRGB, which
// is what the canvas holds.
const _o = { r: 0, g: 0, b: 0 };
const srgb = (c) => { c.getRGB(_o, THREE.SRGBColorSpace); return _o; };
const lum = (c) => { const s = srgb(c); return s.r * 0.3 + s.g * 0.59 + s.b * 0.11; };
const css = (c, a) => { const s = srgb(c); return 'rgba(' + Math.round(s.r * 255) + ',' + Math.round(s.g * 255) + ',' + Math.round(s.b * 255) + ',' + a.toFixed(3) + ')'; };
const col = (hex) => new THREE.Color(hex);
const mix = (a, b, t) => a.clone().lerp(b, t);
const g01 = (v) => Math.max(0, Math.min(1, v));
const gauss = (x, w) => Math.exp(-((x / w) ** 2));

// Front depth of the canonical face on a 2 mm lattice, found by sphere tracing
// the sculpt from in front. Shared by every painter of one head.
function makeFrontMap(sdf, H) {
  const X0 = -0.072, X1 = 0.072, Y0 = 1.615, Y1 = 1.875, STEP = 0.0025;
  const nx = Math.round((X1 - X0) / STEP) + 1, ny = Math.round((Y1 - Y0) / STEP) + 1;
  const Z = new Float32Array(nx * ny);
  const C = HEAD_C;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = X0 + i * STEP, y = Y0 + j * STEP;
      const wx = x * H, wy = C.y + (y - C.y) * H;
      let z = 0.135, hit = -0.02;
      for (let k = 0; k < 64; k++) {
        const wz = C.z + (z - C.z) * H;
        const d = sdf(wx, wy, wz) / H;
        if (d < 0.0002) { hit = z; break; }
        z -= Math.max(d, 0.0004);
        if (z < -0.02) break;
      }
      Z[j * nx + i] = hit;
    }
  }
  return (x, y) => {
    const fx = Math.max(0, Math.min(nx - 1.001, (x - X0) / STEP)), fy = Math.max(0, Math.min(ny - 1.001, (y - Y0) / STEP));
    const i = Math.floor(fx), j = Math.floor(fy), a = fx - i, b = fy - j;
    const z00 = Z[j * nx + i], z10 = Z[j * nx + i + 1], z01 = Z[(j + 1) * nx + i], z11 = Z[(j + 1) * nx + i + 1];
    return (z00 * (1 - a) + z10 * a) * (1 - b) + (z01 * (1 - a) + z11 * a) * b;
  };
}

export function makeHeadPainter(ctx, size, grid, rect, H, front) {
  const C = HEAD_C;
  // Canonical head point to world, then to canvas pixels. A missing depth is
  // taken from the sculpted surface.
  const hc = (x, y, z) => [x * H, C.y + (y - C.y) * H, C.z + (z - C.z) * H];
  const toPx = (x, y, z) => {
    if (z === undefined || z === null) z = front ? front(x, y) : 0.1;
    const w = hc(x, y, z);
    const [u, v] = grid.uvOf(w[0], w[1], w[2]);
    return [
      (rect[0] + u * (rect[2] - rect[0])) * size,
      (1 - (rect[1] + v * (rect[3] - rect[1]))) * size
    ];
  };
  // Pixels per metre around a point, separately across and up the face.
  const scaleAt = (x, y, z) => {
    const a = toPx(x - 0.003, y, z), b = toPx(x + 0.003, y, z);
    const c = toPx(x, y - 0.003, z), d = toPx(x, y + 0.003, z);
    return [Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.006, Math.hypot(d[0] - c[0], d[1] - c[1]) / 0.006];
  };
  const pxPerM = (x, y, z) => { const s = scaleAt(x, y, z); return (s[0] + s[1]) * 0.5; };

  function blob(x, y, z, rx, ry, stops, op = 'source-over', rot = 0) {
    const [cx, cy] = toPx(x, y, z);
    const [sx, sy] = scaleAt(x, y, z);
    const pr = rx * sx, pry = ry * sy;
    if (!(pr > 0.3 && pry > 0.3)) return;
    ctx.save();
    ctx.globalCompositeOperation = op;
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.scale(1, pry / pr);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, pr);
    for (const s of stops) g.addColorStop(s[0], s[1]);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, pr, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Polyline with its width and softness given in metres, so the same crease
  // is the same physical size on every layer. Softness is built from a few
  // wider, fainter passes under the core line rather than a canvas blur
  // filter: a filtered draw rasterises and blurs a whole canvas sized layer
  // per call, which on a software canvas turned a face into seconds of boot.
  const withAlpha = (style, k) => style.replace(/,([0-9.]+)\)$/, (m, a) => ',' + (parseFloat(a) * k).toFixed(3) + ')');
  function path(pts) {
    ctx.beginPath();
    pts.forEach((p, i) => { const q = toPx(p[0], p[1], p[2]); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
  }
  function stroke(pts, widthM, style, op = 'source-over', blurM = 0) {
    const p0 = pts[Math.floor(pts.length / 2)];
    const k = pxPerM(p0[0], p0[1], p0[2]);
    const w = Math.max(0.35, widthM * k), bl = blurM * k;
    ctx.save();
    ctx.globalCompositeOperation = op;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    path(pts);
    if (bl > 0.3) {
      ctx.strokeStyle = withAlpha(style, 0.22);
      ctx.lineWidth = w + bl * 2.2; ctx.stroke();
      ctx.strokeStyle = withAlpha(style, 0.35);
      ctx.lineWidth = w + bl * 1.1; ctx.stroke();
      ctx.strokeStyle = withAlpha(style, 0.6);
    } else ctx.strokeStyle = style;
    ctx.lineWidth = w;
    ctx.stroke();
    ctx.restore();
  }

  function poly(pts, style, op = 'source-over', blurM = 0) {
    const p0 = pts[0];
    const k = pxPerM(p0[0], p0[1], p0[2]);
    const bl = blurM * k;
    ctx.save();
    ctx.globalCompositeOperation = op;
    ctx.lineJoin = 'round';
    path(pts);
    ctx.closePath();
    if (bl > 0.3) {
      // Feathered edge: a soft stroke straddling the outline, then the body.
      ctx.strokeStyle = withAlpha(style, 0.3);
      ctx.lineWidth = bl * 2; ctx.stroke();
      ctx.fillStyle = withAlpha(style, 0.8);
    } else ctx.fillStyle = style;
    ctx.fill();
    ctx.restore();
  }

  // fn(th, ph, pos, k) -> [r, g, b, a] in 0..1 (sRGB), evaluated once per grid
  // vertex. th and ph are measured from the head centre to the vertex itself:
  // the grid's own cast directions bend down the neck, and a hairline tested
  // against those painted the nape shadow halfway to the shoulders.
  // The field image is drawn up with smoothing, which is all the softening a
  // one texel per vertex wash needs.
  function field(fn, op = 'source-over', blurPx = 0) {
    const W = grid.nu + 1, R = grid.nRows;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = R;
    const g = cv.getContext('2d');
    const img = g.createImageData(W, R);
    for (let k = 0; k < R; k++) {
      for (let i = 0; i < W; i++) {
        const ii = i % grid.nu;
        const p = grid.rings[k][ii];
        // Canonical position, then angles from the head centre.
        const cx = p.x / H, cy = C.y + (p.y - C.y) / H, cz = C.z + (p.z - C.z) / H;
        const dx = cx - C.x, dy = cy - C.y, dz = cz - C.z;
        const th = Math.atan2(dx, dz), ph = Math.atan2(dy, Math.hypot(dx, dz));
        const c = fn(th, ph, [cx, cy, cz], k);
        const o = ((R - 1 - k) * W + i) * 4;
        img.data[o] = c[0] * 255; img.data[o + 1] = c[1] * 255; img.data[o + 2] = c[2] * 255; img.data[o + 3] = c[3] * 255;
      }
    }
    g.putImageData(img, 0, 0);
    const pw = (rect[2] - rect[0]) * size / grid.nu;
    const ph = (rect[3] - rect[1]) * size / (R - 1);
    ctx.save();
    ctx.globalCompositeOperation = op;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    void blurPx;
    ctx.drawImage(cv, rect[0] * size - pw * 0.5, (1 - rect[3]) * size - ph * 0.5, W * pw, R * ph);
    ctx.restore();
  }

  return { toPx, scaleAt, pxPerM, blob, stroke, poly, field, hc, ctx, size, front };
}

// One painter per layer over the same head, plus the front depth map.
export function makeFacePainters(layers, grid, rect, H, sdf) {
  const front = makeFrontMap(sdf, H);
  return {
    albedo: makeHeadPainter(layers.albedo.ctx, layers.albedo.size, grid, rect, H, front),
    height: makeHeadPainter(layers.height.ctx, layers.height.size, grid, rect, H, front),
    rough: makeHeadPainter(layers.rough.ctx, layers.rough.size, grid, rect, H, front),
    front
  };
}

// Height strokes: grooves darken the height canvas, ridges lighten it.
const GROOVE = (a) => 'rgba(0,0,0,' + a.toFixed(3) + ')';
const RIDGE = (a) => 'rgba(255,255,255,' + a.toFixed(3) + ')';
const ROUGH = (r, a = 1) => { const v = Math.round(g01(r) * 255); return 'rgba(' + v + ',' + v + ',' + v + ',' + a.toFixed(3) + ')'; };

// Catmull-Rom through canonical points, densified so a curve stays a curve on
// the canvas.
function spline(pts, n = 8) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const q = [0, 1].map((a) => 0.5 * ((2 * p1[a]) + (-p0[a] + p2[a]) * t + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t2 + (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * t3));
      out.push([q[0], q[1]]);
    }
  }
  out.push([pts[pts.length - 1][0], pts[pts.length - 1][1]]);
  return out;
}

// o: { skin, hair, stubble, beard, hairCover(th, ph), beardCover(th, ph), rng,
//      bald, baldCover, ap, fem, furrow, age, scars[], freckles, moles }
export function paintFace(PP, o) {
  const A = PP.albedo, HT = PP.height, RG = PP.rough;
  const skin = col(o.skin);
  const hair = col(o.hair);
  const L = lum(skin);
  const pale = g01((L - 0.40) / 0.30);        // 0 on deep brown skin, 1 on fair
  const rng = o.rng;
  const fem = o.fem ?? 0, fur = o.furrow ?? 0, age = o.age ?? 0.5;
  const ap = o.ap;

  // ---- scalp ------------------------------------------------------------
  // Hair roots darken the skin under the shell, so a hairline reads soft from
  // any distance even where the shell has dithered away. A shaved head still
  // carries the ghost of its hairline as a faint cool shadow.
  if (o.bald) {
    const sc = mix(mix(skin, hair, 0.5), col('#556070'), 0.2 * pale);
    A.field((th, ph) => {
      const c = o.baldCover(th, ph);
      const s = srgb(sc);
      return [s.r, s.g, s.b, c * (0.10 + 0.14 * pale)];
    }, 'source-over', 2);
  }
  if (o.hairCover) {
    const sc = srgb(mix(skin, hair, 0.8));
    const s = [sc.r, sc.g, sc.b];
    A.field((th, ph) => [s[0], s[1], s[2], Math.min(1, o.hairCover(th, ph, true)) * 0.92], 'source-over', 1.5);
  }

  // ---- tone zones -------------------------------------------------------
  // The face is three bands of colour a portrait painter would know: a
  // yellower forehead, a red middle third (nose, cheeks, ears) and, on a man,
  // a blue-grey lower third where the beard grows even after a shave. Pale
  // skin shows the red as pink; dark skin as a deeper, warmer brown.
  const flush = pale > 0.3 ? col('#c2474a') : mix(skin, col('#7a2418'), 0.55);
  const sallow = mix(skin, col('#c9a060'), 0.5);
  A.field((th, ph) => {
    const a = Math.abs(th);
    const cheek = Math.exp(-(((a - 0.52) / 0.22) ** 2) - ((ph + 0.12) / 0.15) ** 2);
    const nose = Math.exp(-((th / 0.12) ** 2) - ((ph + 0.20) / 0.12) ** 2);
    const chin = Math.exp(-((th / 0.22) ** 2) - ((ph + 0.72) / 0.12) ** 2);
    const w = Math.min(1, cheek * 0.65 + nose * 0.85 + chin * 0.35) * (0.12 + 0.14 * pale);
    const s = srgb(flush);
    return [s.r, s.g, s.b, w];
  }, 'source-over', 2);
  A.field((th, ph) => {
    const fore = g01((ph - 0.28) / 0.2) * Math.exp(-((th / 0.9) ** 2));
    const s = srgb(sallow);
    return [s.r, s.g, s.b, fore * 0.10];
  }, 'source-over', 2);

  // Beard shadow: the cool wash where a man's beard grows, strongest over the
  // upper lip and chin. Under a full beard it is the dark bed between hairs.
  const beardAmt = o.beard ? 0.95 : fem ? 0 : Math.max(0.3, o.stubble);
  if (beardAmt > 0 && o.beardCover) {
    const sh = mix(mix(skin, hair, o.beard ? 0.75 : 0.45), col('#3a4a66'), 0.35 * pale);
    const s = srgb(sh);
    A.field((th, ph) => {
      const c = o.beardCover(th, ph, true);
      return [s.r, s.g, s.b, Math.min(1, c) * (o.beard ? 0.78 : 0.34 + 0.10 * pale) * beardAmt];
    }, 'source-over', 2);
  }

  // ---- eyes -------------------------------------------------------------
  // Darker, cooler skin round the orbit: thinner skin over the vessels. Then
  // the upper lid crease, the tear trough under the lower lid, and the wet
  // bits: caruncle, waterline, lash lines.
  for (const s of [-1, 1]) {
    const ex = s * EYE.x;
    const dark = pale > 0.3 ? 'rgba(96,56,64,' : 'rgba(40,20,18,';
    A.blob(ex + s * 0.001, EYE.y - 0.009, null, 0.019, 0.008, [[0, dark + (0.20 + 0.10 * age).toFixed(3) + ')'], [1, dark + '0)']]);
    A.blob(ex + s * 0.003, EYE.y + 0.006, null, 0.018, 0.007, [[0, dark + '0.10)'], [0.6, dark + '0.05)'], [1, dark + '0)']]);
    // Height: the upper lid crease sits a few millimetres above the margin
    // and deepens as the lid is drawn down; the lower lid gets a soft line.
    const crease = [], trough = [], margU = [], margL = [];
    for (let i = 0; i <= 18; i++) {
      const xi = -0.92 + (i / 18) * 1.84;
      const pu = lidPoint(s, xi, true, EYE.r + 0.0030, ap);
      const pl = lidPoint(s, xi, false, EYE.r + 0.0026, ap);
      const lift = 0.0042 + 0.0012 * (1 - xi * xi) - 0.0010 * fur;
      crease.push([pu.x + s * 0.0006 * xi, pu.y + lift, null]);
      trough.push([pl.x, pl.y - 0.0036 - 0.0008 * (1 - xi * xi), null]);
      margU.push([pu.x, pu.y, pu.z]);
      margL.push([pl.x, pl.y, pl.z]);
    }
    HT.stroke(crease, 0.0011, GROOVE(0.35), 'source-over', 0.0005);
    HT.stroke(crease.map((p) => [p[0], p[1] - 0.0012, null]), 0.0018, RIDGE(0.12), 'source-over', 0.0008);
    HT.stroke(trough, 0.0014, GROOVE(0.08 + 0.12 * age), 'source-over', 0.0008);
    A.stroke(crease, 0.0010, pale > 0.3 ? 'rgba(80,40,36,0.16)' : 'rgba(30,14,10,0.20)', 'source-over', 0.0006);
    // Lash lines: the upper lid margin is the darkest line on a face.
    A.stroke(margU, 0.0012, 'rgba(18,11,9,0.95)', 'source-over', 0.0002);
    A.stroke(margU.map((p) => [p[0], p[1] + 0.0006, p[2] + 0.0003]), 0.0010, 'rgba(24,14,10,0.55)', 'source-over', 0.0003);
    // Waterline: the flat wet ledge of the lower lid, pink, shiny.
    A.stroke(margL, 0.0007, pale > 0.3 ? 'rgba(200,128,122,0.6)' : 'rgba(140,72,64,0.6)', 'source-over', 0.0002);
    A.stroke(margL.map((p) => [p[0], p[1] - 0.0010, p[2]]), 0.0007, 'rgba(40,24,20,0.45)', 'source-over', 0.0002);
    RG.stroke(margL, 0.0014, ROUGH(0.14), 'source-over', 0.0003);
    RG.stroke(margU, 0.0010, ROUGH(0.30), 'source-over', 0.0003);
    // Caruncle, the pink mound in the inner corner.
    const cr = lidPoint(s, -1, true, EYE.r + 0.0020, ap);
    A.blob(cr.x + s * 0.0012, cr.y - 0.0004, cr.z, 0.0024, 0.0018, [[0, 'rgba(196,96,96,0.85)'], [1, 'rgba(196,96,96,0)']]);
    RG.blob(cr.x + s * 0.0012, cr.y - 0.0004, cr.z, 0.0026, 0.0020, [[0, ROUGH(0.12)], [1, ROUGH(0.12, 0)]]);
    // Crow's feet fan from the outer corner; more with age and in a squint.
    const oc = lidPoint(s, 1, true, EYE.r + 0.003, ap);
    const nCrow = 3 + Math.floor(age * 3);
    for (let n = 0; n < nCrow; n++) {
      const ang = -0.55 + n * (1.1 / Math.max(1, nCrow - 1)) + (rng() - 0.5) * 0.12;
      const len = 0.006 + rng() * 0.006;
      const x0 = oc.x + s * 0.0035, y0 = oc.y - 0.001;
      const pts = [[x0, y0, null], [x0 + s * Math.cos(ang) * len * 0.5, y0 + Math.sin(ang) * len * 0.5 + 0.0004, null], [x0 + s * Math.cos(ang) * len, y0 + Math.sin(ang) * len, null]];
      HT.stroke(pts, 0.0006, GROOVE(0.10 + 0.14 * age + 0.06 * fur), 'source-over', 0.0003);
    }
  }

  // ---- brows ------------------------------------------------------------
  // Hair by hair. Inner hairs stand up, the body of the brow runs up and out,
  // the tail lies flat; the top row points down and out over the rows below
  // it, which is the herringbone a painted smear never has. A woman's brow is
  // finer, sits higher and arches toward its outer third. The fighting face
  // pulls the inner ends down and together.
  const browCol = mix(hair, col('#000000'), 0.15);
  const browLight = mix(hair, skin, 0.35);
  const scarGaps = (o.scars || []).filter((sc) => sc.kind === 'brow');
  for (const s of [-1, 1]) {
    const lowerInner = 0.0014 * fur;
    const yc = (t) => (fem
      ? 1.7950 + 0.0070 * Math.sin(Math.min(1, t * 1.15) * Math.PI * 0.82) - 0.0035 * t * t
      : 1.7910 + 0.0050 * Math.sin(Math.min(1, t * 1.25) * Math.PI * 0.8) - 0.0030 * t * t) - lowerInner * (1 - t) ** 2 - 0.0006 * fur;
    const thick = (t) => (fem ? 0.0048 * (1 - 0.65 * t) : 0.0068 * (1 - 0.55 * t)) * (0.85 + 0.3 * (o.browBulk ?? 0.5));
    const x0 = s * (0.0105 - 0.0012 * fur), span = fem ? 0.047 : 0.049;
    const nHair = fem ? 260 : 420;
    // Underlying wash so the brow has body between hairs.
    const band = [];
    for (let i = 0; i <= 14; i++) { const t = i / 14; band.push([x0 + s * t * span, yc(t), null]); }
    A.stroke(band, fem ? 0.0028 : 0.0042, css(browCol, fem ? 0.18 : 0.26), 'source-over', 0.0016);
    RG.stroke(band, 0.006, ROUGH(0.66, 0.8), 'source-over', 0.0015);
    for (let n = 0; n < nHair; n++) {
      const t = Math.pow(rng(), 1.12);
      const x = x0 + s * t * span;
      const across = rng() - 0.5;          // -0.5 bottom row, 0.5 top row
      const y = yc(t) + across * thick(t);
      // Edge thinning: fewer hairs along the top edge and toward the tail.
      if (rng() < Math.abs(across) * 0.9 + t * 0.35) continue;
      let gap = false;
      for (const sc of scarGaps) if (sc.side === s && Math.abs(x - sc.x) < 0.0016) gap = true;
      if (gap) continue;
      const base = (1 - t) * 1.30 + t * 0.12;             // up at the inner end, flat at the tail
      const ang = base - across * 0.9 * (0.4 + t);         // top row combs down over the rest
      const len = (fem ? 0.0034 : 0.0048) * (0.75 + rng() * 0.5) * (1 - 0.3 * t);
      const bend = (rng() - 0.3) * 0.25;
      const dx1 = s * Math.cos(ang) * len * 0.5, dy1 = Math.sin(ang) * len * 0.5;
      const dx2 = s * Math.cos(ang - bend) * len, dy2 = Math.sin(ang - bend) * len - 0.0003;
      const pts = [[x, y, null], [x + dx1, y + dy1, null], [x + dx2, y + dy2, null]];
      const a = (0.40 + rng() * 0.45) * (1 - t * 0.3);
      A.stroke(pts, fem ? 0.00016 : 0.00020, css(rng() < 0.15 ? browLight : browCol, a));
      HT.stroke(pts, 0.00022, RIDGE(0.12));
    }
  }

  // ---- nose, mouth, cheeks ------------------------------------------------
  for (const s of [-1, 1]) {
    // Nostrils, and the alar groove where the wing meets the cheek.
    A.blob(s * 0.0066, 1.7322, null, 0.0040, 0.0021, [[0, 'rgba(28,12,10,0.92)'], [0.7, 'rgba(40,18,14,0.5)'], [1, 'rgba(40,20,16,0)']]);
    const alar = spline([[s * 0.0180, 1.7450], [s * 0.0198, 1.7395], [s * 0.0188, 1.7340], [s * 0.0150, 1.7315]]).map((p) => [p[0], p[1], null]);
    HT.stroke(alar, 0.0012, GROOVE(0.6), 'source-over', 0.0005);
    A.stroke(alar, 0.0014, 'rgba(70,30,26,0.22)', 'source-over', 0.0007);
    // Nasolabial line: from the top of the wing, down and out round the
    // mouth. Sharp at the top where the cheek pad folds over it, fading out
    // past the mouth corner.
    const nl = spline([[s * 0.0200, 1.7440], [s * 0.0245, 1.7330], [s * 0.0290, 1.7200], [s * 0.0318, 1.7080], [s * 0.0325, 1.6960]]).map((p) => [p[0], p[1], null]);
    const depth = (0.35 + 0.35 * age + 0.15 * (o.fold ?? 0.6)) * (0.55 - 0.3 * fem);
    HT.stroke(nl.slice(0, Math.floor(nl.length * 0.75)), 0.0014, GROOVE(depth), 'source-over', 0.0007);
    HT.stroke(nl, 0.0030, GROOVE(depth * 0.35), 'source-over', 0.0016);
    HT.stroke(nl.map((p) => [p[0] - s * 0.0022, p[1] + 0.0008, null]), 0.0030, RIDGE(depth * 0.35), 'source-over', 0.0016);
    A.stroke(nl, 0.0030, pale > 0.3 ? 'rgba(120,60,50,0.10)' : 'rgba(40,16,10,0.14)', 'source-over', 0.0016);
    // Mouth corner: the small pocket where the lips meet, shadowed.
    HT.blob(s * 0.0255, 1.7055, null, 0.0022, 0.0016, [[0, GROOVE(0.55)], [1, GROOVE(0)]]);
    A.blob(s * 0.0252, 1.7057, null, 0.0022, 0.0016, [[0, 'rgba(40,16,14,0.45)'], [1, 'rgba(40,16,14,0)']]);
  }
  // Philtrum groove down the middle of the upper lip.
  HT.stroke([[0, 1.7290, null], [0, 1.7200, null]], 0.0022, GROOVE(0.22), 'source-over', 0.0012);
  for (const s of [-1, 1]) HT.stroke([[s * 0.0030, 1.7285, null], [s * 0.0046, 1.7150, null]], 0.0014, RIDGE(0.25), 'source-over', 0.0008);

  // Lips. The vermilion is the skin tone pulled toward a muted rose or, for
  // darker skin, a deeper plum with a lighter, pinker inner lower lip; a flat
  // red reads as lipstick. The border is soft, the parting line is dark, and
  // fine vertical lines break the highlight into a lip rather than a sausage.
  const ML = 1.7058;
  const lipCol = pale > 0.3
    ? mix(skin, col(fem ? '#b8465a' : '#a24e4c'), fem ? 0.70 : 0.62)
    : mix(skin, col('#3e1a20'), 0.40);
  const lipInner = pale > 0.3 ? mix(lipCol, col('#c06a6a'), 0.35) : mix(lipCol, col('#8a4a4c'), 0.45);
  const upperOutline = [], lowerOutline = [];
  const lw = 0.0245 * (fem ? 0.96 : 1);
  for (let i = 0; i <= 20; i++) {
    const t = -1 + (i / 20) * 2;
    const x = t * lw;
    // Cupid's bow: two peaks either side of the philtrum and a dip between.
    const bow = (fem ? 0.0096 : 0.0074) * Math.pow(1 - t * t, 0.5) + 0.0010 * gauss(Math.abs(t) - 0.20, 0.12) - 0.0012 * gauss(t, 0.08);
    upperOutline.push([x, ML + bow, null]);
    lowerOutline.push([x, ML - (fem ? 0.0120 : 0.0094) * Math.pow(1 - t * t, 0.62), null]);
  }
  A.poly(upperOutline.concat([[lw, ML, null], [-lw, ML, null]]), css(lipCol, 0.92), 'source-over', 0.0005);
  A.poly(lowerOutline.concat([[lw, ML, null], [-lw, ML, null]]), css(lipCol, 0.78), 'source-over', 0.0006);
  A.blob(0, ML - 0.0040, null, 0.013, 0.0030, [[0, css(lipInner, 0.45)], [1, css(lipInner, 0)]]);
  // Vermilion border catches a thin light line, most of all on the upper lip.
  A.stroke(upperOutline.slice(2, -2), 0.0006, css(mix(skin, col('#ffffff'), 0.15), 0.25), 'source-over', 0.0003);
  RG.poly(upperOutline.concat([[lw, ML, null], [-lw, ML, null]]), ROUGH(0.36), 'source-over', 0.0005);
  RG.poly(lowerOutline.concat([[lw, ML, null], [-lw, ML, null]]), ROUGH(0.30), 'source-over', 0.0006);
  for (let n = 0; n < 16; n++) {
    const t = (rng() * 2 - 1) * 0.85;
    const x = t * lw;
    const up = rng() < 0.4;
    const y0 = up ? ML + 0.0008 : ML - 0.0010;
    const y1 = up ? ML + 0.0058 * Math.sqrt(1 - t * t) : ML - 0.0075 * Math.sqrt(1 - t * t);
    HT.stroke([[x, y0, null], [x + (rng() - 0.5) * 0.0012, (y0 + y1) * 0.5 + (rng() - 0.5) * 0.001, null], [x + (rng() - 0.5) * 0.0016, y1, null]], 0.0004, GROOVE(0.06 + 0.08 * rng()), 'source-over', 0.0002);
  }
  const line = [];
  for (let i = 0; i <= 16; i++) {
    const t = -1 + (i / 16) * 2;
    line.push([t * (lw + 0.0006), ML + 0.0005 * Math.cos(t * Math.PI * 0.5) - Math.abs(t) ** 3 * 0.0010, null]);
  }
  A.stroke(line, 0.0011, 'rgba(34,14,12,0.9)', 'source-over', 0.0003);
  HT.stroke(line, 0.0012, GROOVE(0.7), 'source-over', 0.0004);

  // ---- forehead, frown, chin, neck ----------------------------------------
  const nFore = Math.max(0, Math.floor(age * 4 + rng() * 1.5) - (fem ? 2 : 0));
  for (let n = 0; n < nFore; n++) {
    const y = 1.822 + n * 0.0075 + (rng() - 0.5) * 0.002;
    const pts = [];
    const w = 0.022 + rng() * 0.014;
    const ph = rng() * 6;
    for (let i = 0; i <= 12; i++) {
      const t = -1 + (i / 12) * 2;
      pts.push([t * w, y + 0.0012 * Math.sin(t * 2.4 + ph) + 0.0025 * t * t, null]);
    }
    HT.stroke(pts, 0.0006, GROOVE(0.10 + 0.18 * age), 'source-over', 0.0003);
  }
  // Frown lines: the vertical pair between the brows a fighter wears in.
  if (fur > 0) {
    for (const s of [-1, 1]) {
      const x = s * (0.0036 + rng() * 0.0012);
      HT.stroke([[x, 1.7870, null], [x + s * 0.0006, 1.7950, null], [x + s * 0.0004, 1.8020, null]], 0.0010, GROOVE(0.35 + 0.35 * fur), 'source-over', 0.0005);
    }
    HT.stroke([[-0.006, 1.7835, null], [0, 1.7815, null], [0.006, 1.7835, null]], 0.0012, GROOVE(0.25 * fur), 'source-over', 0.0006);
  }
  HT.stroke([[-0.012, 1.6880, null], [0, 1.6865, null], [0.012, 1.6880, null]], 0.0020, GROOVE(0.30), 'source-over', 0.0010);
  if (o.cleft) HT.stroke([[0, 1.6800, null], [0, 1.6660, null]], 0.0016, GROOVE(0.45 * o.cleft), 'source-over', 0.0008);

  // ---- roughness zones ----------------------------------------------------
  // Forehead and nose shine, the cheeks are matte, a stubbled jaw is matte
  // with the stubble itself; lids and under-eyes sit in between.
  RG.field((th, ph) => {
    const a = Math.abs(th);
    const fore = g01((ph - 0.20) / 0.12) * Math.exp(-((th / 0.75) ** 2)) * g01((1.2 - ph) / 0.2);
    const nose = Math.exp(-((th / 0.13) ** 2) - ((ph + 0.10) / 0.18) ** 2);
    const cheekbone = Math.exp(-(((a - 0.55) / 0.16) ** 2) - ((ph + 0.02) / 0.08) ** 2);
    const cheek = Math.exp(-(((a - 0.55) / 0.22) ** 2) - ((ph + 0.28) / 0.16) ** 2);
    const beardC = o.beardCover ? o.beardCover(th, ph, true) : 0;
    let r = 0.62;
    r -= fore * 0.06 + nose * 0.10 + cheekbone * 0.05;
    r += cheek * 0.06 + beardC * (fem ? 0 : 0.06 + 0.10 * (o.stubble ?? 0));
    const v = g01(r);
    return [v, v, v, 0.85];
  }, 'source-over', 2);

  // ---- stubble ----------------------------------------------------------
  // A stipple of cut hair ends over the wash, dense where the beard is dense.
  if (!o.beard && !fem && o.stubble > 0 && o.beardCover) {
    const dot = mix(skin, hair, 0.9);
    for (let n = 0; n < 9000; n++) {
      const th = (rng() - 0.5) * 2.9;
      const ph = -1.05 + rng() * 1.05;
      const c = o.beardCover(th, ph, true);
      if (rng() > c * o.stubble * 1.3) continue;
      const d = new THREE.Vector3(Math.sin(th) * Math.cos(ph), Math.sin(ph), Math.cos(th) * Math.cos(ph));
      const p = HEAD_C.clone().addScaledVector(d, 0.1);
      A.stroke([[p.x, p.y, p.z], [p.x + 0.00015, p.y - 0.0004, p.z]], 0.00022, css(dot, 0.30 + rng() * 0.35));
    }
  }

  // ---- marks ------------------------------------------------------------
  // Scars are paler and shinier than the skin round them and stand a little
  // proud; on dark skin they heal lighter still.
  const scarCol = pale > 0.3 ? mix(skin, col('#f0d0c8'), 0.35) : mix(skin, col('#b08070'), 0.45);
  for (const sc of o.scars || []) {
    let pts;
    if (sc.kind === 'brow') {
      const x = sc.x;
      pts = [[x - sc.side * 0.0012, 1.8010, null], [x, 1.7930, null], [x + sc.side * 0.0010, 1.7860, null]];
    } else if (sc.kind === 'nose') {
      pts = [[-0.0050, 1.7700, null], [0.0000, 1.7680, null], [0.0045, 1.7695, null]];
    } else if (sc.kind === 'cheek') {
      const x = sc.side * 0.045;
      pts = [[x - sc.side * 0.004, 1.7550, null], [x, 1.7500, null], [x + sc.side * 0.005, 1.7470, null]];
    } else if (sc.kind === 'chin') {
      pts = [[-0.004, 1.6760, null], [0.001, 1.6740, null], [0.006, 1.6765, null]];
    } else if (sc.kind === 'lip') {
      const x = sc.side * 0.010;
      pts = [[x, 1.7160, null], [x + sc.side * 0.0008, 1.7110, null], [x + sc.side * 0.0006, 1.7060, null]];
    } else continue;
    const d = spline(pts, 6).map((p) => [p[0], p[1], null]);
    A.stroke(d, 0.0016, css(scarCol, 0.55), 'source-over', 0.0005);
    A.stroke(d, 0.0036, css(mix(skin, col('#9a4040'), 0.25), 0.18), 'source-over', 0.0015);
    HT.stroke(d, 0.0012, RIDGE(0.55), 'source-over', 0.0004);
    RG.stroke(d, 0.0018, ROUGH(0.30), 'source-over', 0.0005);
  }
  if (o.scarTissue) {
    // Years of cuts over the orbit: mottled paler shiny skin along the brow.
    for (const s of [-1, 1]) {
      A.blob(s * 0.034, 1.7985, null, 0.014, 0.004, [[0, css(scarCol, 0.30 * o.scarTissue)], [1, css(scarCol, 0)]]);
      RG.blob(s * 0.034, 1.7985, null, 0.014, 0.004, [[0, ROUGH(0.34, 0.8)], [1, ROUGH(0.34, 0)]]);
      for (let n = 0; n < 4; n++) {
        const x = s * (0.024 + rng() * 0.022), y = 1.7960 + rng() * 0.004;
        HT.stroke([[x - 0.002, y + 0.0005, null], [x + 0.002, y - 0.0005, null]], 0.0008, RIDGE(0.35), 'source-over', 0.0003);
      }
    }
  }
  for (let n = 0; n < (o.moles ?? 0); n++) {
    const th = (rng() - 0.5) * 1.6, ph = -0.6 + rng() * 0.9;
    const d = new THREE.Vector3(Math.sin(th) * Math.cos(ph), Math.sin(ph), Math.cos(th) * Math.cos(ph));
    const p = HEAD_C.clone().addScaledVector(d, 0.1);
    const r = 0.0007 + rng() * 0.0009;
    A.blob(p.x, p.y, p.z, r, r, [[0, 'rgba(60,34,24,0.8)'], [0.7, 'rgba(70,40,28,0.5)'], [1, 'rgba(70,40,28,0)']]);
  }
  if (o.freckles) {
    const fr = pale > 0.3 ? 'rgba(150,80,44,' : 'rgba(50,26,16,';
    for (let n = 0; n < 700 * o.freckles; n++) {
      const th = (rng() - 0.5) * 1.5, ph = -0.35 + rng() * 0.45;
      const w = Math.exp(-((th / 0.55) ** 2)) * Math.exp(-(((ph + 0.1) / 0.18) ** 2));
      if (rng() > w) continue;
      const d = new THREE.Vector3(Math.sin(th) * Math.cos(ph), Math.sin(ph), Math.cos(th) * Math.cos(ph));
      const p = HEAD_C.clone().addScaledVector(d, 0.1);
      const r = 0.0004 + rng() * 0.0007;
      A.blob(p.x, p.y, p.z, r, r, [[0, fr + (0.25 + rng() * 0.3).toFixed(3) + ')'], [1, fr + '0)']]);
    }
  }
}

// Ears and fists live in the spare rect, off the head grid. Their blood shows
// through thin skin over cartilage and over the knuckles, so both carry a
// flush the forearm does not.
export function paintExtremities(ctx, size, earRect, fistRect, skinHex) {
  const skin = col(skinHex);
  const pale = g01((lum(skin) - 0.40) / 0.30);
  const flush = pale > 0.3 ? col('#c8484a') : mix(skin, col('#6a2014'), 0.5);
  const rect = (r) => [r[0] * size, (1 - r[3]) * size, (r[2] - r[0]) * size, (r[3] - r[1]) * size];
  ctx.save();
  const [ex, ey, ew, eh] = rect(earRect);
  ctx.fillStyle = css(flush, 0.04 + 0.04 * pale);
  ctx.fillRect(ex, ey, ew, eh);
  const [fx, fy, fw, fh] = rect(fistRect);
  // The fist loft runs wrist to knuckles along v, so the knuckles are the top
  // of its rect on the canvas.
  const g = ctx.createLinearGradient(0, fy + fh, 0, fy);
  g.addColorStop(0, css(flush, 0));
  g.addColorStop(0.55, css(flush, 0.10 + 0.08 * pale));
  g.addColorStop(1, css(flush, 0.26 + 0.14 * pale));
  ctx.fillStyle = g;
  ctx.fillRect(fx, fy, fw, fh);
  ctx.restore();
}
