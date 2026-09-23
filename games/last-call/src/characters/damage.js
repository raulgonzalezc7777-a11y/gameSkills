import { clamp01 } from '../core/math.js';

// Everything that happens to a fighter's surface after it is built: the
// tattoos one of them wears, and the bruising, cuts and blood that accumulate
// over a round. The face itself is painted by face.js.
//
// All of it composites onto a per-fighter copy of the skin canvas, so two
// fighters sharing a skin tone never share each other's damage. The GPU
// re-upload is the expensive half, so needsUpdate is rate limited: a flurry of
// hits in one combo costs one upload, not eight.

const UPLOAD_MS = 90;

// UV to canvas pixels. CanvasTexture flips Y, so v = 0 is the bottom row.
const px = (u, size) => u * size;
const py = (v, size) => (1 - v) * size;

function rectPx(r, size) {
  return {
    x: px(r[0], size),
    y: py(r[3], size),
    w: (r[2] - r[0]) * size,
    h: (r[3] - r[1]) * size
  };
}

function blob(ctx, x, y, rx, ry, rot, stops) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(1, ry / rx);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  for (const s of stops) g.addColorStop(s[0], s[1]);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ------------------------------------------------------------- tattoos -----

const TATTOO_INK = ['#20242e', '#1a2430', '#241c2a'];

