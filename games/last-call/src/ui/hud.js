import * as THREE from 'three';
import { bus, EV } from '../core/events.js';
import { clamp01 } from '../core/math.js';
import { rng } from '../core/rng.js';

// The HUD, in the language the player speaks. DOM rather than WebGL so text
// stays sharp at any size and the post stack never smears it.
//
// Layout, top to bottom: two fighter cards with the clock between them;
// comic-book words that pop out of the fight where things happen; the crowd
// meter at the bottom centre. Full-screen layers for banners, pause and the
// result sit above everything.

const TIERS = [
  { max: 25, label: 'SOBRIO', color: '#9fe8ff' },
  { max: 50, label: 'ALEGRE', color: '#ffd35a' },
  { max: 72, label: 'PEDO', color: '#ffa53d' },
  { max: 90, label: 'CIEGO', color: '#ff5a3d' },
  { max: 101, label: 'KO ETÍLICO', color: '#ff2a6d' }
];
const tierOf = (d) => TIERS.find((t) => d < t.max) || TIERS[TIERS.length - 1];

const WORDS = {
  light: ['¡PAF!', '¡ZAS!', '¡PLAF!', '¡TOC!'],
  mid: ['¡PUM!', '¡CRACK!', '¡ZASCA!', '¡PLOF!'],
  heavy: ['¡CATAPUM!', '¡BOOM!', '¡KAPOW!', '¡BADABUM!']
};

const initials = (name) => name.replace(/"[^"]*"/g, ' ').split(/\s+/).filter(Boolean)
  .map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const nickname = (name) => (name.match(/"([^"]+)"/) || [])[1] || '';
const plainName = (name) => name.replace(/"[^"]*"/g, '').replace(/\s+/g, ' ').trim();

const _v = new THREE.Vector3();

// Font sizes of the pop classes in hud.css, for stacking without a layout read.
const POP_EM = { s: 22, m: 34, l: 48, xl: 68 };

export class HUD {
  constructor() { this.root = null; this.els = {}; this.paused = false; this._pops = []; }

