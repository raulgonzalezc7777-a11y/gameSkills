// The ladder: twelve bouts across three bars. Each one names the rival, how
// sharp the rival is, and a house rule that changes the fight. Levels unlock
// in order; stars are earned per level and never lost.

export const MODS = {
  happyHour: { name: 'Happy hour', desc: 'Beber cura el doble y sube más.' },
  cabezones: { name: 'Cabezones', desc: 'Todo el mundo tiene la cabeza gigante.' },
  cuerdasLocas: { name: 'Cuerdas locas', desc: 'Las cuerdas rebotan como camas elásticas y todo sale volando más.' },
  lluviaBotellas: { name: 'Lluvia de botellas', desc: 'El público tira botellas a cualquiera.' },
  lunar: { name: 'Gravedad lunar', desc: 'Alguien ha echado algo en las copas. Flotáis.' },
  ultimaRonda: { name: 'Última ronda', desc: 'Asaltos de 45 segundos.' },
  borrachos: { name: 'Barra libre', desc: 'Los dos empezáis bien cargados.' },
  jefe: { name: 'Jefe del bar', desc: 'El rival aguanta mucho más y pega más fuerte.' }
};

export const CHAPTERS = [
  { id: 1, name: 'El Garito', from: 1, to: 4 },
  { id: 2, name: 'La Bodega', from: 5, to: 8 },
  { id: 3, name: 'Club Último Trago', from: 9, to: 12 }
];

export const LEVELS = [
  { n: 1, title: 'La primera ronda', cpu: 'dez', diff: 0.3, mods: [], reward: 150 },
  { n: 2, title: 'Hora feliz', cpu: 'marta', diff: 0.38, mods: ['happyHour'], reward: 180 },
  { n: 3, title: 'Cabeza de chorlito', cpu: 'kiko', diff: 0.44, mods: ['cabezones'], reward: 210 },
  { n: 4, title: 'El dueño del garito', cpu: 'boiler', diff: 0.5, mods: ['jefe'], reward: 300 },
  { n: 5, title: 'Muelles', cpu: 'ruthie', diff: 0.52, mods: ['cuerdasLocas'], reward: 260 },
  { n: 6, title: 'Cuidado arriba', cpu: 'dez', diff: 0.56, mods: ['lluviaBotellas'], reward: 280 },
  { n: 7, title: 'Barra libre', cpu: 'bogdan', diff: 0.58, mods: ['borrachos', 'happyHour'], reward: 300 },
  { n: 8, title: 'La reina de la bodega', cpu: 'marta', diff: 0.62, mods: ['jefe', 'ultimaRonda'], reward: 420 },
  { n: 9, title: 'Pasos de astronauta', cpu: 'kiko', diff: 0.64, mods: ['lunar'], reward: 360 },
  { n: 10, title: 'Todo vale', cpu: 'ruthie', diff: 0.68, mods: ['cabezones', 'cuerdasLocas'], reward: 400 },
  { n: 11, title: 'Diluvio', cpu: 'boiler', diff: 0.72, mods: ['lluviaBotellas', 'borrachos'], reward: 450 },
  { n: 12, title: 'El último trago', cpu: 'bogdan', diff: 0.8, mods: ['jefe', 'cuerdasLocas', 'lluviaBotellas'], reward: 700 }
];
export const LEVEL_COUNT = LEVELS.length;
export const levelByN = (n) => LEVELS.find((l) => l.n === n) || null;

// Match options for a level. The player's own choices (fighter, kit, drink)
// are layered on by the flow.
export function levelMatchOpts(level) {
  return {
    cpu: level.cpu,
    difficulty: level.diff,
    mods: [...level.mods],
    roundSeconds: level.mods.includes('ultimaRonda') ? 45 : undefined
  };
}

// House rules that act on the fighters rather than on the physics.
export function applyFighterMods(match, mods) {
  const set = new Set(mods || []);
  const both = [match.player, match.cpu];
  if (set.has('happyHour')) for (const f of both) { f.mod.heal *= 2.5; f.mod.buzz *= 1.3; }
  if (set.has('borrachos')) for (const f of both) f.drunk = Math.max(f.drunk, 70);
  if (set.has('jefe')) { match.cpu.mod.chin *= 1.4; match.cpu.mod.pow *= 1.12; }
  if (set.has('cabezones')) for (const f of both) f.rig?.bones?.head?.scale.setScalar(1.8);
}

// Stars for a won bout: one for the win, one for not dropping a round, one
// for finishing with more than half your health.
export function starsFor(result) {
  if (!result.won) return 0;
  let s = 1;
  if (result.roundsLost === 0) s++;
  if (result.healthLeft >= 50) s++;
  return s;
}
