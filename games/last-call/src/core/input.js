import { clamp } from './math.js';

// Keyboard + mouse + gamepad folded into one intent struct. Gameplay code
// never touches a key code; it reads 'input.state'.
const DEFAULT_BINDS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  jab: ['KeyJ'],
  cross: ['KeyK'],
  hook: ['KeyU'],
  uppercut: ['KeyI'],
  kick: ['KeyL'],
  block: ['Space'],
  dodge: ['KeyC', 'ControlLeft'],
  grapple: ['KeyG'],
  drink: ['KeyE'],
  taunt: ['KeyT'],
  special: ['KeyF'],
  pause: ['Escape'],
  photo: ['KeyP']
};

class Input {
  constructor() {
    this.binds = DEFAULT_BINDS;
    this.keys = new Set();
    this.pressedThisFrame = new Set();
    this.releasedThisFrame = new Set();
    this.mouse = { dx: 0, dy: 0, buttons: 0, locked: false, wheel: 0 };
    this.state = {
      moveX: 0, moveY: 0, lookX: 0, lookY: 0,
      sprint: false, block: false,
      magnitude: 0
    };
    this.gamepadIndex = null;
    this._buffer = []; // {action, t} attack buffer for combo windows
    this.bufferWindow = 0.28;
    this.enabled = true;
  }

  attach(el = window) {
    this._onKeyDown = (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressedThisFrame.add(e.code);
      const act = this.actionFor(e.code);
      if (act) this._buffer.push({ action: act, t: performance.now() / 1000 });
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
    };
    this._onKeyUp = (e) => { this.keys.delete(e.code); this.releasedThisFrame.add(e.code); };
    this._onMove = (e) => {
      if (!this.mouse.locked) return;
      this.mouse.dx += e.movementX || 0;
      this.mouse.dy += e.movementY || 0;
    };
    this._onDown = (e) => {
      this.mouse.buttons |= 1 << e.button;
      const act = e.button === 0 ? 'jab' : e.button === 2 ? 'block' : 'hook';
      this._buffer.push({ action: act, t: performance.now() / 1000 });
    };
    this._onUp = (e) => { this.mouse.buttons &= ~(1 << e.button); };
    this._onWheel = (e) => { this.mouse.wheel += Math.sign(e.deltaY); };
    this._onLock = () => { this.mouse.locked = document.pointerLockElement != null; };
    this._onBlur = () => { this.keys.clear(); this.mouse.buttons = 0; };

    window.addEventListener('keydown', this._onKeyDown, { passive: false });
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMove);
    window.addEventListener('mousedown', this._onDown);
    window.addEventListener('mouseup', this._onUp);
    window.addEventListener('wheel', this._onWheel, { passive: true });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', this._onLock);
    window.addEventListener('blur', this._onBlur);
    return this;
  }

  requestLock(el) {
    try { const r = el?.requestPointerLock?.(); r?.catch?.(() => {}); } catch { /* refused */ }
  }

  actionFor(code) {
    for (const [action, codes] of Object.entries(this.binds)) {
      if (codes.includes(code)) return action;
    }
    return null;
  }

  down(action) {
    const codes = this.binds[action];
    if (!codes) return false;
    return codes.some((c) => this.keys.has(c));
  }

  pressed(action) {
    const codes = this.binds[action];
    if (!codes) return false;
    return codes.some((c) => this.pressedThisFrame.has(c));
  }

  // Attack buffering: a press inside the window still counts once the
  // previous animation frees up. This is what makes combos feel responsive.
  consumeBuffered(actions, now) {
    for (let i = 0; i < this._buffer.length; i++) {
      const b = this._buffer[i];
      if (now - b.t > this.bufferWindow) continue;
      if (actions.includes(b.action)) { this._buffer.splice(i, 1); return b.action; }
    }
    return null;
  }

  clearBuffer() { this._buffer.length = 0; }

  update(dt) {
    const s = this.state;
    let mx = 0, my = 0;
    if (this.down('left')) mx -= 1;
    if (this.down('right')) mx += 1;
    if (this.down('forward')) my += 1;
    if (this.down('back')) my -= 1;

    // Gamepad overrides when a stick is actually pushed.
    const pads = navigator.getGamepads?.() || [];
    const pad = pads[this.gamepadIndex ?? 0];
    if (pad) {
      const dz = (v) => (Math.abs(v) < 0.18 ? 0 : (v - Math.sign(v) * 0.18) / 0.82);
      const gx = dz(pad.axes[0] || 0), gy = -dz(pad.axes[1] || 0);
      if (gx || gy) { mx = gx; my = gy; }
      s.lookX = dz(pad.axes[2] || 0) * 2.6;
      s.lookY = dz(pad.axes[3] || 0) * 2.0;
      if (pad.buttons[0]?.pressed) this._buffer.push({ action: 'jab', t: performance.now() / 1000 });
      if (pad.buttons[2]?.pressed) this._buffer.push({ action: 'hook', t: performance.now() / 1000 });
      s.block = pad.buttons[6]?.value > 0.4 || this.down('block');
      s.sprint = pad.buttons[10]?.pressed || this.down('sprint');
    } else {
      s.lookX = this.mouse.dx * 0.0022;
      s.lookY = this.mouse.dy * 0.0019;
      s.block = this.down('block') || (this.mouse.buttons & 2) !== 0;
      s.sprint = this.down('sprint');
    }

    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    s.moveX = mx; s.moveY = my;
    s.magnitude = clamp(Math.hypot(mx, my), 0, 1);

    this.mouse.dx = 0; this.mouse.dy = 0;
    const now = performance.now() / 1000;
    this._buffer = this._buffer.filter((b) => now - b.t <= this.bufferWindow);
  }

  lateUpdate() {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.mouse.wheel = 0;
  }
}

export const input = new Input();