  mount(root) {
    this.root = root;
    root.innerHTML = `
      <div class="hud" id="hud">
        <div class="top">
          ${this.card('l')}
          <div class="centre">
            <div class="clock"><span id="timer">99</span></div>
            <div class="round" id="round">ASALTO 1</div>
            <div class="pips" id="pips"></div>
          </div>
          ${this.card('r')}
        </div>
        <div class="combo l" id="combo-l"><b>0</b><span>golpes</span></div>
        <div class="combo r" id="combo-r"><b>0</b><span>golpes</span></div>
        <div class="pops" id="pops"></div>
        <div class="crowd" id="hype">
          <div class="crowd-label" id="hype-label">AMBIENTE</div>
          <div class="crowd-track"><div class="crowd-fill" id="hype-fill"></div></div>
        </div>
        <div class="hints" id="hints">
          <span><i class="key">WASD</i>moverse</span><span><i class="key">J K U I</i>puños</span>
          <span><i class="key">L</i>patada</span><span><i class="key">Espacio</i>bloquear</span>
          <span><i class="key">E</i>beber</span><span><i class="key">F</i>borrachera</span>
          <span><i class="key">Esc</i>pausa</span>
        </div>
        <div class="perf" id="perf"></div>
      </div>
      <div class="banner" id="banner"><div class="b-main"></div><div class="b-sub"></div></div>
      <div class="overlay hide" id="pause">
        <div class="panel">
          <h2>PAUSA</h2>
          <button id="resume" class="big">Seguir peleando</button>
          <div class="controls-grid">
            <span><i class="key">W A S D</i>Moverse</span><span><i class="key">Shift</i>Correr</span>
            <span><i class="key">J</i>Directo</span><span><i class="key">K</i>Cruzado</span>
            <span><i class="key">U</i>Gancho</span><span><i class="key">I</i>Uppercut</span>
            <span><i class="key">L</i>Patada</span><span><i class="key">Espacio</i>Bloquear</span>
            <span><i class="key">C</i>Esquivar</span><span><i class="key">G</i>Agarrar</span>
            <span><i class="key">E</i>Beber</span><span><i class="key">F</i>Borrachera</span>
          </div>
          <p class="tip">Beber te da fuerza y aguante, pero cuanto más bebes menos te tienes en pie.</p>
        </div>
      </div>
      <div class="overlay hide" id="result">
        <div class="panel">
          <div class="r-eyebrow">FIN DEL COMBATE</div>
          <h2 id="result-title">GANADOR</h2>
          <div class="r-score" id="result-score">2 - 0</div>
          <button id="again" class="big">Revancha</button>
        </div>
      </div>
      <div class="screen" id="title">
        <div class="title">
          <div class="eyebrow">EL GARITO · 03:47</div>
          <h1>LAST CALL</h1>
          <div class="sub">Pelea de bar a la hora de cierre</div>
          <div class="cta">Haz clic para pelear</div>
          <div class="quality" id="quality">
            <span class="qlabel">Calidad</span>
            <button data-q="auto" class="on">Auto</button>
            <button data-q="low">Baja</button>
            <button data-q="medium">Media</button>
            <button data-q="high">Alta</button>
            <button data-q="cinematic">Cine</button>
          </div>
          <div class="controls">
            <span><i class="key">WASD</i>Moverse</span><span><i class="key">J K U I</i>Puños</span>
            <span><i class="key">L</i>Patada</span><span><i class="key">Espacio</i>Bloquear</span>
            <span><i class="key">E</i>Beber</span><span><i class="key">F</i>Borrachera</span>
          </div>
        </div>
      </div>
      <div class="toast" id="toast"></div>`;

    const $ = (id) => root.querySelector('#' + id);
    const side = (k) => ({
      card: $(`${k}-card`), hp: $(`${k}-hp`), ghost: $(`${k}-ghost`), st: $(`${k}-st`),
      beer: $(`${k}-beer`), foam: $(`${k}-foam`), tier: $(`${k}-tier`), name: $(`${k}-name`),
      nick: $(`${k}-nick`), badge: $(`${k}-badge`), combo: $(`combo-${k}`)
    });
    this.els = {
      hud: $('hud'), top: this.root.querySelector('.top'), timer: $('timer'), round: $('round'), pips: $('pips'), pops: $('pops'),
      banner: $('banner'), title: $('title'), perf: $('perf'), hints: $('hints'),
      hypeFill: $('hype-fill'), hypeLabel: $('hype-label'), hype: $('hype'),
      toast: $('toast'), quality: $('quality'), pause: $('pause'), result: $('result'),
      resultTitle: $('result-title'), resultScore: $('result-score'),
      l: side('l'), r: side('r')
    };

    $('resume').addEventListener('click', () => this.setPaused(false));
    $('again').addEventListener('click', () => location.reload());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this._started && !this._over) this.setPaused(!this.paused);
    });

    this.wire();
    return this;
  }

  card(k) {
    return `<div class="card ${k}" id="${k}-card">
      <div class="badge" id="${k}-badge">??</div>
      <div class="info">
        <div class="names"><span class="name" id="${k}-name">Luchador</span><span class="nick" id="${k}-nick"></span></div>
        <div class="bar hp"><div class="ghost" id="${k}-ghost"></div><div class="fill" id="${k}-hp"></div><div class="ticks"></div></div>
        <div class="bar st"><div class="fill" id="${k}-st"></div></div>
      </div>
      <div class="beer">
        <svg viewBox="0 0 40 56" aria-hidden="true">
          <defs><clipPath id="${k}-glass"><path d="M6 4 L34 4 L31 52 Q20 55 9 52 Z"/></clipPath></defs>
          <g clip-path="url(#${k}-glass)">
            <rect x="0" y="0" width="40" height="56" fill="rgba(255,255,255,0.06)"/>
            <rect id="${k}-beer" x="0" y="56" width="40" height="56" fill="#f0a91e"/>
            <rect id="${k}-foam" x="0" y="52" width="40" height="5" fill="#fff6dc"/>
          </g>
          <path d="M6 4 L34 4 L31 52 Q20 55 9 52 Z" fill="none" stroke="rgba(255,255,255,0.7)" stroke-width="1.6"/>
        </svg>
        <div class="tier" id="${k}-tier">SOBRIO</div>
      </div>
    </div>`;
  }

  // World hookup: the camera to project with and the match to find bodies in.
  bindWorld(camera, match) { this.camera = camera; this.match = match; }

  sideOf(f) { return this.match && f === this.match.cpu ? 'r' : 'l'; }

  headPoint(f, out) {
    if (f?.ragdoll?.built) {
      const p = f.ragdoll.head.body.position;
      return out.set(p.x, p.y + 0.35, p.z);
    }
    return out.copy(f.position).setY(2.1);
  }

  wire() {
    bus.on(EV.HIT_LANDED, (p) => {
      const d = p.damage || 0;
      const set = d >= 12 ? WORDS.heavy : d >= 7 ? WORDS.mid : WORDS.light;
      const at = p.point ? _v.set(p.point.x, p.point.y + 0.25, p.point.z) : this.headPoint(p.target, _v);
      // A counter says so in place of the sound word, so one hit is one word.
      const word = p.counter ? '¡CONTRA!' : rng.pick(set);
      const colour = p.counter ? '#7df9ff' : d >= 12 ? '#ffd33d' : '#ffffff';
      this.pop(word, at, d >= 12 ? 'xl' : d >= 7 ? 'l' : 'm', colour);
      this.pop(`-${Math.round(d)}`, _v.set(at.x, at.y - 0.3, at.z), 's', '#ff5a6e');
    });
    bus.on(EV.HIT_BLOCKED, (p) => this.pop('bloqueo', this.headPoint(p.target, _v), 's', '#9fb4d8'));
    bus.on(EV.PARRY, (p) => p?.fighter && this.pop('¡PARADA!', this.headPoint(p.fighter, _v), 'l', '#7df9ff'));
    bus.on(EV.KNOCKDOWN, (p) => {
      if (p.fighter) this.pop('¡AL SUELO!', this.headPoint(p.fighter, _v), 'xl', '#ff7a3d');
    });
    bus.on('brawl:hiccup', (p) => this.pop('¡HIC!', this.headPoint(p.fighter, _v), 'm', '#ffd35a'));
    bus.on('brawl:fell', (p) => this.pop('¡SE CAYÓ SOLO!', this.headPoint(p.fighter, _v), 'l', '#ffa53d'));
    bus.on('brawl:launch', (p) => this.pop('¡A VOLAR!', this.headPoint(p.fighter, _v), 'l', '#ff2a6d'));
    bus.on(EV.DRINK, (p) => p?.fighter && this.pop('¡GLUP GLUP!', this.headPoint(p.fighter, _v), 'm', '#f0a91e'));
    bus.on(EV.COMBO, ({ fighter, count }) => this.showCombo(this.sideOf(fighter), count));
    bus.on(EV.KO, () => this.announce('K.O.', '¡fuera de combate!', 'ko'));
    bus.on(EV.ROUND_START, ({ round }) => {
      this.els.round.textContent = `ASALTO ${round}`;
      this.announce(`ASALTO ${round}`, '¡a pelear!');
    });
    bus.on(EV.UI_STATE, (p) => {
      if (!p?.announce) return;
      const map = { 'LAST CALL': ['ÚLTIMA RONDA', 'todos beben'], 'GUARD BREAK': ['¡GUARDIA ROTA!', ''], COUNTER: null };
      const m = map[p.announce];
      if (m === null) return;
      if (m) this.announce(m[0], m[1]); else this.announce(p.announce, '');
    });
    bus.on(EV.MATCH_END, ({ winner, wins }) => {
      this._over = true;
      const w = winner === 0 ? this.match?.player : this.match?.cpu;
      setTimeout(() => {
        this.els.resultTitle.textContent = winner === 0 ? '¡HAS GANADO!' : 'HAS PERDIDO';
        this.els.resultScore.textContent = `${plainName(w?.spec?.name || '')} · ${wins[0]} - ${wins[1]}`;
        this.els.result.classList.remove('hide');
      }, 2600);
    });
  }

  // A comic-book word at a point in the world. Pooled, so a flurry of hits
  // never builds up DOM.
  pop(text, world, size = 'm', color = '#fff') {
    if (!this.camera || !this._started) return;
    let el = this._pops.find((e) => !e._live);
    if (!el) {
      if (this._pops.length > 28) return;
      el = document.createElement('div');
      el.className = 'pop';
      this.els.pops.appendChild(el);
      this._pops.push(el);
    }
    el._live = true;
    el._world = new THREE.Vector3(world.x, world.y, world.z);
    el._t = 0;
    el._tilt = rng.range(-12, 12);
    el._born = this._popSeq = (this._popSeq || 0) + 1;
    el.textContent = text;
    el.dataset.size = size;
    el.style.color = color;
    el.style.opacity = '1';
    el.style.display = 'block';
  }

  updatePops(dt) {
    if (!this.camera) return;
    const w = window.innerWidth, h = window.innerHeight;
    // Keep words under the scoreboard: nothing may cover a health bar.
    if (!this._topBottom || this._topW !== w) {
      this._topW = w;
      this._topBottom = this.els.top ? this.els.top.getBoundingClientRect().bottom : 90;
    }
    const floor = this._topBottom + 36;
    // Project every live word, then settle them oldest first: a newer word
    // that lands on an older one climbs above it (or drops below it when the
    // scoreboard is in the way), so a flurry reads as a stack, never a smudge.
    const live = [];
    for (const el of this._pops) {
      if (!el._live) continue;
      el._t += dt;
      const life = 1.05;
      if (el._t >= life) { el._live = false; el.style.display = 'none'; continue; }
      _v.copy(el._world);
      _v.y += el._t * 0.5;
      _v.project(this.camera);
      if (_v.z > 1) { el.style.display = 'none'; continue; }
      const em = POP_EM[el.dataset.size] || 34;
      const k = el._t / life;
      const scale = k < 0.12 ? 0.4 + (k / 0.12) * 0.9 : 1.3 - Math.min(0.3, (k - 0.12) * 0.8);
      const hw = Math.min(w * 0.45, el.textContent.length * em * 0.3 * scale) + 6;
      const hh = em * 0.65 * scale;
      el.style.display = 'block';
      live.push({ el, k, scale, hw, hh,
        x: Math.min(w - hw, Math.max(hw, (_v.x * 0.5 + 0.5) * w)),
        y: Math.max(floor, (-_v.y * 0.5 + 0.5) * h) });
    }
    live.sort((p, q) => p.el._born - q.el._born);
    for (let i = 0; i < live.length; i++) {
      const me = live[i];
      for (let pass = 0; pass < 6; pass++) {
        let hit = null;
        for (let j = 0; j < i; j++) {
          const o = live[j];
          if (Math.abs(o.x - me.x) < o.hw + me.hw && Math.abs(o.y - me.y) < o.hh + me.hh) { hit = o; break; }
        }
        if (!hit) break;
        const up = hit.y - hit.hh - me.hh - 2;
        me.y = up >= floor ? up : hit.y + hit.hh + me.hh + 2;
      }
      const { el, k, scale, x, y } = me;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) rotate(${el._tilt}deg) scale(${scale.toFixed(3)})`;
      el.style.opacity = k > 0.72 ? String(1 - (k - 0.72) / 0.28) : '1';
    }
  }

  onQualityPick(cb) {
    this.els.quality?.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', (e) => { e.stopPropagation(); cb(b.dataset.q); });
    });
  }

  setQuality(name, auto) {
    this.els.quality?.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', auto ? b.dataset.q === 'auto' : b.dataset.q === name);
    });
    if (this._qualityShown && this._qualityShown !== name && auto) this.toast(`Calidad bajada a ${name} para mantener la fluidez`);
    this._qualityShown = name;
  }

  setPaused(on) {
    this.paused = on;
    this.els.pause.classList.toggle('hide', !on);
    if (on) document.exitPointerLock?.();
  }

  toast(text) {
    const t = this.els.toast;
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  start() {
    this._started = true;
    this.els.title.classList.add('hide');
    this.els.hud.classList.add('on');
    clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => this.els.hints.classList.add('faded'), 12000);
  }

  announce(main, sub = '', kind = '') {
    const b = this.els.banner;
    b.querySelector('.b-main').textContent = main;
    b.querySelector('.b-sub').textContent = sub;
    b.className = 'banner ' + kind;
    void b.offsetWidth;
    b.classList.add('show');
  }

  showCombo(k, n) {
    const c = this.els[k]?.combo;
    if (!c || n < 2) return;
    c.querySelector('b').textContent = n;
    c.classList.remove('pop');
    void c.offsetWidth;
    c.classList.add('pop');
    clearTimeout(c._t);
    c._t = setTimeout(() => c.classList.remove('pop'), 1500);
  }

  update(dt, s) {
    this.updatePops(dt);
    for (const k of ['l', 'r']) {
      const f = s[k];
      if (!f) continue;
      const e = this.els[k];
      e.hp.style.transform = `scaleX(${clamp01(f.health / 100)})`;
      e.ghost.style.transform = `scaleX(${clamp01(f.ghost / 100)})`;
      e.st.style.transform = `scaleX(${clamp01(f.stamina / 100)})`;
      e.card.classList.toggle('low', f.health < 25);
      const d = clamp01(f.drunk / 100);
      const y = 56 - d * 50;
      e.beer.setAttribute('y', y.toFixed(1));
      e.foam.setAttribute('y', (y - 3.5).toFixed(1));
      const tier = tierOf(f.drunk);
      if (e.tier.textContent !== tier.label) { e.tier.textContent = tier.label; e.tier.style.color = tier.color; }
      if (e._name !== f.name) {
        e._name = f.name;
        e.name.textContent = plainName(f.name);
        e.nick.textContent = nickname(f.name);
        e.badge.textContent = initials(f.name);
        if (f.accent) e.card.style.setProperty('--accent', f.accent);
      }
    }
    this.els.timer.textContent = String(Math.max(0, Math.ceil(s.clock))).padStart(2, '0');
    this.els.timer.parentElement.classList.toggle('urgent', s.clock <= 20);

    const hype = clamp01((s.hype ?? 0) / 100);
    this.els.hypeFill.style.transform = `scaleX(${hype})`;
    const ready = hype >= 1;
    this.els.hype.classList.toggle('ready', ready);
    const label = ready ? '¡BORRACHERA LISTA! PULSA F' : s.lastCall ? 'ÚLTIMA RONDA' : 'AMBIENTE';
    if (this.els.hypeLabel.textContent !== label) this.els.hypeLabel.textContent = label;

    if (s.wins) {
      const key = s.wins.join('/');
      if (this._pipKey !== key) {
        this._pipKey = key;
        this.els.pips.innerHTML = [0, 1].map((side) => `<span class="pipset">` +
          [0, 1].map((i) => `<i class="pip${s.wins[side] > i ? ' on' : ''}"></i>`).join('') + '</span>').join('');
      }
    }
    if (s.fps !== undefined && this._debug) this.els.perf.textContent = `${s.fps.toFixed(0)} FPS`;
  }
}
