import { bus, EV } from '../core/events.js';

// The first bout teaches itself: one short tip at a time, each one cleared
// by doing the thing it asks for, so a new player is punching within the
// first seconds instead of reading a menu. Shown once, on the first bout.

export class Coach {
  constructor(root) {
    this.el = document.createElement('div');
    this.el.className = 'coach hide';
    this.el.setAttribute('role', 'status');
    root.append(this.el);
    this.active = false;
  }

  start(match, touch) {
    this.stop();
    this.match = match;
    this.active = true;
    this.hits = 0;
    this.drank = false;
    const P = () => match.player;
    this.steps = [
      { text: touch ? 'Arrastra el joystick hacia tu rival' : 'Acércate con W A S D', done: () => P().position.distanceTo(match.cpu.position) < 1.5 },
      { text: touch ? 'Toca GOLPE rápido varias veces: ¡combo!' : 'Pega con J K U I, seguido: ¡combo!', done: () => this.hits >= 3 },
      { text: touch ? 'Toca BEBER: más aguante... y más borracho' : 'Pulsa E para beber: más aguante... y más borracho', done: () => this.drank },
      { text: '¡Estámpalo contra las cuerdas y remata!', done: () => this.t > 6 }
    ];
    this.i = -1;
    this._offs = [
      bus.on(EV.HIT_LANDED, (p) => { if (p.attacker === P()) this.hits++; }),
      bus.on(EV.DRINK, (p) => { if (p.fighter === P()) this.drank = true; })
    ];
    this.next();
  }

  next() {
    this.i++;
    this.t = 0;
    if (this.i >= this.steps.length) { this.stop(); return; }
    this.el.textContent = this.steps[this.i].text;
    this.el.classList.remove('hide', 'ok');
    this.el.classList.remove('coach-in'); void this.el.offsetWidth; this.el.classList.add('coach-in');
  }

  update(dt) {
    if (!this.active || this.match.director.phase !== 'fight') return;
    this.t += dt;
    const step = this.steps[this.i];
    if (step && step.done()) {
      this.el.classList.add('ok');
      this.active = false;
      setTimeout(() => { if (this.steps) { this.active = true; this.next(); } }, 700);
    }
  }

  stop() {
    this.active = false;
    this.steps = null;
    this._offs?.forEach((o) => o());
    this._offs = null;
    this.el.classList.add('hide');
  }
}