// Tribal bands and a shoulder piece, drawn as stroked arcs inside the arm and
// torso atlas rects. Nothing here is symmetric on purpose: a fighter with the
// same sleeve on both arms looks printed rather than inked.
export function paintTattoos(ctx, size, rects, rng, style = 'sleeve') {
  const ink = rng.pick(TATTOO_INK);
  ctx.save();
  ctx.globalAlpha = 0.80;
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const arm = rectPx(rects[rng.chance(0.5) ? 'armL' : 'armR'], size);
  if (style === 'sleeve' || style === 'full') {
    // Tribal bands wrapping the upper arm. The arm loft runs its v axis along
    // the limb, so a horizontal stroke here is a band around it.
    for (let b = 0; b < 4; b++) {
      const y = arm.y + arm.h * (0.60 + b * 0.085);
      const amp = arm.h * (0.018 + rng.range(0, 0.014));
      ctx.lineWidth = arm.h * rng.range(0.012, 0.030);
      ctx.beginPath();
      for (let i = 0; i <= 48; i++) {
        const t = i / 48;
        const x = arm.x + t * arm.w;
        const yy = y + Math.sin(t * Math.PI * rng.int(4, 7) + b) * amp;
        if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    // Barbed spikes hanging off the lowest band.
    for (let i = 0; i < 12; i++) {
      const x = arm.x + arm.w * (i / 12 + 0.02);
      const y = arm.y + arm.h * 0.94;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + arm.w * 0.035, y - arm.h * rng.range(0.03, 0.075));
      ctx.lineTo(x + arm.w * 0.07, y);
      ctx.closePath();
      ctx.fill();
    }
  }

  if (style === 'chest' || style === 'full') {
    const body = rectPx(rects.body, size);
    // The torso loft puts the chest a little over halfway up its rect and the
    // front centreline at the middle of its u range.
    const cx = body.x + body.w * 0.5;
    const cy = body.y + body.h * 0.40;
    ctx.lineWidth = body.w * 0.012;
    for (let w = 0; w < 2; w++) {
      const s = w ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.quadraticCurveTo(cx + s * body.w * 0.18, cy - body.h * 0.05, cx + s * body.w * 0.26, cy + body.h * 0.04);
      ctx.quadraticCurveTo(cx + s * body.w * 0.16, cy + body.h * 0.02, cx + s * body.w * 0.10, cy + body.h * 0.06);
      ctx.stroke();
      for (let f = 0; f < 4; f++) {
        const t = 0.25 + f * 0.2;
        ctx.beginPath();
        ctx.moveTo(cx + s * body.w * 0.26 * t, cy + body.h * 0.02 * t);
        ctx.lineTo(cx + s * body.w * (0.26 * t + 0.05), cy + body.h * (0.02 * t + 0.045));
        ctx.stroke();
      }
    }
  }

  ctx.restore();
}

// -------------------------------------------------------------- damage -----

const ALIAS = {
  head: 'face', face: 'face',
  body: 'torso', chest: 'torso', torso: 'torso',
  legs: 'legs', legL: 'legs', legR: 'legs', leg: 'legs',
  arms: 'arms', armL: 'arms', armR: 'arms', arm: 'arms'
};

// Which atlas rects a logical part paints into.
const PART_RECTS = {
  face: ['head'],
  torso: ['body'],
  arms: ['armL', 'armR'],
  legs: ['legL', 'legR']
};

export function createDamage(opts) {
  const { ctx, size, texture, rects, faceLandmarks, morphIndex, influences, rng } = opts;
  const level = { face: 0, torso: 0, arms: 0, legs: 0 };
  let cuts = 0;
  let lastUpload = -1e9;
  let pending = false;
  let timer = 0;

  const upload = () => {
    texture.needsUpdate = true;
    lastUpload = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    pending = false;
  };

  const touch = () => {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - lastUpload >= UPLOAD_MS) { upload(); return; }
    if (pending) return;
    pending = true;
    // One trailing upload so the final hit of a combo is never lost.
    timer = setTimeout(upload, UPLOAD_MS - (now - lastUpload));
  };

  // A bruise is two layers: a broad multiply that darkens and reddens, then a
  // tighter, more saturated core. One layer alone reads as dirt.
  const bruise = (r, cx, cy, rad, strength) => {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    blob(ctx, cx, cy, rad, rad * 0.78, rng.range(0, Math.PI), [
      [0, 'rgba(176,96,104,' + (0.62 * strength).toFixed(3) + ')'],
      [0.5, 'rgba(206,140,140,' + (0.34 * strength).toFixed(3) + ')'],
      [1, 'rgba(255,255,255,0)']
    ]);
    blob(ctx, cx + rad * 0.12, cy - rad * 0.08, rad * 0.45, rad * 0.36, 0, [
      [0, 'rgba(128,64,92,' + (0.55 * strength).toFixed(3) + ')'],
      [1, 'rgba(255,255,255,0)']
    ]);
    ctx.globalCompositeOperation = 'source-over';
    // A thin hot rim sells the swelling rather than a flat stain.
    blob(ctx, cx, cy, rad * 0.85, rad * 0.66, 0, [
      [0.55, 'rgba(190,70,58,0)'],
      [0.82, 'rgba(184,66,54,' + (0.22 * strength).toFixed(3) + ')'],
      [1, 'rgba(184,66,54,0)']
    ]);
    ctx.restore();
  };

  // A cut is a dark split with a pale lip on one side, and it bleeds downward
  // in canvas space, which is downward on the face because the head loft runs
  // its v axis from neck to crown.
  const cut = (cx, cy, len, ang, strength) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(232,206,190,0.55)';
    ctx.lineWidth = len * 0.20;
    ctx.beginPath(); ctx.moveTo(-len * 0.5, -len * 0.05); ctx.lineTo(len * 0.5, len * 0.03); ctx.stroke();
    ctx.strokeStyle = 'rgba(104,16,14,0.95)';
    ctx.lineWidth = len * 0.11;
    ctx.beginPath(); ctx.moveTo(-len * 0.5, 0); ctx.lineTo(len * 0.5, 0); ctx.stroke();
    ctx.strokeStyle = 'rgba(52,6,8,0.85)';
    ctx.lineWidth = len * 0.045;
    ctx.beginPath(); ctx.moveTo(-len * 0.42, 0); ctx.lineTo(len * 0.42, 0); ctx.stroke();
    ctx.restore();

    // Trickle: a wandering line that thins and fades as it runs.
    const steps = 9;
    let x = cx + rng.range(-len * 0.2, len * 0.2), y = cy;
    const drop = len * rng.range(1.6, 3.2) * strength;
    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const nx = x + rng.range(-len * 0.10, len * 0.10);
      const ny = y + drop / steps;
      ctx.strokeStyle = 'rgba(122,14,16,' + (0.9 - t * 0.55).toFixed(3) + ')';
      ctx.lineWidth = len * (0.13 - t * 0.08);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(nx, ny); ctx.stroke();
      x = nx; y = ny;
    }
    blob(ctx, x, y, len * 0.16, len * 0.22, 0, [
      [0, 'rgba(112,12,14,0.85)'], [1, 'rgba(112,12,14,0)']
    ]);
    ctx.restore();
  };

  const setDamage = (part, amount) => {
    const key = ALIAS[part] || 'torso';
    // Callers using a 0..100 health scale get normalised rather than clipped.
    let a = amount > 1.5 ? amount / 100 : amount;
    a = clamp01(a);
    if (a <= 0.001) return;
    level[key] = clamp01(level[key] + a);

    for (const name of PART_RECTS[key]) {
      const r = rectPx(rects[name], size);
      if (key === 'face') {
        const lm = faceLandmarks;
        const side = rng.chance(0.5) ? lm.eyeL : lm.eyeR;
        const unit = lm.unit * size;
        const cx = px(side[0], size) + rng.range(-unit * 0.2, unit * 0.2);
        const cy = py(side[1], size) + rng.range(-unit * 0.25, unit * 0.35);
        bruise(r, cx, cy, unit * (0.28 + a * 0.30), 0.45 + a * 0.55);
        // A real cut opens above the brow or on the cheekbone, and only once
        // the face has taken a beating.
        if (level.face > 0.30 && cuts < 3 && rng.chance(0.45)) {
          cuts++;
          cut(cx + rng.range(-unit * 0.1, unit * 0.1), cy - unit * 0.34,
            unit * rng.range(0.24, 0.36), rng.range(-0.5, 0.5), 0.6 + level.face * 0.6);
        }
      } else {
        const cx = r.x + r.w * rng.range(0.22, 0.78);
        const cy = r.y + r.h * rng.range(0.15, 0.80);
        const rad = Math.min(r.w, r.h) * (0.09 + a * 0.10);
        bruise(r, cx, cy, rad, 0.35 + a * 0.55);
      }
    }
    touch();

    if (influences && morphIndex[key] !== undefined) {
      influences[morphIndex[key]] = level[key];
    }
  };

  const reset = () => {
    for (const k in level) level[k] = 0;
    cuts = 0;
    if (influences) for (let i = 0; i < influences.length; i++) influences[i] = 0;
  };

  const dispose = () => { if (timer) clearTimeout(timer); };

  return { setDamage, reset, dispose, level };
}
