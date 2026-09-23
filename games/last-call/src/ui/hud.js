import { bus, EV } from '../core/events.js';
import { clamp01 } from '../core/math.js';

// DOM HUD. Kept in the DOM (not WebGL) so text stays razor sharp at any
// resolution and post FX never smears it.
export class HUD {
  constructor() { this.root = null; this.els = {}; }

  mount(root) {
    this.root = root;
    root.innerHTML = `
      <div class="hud" id="hud">
        <div class="bars">
          ${this.side('l', 'L')}
          <div class="gutter">
            <div class="timer" id="timer">99</div>
            <div class="round" id="round">Round 1 of 3</div>
            <div class="pips" id="pips"></div>
          </div>
          ${this.side('r', 'R')}
        </div>
        <div class="hype" id="hype">
          <div class="hype-track"><div class="hype-fill" id="hype-fill"></div></div>
          <div class="hype-label" id="hype-label">Crowd</div>
        </div>
        <div class="combo" id="combo"><div class="n">0</div><div class="w">Hit combo</div></div>
        <div class="announce" id="announce"></div>
        <div class="hints">
          <span><i class="key">WASD</i>Move</span>
          <span><i class="key">J</i>Jab</span>
          <span><i class="key">K</i>Cross</span>
          <span><i class="key">U</i>Hook</span>
          <span><i class="key">I</i>Upper</span>
          <span><i class="key">Space</i>Block</span>
          <span><i class="key">E</i>Drink</span>
        </div>
        <div class="perf" id="perf"></div>
      </div>
      <div class="screen" id="title">
        <div class="title">
          <h1>LAST CALL</h1>
          <div class="sub">Closing time brawl</div>
          <div class="cta">Click to fight</div>
          <div class="quality" id="quality">
            <span class="qlabel">Quality</span>
            <button data-q="auto" class="on">Auto</button>
            <button data-q="low">Low</button>
            <button data-q="medium">Medium</button>
            <button data-q="high">High</button>
            <button data-q="cinematic">Cinematic</button>
          </div>
          <div class="controls">
            <span><i class="key">WASD</i>Move</span><span><i class="key">Shift</i>Sprint</span>
            <span><i class="key">J</i>Jab</span><span><i class="key">K</i>Cross</span>
            <span><i class="key">U</i>Hook</span><span><i class="key">I</i>Uppercut</span>
            <span><i class="key">L</i>Kick</span><span><i class="key">Space</i>Block</span>
            <span><i class="key">C</i>Dodge</span><span><i class="key">G</i>Grab</span>
            <span><i class="key">E</i>Drink</span><span><i class="key">F</i>Borrachera</span>
          </div>
        </div>
      </div>
      <div class="toast" id="toast"></div>`;
    const $ = (id) => root.querySelector('#' + id);
    this.els = {
      hud: $('hud'), timer: $('timer'), round: $('round'), combo: $('combo'),
      announce: $('announce'), title: $('title'), perf: $('perf'),
      toast: $('toast'), quality: $('quality'),
      pips: $('pips'), hype: $('hype'), hypeFill: $('hype-fill'), hypeLabel: $('hype-label'),
      l: { hp: $('l-hp'), ghost: $('l-ghost'), st: $('l-st'), dk: $('l-dk'), name: $('l-name') },
      r: { hp: $('r-hp'), ghost: $('r-ghost'), st: $('r-st'), dk: $('r-dk'), name: $('r-name') }
    };

    bus.on(EV.COMBO, ({ count }) => this.showCombo(count));
    bus.on(EV.UI_STATE, (p) => { if (p?.announce) this.announce(p.announce); });
    bus.on(EV.PARRY, () => this.announce('Parry'));
    bus.on(EV.MATCH_END, ({ winner }) => this.announce(winner === 0 ? 'You win' : 'You lose'));
    bus.on(EV.KO, () => this.announce('K.O.'));
    bus.on(EV.ROUND_START, ({ round }) => { this.els.round.textContent = `Round ${round} of 3`; this.announce('Fight'); });
    return this;
  }

