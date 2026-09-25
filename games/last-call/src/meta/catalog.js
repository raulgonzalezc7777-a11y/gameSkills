// Everything the shop sells and everything a fighter brings to the ring.
// Prices are in chapas (bottle caps), the game's only currency. It is earned
// by fighting and cannot be bought with money: there is no payment anywhere.
//
// Stats run 1..5 and are real: they become multipliers on the fighter (see
// applyFighterStats), so a bruiser hits harder and a lean one moves quicker.

// Lookup tables have no prototype: an id like '__proto__' or 'constructor'
// coming from a save or a button must find nothing, not Object.prototype.
function table(list) {
  const t = Object.create(null);
  for (const x of list) t[x.id] = x;
  return Object.freeze(t);
}

export const FIGHTERS = [
  { id: 'boiler', nick: 'La Caldera', price: 0, stats: { pow: 5, spd: 2, chin: 4 },
    blurb: 'Pega como un camión de reparto. Llega tarde a todo.' },
  { id: 'dez', nick: 'El Rayo', price: 0, stats: { pow: 3, spd: 5, chin: 2 },
    blurb: 'Rápido, bocazas y con los pies más ligeros del barrio.' },
  { id: 'marta', nick: 'La Jefa', price: 450, stats: { pow: 3, spd: 4, chin: 3 },
    blurb: 'Lleva el bar. Y la pelea. Y tu cuenta.' },
  { id: 'kiko', nick: 'Katana', price: 700, stats: { pow: 4, spd: 4, chin: 2 },
    blurb: 'Brazos larguísimos y cero paciencia.' },
  { id: 'ruthie', nick: 'El Mazo', price: 950, stats: { pow: 5, spd: 3, chin: 3 },
    blurb: 'Un golpe suyo y ves a tu abuela.' },
  { id: 'bogdan', nick: 'El Oso', price: 1400, stats: { pow: 4, spd: 1, chin: 5 },
    blurb: 'Aguanta lo que le eches. Y la bebida mejor que nadie.' }
];
export const FIGHTER_BY_ID = table(FIGHTERS);

// Kits recolour the player's fighter. Only colours, so they apply to anyone.
export const OUTFITS = [
  { id: 'clasico', name: 'De serie', price: 0, colors: null, swatch: ['#8e1f25', '#1a1d28'] },
  { id: 'neon', name: 'Neón', price: 250, colors: { tank: '#ff2a6d', trunks: '#0b3d4a', shoe: '#05d9e8', wrap: '#05d9e8', sole: '#ff2a6d' }, swatch: ['#ff2a6d', '#05d9e8'] },
  { id: 'camuflaje', name: 'Camuflaje', price: 300, colors: { tank: '#4b5320', trunks: '#6b5b3e', shoe: '#3b3b2e', wrap: '#8a7f5a' }, swatch: ['#4b5320', '#6b5b3e'] },
  { id: 'hawaiana', name: 'Hawaiana', price: 350, colors: { tank: '#ff8c42', trunks: '#2ec4b6', shoe: '#fdfdfd', wrap: '#ffd166' }, swatch: ['#ff8c42', '#2ec4b6'] },
  { id: 'luto', name: 'Luto', price: 400, colors: { tank: '#121212', trunks: '#0a0a0a', shoe: '#111111', wrap: '#2a2a2a', belt: '#000000', sole: '#222222' }, swatch: ['#121212', '#3a3a3a'] },
  { id: 'fiesta', name: 'Fiesta', price: 450, colors: { tank: '#9b5de5', trunks: '#f15bb5', shoe: '#fee440', wrap: '#fee440' }, swatch: ['#9b5de5', '#f15bb5'] },
  { id: 'oro', name: 'Oro puro', price: 900, colors: { tank: '#d4a017', trunks: '#1a1a1a', shoe: '#d4a017', wrap: '#f5d76e', belt: '#d4a017', sole: '#1a1a1a' }, swatch: ['#d4a017', '#1a1a1a'] }
];
export const OUTFIT_BY_ID = table(OUTFITS);

// Drinks are consumed: one per bout, picked before it starts.
export const DRINKS = [
  { id: 'doble', name: 'Cerveza doble', price: 60, desc: 'Empiezas con el puntillo y el aguante a tope.' },
  { id: 'carajillo', name: 'Carajillo', price: 80, desc: 'Recuperas aguante un 50% más rápido.' },
  { id: 'chupito', name: 'Chupito de valor', price: 100, desc: 'El público empieza a medio calentar.' },
  { id: 'agua', name: 'Vaso de agua', price: 70, desc: 'Empiezas sobrio y la bebida te sube menos.' }
];
export const DRINK_BY_ID = table(DRINKS);

// Stat 1..5 to a multiplier around 1. Kept gentle: the player's skill must
// matter more than the card.
const lerp = (lo, hi, v) => lo + (hi - lo) * ((Math.min(5, Math.max(1, v)) - 1) / 4);

export function applyFighterStats(fighter, id) {
  const c = FIGHTER_BY_ID[id];
  if (!c) return;
  fighter.mod.pow *= lerp(0.9, 1.14, c.stats.pow);
  fighter.mod.speed *= lerp(0.9, 1.12, c.stats.spd);
  fighter.mod.chin *= lerp(0.9, 1.14, c.stats.chin);
  if (id === 'bogdan') fighter.mod.buzz *= 0.8;   // holds his drink
}

export function applyDrink(fighter, director, id) {
  switch (id) {
    case 'doble': fighter.drunk = Math.max(fighter.drunk, 40); fighter.stamina = 100; break;
    case 'carajillo': fighter.mod.regen *= 1.5; break;
    case 'chupito': if (director) director.hype = Math.max(director.hype, 50); break;
    case 'agua': fighter.drunk = 0; fighter.mod.buzz *= 0.7; break;
    default: break;
  }
}
