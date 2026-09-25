import { ROSTER } from '../characters/roster.js';
import { FIGHTERS, FIGHTER_BY_ID, OUTFITS, OUTFIT_BY_ID, DRINKS, DRINK_BY_ID } from '../meta/catalog.js';
import { LEVELS, CHAPTERS, MODS, levelByN } from '../meta/levels.js';
import { ACHIEVEMENTS } from '../meta/progress.js';

// Every menu outside the fight: home, locker room, shop, ladder, challenges,
// profile, settings and the payout after a bout. Built for a phone held
// upright first; wider screens get the same screens in a centred column.
//
// All DOM is built with h(), which only ever sets text through textContent
// and attributes through setAttribute on an allow-list, never innerHTML with
// data. Nothing a save file holds can become markup.

const SVGNS = 'http://www.w3.org/2000/svg';
const ALLOWED_ATTRS = new Set(['class', 'id', 'type', 'role', 'aria-label', 'aria-pressed', 'aria-selected', 'data-id', 'data-kind', 'data-tab', 'data-q', 'disabled', 'title', 'tabindex']);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'on') { for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn); continue; }
      if (k === 'style') { for (const [p, val] of Object.entries(v)) el.style.setProperty(p, String(val)); continue; }
      if (!ALLOWED_ATTRS.has(k)) continue;
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

const HEX = /^#[0-9a-f]{6}$/i;
const col = (c, d = '#888888') => (HEX.test(c || '') ? c : d);