  side(id, cls) {
    return `<div class="side ${cls === 'R' ? 'right' : ''}">
      <div class="nameplate"><span class="flag"></span><span id="${id}-name">Fighter</span></div>
      <div class="track"><div class="ghost" id="${id}-ghost"></div><div class="fill hp" id="${id}-hp"></div></div>
      <div class="track small"><div class="fill st" id="${id}-st"></div></div>
      <div class="track small"><div class="fill dk" id="${id}-dk"></div></div>
      <div class="label">Stamina / Buzz</div>
    </div>`;
  }

  // Quality buttons live on the title card. They must not start the fight,
  // which the card itself does on click, so they stop the event here.
  onQualityPick(cb) {
    this.els.quality?.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', (e) => { e.stopPropagation(); cb(b.dataset.q); });
    });
  }

  setQuality(name, auto) {
    this.els.quality?.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', auto ? b.dataset.q === 'auto' : b.dataset.q === name);
    });
    if (this._qualityShown && this._qualityShown !== name && auto) {
      this.toast(`Quality lowered to ${name} to keep the frame rate up`);
    }
    this._qualityShown = name;
  }

  toast(text) {
    const t = this.els.toast;
    if (!t) return;
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  start() {
    this.els.title.classList.add('hide');
    this.els.hud.classList.add('on');
    // The control strip is a tutorial, not HUD. It earns its place for the
    // first few seconds and then gets out of the way of the fight.
    clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => this.root?.querySelector('.hints')?.classList.add('faded'), 11000);
  }

  announce(text) {
    const a = this.els.announce;
    a.textContent = text;
    a.classList.remove('show');
    void a.offsetWidth;
    a.classList.add('show');
  }

  showCombo(n) {
    const c = this.els.combo;
    c.querySelector('.n').textContent = n;
    c.classList.remove('pop');
    void c.offsetWidth;
    c.classList.add('pop');
    clearTimeout(this._ct);
    this._ct = setTimeout(() => c.classList.remove('pop'), 1600);
  }

  update(dt, s) {
    const set = (el, v) => { if (el) el.style.transform = `scaleX(${clamp01(v)})`; };
    for (const k of ['l', 'r']) {
      const f = s[k];
      if (!f) continue;
      const e = this.els[k];
      set(e.hp, f.health / 100);
      set(e.ghost, f.ghost / 100);
      set(e.st, f.stamina / 100);
      set(e.dk, f.drunk / 100);
      if (e.name.textContent !== f.name) e.name.textContent = f.name;
    }
    this.els.timer.textContent = String(Math.max(0, Math.ceil(s.clock))).padStart(2, '0');
    this.els.timer.classList.toggle('urgent', s.clock <= 20);

    // Crowd hype. Full means the Borrachera is available, which the label says
    // in words because a bar that is merely full says nothing on its own.
    const hype = clamp01((s.hype ?? 0) / 100);
    if (this.els.hypeFill) this.els.hypeFill.style.transform = `scaleX(${hype})`;
    const ready = hype >= 1;
    if (this.els.hype) this.els.hype.classList.toggle('ready', ready);
    if (this.els.hypeLabel) {
      const want = ready ? 'Borrachera ready  F' : s.lastCall ? 'Last call' : 'Crowd';
      if (this.els.hypeLabel.textContent !== want) this.els.hypeLabel.textContent = want;
    }

    if (this.els.pips && s.wins) {
      const key = s.wins.join('/') + ':' + s.round;
      if (this._pipKey !== key) {
        this._pipKey = key;
        this.els.pips.innerHTML = [0, 1].map((side) =>
          `<span class="pipset ${side ? 'r' : 'l'}">` +
          [0, 1].map((i) => `<i class="pip${s.wins[side] > i ? ' on' : ''}"></i>`).join('') +
          '</span>').join('');
      }
    }
    if (s.fps !== undefined) this.els.perf.textContent = `${s.fps.toFixed(0)} FPS  ${s.tris ?? ''}`;
  }
}
