import { input } from '../core/input.js';

// On-screen controls for phones and tablets: a floating stick on the left half
// and a thumb cluster of big buttons on the right. Everything is fed into the
// same input object the keyboard uses, so gameplay never knows the difference.

// Six buttons, not ten: a phone has room for thumbs, not for a keyboard. The
// punch button is the whole boxing kit; tapping it in rhythm walks the combo
// from jab to cross to hook to uppercut, and a pause starts it over.
const BUTTONS = [
  // [label, key code, css slot, sub-label]
  ['GOLPE', 'combo', 'b-punch', 'toca seguido'],
  ['PATADA', 'KeyL', 'b-kick'],
  ['BLOQUEO', 'Space', 'b-block', 'mantén'],
  ['BEBER', 'KeyE', 'b-drink'],
  ['AGARRAR', 'KeyG', 'b-grab'],
  ['ESQUIVAR', 'KeyC', 'b-dodge']
];
const COMBO = ['KeyJ', 'KeyK', 'KeyU', 'KeyI'];
const COMBO_GAP = 0.75;   // seconds between taps that still count as one combo

export function wantsTouch() {
  try {
    // A phone or tablet: the main pointer is a finger and nothing hovers. A
    // laptop with a touch screen still has a fine pointer, so it keeps the
    // keyboard layout until it is actually touched.
    return matchMedia('(hover: none) and (pointer: coarse)').matches;
  } catch { return false; }
}

export class TouchControls {
  constructor() { this.root = null; this.on = false; }

  mount(parent, { onPause } = {}) {
    const root = document.createElement('div');
    root.className = 'touch';
    root.innerHTML = `
      <div class="t-stickzone"><div class="t-base"><div class="t-knob"></div></div></div>
      <div class="t-pad">${BUTTONS.map(([label, code, slot, sub]) =>
        `<button class="t-btn ${slot}" data-code="${code}" aria-label="${label}">${label}${sub ? `<small>${sub}</small>` : ''}</button>`).join('')}</div>
      <button class="t-special" data-code="KeyF" aria-label="Borrachera">¡BORRACHERA!<small>toca ya</small></button>
      <button class="t-pause" aria-label="Pausa">II</button>`;
    parent.appendChild(root);
    this.root = root;
    this.base = root.querySelector('.t-base');
    this.knob = root.querySelector('.t-knob');
    this.special = root.querySelector('.t-special');
    this._combo = 0; this._comboT = -9;

    const zone = root.querySelector('.t-stickzone');
    let id = null, ox = 0, oy = 0;
    const R = 56;
    const place = (x, y) => { this.base.style.transform = `translate(${x - 70}px, ${y - 70}px)`; };
    // At rest the stick waits low on the left where a thumb falls; a touch
    // anywhere in the zone recentres it under that thumb.
    this.rest = () => {
      const r = zone.getBoundingClientRect();
      place(Math.max(86, r.width * 0.3), Math.max(80, r.height - 96));
    };
    const release = () => {
      this.rest();
      id = null;
      input.setStick(0, 0);
      this.knob.style.transform = 'translate(0px, 0px)';
      this.base.classList.remove('live');
    };
    zone.addEventListener('pointerdown', (e) => {
      if (id !== null) return;
      id = e.pointerId;
      zone.setPointerCapture?.(id);
      const r = zone.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      place(ox, oy);
      this.base.classList.add('live');
      e.preventDefault();
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      const r = zone.getBoundingClientRect();
      let dx = e.clientX - r.left - ox, dy = e.clientY - r.top - oy;
      const len = Math.hypot(dx, dy);
      if (len > R) { dx *= R / len; dy *= R / len; }
      this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const k = Math.min(1, len / R);
      const dead = k < 0.18 ? 0 : (k - 0.18) / 0.82;
      input.setStick(len ? (dx / Math.max(len, 1e-3)) * dead : 0, len ? (-dy / Math.max(len, 1e-3)) * dead : 0);
      // A hard shove on the stick is a sprint, like pushing a real stick home.
      if (k > 0.96) input.virtualPress('ShiftLeft'); else input.virtualRelease('ShiftLeft');
    });
    const end = (e) => { if (e.pointerId === id) { release(); input.virtualRelease('ShiftLeft'); } };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);

    for (const btn of root.querySelectorAll('.t-btn, .t-special')) {
      let code = btn.dataset.code;
      const down = (e) => {
        e.preventDefault();
        btn.classList.add('down');
        if (btn.dataset.code === 'combo') {
          const now = performance.now() / 1000;
          this._combo = now - this._comboT < COMBO_GAP ? (this._combo + 1) % COMBO.length : 0;
          this._comboT = now;
          code = COMBO[this._combo];
        }
        input.virtualPress(code);
        navigator.vibrate?.(8);
      };
      const up = (e) => { e.preventDefault(); btn.classList.remove('down'); input.virtualRelease(code); };
      btn.addEventListener('pointerdown', down);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('pointerleave', up);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    root.querySelector('.t-pause').addEventListener('pointerdown', (e) => { e.preventDefault(); onPause?.(); });
    // Stop the page from scrolling or zooming under a thumb.
    root.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    return this;
  }

  show(v) {
    this.on = v;
    this.root?.classList.toggle('on', v);
    document.documentElement.classList.toggle('touch-mode', v);
    if (v) { this.rest?.(); window.addEventListener('resize', () => this.rest?.()); }
  }

  // Lights the Borrachera button when the crowd has paid for it.
  update(ready) {
    if (!this.on) return;
    this.special?.classList.toggle('ready', !!ready);
  }
}
