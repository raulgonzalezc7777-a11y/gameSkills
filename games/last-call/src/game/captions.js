// The line that goes on the replay: picked from how the bout actually ended,
// so the clip says what happened. Written to be read in half a second.

const pick = (a) => a[Math.floor(Math.random() * a.length)];

const WIN = {
  uppercut: ['UPPERCUT AL TECHO. QUE ALGUIEN LE PIDA UN TAXI', 'LO HE MANDADO A LA ÓRBITA', 'EL TECHO LE MANDA RECUERDOS'],
  kick: ['PATADA Y A DORMIR', 'LE HE RETIRADO EL SALUDO. Y LA DENTADURA'],
  prop: ['TABURETAZO. EL CAMARERO NO ESTÁ CONTENTO', 'LA BOTELLA LLEGÓ ANTES QUE ÉL', 'EL MOBILIARIO TAMBIÉN PELEA'],
  super: ['LA BORRACHERA NO PERDONA', 'MODO BORRACHERA: ACTIVADO. RIVAL: DESACTIVADO'],
  ropes: ['REBOTÓ EN LAS CUERDAS Y EN SU DIGNIDAD', 'LAS CUERDAS LO DEVOLVIERON... A MI PUÑO'],
  drunk: ['GANÉ CON UN PEDO HISTÓRICO', 'NI ME ACUERDO DE HABER GANADO', 'PELEO MEJOR CON CINCO CAÑAS'],
  any: ['SE QUEDÓ DORMIDO EN LA BARRA', 'HASTA AQUÍ LA NOCHE', 'ÚLTIMA RONDA... PARA ÉL', 'PIDE LA CUENTA, CAMPEÓN', 'ESO HA DOLIDO HASTA AQUÍ']
};
const LOSE = {
  super: ['ME HAN HECHO LA BORRACHERA EN LA CARA'],
  prop: ['ME HAN TIRADO EL BAR ENCIMA'],
  any: ['ME HAN APAGADO LA LUZ', 'MAÑANA NO ME ACUERDO DE NADA', 'YO SOLO VENÍA A POR UNA CAÑA', 'MI DIGNIDAD SE QUEDÓ EN LA BARRA', 'CAÍ COMO UN SACO DE PATATAS']
};

// ko: { playerWon, move, super, ropes, winnerDrunk }
export function captionFor(ko) {
  const T = ko.playerWon ? WIN : LOSE;
  let key = 'any';
  if (ko.super && T.super) key = 'super';
  else if (/throw|Smash|Swing|Slam/i.test(ko.move || '') && T.prop) key = 'prop';
  else if (ko.ropes && T.ropes) key = 'ropes';
  else if (ko.move === 'uppercut' && T.uppercut) key = 'uppercut';
  else if (ko.move === 'kick' && T.kick) key = 'kick';
  else if (ko.playerWon && ko.winnerDrunk > 0.7 && Math.random() < 0.6) key = 'drunk';
  return pick(T[key]);
}
