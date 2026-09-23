import * as THREE from 'three';
import { HEAD_C, lidPoint, EYE } from './head.js';

// Everything painted onto the head's slice of the skin atlas at boot: scalp
// shadow under the hair, stubble, the flush over cheeks, nose and ears, brows,
// lash lines, lips and nostrils.
//
// Shapes are authored in metres on the canonical head and pushed through the
// head grid's own uv lookup, so a brow lands on the brow ridge whatever the
// grid density is doing there. Broad washes go through a field image with one
// texel per grid vertex, drawn up with smoothing: the grid is regular in uv, so
// that image is exactly aligned with the mesh and costs a few thousand texels.

const lum = (c) => c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
const css = (c, a) => 'rgba(' + Math.round(c.r * 255) + ',' + Math.round(c.g * 255) + ',' + Math.round(c.b * 255) + ',' + a.toFixed(3) + ')';

export function makeHeadPainter(ctx, size, grid, rect, H) {
  const C = HEAD_C;
  // Canonical head point to world, then to canvas pixels.
  const hc = (x, y, z) => [x * H, C.y + (y - C.y) * H, C.z + (z - C.z) * H];
  const toPx = (x, y, z) => {
    const w = hc(x, y, z);
    const [u, v] = grid.uvOf(w[0], w[1], w[2]);
    return [
      (rect[0] + u * (rect[2] - rect[0])) * size,
      (1 - (rect[1] + v * (rect[3] - rect[1]))) * size
    ];
  };
  // Pixels per metre around a point, separately across and up the face.
  const scaleAt = (x, y, z) => {
    const a = toPx(x - 0.005, y, z), b = toPx(x + 0.005, y, z);
    const c = toPx(x, y - 0.005, z), d = toPx(x, y + 0.005, z);
    return [Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.01, Math.hypot(d[0] - c[0], d[1] - c[1]) / 0.01];
  };

  function blob(x, y, z, rx, ry, stops, op = 'source-over') {
    const [cx, cy] = toPx(x, y, z);
    const [sx, sy] = scaleAt(x, y, z);
    const pr = rx * sx, pry = ry * sy;
    if (!(pr > 0.5 && pry > 0.5)) return;
    ctx.save();
    ctx.globalCompositeOperation = op;
    ctx.translate(cx, cy);
    ctx.scale(1, pry / pr);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, pr);
    for (const s of stops) g.addColorStop(s[0], s[1]);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, pr, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function stroke(pts, width, style, op = 'source-over', blur = 0) {
    ctx.save();
    ctx.globalCompositeOperation = op;
    if (blur) ctx.filter = 'blur(' + blur.toFixed(1) + 'px)';
    ctx.strokeStyle = style;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = width;
    ctx.beginPath();
    pts.forEach((p, i) => { const q = toPx(p[0], p[1], p[2]); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
    ctx.stroke();
    ctx.restore();
  }

  function poly(pts, style, op = 'source-over', blur = 0) {
    ctx.save();
    ctx.globalCompositeOperation = op;
    if (blur) ctx.filter = 'blur(' + blur.toFixed(1) + 'px)';
    ctx.fillStyle = style;
    ctx.beginPath();
    pts.forEach((p, i) => { const q = toPx(p[0], p[1], p[2]); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // fn(th, ph, pos) -> [r, g, b, a] in 0..1, evaluated once per grid vertex.
  function field(fn, op = 'source-over', blurPx = 0) {
    const W = grid.nu + 1, R = grid.nRows;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = R;
    const g = cv.getContext('2d');
    const img = g.createImageData(W, R);
    for (let k = 0; k < R; k++) {
      for (let i = 0; i < W; i++) {
        const ii = i % grid.nu;
        const [th, ph] = grid.dirs[k][ii];
        const c = fn(th, ph, grid.rings[k][ii], k);
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
    if (blurPx) ctx.filter = 'blur(' + blurPx + 'px)';
    ctx.drawImage(cv, rect[0] * size - pw * 0.5, (1 - rect[3]) * size - ph * 0.5, W * pw, R * ph);
    ctx.restore();
  }

  return { toPx, scaleAt, blob, stroke, poly, field, hc };
}

// o: { skin, hair, stubble, beard, hairCover(th, ph), beardCover(th, ph), rng, bald }
export function paintFace(P, o) {
  const skin = new THREE.Color(o.skin);
  const hair = new THREE.Color(o.hair);
  const L = lum(skin);
  const rng = o.rng;

  // Scalp. Hair roots darken the skin under the shell, and a shaved or thin
  // patch still carries that shadow, so the hairline reads soft from any
  // distance even where the shell has dithered away.
  // A shaved head still carries the ghost of its hairline: follicles under
  // pale skin read as a faint cool shadow over the crown.
  if (o.bald) {
    const sc = skin.clone().lerp(hair, 0.5).lerp(new THREE.Color('#556070'), L > 0.45 ? 0.2 : 0);
    P.field((th, ph) => {
      const c = o.baldCover(th, ph);
      return [sc.r, sc.g, sc.b, c * (L > 0.45 ? 0.22 : 0.10)];
    }, 'source-over', 2);
  }
  if (o.hairCover) {
    const sc = skin.clone().lerp(hair, 0.78);
    P.field((th, ph) => {
      const c = o.hairCover(th, ph, true);
      return [sc.r, sc.g, sc.b, Math.min(1, c) * 0.9];
    }, 'source-over', 1.5);
  }

  // Flush: nose, cheeks, ears and chin carry more blood than the forehead.
  // Pale skin shows it as pink, dark skin as a deeper warm brown.
  const flush = L > 0.45 ? new THREE.Color('#c0584c') : skin.clone().lerp(new THREE.Color('#9a4030'), 0.45);
  const flushAmt = L > 0.45 ? 0.30 : 0.18;
  P.field((th, ph, p) => {
    const cheek = Math.exp(-(((Math.abs(th) - 0.55) / 0.22) ** 2) - ((ph + 0.12) / 0.16) ** 2);
    const nose = Math.exp(-((th / 0.14) ** 2) - ((ph + 0.18) / 0.14) ** 2);
    const ear = Math.exp(-(((Math.abs(th) - 1.62) / 0.18) ** 2) - ((ph + 0.02) / 0.3) ** 2);
    const a = Math.min(1, cheek * 0.55 + nose * 0.6 + ear * 0.5) * flushAmt;
    return [flush.r, flush.g, flush.b, a];
  }, 'source-over', 2);

  // Beard shadow and stubble: a cool, darker wash over the jaw, then a
  // stipple of hair ends on top of it.
  const beardAmt = o.beard ? 0.8 : o.stubble;
  if (beardAmt > 0 && o.beardCover) {
    const sh = skin.clone().lerp(hair, 0.55).lerp(new THREE.Color('#44506a'), L > 0.45 ? 0.25 : 0.05);
    P.field((th, ph) => {
      const c = o.beardCover(th, ph, true);
      return [sh.r, sh.g, sh.b, Math.min(1, c) * 0.55 * beardAmt];
    }, 'source-over', 2);
  }

  // Socket shading: the upper lid crease and the tear trough are what make an
  // eye sit in a head rather than on it.
  for (const s of [-1, 1]) {
    const ex = s * EYE.x;
    P.blob(ex + s * 0.002, EYE.y + 0.006, 0.08, 0.020, 0.012, [
      [0, 'rgba(70,36,30,0.30)'], [0.6, 'rgba(70,40,34,0.14)'], [1, 'rgba(80,50,40,0)']
    ]);
    P.blob(ex, EYE.y - 0.010, 0.08, 0.017, 0.006, [
      [0, 'rgba(84,48,56,0.22)'], [1, 'rgba(84,48,56,0)']
    ]);
  }

  // Brows: several hundred short strokes along the ridge, dense and upright
  // at the inner end, sparse and swept out toward the tail.
  const brow = hair.clone().lerp(new THREE.Color('#000000'), 0.2);
  for (const s of [-1, 1]) {
    for (let n = 0; n < 150; n++) {
      const t = rng();
      const x = s * (0.011 + t * 0.047);
      const yc = 1.7915 + Math.sin(Math.min(1, t * 1.25) * Math.PI * 0.8) * 0.0065 - t * t * 0.003;
      const hgt = 0.0062 * (1 - t * 0.65);
      const y = yc + (rng() - 0.5) * hgt;
      const ang = (1 - t) * 1.25 + t * 0.25;   // upright at the inner end, flat at the tail
      const len = 0.0045 + rng() * 0.002;
      const dx = s * Math.cos(ang) * len, dy = Math.sin(ang) * len * 0.8 - t * 0.0008;
      const a = (0.35 + rng() * 0.4) * (1 - t * 0.35);
      P.stroke([[x, y, 0.1], [x + dx, y + dy, 0.1]], 1.2, css(brow, a));
    }
  }

  // Lash lines: the upper lid margin is the darkest line on a face.
  for (const s of [-1, 1]) {
    const up = [], lo = [];
    for (let i = 0; i <= 14; i++) {
      const xi = -0.98 + (i / 14) * 1.96;
      const pu = lidPoint(s, xi, true, EYE.r + 0.0026);
      const pl = lidPoint(s, xi, false, EYE.r + 0.0024);
      up.push([pu.x, pu.y, pu.z]);
      lo.push([pl.x, pl.y, pl.z]);
    }
    P.stroke(up, 3.6, 'rgba(20,12,9,0.9)');
    P.stroke(lo, 1.2, 'rgba(60,34,28,0.45)');
  }

  // Lips. Colour is the skin tone pulled toward a muted rose or, for darker
  // skin, toward a deeper plum; a flat red reads as lipstick.
  const lip = L > 0.45
    ? skin.clone().lerp(new THREE.Color('#9a4a48'), 0.45)
    : skin.clone().lerp(new THREE.Color('#4a2428'), 0.35);
  const ML = 1.7058;
  const upperOutline = [], lowerOutline = [];
  for (let i = 0; i <= 16; i++) {
    const t = -1 + (i / 16) * 2;
    const x = t * 0.0245;
    const bow = 0.0082 - Math.abs(t) * 0.001 - Math.exp(-((t / 0.12) ** 2)) * 0.0016;
    upperOutline.push([x, ML + bow * Math.pow(1 - t * t, 0.45), 0.1]);
    lowerOutline.push([x, ML - 0.0095 * Math.pow(1 - t * t, 0.6), 0.1]);
  }
  P.poly(upperOutline.concat([[0.0245, ML, 0.1], [-0.0245, ML, 0.1]]).reverse(), css(lip, 0.75), 'source-over', 1.5);
  P.poly(lowerOutline, css(lip.clone().lerp(skin, 0.15), 0.65), 'source-over', 1.5);
  const line = [];
  for (let i = 0; i <= 12; i++) {
    const t = -1 + (i / 12) * 2;
    line.push([t * 0.025, ML + 0.0006 * Math.cos(t * Math.PI * 0.5) - Math.abs(t) ** 3 * 0.0012, 0.1]);
  }
  P.stroke(line, 1.8, 'rgba(40,18,16,0.75)');

  // Nostrils and the shadow along the nasolabial fold.
  for (const s of [-1, 1]) {
    P.blob(s * 0.0068, 1.7318, 0.106, 0.0042, 0.0022, [[0, 'rgba(26,12,10,0.9)'], [1, 'rgba(40,20,16,0)']]);
    P.stroke([[s * 0.021, 1.737, 0.1], [s * 0.026, 1.724, 0.1], [s * 0.029, 1.708, 0.1]], 4, 'rgba(90,50,40,0.10)', 'source-over', 2);
  }

  // Stipple of hair ends over the stubble wash.
  if (!o.beard && o.stubble > 0 && o.beardCover) {
    const dot = skin.clone().lerp(hair, 0.85);
    for (let n = 0; n < 2600; n++) {
      const th = (rng() - 0.5) * 2.8;
      const ph = -1.0 + rng() * 1.0;
      const c = o.beardCover(th, ph, true);
      if (rng() > c * o.stubble) continue;
      const d = new THREE.Vector3(Math.sin(th) * Math.cos(ph), Math.sin(ph), Math.cos(th) * Math.cos(ph));
      const p = HEAD_C.clone().addScaledVector(d, 0.1);
      P.stroke([[p.x, p.y, p.z], [p.x + 0.0004, p.y - 0.0008, p.z]], 1.0, css(dot, 0.25 + rng() * 0.3));
    }
  }
}
