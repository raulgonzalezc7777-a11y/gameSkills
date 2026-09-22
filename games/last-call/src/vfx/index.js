import { VFX } from './particles.js';
import { bus, EV } from '../core/events.js';
import { CFG } from '../core/config.js';

export { VFX };
export { DecalField } from './decals.js';
export { TrailRig } from './trails.js';

const _dir = { x: 0, y: 0, z: 0 };
const _pos = { x: 0, y: 0, z: 0 };

function dirFrom(attacker, target, out) {
  const a = attacker?.position, b = target?.position;
  if (!a || !b) { out.x = 0; out.y = 1; out.z = 0; return out; }
  let dx = b.x - a.x, dy = 0.15, dz = b.z - a.z;
  const l = Math.hypot(dx, dy, dz) || 1;
  out.x = dx / l; out.y = dy / l; out.z = dz / l;
  return out;
}

// One call wires the whole event bus to the effects. Keeping it here rather
// than in main.js means a new effect never needs the integrator's attention.
export function installVFXListeners(vfx) {
  const offs = [];

  offs.push(bus.on(EV.HIT_LANDED, (p) => {
    const pt = p.point || p.target?.position;
    if (!pt) return;
    dirFrom(p.attacker, p.target, _dir);
    const power = Math.min(2.4, 0.55 + (p.damage || 8) * 0.085);
    vfx.emit('impactFlash', pt, _dir, { power });
    vfx.emit('sweat', pt, _dir, { count: Math.round(6 + power * 7), power });
    if ((p.damage || 0) > 11) {
      vfx.emit('shockwave', pt, _dir, { power });
      vfx.emit('blood', pt, _dir, { count: Math.round(3 + power * 4), power: power * 0.8 });
    }
    if ((p.damage || 0) > 20) vfx.emit('spark', pt, _dir, { count: 10, power });
  }));

  offs.push(bus.on(EV.HIT_BLOCKED, (p) => {
    const pt = p.point || p.target?.position;
    if (!pt) return;
    dirFrom(p.attacker, p.target, _dir);
    vfx.emit('spark', pt, _dir, { count: 12, power: 0.9, color: '#cfe8ff' });
    vfx.emit('impactFlash', pt, _dir, { power: 0.6 });
  }));

  offs.push(bus.on(EV.PARRY, (p) => {
    const pt = p?.point || p?.fighter?.position;
    if (!pt) return;
    _dir.x = 0; _dir.y = 1; _dir.z = 0;
    vfx.emit('spark', pt, _dir, { count: 26, power: 1.5, color: '#fff2b0' });
    vfx.emit('shockwave', pt, _dir, { power: 0.9 });
  }));

  offs.push(bus.on(EV.KNOCKDOWN, (p) => {
    const f = p.fighter; if (!f) return;
    _pos.x = f.position.x; _pos.y = 0.12; _pos.z = f.position.z;
    _dir.x = 0; _dir.y = 1; _dir.z = 0;
    vfx.emit('dust', _pos, _dir, { count: 22, power: 1.4 });
    vfx.emit('shockwave', _pos, _dir, { power: 1.3 });
  }));

  offs.push(bus.on(EV.KO, (p) => {
    const f = p.fighter; if (!f) return;
    _pos.x = f.position.x; _pos.y = 1.1; _pos.z = f.position.z;
    _dir.x = 0; _dir.y = 1; _dir.z = 0;
    vfx.emit('shockwave', _pos, _dir, { power: 2.2 });
    vfx.emit('confetti', _pos, _dir, { count: 160, power: 1.8 });
    vfx.emit('smoke', _pos, _dir, { count: 14, power: 1.2 });
  }));

  offs.push(bus.on(EV.DRINK, (p) => {
    const f = p.fighter; if (!f) return;
    _pos.x = f.position.x; _pos.y = 1.5; _pos.z = f.position.z;
    dirFrom(f, { position: { x: f.position.x, y: 0, z: f.position.z + 1 } }, _dir);
    vfx.emit('beer', _pos, _dir, { count: 16, power: 0.9 });
  }));

  offs.push(bus.on(EV.FOOTSTEP, (p) => {
    if (!p?.position) return;
    _dir.x = 0; _dir.y = 1; _dir.z = 0;
    vfx.emit('dust', p.position, _dir, { count: 3, power: 0.35 * (p.intensity ?? 1) });
  }));

  offs.push(bus.on(EV.PROP_BREAK, (p) => {
    if (!p?.position) return;
    const v = p.velocity || { x: 0, y: 1, z: 0 };
    const l = Math.hypot(v.x, v.y, v.z) || 1;
    _dir.x = v.x / l; _dir.y = Math.abs(v.y / l) + 0.3; _dir.z = v.z / l;
    vfx.emit('glass', p.position, _dir, { count: 24, power: 1.2 });
    vfx.emit('beer', p.position, _dir, { count: 18, power: 1.0 });
  }));

  offs.push(bus.on(EV.COMBO, (p) => {
    const f = p.fighter; if (!f || p.count < 3) return;
    _pos.x = f.position.x; _pos.y = 1.7; _pos.z = f.position.z;
    _dir.x = 0; _dir.y = 1; _dir.z = 0;
    vfx.emit('confetti', _pos, _dir, { count: 16 + p.count * 5, power: 1.0 });
  }));

  return () => offs.forEach((o) => o());
}
