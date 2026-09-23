// The card. Six fighters whose silhouettes read apart at a glance: the read
// order is build, then height, then palette, because that is the order a
// player's eye picks them up across a dark room.
//
// Nothing here is wired into the game yet. game/match.js picks from it when it
// is ready to; until then this is the source of truth for what a spec contains.
//
// spec fields
//   name       seeds the RNG, so a named fighter always generates identically
//   build      key into BODY_TYPES in builder.js
//   scale      extra height multiplier on top of the build's own
//   skin       base skin tone fed to TEX.skin
//   sss        subsurface tint under the fresnel rim, warmer for paler skin
//   tank trunks belt wrap shoe sole hair eyes    garment and hair colours
//   hairStyle  bald | buzz | short | afro
//   beard      boolean, swaps stubble for a jaw shell
//   stubble    0..1, ignored when beard is set
//   tattoo     false | 'sleeve' | 'chest' | 'full'
export const ROSTER = [
  {
    name: 'Vic "The Boiler" Kozlov',
    id: 'boiler',
    build: 'bruiser',
    skin: '#c99a76', sss: '#c04a2e',
    tank: '#8e1f25', trunks: '#1a1d28', belt: '#0d0f16',
    wrap: '#e8e3d4', shoe: '#23272f', sole: '#d6cfbe',
    hair: '#1b1410', hairStyle: 'buzz', beard: true,
    eyes: '#3d2a18', tattoo: 'full',
    taunt: 'Last one standing buys.'
  },
  {
    name: 'Dez Okonjo',
    id: 'dez',
    build: 'lean',
    skin: '#6d4328', sss: '#8e2a18',
    tank: '#e8e4d8', trunks: '#1d5a52', belt: '#123b36',
    wrap: '#2a2f38', shoe: '#e4e0d4', sole: '#2a2f38',
    hair: '#100c0a', hairStyle: 'afro', stubble: 0.35,
    eyes: '#2a1c10', tattoo: 'sleeve',
    taunt: 'You are slow and you are loud.'
  },
  {
    name: 'Marta Reyes',
    id: 'marta',
    build: 'athletic',
    scale: 0.955,
    skin: '#bb8258', sss: '#b8452c',
    tank: '#d43f6a', trunks: '#22252f', belt: '#14161d',
    wrap: '#f0ece0', shoe: '#d43f6a', sole: '#f0ece0',
    hair: '#241510', hairStyle: 'short', stubble: 0,
    eyes: '#241a12', tattoo: 'chest',
    taunt: 'Try to keep up.'
  },
  {
    name: 'Bogdan Petric',
    id: 'bogdan',
    build: 'stocky',
    skin: '#d0a079', sss: '#c25234',
    tank: '#4f5a2c', trunks: '#31261c', belt: '#1d160f',
    wrap: '#cfc6ad', shoe: '#4a3b2c', sole: '#b9ae97',
    hair: '#3a2a1c', hairStyle: 'bald', beard: true,
    eyes: '#4a3520', tattoo: false,
    taunt: 'Sit down before you fall down.'
  },
  {
    name: 'Kiko Tanaka',
    id: 'kiko',
    build: 'rangy',
    skin: '#d9b183', sss: '#b04a30',
    tank: '#1b2c4a', trunks: '#c9c2b2', belt: '#8a3038',
    wrap: '#8a3038', shoe: '#1b2c4a', sole: '#c9c2b2',
    hair: '#0e0c0b', hairStyle: 'short', stubble: 0.2,
    eyes: '#1c1410', tattoo: 'sleeve',
    taunt: 'Nothing personal.'
  },
  {
    name: 'Ruthie Kane',
    id: 'ruthie',
    build: 'slugger',
    scale: 0.975,
    skin: '#e6b795', sss: '#c8563a',
    tank: '#2b2f3a', trunks: '#7a1f2b', belt: '#3c1116',
    wrap: '#d9d2c2', shoe: '#7a1f2b', sole: '#2b2f3a',
    hair: '#6b2f18', hairStyle: 'short', stubble: 0,
    eyes: '#2a3a2a', tattoo: 'full',
    taunt: 'Bar tab says you blink first.'
  }
];

export const ROSTER_BY_ID = {};
for (const f of ROSTER) ROSTER_BY_ID[f.id] = f;

export const pickFighter = (id) => ROSTER_BY_ID[id] || ROSTER[0];
