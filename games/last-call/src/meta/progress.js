import { bus, EV } from '../core/events.js';
import { FIGHTER_BY_ID, OUTFIT_BY_ID, DRINK_BY_ID, FIGHTERS } from './catalog.js';
import { levelByN, starsFor, LEVEL_COUNT } from './levels.js';

// Progression: what a bout pays, XP and rank, daily challenges, the login
// streak, achievements and the shop's buy and equip rules. Everything that
// changes the save goes through here, and every payout is computed from what
// the match actually recorded, with caps, so no single bout can mint a
// fortune and a bout abandoned early pays nothing.

export const RANKS = ['Novato', 'Parroquiano', 'Habitual', 'Camorrista', 'Matón de barra', 'Leyenda del garito'];

// XP needed to go from level n to n+1.
export const xpForLevel = (n) => 220 + n * 140;

export function levelFromXp(xp) {
  let lvl = 1, left = xp;
  while (left >= xpForLevel(lvl) && lvl < 99) { left -= xpForLevel(lvl); lvl++; }
  return { lvl, into: left, need: xpForLevel(lvl), rank: RANKS[Math.min(RANKS.length - 1, Math.floor((lvl - 1) / 4))] };
}

// ---------------------------------------------------------------- dates ---
export function today(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dayDiff(a, b) {
  const pa = Date.parse(a + 'T12:00:00'), pb = Date.parse(b + 'T12:00:00');
  return Math.round((pb - pa) / 86400000);
}

// ------------------------------------------------------------ challenges ---
export const CHALLENGES = [
  { id: 'golpes', text: 'Conecta 40 golpes', goal: 40, reward: 90, stat: 'punches' },
  { id: 'kos', text: 'Gana 2 combates por K.O.', goal: 2, reward: 140, stat: 'kos' },
  { id: 'victorias', text: 'Gana 2 combates', goal: 2, reward: 120, stat: 'wins' },
  { id: 'botellas', text: 'Rompe 6 botellas', goal: 6, reward: 100, stat: 'bottles' },
  { id: 'tragos', text: 'Bebe 8 veces', goal: 8, reward: 80, stat: 'drinks' },
  { id: 'combo', text: 'Haz un combo de 5', goal: 5, reward: 110, stat: 'combo', best: true },
  { id: 'borrachera', text: 'Usa la Borrachera', goal: 1, reward: 100, stat: 'supers' },
  { id: 'cuerdas', text: 'Estampa al rival contra las cuerdas 5 veces', goal: 5, reward: 100, stat: 'ropes' },
  { id: 'solito', text: 'Haz que el rival se caiga solo 2 veces', goal: 2, reward: 120, stat: 'selfFalls' },
  { id: 'upper', text: 'Conecta 10 uppercuts', goal: 10, reward: 90, stat: 'uppers' },
  { id: 'derribos', text: 'Derriba al rival 4 veces', goal: 4, reward: 110, stat: 'knockdowns' }
];
const CH_BY_ID = Object.create(null);
for (const c of CHALLENGES) CH_BY_ID[c.id] = c;

// Three challenges per calendar day, picked from the date so everyone who
// plays on the same day gets the same three.
function pickDaily(date) {
  let h = 2166136261;
  for (const c of date) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const pool = CHALLENGES.map((c) => c.id);
  const out = [];
  while (out.length < 3) {
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    const id = pool.splice(h % pool.length, 1)[0];
    out.push(id);
  }
  return out;
}

export const STREAK_REWARDS = [50, 75, 100, 125, 150, 200, 300];

// ---------------------------------------------------------- achievements ---
export const ACHIEVEMENTS = [
  { id: 'primera', name: 'Bautizo', text: 'Gana tu primer combate', reward: 100, test: (s) => s.stats.wins >= 1 },
  { id: 'diez', name: 'Cliente fijo', text: 'Juega 10 combates', reward: 150, test: (s) => s.stats.matches >= 10 },
  { id: 'kos10', name: 'Apagaluces', text: 'Consigue 10 K.O.', reward: 250, test: (s) => s.stats.kos >= 10 },
  { id: 'botellero', name: 'Botellero', text: 'Rompe 50 botellas', reward: 250, test: (s) => s.stats.bottles >= 50 },
  { id: 'combo8', name: 'Metralleta', text: 'Haz un combo de 8', reward: 200, test: (s) => s.stats.bestCombo >= 8 },
  { id: 'coleccion', name: 'Toda la plantilla', text: 'Consigue a los 6 luchadores', reward: 500, test: (s) => s.owned.fighters.length >= FIGHTERS.length },
  { id: 'bodega', name: 'Rey de la bodega', text: 'Supera el nivel 8', reward: 400, test: (s) => (s.levels[8] || 0) > 0 },
  { id: 'escalera', name: 'El último trago', text: 'Supera el nivel 12', reward: 1000, test: (s) => (s.levels[12] || 0) > 0 },
  { id: 'estrellas', name: 'Perfeccionista', text: 'Consigue las 36 estrellas', reward: 1500, test: (s) => Object.values(s.levels).reduce((a, b) => a + b, 0) >= 36 }
];

// ------------------------------------------------------------ the tracker --
// Counts what the player did during one bout. Created at the bell, read when
// the match ends, then thrown away.
export class BoutTracker {
  constructor(match) {
    this.match = match;
    this.c = { punches: 0, uppers: 0, kos: 0, knockdowns: 0, bottles: 0, drinks: 0, combo: 0, supers: 0, ropes: 0, selfFalls: 0, roundsLost: 0, fightTime: 0 };
    const P = () => this.match.player, C = () => this.match.cpu;
    this._offs = [
      bus.on(EV.HIT_LANDED, (p) => {
        if (p.attacker !== P()) return;
        this.c.punches++;
        if (p.move?.name === 'uppercut') this.c.uppers++;
      }),
      bus.on(EV.KNOCKDOWN, (p) => { if (p.fighter === C() && !p.self) this.c.knockdowns++; }),
      bus.on(EV.KO, (p) => { if (p.fighter === C()) this.c.kos++; }),
      bus.on(EV.PROP_BREAK, () => { this.c.bottles++; }),
      bus.on(EV.DRINK, (p) => { if (p.fighter === P()) this.c.drinks++; }),
      bus.on(EV.COMBO, (p) => { if (p.fighter === P()) this.c.combo = Math.max(this.c.combo, p.count); }),
      bus.on('borrachera:start', (p) => { if (p.fighter === P()) this.c.supers++; }),
      bus.on('brawl:ropes', (p) => { if (p.fighter === C()) this.c.ropes++; }),
      bus.on('brawl:fell', (p) => { if (p.fighter === C()) this.c.selfFalls++; }),
      bus.on(EV.ROUND_END, (p) => { if (p.winner === 1) this.c.roundsLost++; })
    ];
  }
  tick(dt, fighting) { if (fighting) this.c.fightTime += dt; }
  dispose() { this._offs.forEach((o) => o()); }
}

// --------------------------------------------------------------- the game --
export class Progress {
  constructor(store) {
    this.store = store;
    this.refreshDaily();
  }
  get s() { return this.store.data; }
  get level() { return levelFromXp(this.s.xp); }

  // ---- daily -----------------------------------------------------------
  refreshDaily(now = Date.now()) {
    const d = today(now);
    if (this.s.daily.date !== d) {
      this.s.daily = { date: d, ids: pickDaily(d), prog: {}, claimed: [] };
      this.store.save();
    }
  }
  dailyList() {
    return this.s.daily.ids.map((id) => {
      const c = CH_BY_ID[id];
      const p = Math.min(c.goal, this.s.daily.prog[id] || 0);
      return { ...c, prog: p, done: p >= c.goal, claimed: this.s.daily.claimed.includes(id) };
    });
  }
  claimDaily(id) {
    const c = this.dailyList().find((x) => x.id === id);
    if (!c || !c.done || c.claimed) return 0;
    this.s.daily.claimed.push(id);
    this.store.earn(c.reward);
    this.store.save();
    return c.reward;
  }

  // Login streak. A day is claimable once. A clock set backwards (a date
  // earlier than the last claim) claims nothing, which is what stops a
  // phone's date setting being a chapas tap.
  streakState(now = Date.now()) {
    const k = this.s.streak, d = today(now);
    if (k.lastTs && now < k.lastTs - 3600000) return { can: false, day: k.count, reward: 0, reason: 'clock' };
    if (k.last === d) return { can: false, day: k.count, reward: 0 };
    const gap = k.last ? dayDiff(k.last, d) : 1;
    if (gap < 0) return { can: false, day: k.count, reward: 0, reason: 'clock' };
    const day = gap === 1 ? k.count + 1 : 1;
    return { can: true, day, reward: STREAK_REWARDS[(day - 1) % STREAK_REWARDS.length] };
  }
  claimStreak(now = Date.now()) {
    const st = this.streakState(now);
    if (!st.can) return 0;
    this.s.streak = { last: today(now), count: st.day, lastTs: now };
    this.store.earn(st.reward);
    this.store.save();
    return st.reward;
  }

  // ---- shop --------------------------------------------------------------
  buy(kind, id) {
    const s = this.s;
    if (kind === 'fighter') {
      const f = FIGHTER_BY_ID[id];
      if (!f || s.owned.fighters.includes(id) || !this.store.spend(f.price)) return false;
      s.owned.fighters.push(id);
    } else if (kind === 'outfit') {
      const o = OUTFIT_BY_ID[id];
      if (!o || s.owned.outfits.includes(id) || !this.store.spend(o.price)) return false;
      s.owned.outfits.push(id);
    } else if (kind === 'drink') {
      const d = DRINK_BY_ID[id];
      if (!d || (s.drinks[id] || 0) >= 99 || !this.store.spend(d.price)) return false;
      s.drinks[id] = (s.drinks[id] || 0) + 1;
    } else return false;
    this.checkAchievements();
    this.store.save();
    return true;
  }
  select(kind, id) {
    const s = this.s;
    if (kind === 'fighter' && s.owned.fighters.includes(id)) s.sel.fighter = id;
    else if (kind === 'outfit' && s.owned.outfits.includes(id)) s.sel.outfit = id;
    else if (kind === 'drink') s.sel.drink = id && (s.drinks[id] || 0) > 0 ? (s.sel.drink === id ? '' : id) : '';
    else return false;
    this.store.save();
    return true;
  }
  // Uses up the selected drink, if there is one left. Returns its id.
  consumeDrink() {
    const id = this.s.sel.drink;
    if (!id || !(this.s.drinks[id] > 0)) { this.s.sel.drink = ''; return ''; }
    this.s.drinks[id]--;
    if (!this.s.drinks[id]) { delete this.s.drinks[id]; this.s.sel.drink = ''; }
    this.store.save();
    return id;
  }

  isUnlocked(n) { return n === 1 || (this.s.levels[n - 1] || 0) > 0; }

  // ---- the payout ----------------------------------------------------------
  // Turns a finished bout into chapas, XP, stats, challenge progress, stars
  // and achievements. 'quit' pays nothing and counts nothing but the loss.
  settle(tracker, result) {
    const s = this.s, c = tracker.c;
    const lines = [];
    const add = (label, n) => { if (n > 0) lines.push({ label, n: Math.round(n) }); };
    const counts = !result.quit && c.fightTime >= 15;   // a bout that barely happened pays nothing

    s.stats.matches++;
    if (counts) {
      if (result.won) s.stats.wins++;
      s.stats.kos += c.kos; s.stats.knockdowns += c.knockdowns; s.stats.bottles += c.bottles;
      s.stats.punches += c.punches; s.stats.drinks += c.drinks; s.stats.supers += c.supers;
      s.stats.bestCombo = Math.max(s.stats.bestCombo, c.combo);

      add(result.won ? 'Victoria' : 'Por intentarlo', result.won ? 120 : 35);
      add(`K.O. x${c.kos}`, c.kos * 30);
      add(`Derribos x${c.knockdowns}`, c.knockdowns * 10);
      if (c.combo >= 4) add(`Combo de ${c.combo}`, Math.min(50, c.combo * 5));
      add(`Botellas rotas x${c.bottles}`, Math.min(30, c.bottles * 3));
      add(`Contra las cuerdas x${c.ropes}`, Math.min(30, c.ropes * 5));
      if (result.won && c.roundsLost === 0) add('Sin perder un asalto', 40);

      // Daily challenge progress.
      const bump = { punches: c.punches, kos: c.kos, wins: result.won ? 1 : 0, bottles: c.bottles, drinks: c.drinks,
        supers: c.supers, ropes: c.ropes, selfFalls: c.selfFalls, uppers: c.uppers, knockdowns: c.knockdowns };
      for (const id of s.daily.ids) {
        const ch = CH_BY_ID[id];
        if (!ch) continue;
        if (ch.best) s.daily.prog[id] = Math.max(s.daily.prog[id] || 0, c.combo);
        else s.daily.prog[id] = (s.daily.prog[id] || 0) + (bump[ch.stat] || 0);
      }
    }

    // Level stars and first-clear reward.
    let stars = 0, newStars = 0, firstClear = false;
    if (result.level && counts) {
      stars = starsFor(result);
      const before = s.levels[result.level] || 0;
      if (stars > before) {
        newStars = stars - before;
        s.levels[result.level] = stars;
        if (before === 0) { firstClear = true; add(`Nivel ${result.level} superado`, levelByN(result.level)?.reward || 0); }
        add(`Estrellas nuevas x${newStars}`, newStars * 50);
      }
    }

    let total = lines.reduce((a, l) => a + l.n, 0);
    total = Math.min(total, 1500);                      // hard cap per bout
    const lvlBefore = this.level.lvl;
    this.store.earn(total);
    s.xp += Math.round(total * 0.9 + (counts ? 40 : 0));
    const lvlAfter = this.level.lvl;
    let levelUp = 0;
    if (lvlAfter > lvlBefore) { levelUp = (lvlAfter - lvlBefore) * 100; this.store.earn(levelUp); }

    const achieved = this.checkAchievements();
    this.store.save();
    return { lines, total, stars, newStars, firstClear, levelUp, lvl: this.level, achieved, counts };
  }

  checkAchievements() {
    const s = this.s, got = [];
    for (const a of ACHIEVEMENTS) {
      if (s.ach.includes(a.id) || !a.test(s)) continue;
      s.ach.push(a.id);
      this.store.earn(a.reward);
      got.push(a);
    }
    return got;
  }

  get totalStars() { return Object.values(this.s.levels).reduce((a, b) => a + b, 0); }
  get maxStars() { return LEVEL_COUNT * 3; }
}