function svg(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

// A bust drawn from the fighter's own colours: skin, hair style, beard and
// vest. Cheap, instant, and recognisable next to the 3D fighter.
export function avatar(spec, outfit, size = 64) {
  const s = { ...spec, ...(outfit || {}) };
  const el = svg('svg', { viewBox: '0 0 64 64', width: size, height: size, class: 'avatar', 'aria-hidden': 'true' });
  el.append(svg('circle', { cx: 32, cy: 32, r: 31, fill: '#16121c' }));
  // shoulders and vest
  el.append(svg('path', { d: 'M8 64 C10 46 20 40 32 40 C44 40 54 46 56 64 Z', fill: col(s.skin) }));
  el.append(svg('path', { d: 'M16 64 C17 50 24 44 32 44 C40 44 47 50 48 64 Z', fill: col(s.tank) }));
  el.append(svg('rect', { x: 27, y: 34, width: 10, height: 9, rx: 3, fill: col(s.skin) }));
  // head
  el.append(svg('ellipse', { cx: 32, cy: 25, rx: 11.5, ry: 13, fill: col(s.skin) }));
  const hair = col(s.hair, '#1b1410');
  if (s.hairStyle === 'afro') el.append(svg('ellipse', { cx: 32, cy: 16, rx: 15, ry: 11, fill: hair }));
  else if (s.hairStyle === 'short') el.append(svg('path', { d: 'M20.5 22 C21 12 28 9 32 9 C38 9 44 12 43.5 22 C40 17 35 16 32 16 C28 16 24 17 20.5 22 Z', fill: hair }));
  else if (s.hairStyle === 'buzz') el.append(svg('path', { d: 'M21 21 C22 14 27 11.5 32 11.5 C37 11.5 42 14 43 21 C39 17.5 35 17 32 17 C29 17 25 17.5 21 21 Z', fill: hair, opacity: 0.8 }));
  if (s.bun) el.append(svg('circle', { cx: 32, cy: 8.5, r: 4.5, fill: hair }));
  if (s.beard) el.append(svg('path', { d: 'M21.5 27 C22 36 27 39.5 32 39.5 C37 39.5 42 36 42.5 27 C40 32 36 33 32 33 C28 33 24 32 21.5 27 Z', fill: hair }));
  // eyes and brow line
  el.append(svg('rect', { x: 25, y: 23, width: 5, height: 2, rx: 1, fill: '#140c08' }));
  el.append(svg('rect', { x: 34, y: 23, width: 5, height: 2, rx: 1, fill: '#140c08' }));
  return el;
}

const specById = (id) => ROSTER.find((r) => r.id === id) || ROSTER[0];
const plain = (name) => String(name).replace(/\s*"[^"]*"\s*/g, ' ').replace(/\s+/g, ' ').trim();

function capIcon() {
  const el = svg('svg', { viewBox: '0 0 24 24', width: 18, height: 18, class: 'cap', 'aria-hidden': 'true' });
  el.append(svg('circle', { cx: 12, cy: 12, r: 10, fill: '#ffd33d', stroke: '#9a7a12', 'stroke-width': 2 }));
  el.append(svg('circle', { cx: 12, cy: 12, r: 5.5, fill: 'none', stroke: '#9a7a12', 'stroke-width': 1.6 }));
  return el;
}
const chapas = (n) => h('span', { class: 'price' }, capIcon(), ' ', n.toLocaleString('es-ES'));

function stars(n, max = 3) {
  return h('span', { class: 'stars', 'aria-label': `${n} de ${max} estrellas` },
    Array.from({ length: max }, (_, i) => h('i', { class: i < n ? 'on' : '' }, '★')));
}

function statBar(label, v) {
  return h('div', { class: 'stat' }, h('span', null, label),
    h('b', null, Array.from({ length: 5 }, (_, i) => h('i', { class: i < v ? 'on' : '' }))));
}

// ------------------------------------------------------------------ Menu ---
export class Menu {
  constructor(root, { progress, store, onPlay, onSettings, onClose }) {
    this.p = progress;
    this.store = store;
    this.onPlay = onPlay;
    this.onSettings = onSettings;
    this.onClose = onClose;
    this.el = h('div', { class: 'menu hide', role: 'dialog', 'aria-label': 'Menú' });
    root.append(this.el);
    this.stack = [];
    this.pre = { mode: 'quick', level: null, cpu: 'random', diff: 0.6 };
    store.onChange(() => this.refreshTop());
  }

  get open() { return !this.el.classList.contains('hide'); }
  show(screen = 'home', arg) { this.el.classList.remove('hide'); this.stack = []; this.go(screen, arg); }
  hide() { this.el.classList.add('hide'); this.el.replaceChildren(); }

  go(screen, arg, push = true) {
    if (push && this.cur) this.stack.push(this.cur);
    this.cur = { screen, arg };
    const body = this[screen](arg);
    this.el.replaceChildren(this.topBar(screen), h('div', { class: 'm-body' }, body));
    this.el.scrollTop = 0;
  }
  back() {
    const prev = this.stack.pop() || { screen: 'home' };
    this.go(prev.screen, prev.arg, false);
  }
  rerender() { if (this.cur) this.go(this.cur.screen, this.cur.arg, false); }

  topBar(screen) {
    const lv = this.p.level;
    const home = screen === 'home';
    this._top = h('div', { class: 'm-top' },
      home ? h('div', { class: 'm-rank' },
        h('b', null, `NV ${lv.lvl}`),
        h('span', null, lv.rank),
        h('i', { class: 'xp' }, h('u', { style: { width: `${Math.round((lv.into / lv.need) * 100)}%` } })))
        : h('button', { class: 'm-back', type: 'button', 'aria-label': 'Volver', on: { click: () => this.back() } }, '‹ VOLVER'),
      h('div', { class: 'm-wallet', 'aria-label': 'Chapas' }, chapas(this.store.chapas)));
    return this._top;
  }
  refreshTop() {
    const w = this._top?.querySelector('.m-wallet');
    if (w) w.replaceChildren(chapas(this.store.chapas));
  }

  toast(text, kind = '') {
    const t = h('div', { class: `m-toast ${kind}` }, text);
    this.el.append(t);
    setTimeout(() => t.classList.add('out'), 1600);
    setTimeout(() => t.remove(), 2100);
  }

  // ---------------------------------------------------------------- home ---
  home() {
    const s = this.store.data;
    const spec = specById(s.sel.fighter);
    const card = FIGHTER_BY_ID[s.sel.fighter];
    const daily = this.p.dailyList();
    const claimable = daily.filter((d) => d.done && !d.claimed).length;
    const streak = this.p.streakState();
    const next = LEVELS.find((l) => !s.levels[l.n] && this.p.isUnlocked(l.n)) || LEVELS[LEVELS.length - 1];

    const out = h('div', { class: 'm-home' },
      h('div', { class: 'm-hero' },
        avatar(spec, OUTFIT_BY_ID[s.sel.outfit]?.colors, 96),
        h('div', null, h('div', { class: 'm-eyebrow' }, 'TU LUCHADOR'), h('div', { class: 'm-name' }, plain(spec.name)),
          h('div', { class: 'm-nick' }, card?.nick || ''),
          h('button', { class: 'm-link', type: 'button', on: { click: () => this.go('locker', { mode: 'pick' }) } }, 'Cambiar ›'))),
      h('button', { class: 'm-play', type: 'button', on: { click: () => this.go('locker', { mode: 'level', level: next.n }) } },
        h('span', null, 'NIVEL ', next.n), h('b', null, next.title), h('small', null, 'Continuar la escalera')),
      h('div', { class: 'm-grid' },
        this.tile('PELEA RÁPIDA', 'Elige rival y dificultad', () => this.go('locker', { mode: 'quick' })),
        this.tile('NIVELES', `${this.p.totalStars}/${this.p.maxStars} ★`, () => this.go('levels')),
        this.tile('TIENDA', 'Luchadores, ropa, bebidas', () => this.go('shop', 'fighters')),
        this.tile('RETOS', claimable ? `${claimable} por cobrar` : 'Diarios y logros', () => this.go('challenges'), claimable),
        this.tile('PERFIL', 'Tus números', () => this.go('profile')),
        this.tile('AJUSTES', 'Sonido y calidad', () => this.go('settings'))));
    if (streak.can) {
      out.prepend(h('div', { class: 'm-streak' },
        h('div', null, h('b', null, `¡Día ${streak.day} seguido!`), h('span', null, 'Recompensa por volver al bar')),
        h('button', { class: 'm-btn gold', type: 'button', on: { click: () => {
          const n = this.p.claimStreak();
          if (n) this.toast(`+${n} chapas`, 'good');
          this.rerender();
        } } }, 'COBRAR ', chapas(streak.reward))));
    }
    if (this.store.tampered && !this._warnedTamper) {
      this._warnedTamper = true;
      out.prepend(h('div', { class: 'm-note' }, 'La partida guardada estaba modificada: se han restablecido las chapas. Tus luchadores y estrellas siguen ahí.'));
    }
    if (!this.store.persistent && !this._warnedStore) {
      this._warnedStore = true;
      out.prepend(h('div', { class: 'm-note' }, 'Este navegador no deja guardar datos: tu progreso durará hasta que cierres la página.'));
    }
    return out;
  }

  tile(title, sub, fn, badge) {
    return h('button', { class: 'm-tile', type: 'button', on: { click: fn } },
      h('b', null, title), h('span', null, sub), badge ? h('i', { class: 'm-badge' }, badge) : null);
  }

  // -------------------------------------------------------------- locker ---
  // Pick fighter, kit and drink. In 'quick' mode also the rival and how hard;
  // in 'level' mode the level sets the rival and the house rules.
  locker(arg = {}) {
    const s = this.store.data;
    const mode = arg.mode || 'quick';
    const level = mode === 'level' ? levelByN(arg.level) : null;
    if (level && !this.p.isUnlocked(level.n)) return h('div', { class: 'm-note' }, 'Supera el nivel anterior para desbloquear este.');

    const fighters = h('div', { class: 'm-row scroll' }, FIGHTERS.map((f) => {
      const owned = s.owned.fighters.includes(f.id);
      const sel = s.sel.fighter === f.id;
      return h('button', { class: `m-fcard ${sel ? 'sel' : ''} ${owned ? '' : 'locked'}`, type: 'button', 'aria-pressed': sel,
        on: { click: () => { if (owned) { this.p.select('fighter', f.id); this.rerender(); } else this.go('shop', 'fighters'); } } },
        avatar(specById(f.id), sel ? OUTFIT_BY_ID[s.sel.outfit]?.colors : null, 64),
        h('b', null, plain(specById(f.id).name).split(' ')[0]),
        owned ? h('span', null, f.nick) : chapas(f.price));
    }));
    const card = FIGHTER_BY_ID[s.sel.fighter];
    const stats = h('div', { class: 'm-stats' }, statBar('Fuerza', card.stats.pow), statBar('Velocidad', card.stats.spd), statBar('Aguante', card.stats.chin),
      h('p', { class: 'm-blurb' }, card.blurb));

    const outfits = h('div', { class: 'm-row scroll' }, OUTFITS.filter((o) => s.owned.outfits.includes(o.id)).map((o) =>
      h('button', { class: `m-chip ${s.sel.outfit === o.id ? 'sel' : ''}`, type: 'button', on: { click: () => { this.p.select('outfit', o.id); this.rerender(); } } },
        h('i', { class: 'sw', style: { background: `linear-gradient(135deg, ${col(o.swatch[0])} 50%, ${col(o.swatch[1])} 50%)` } }), o.name)),
      h('button', { class: 'm-chip ghost', type: 'button', on: { click: () => this.go('shop', 'outfits') } }, '+ Más ropa'));

    const inv = DRINKS.filter((d) => (s.drinks[d.id] || 0) > 0);
    const drinks = h('div', { class: 'm-row scroll' },
      inv.length ? inv.map((d) => h('button', { class: `m-chip ${s.sel.drink === d.id ? 'sel' : ''}`, type: 'button', title: d.desc,
        on: { click: () => { this.p.select('drink', d.id); this.rerender(); } } }, d.name, h('small', null, ` x${s.drinks[d.id]}`)))
        : h('span', { class: 'm-muted' }, 'No tienes bebidas.'),
      h('button', { class: 'm-chip ghost', type: 'button', on: { click: () => this.go('shop', 'drinks') } }, '+ Comprar'));

    let setup;
    if (level) {
      const rival = specById(level.cpu);
      setup = h('div', { class: 'm-vs' },
        h('div', { class: 'm-eyebrow' }, `NIVEL ${level.n} · ${CHAPTERS.find((c) => level.n >= c.from && level.n <= c.to)?.name || ''}`),
        h('div', { class: 'm-vsrow' }, avatar(rival, null, 56), h('div', null, h('b', null, level.title), h('span', null, `Rival: ${plain(rival.name)}`))),
        level.mods.length ? h('div', { class: 'm-mods' }, level.mods.map((m) => h('span', { class: 'mod', title: MODS[m].desc }, MODS[m].name, h('small', null, MODS[m].desc)))) : null,
        h('div', { class: 'm-muted' }, 'Premio al superarlo: ', chapas(level.reward)));
    } else if (mode === 'quick') {
      setup = h('div', { class: 'm-vs' },
        h('div', { class: 'm-eyebrow' }, 'RIVAL'),
        h('div', { class: 'm-row scroll' },
          h('button', { class: `m-chip ${this.pre.cpu === 'random' ? 'sel' : ''}`, type: 'button', on: { click: () => { this.pre.cpu = 'random'; this.rerender(); } } }, 'Al azar'),
          FIGHTERS.map((f) => h('button', { class: `m-chip ${this.pre.cpu === f.id ? 'sel' : ''}`, type: 'button', on: { click: () => { this.pre.cpu = f.id; this.rerender(); } } }, plain(specById(f.id).name).split(' ')[0]))),
        h('div', { class: 'm-eyebrow' }, 'DIFICULTAD'),
        h('div', { class: 'm-seg' }, [['Fácil', 0.35], ['Normal', 0.6], ['Difícil', 0.82]].map(([t, v]) =>
          h('button', { class: this.pre.diff === v ? 'sel' : '', type: 'button', on: { click: () => { this.pre.diff = v; this.rerender(); } } }, t))));
    }

    const fight = mode === 'pick' ? h('button', { class: 'm-play', type: 'button', on: { click: () => this.back() } }, h('b', null, 'LISTO'))
      : h('button', { class: 'm-play', type: 'button', on: { click: () => this.startFight(mode, level) } }, h('b', null, '¡A PELEAR!'));

    return h('div', { class: 'm-locker' },
      setup,
      h('div', { class: 'm-eyebrow' }, 'LUCHADOR'), fighters, stats,
      h('div', { class: 'm-eyebrow' }, 'ROPA'), outfits,
      mode !== 'pick' ? [h('div', { class: 'm-eyebrow' }, 'BEBIDA PARA EL COMBATE'), drinks] : null,
      fight);
  }

  startFight(mode, level) {
    const s = this.store.data;
    let cpu;
    if (level) cpu = level.cpu;
    else if (this.pre.cpu === 'random') { const pool = FIGHTERS.map((f) => f.id).filter((id) => id !== s.sel.fighter); cpu = pool[Math.floor(Math.random() * pool.length)]; }
    else cpu = this.pre.cpu;
    this.onPlay({ mode, level: level?.n ?? null, cpu, difficulty: level ? level.diff : this.pre.diff });
  }

  // ---------------------------------------------------------------- shop ---
  shop(tab = 'fighters') {
    const s = this.store.data;
    const tabs = h('div', { class: 'm-tabs', role: 'tablist' }, [['fighters', 'Luchadores'], ['outfits', 'Ropa'], ['drinks', 'Bebidas']].map(([id, t]) =>
      h('button', { class: tab === id ? 'sel' : '', type: 'button', role: 'tab', 'aria-selected': tab === id, on: { click: () => this.go('shop', id, false) } }, t)));
    const buy = (kind, id, price) => {
      if (this.store.chapas < price) { this.toast('No te llegan las chapas', 'bad'); return; }
      if (this.p.buy(kind, id)) { this.toast('¡Comprado!', 'good'); this.rerender(); } else this.toast('No se pudo comprar', 'bad');
    };
    let list;
    if (tab === 'fighters') {
      list = FIGHTERS.map((f) => {
        const owned = s.owned.fighters.includes(f.id), spec = specById(f.id);
        return h('div', { class: 'm-item' }, avatar(spec, null, 64),
          h('div', { class: 'm-item-t' }, h('b', null, plain(spec.name)), h('span', null, f.nick), h('p', null, f.blurb),
            h('div', { class: 'm-mini' }, statBar('FUE', f.stats.pow), statBar('VEL', f.stats.spd), statBar('AGU', f.stats.chin))),
          owned ? (s.sel.fighter === f.id ? h('span', { class: 'm-tag' }, 'ELEGIDO')
            : h('button', { class: 'm-btn', type: 'button', on: { click: () => { this.p.select('fighter', f.id); this.rerender(); } } }, 'ELEGIR'))
            : h('button', { class: `m-btn gold ${this.store.chapas < f.price ? 'poor' : ''}`, type: 'button', on: { click: () => buy('fighter', f.id, f.price) } }, chapas(f.price)));
      });
    } else if (tab === 'outfits') {
      const spec = specById(s.sel.fighter);
      list = OUTFITS.map((o) => {
        const owned = s.owned.outfits.includes(o.id);
        return h('div', { class: 'm-item' }, avatar(spec, o.colors, 64),
          h('div', { class: 'm-item-t' }, h('b', null, o.name), h('span', null, 'Se ve en cualquier luchador')),
          owned ? (s.sel.outfit === o.id ? h('span', { class: 'm-tag' }, 'PUESTO')
            : h('button', { class: 'm-btn', type: 'button', on: { click: () => { this.p.select('outfit', o.id); this.rerender(); } } }, 'PONER'))
            : h('button', { class: `m-btn gold ${this.store.chapas < o.price ? 'poor' : ''}`, type: 'button', on: { click: () => buy('outfit', o.id, o.price) } }, chapas(o.price)));
      });
    } else {
      list = DRINKS.map((d) => h('div', { class: 'm-item' },
        h('div', { class: 'm-drink', 'aria-hidden': 'true' }, h('i')),
        h('div', { class: 'm-item-t' }, h('b', null, d.name), h('p', null, d.desc), h('span', null, `Tienes ${s.drinks[d.id] || 0}`)),
        h('button', { class: `m-btn gold ${this.store.chapas < d.price ? 'poor' : ''}`, type: 'button', on: { click: () => buy('drink', d.id, d.price) } }, chapas(d.price))));
      list.unshift(h('p', { class: 'm-muted' }, 'Una bebida por combate. Elígela en el vestuario antes de pelear.'));
    }
    return h('div', { class: 'm-shop' }, h('h2', null, 'TIENDA'), tabs, h('div', { class: 'm-list' }, list),
      h('p', { class: 'm-muted small' }, 'Las chapas solo se ganan peleando. En este juego no se paga con dinero real.'));
  }

  // -------------------------------------------------------------- levels ---
  levels() {
    const s = this.store.data;
    return h('div', { class: 'm-levels' }, h('h2', null, 'LA ESCALERA'),
      h('p', { class: 'm-muted' }, `${this.p.totalStars} de ${this.p.maxStars} estrellas`),
      CHAPTERS.map((c) => h('section', null, h('h3', null, c.name),
        LEVELS.filter((l) => l.n >= c.from && l.n <= c.to).map((l) => {
          const open = this.p.isUnlocked(l.n), st = s.levels[l.n] || 0;
          return h('button', { class: `m-level ${open ? '' : 'locked'} ${st ? 'done' : ''}`, type: 'button', disabled: !open,
            on: { click: () => open && this.go('locker', { mode: 'level', level: l.n }) } },
            h('span', { class: 'm-lnum' }, open ? l.n : '🔒'),
            h('div', { class: 'm-ltxt' }, h('b', null, l.title), h('span', null, `vs ${plain(specById(l.cpu).name)}`),
              l.mods.length ? h('small', null, l.mods.map((m) => MODS[m].name).join(' · ')) : null),
            open ? stars(st) : h('small', null, 'Bloqueado'));
        }))));
  }

  // ---------------------------------------------------------- challenges ---
  challenges() {
    const s = this.store.data;
    const daily = this.p.dailyList();
    const now = new Date(), end = new Date(now); end.setHours(24, 0, 0, 0);
    const hrs = Math.max(0, Math.round((end - now) / 3600000));
    return h('div', { class: 'm-challenges' }, h('h2', null, 'RETOS DEL DÍA'),
      h('p', { class: 'm-muted' }, `Cambian en ${hrs} h`),
      daily.map((d) => h('div', { class: `m-ch ${d.done ? 'done' : ''}` },
        h('div', { class: 'm-ch-t' }, h('b', null, d.text), h('i', { class: 'bar' }, h('u', { style: { width: `${Math.round((d.prog / d.goal) * 100)}%` } })), h('span', null, `${d.prog} / ${d.goal}`)),
        d.claimed ? h('span', { class: 'm-tag' }, 'COBRADO')
          : h('button', { class: `m-btn ${d.done ? 'gold' : ''}`, type: 'button', disabled: !d.done, on: { click: () => {
            const n = this.p.claimDaily(d.id); if (n) { this.toast(`+${n} chapas`, 'good'); this.rerender(); }
          } } }, chapas(d.reward)))),
      h('h2', null, 'LOGROS'),
      ACHIEVEMENTS.map((a) => {
        const got = s.ach.includes(a.id);
        return h('div', { class: `m-ach ${got ? 'got' : ''}` }, h('i', null, got ? '🏆' : '·'),
          h('div', null, h('b', null, a.name), h('span', null, a.text)), chapas(a.reward));
      }));
  }

  // ------------------------------------------------------------- profile ---
  profile() {
    const s = this.store.data, st = s.stats, lv = this.p.level;
    const row = (k, v) => h('div', { class: 'm-kv' }, h('span', null, k), h('b', null, String(v)));
    return h('div', { class: 'm-profile' }, h('h2', null, 'PERFIL'),
      h('div', { class: 'm-hero' }, avatar(specById(s.sel.fighter), OUTFIT_BY_ID[s.sel.outfit]?.colors, 80),
        h('div', null, h('div', { class: 'm-name' }, lv.rank), h('div', { class: 'm-nick' }, `Nivel ${lv.lvl} · ${lv.into}/${lv.need} XP`))),
      row('Combates', st.matches), row('Victorias', st.wins), row('K.O.', st.kos), row('Derribos', st.knockdowns),
      row('Mejor combo', st.bestCombo), row('Golpes conectados', st.punches), row('Botellas rotas', st.bottles),
      row('Tragos', st.drinks), row('Borracheras', st.supers), row('Estrellas', `${this.p.totalStars}/${this.p.maxStars}`),
      row('Racha de días', s.streak.count));
  }

  // ------------------------------------------------------------ settings ---
  settings() {
    const g = this.store.data.settings;
    const toggle = (key, label) => h('button', { class: `m-toggle ${g[key] ? 'on' : ''}`, type: 'button', 'aria-pressed': !!g[key],
      on: { click: () => { g[key] = !g[key]; this.store.save(); this.onSettings?.(g); this.rerender(); } } }, h('span', null, label), h('i'));
    const q = [['auto', 'Auto'], ['low', 'Baja'], ['phone', 'Móvil'], ['medium', 'Media'], ['high', 'Alta']];
    let confirm = false;
    const resetBtn = h('button', { class: 'm-btn danger', type: 'button', on: { click: () => {
      if (!confirm) { confirm = true; resetBtn.textContent = '¿SEGURO? TOCA OTRA VEZ'; return; }
      this.store.reset(); this.toast('Progreso borrado'); this.show('home');
    } } }, 'BORRAR PROGRESO');
    return h('div', { class: 'm-settings' }, h('h2', null, 'AJUSTES'),
      toggle('music', 'Música'), toggle('sfx', 'Efectos de sonido'), toggle('vibrate', 'Vibración'),
      h('div', { class: 'm-eyebrow' }, 'CALIDAD GRÁFICA'),
      h('div', { class: 'm-seg' }, q.map(([id, t]) => h('button', { class: g.quality === id ? 'sel' : '', type: 'button',
        on: { click: () => { g.quality = id; this.store.save(); this.onSettings?.(g); this.rerender(); } } }, t))),
      h('p', { class: 'm-muted small' }, 'Tu progreso se guarda solo en este navegador. No se envía nada a ningún servidor.'),
      resetBtn);
  }

  // ------------------------------------------------------------- results ---
  // After a bout: the verdict, the stars, every line of the payout counted
  // up, the XP bar and whatever unlocked. arg = { won, score, settle, level }.
  results(arg) {
    const { won, score, settle, level } = arg;
    const lines = h('div', { class: 'm-lines' }, settle.lines.map((l, i) =>
      h('div', { class: 'm-line', style: { 'animation-delay': `${0.25 + i * 0.12}s` } }, h('span', null, l.label), h('b', null, '+', l.n))));
    const next = level && won ? levelByN(level + 1) : null;
    const lv = settle.lvl;
    return h('div', { class: `m-results ${won ? 'won' : 'lost'}` },
      h('div', { class: 'm-eyebrow' }, level ? `NIVEL ${level}` : 'PELEA RÁPIDA'),
      h('h1', null, won ? '¡HAS GANADO!' : 'HAS PERDIDO'),
      h('div', { class: 'm-score' }, score),
      level && won && settle.counts ? stars(settle.stars) : null,
      settle.counts ? null : h('p', { class: 'm-muted' }, 'El combate ha sido demasiado corto para dar premio.'),
      lines,
      h('div', { class: 'm-total' }, h('span', null, 'TOTAL'), chapas(settle.total + settle.levelUp)),
      settle.levelUp ? h('div', { class: 'm-levelup' }, `¡SUBES A NIVEL ${lv.lvl}! +${settle.levelUp}`) : null,
      h('div', { class: 'm-xp' }, h('span', null, `NV ${lv.lvl} · ${lv.rank}`), h('i', { class: 'xp' }, h('u', { style: { width: `${Math.round((lv.into / lv.need) * 100)}%` } }))),
      settle.achieved.map((a) => h('div', { class: 'm-unlock' }, '🏆 ', a.name, ' ', h('small', null, `+${a.reward}`))),
      h('div', { class: 'm-actions' },
        next && this.p.isUnlocked(next.n) ? h('button', { class: 'm-play', type: 'button', on: { click: () => this.go('locker', { mode: 'level', level: next.n }) } }, h('b', null, 'SIGUIENTE NIVEL')) : null,
        h('button', { class: next ? 'm-btn wide' : 'm-play', type: 'button', on: { click: () => this.onPlay({ ...arg.replay }) } }, next ? 'REPETIR' : h('b', null, 'REVANCHA')),
        h('button', { class: 'm-btn wide ghost', type: 'button', on: { click: () => this.show('home') } }, 'MENÚ')));
  }
}
