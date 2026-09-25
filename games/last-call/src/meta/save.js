import { FIGHTERS, OUTFITS, DRINKS } from './catalog.js';
import { LEVEL_COUNT } from './levels.js';

// The player's progress, kept in this browser's localStorage.
//
// Nothing here trusts what it reads back. Stored data is untrusted input: a
// browser extension, a curious player or a half-written save can put anything
// in there. So every load rebuilds the save from scratch, field by field,
// keeping only known ids and finite numbers inside their ranges, and it never
// throws. A checksum over the data spots hand-edited saves; this is a client
// side game with nothing to buy with real money, so the checksum is a speed
// bump for casual editing, not a lock, and a tampered save only loses its
// chapas (its unlocks and stars are kept).
//
// If storage is blocked (private mode, sandboxed frame) the game keeps the
// save in memory for the session and says so once.

const KEY = 'lastcall.save.v1';
const SALT = 'garito-0347';
export const MAX_CHAPAS = 999999;

const FIGHTER_IDS = new Set(FIGHTERS.map((f) => f.id));
const OUTFIT_IDS = new Set(OUTFITS.map((o) => o.id));
const DRINK_IDS = new Set(DRINKS.map((d) => d.id));

const int = (v, lo, hi, d = lo) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : d);
const str = (v, max, re) => (typeof v === 'string' && v.length <= max && (!re || re.test(v)) ? v : '');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[a-z0-9]{1,24}$/;

export function freshSave() {
  return {
    v: 1,
    chapas: 200,
    xp: 0,
    owned: { fighters: ['boiler', 'dez'], outfits: ['clasico'] },
    drinks: { doble: 1 },
    sel: { fighter: 'boiler', outfit: 'clasico', drink: '' },
    levels: {},
    stats: { matches: 0, wins: 0, kos: 0, knockdowns: 0, bottles: 0, bestCombo: 0, punches: 0, drinks: 0, supers: 0 },
    daily: { date: '', ids: [], prog: {}, claimed: [] },
    streak: { last: '', count: 0, lastTs: 0 },
    ach: [],
    settings: { music: true, sfx: true, vibrate: true, quality: 'auto' }
  };
}

// Rebuild a save from anything. Unknown keys vanish, bad values become safe.
export function sanitize(raw) {
  const s = freshSave();
  if (!raw || typeof raw !== 'object') return s;
  s.chapas = int(raw.chapas, 0, MAX_CHAPAS, s.chapas);
  s.xp = int(raw.xp, 0, 1e8, 0);
  const o = raw.owned || {};
  const fighters = Array.isArray(o.fighters) ? o.fighters.filter((id) => FIGHTER_IDS.has(id)) : [];
  s.owned.fighters = [...new Set(['boiler', 'dez', ...fighters])];
  const outfits = Array.isArray(o.outfits) ? o.outfits.filter((id) => OUTFIT_IDS.has(id)) : [];
  s.owned.outfits = [...new Set(['clasico', ...outfits])];
  s.drinks = {};
  if (raw.drinks && typeof raw.drinks === 'object') {
    for (const id of DRINK_IDS) { const n = int(raw.drinks[id], 0, 99, 0); if (n) s.drinks[id] = n; }
  }
  const sel = raw.sel || {};
  s.sel.fighter = s.owned.fighters.includes(sel.fighter) ? sel.fighter : 'boiler';
  s.sel.outfit = s.owned.outfits.includes(sel.outfit) ? sel.outfit : 'clasico';
  s.sel.drink = DRINK_IDS.has(sel.drink) ? sel.drink : '';
  if (raw.levels && typeof raw.levels === 'object') {
    for (let n = 1; n <= LEVEL_COUNT; n++) { const st = int(raw.levels[n], 0, 3, 0); if (st) s.levels[n] = st; }
  }
  const st = raw.stats || {};
  for (const k of Object.keys(s.stats)) s.stats[k] = int(st[k], 0, 1e8, 0);
  const d = raw.daily || {};
  s.daily.date = str(d.date, 10, DATE_RE);
  s.daily.ids = Array.isArray(d.ids) ? d.ids.map((x) => str(x, 24, ID_RE)).filter(Boolean).slice(0, 3) : [];
  s.daily.prog = {};
  if (d.prog && typeof d.prog === 'object') for (const id of s.daily.ids) s.daily.prog[id] = int(d.prog[id], 0, 1e6, 0);
  s.daily.claimed = Array.isArray(d.claimed) ? d.claimed.filter((x) => s.daily.ids.includes(x)) : [];
  const k = raw.streak || {};
  s.streak.last = str(k.last, 10, DATE_RE);
  s.streak.count = int(k.count, 0, 10000, 0);
  s.streak.lastTs = int(k.lastTs, 0, 8.64e15, 0);
  s.ach = Array.isArray(raw.ach) ? [...new Set(raw.ach.map((x) => str(x, 24, ID_RE)).filter(Boolean))].slice(0, 64) : [];
  const g = raw.settings || {};
  for (const key of ['music', 'sfx', 'vibrate']) s.settings[key] = typeof g[key] === 'boolean' ? g[key] : true;
  s.settings.quality = ['auto', 'low', 'phone', 'medium', 'high', 'cinematic'].includes(g.quality) ? g.quality : 'auto';
  return s;
}

// cyrb53: a small, well-mixed 53-bit string hash. Not cryptography, and it
// does not need to be; see the note at the top of the file.
function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function storage() {
  try {
    const ls = window.localStorage;
    const probe = '__lc_probe__';
    ls.setItem(probe, '1'); ls.removeItem(probe);
    return ls;
  } catch { return null; }
}

export class SaveStore {
  constructor() {
    this.ls = storage();
    this.persistent = !!this.ls;
    this.tampered = false;
    this.data = this.load();
    this._listeners = new Set();
  }

  load() {
    if (!this.ls) return freshSave();
    let text = null;
    try { text = this.ls.getItem(KEY); } catch { return freshSave(); }
    if (!text || text.length > 200000) return freshSave();
    try {
      const wrap = JSON.parse(text);
      const data = sanitize(wrap?.d);
      if (typeof wrap?.h !== 'string' || wrap.h !== hash(JSON.stringify(wrap.d) + SALT)) {
        // Edited by hand, or written by something else: keep the progress,
        // drop the currency.
        this.tampered = true;
        data.chapas = 0;
      }
      return data;
    } catch {
      return freshSave();
    }
  }

  save() {
    this.data = sanitize(this.data);
    this._listeners.forEach((fn) => { try { fn(this.data); } catch { /* a listener never breaks a save */ } });
    if (!this.ls) return false;
    try {
      const d = this.data;
      this.ls.setItem(KEY, JSON.stringify({ d, h: hash(JSON.stringify(d) + SALT) }));
      return true;
    } catch { return false; }
  }

  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  reset() { this.data = freshSave(); this.save(); }

  // ---- currency, always through here so the bounds hold ------------------
  get chapas() { return this.data.chapas; }
  earn(n) { this.data.chapas = Math.min(MAX_CHAPAS, this.data.chapas + Math.max(0, Math.floor(n) || 0)); }
  spend(n) {
    n = Math.max(0, Math.floor(n) || 0);
    if (this.data.chapas < n) return false;
    this.data.chapas -= n;
    return true;
  }
}
