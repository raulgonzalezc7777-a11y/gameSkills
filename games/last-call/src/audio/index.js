import { AudioEngine } from './engine.js';
import { bus, EV } from '../core/events.js';
import { voiceOf } from './sfx.js';
import { clamp, clamp01 } from '../core/math.js';
import { rng } from '../core/rng.js';

export { AudioEngine };
export { Mixer } from './mixer.js';
export { SfxKit, CrowdBed, SFX_NAMES, voiceOf } from './sfx.js';
export { MusicEngine } from './music.js';

// combat/fighter.js puts the attack's table entry in the payload but not its
// name. Reading the shape back out keeps audio from importing the combat
// module, which would tie the sound design to the fighter entity for the sake
// of one string.
function attackNameFrom(cfg, damage) {
  if (cfg) {
    if (cfg.part === 'body' && cfg.reach > 1.5) return 'kick';
    if (cfg.dmg <= 7.5) return 'jab';
    if (cfg.dmg <= 12.5) return 'cross';
    if (cfg.dmg <= 14.5) return 'hook';
    return 'uppercut';
  }
  const d = damage || 8;
  if (d <= 7.5) return 'jab';
  if (d <= 12.5) return 'cross';
  if (d <= 16) return 'hook';
  return 'uppercut';
}

// One call wires the whole bus to the audio engine, the same way
// installVFXListeners does for the effects. A new sound never needs the
// integrator's attention.
export function installAudioListeners(audio) {
  const offs = [];
  const on = (ev, fn) => offs.push(bus.on(ev, (p) => { if (audio.ready) fn(p || {}); }));

  // Generic passthrough. fighter.js already emits this for whooshes and gulps.
  on(EV.SFX, (p) => {
    if (!p.name) return;
    audio.play(p.name, { position: p.position, volume: p.volume, pitch: p.pitch, damage: p.damage });
  });

  on(EV.HIT_LANDED, (p) => {
    const pt = p.point || p.target?.position;
    const dmg = p.damage || 8;
    const name = attackNameFrom(p.cfg, dmg);
    audio.play(name, { position: pt, damage: dmg });
    // A head shot rings; a body shot does not. Layering the resonance on top
    // of the impact is cheaper than two whole sound families.
    if (p.part === 'head' && dmg > 7) {
      audio.play('headhit', { position: pt, damage: dmg, delay: 0.012, volume: 0.8 });
    }
    const v = voiceOf(p.target);
    audio.play('grunt', {
      position: p.target?.position, damage: dmg, delay: 0.03 + rng() * 0.02,
      f0: v.f0, shift: v.shift
    });
    // The crowd reacts to every landed shot. Director also emits CROWD_REACT
    // for the same hit, so that handler deliberately ignores ooh and roar.
    audio.surgeCrowd(dmg > 12 ? 'roar' : 'ooh', clamp(0.5 + dmg * 0.045, 0.5, 1.6));
  });

  on(EV.HIT_BLOCKED, (p) => {
    const pt = p.point || p.target?.position;
    audio.play('block', { position: pt, damage: p.damage || 4 });
    if ((p.damage || 0) > 3) audio.play('exhale', { position: p.target?.position, volume: 0.5, delay: 0.04 });
  });

  on(EV.HIT_WHIFF, (p) => {
    const f = p.fighter;
    audio.play('whiff', { position: f?.position, power: 1 });
    if (f && f.drunk01 > 0.5) {
      const v = voiceOf(f);
      audio.play('exhale', { position: f.position, volume: 0.6, delay: 0.05, shift: v.shift });
    }
  });

  on(EV.PARRY, (p) => {
    const pt = p.point || p.fighter?.position;
    audio.play('parry', { position: pt });
    audio.surgeCrowd('roar', 1.1);
  });

  on(EV.KNOCKDOWN, (p) => {
    const f = p.fighter;
    audio.play('bodyfall', { position: f?.position, volume: 1.1 });
    const v = voiceOf(f);
    audio.play('grunt', { position: f?.position, damage: 20, f0: v.f0, shift: v.shift });
    audio.surgeCrowd('big', 1.2);
  });

  on(EV.KO, (p) => {
    const f = p.fighter;
    audio.play('headhit', { position: f?.position, damage: 26, volume: 1.15 });
    audio.play('bodyfall', { position: f?.position, volume: 1.3, delay: 0.22 });
    const v = voiceOf(f);
    audio.play('grunt', { position: f?.position, damage: 26, f0: v.f0 * 0.92, shift: v.shift });
    audio.surgeCrowd('peak', 1.4);
    // The track gets out of the way of the slow motion, then comes back up.
    audio.duck(0.72, 1.9, 0.6);
  });

  on(EV.DRINK, (p) => {
    const f = p.fighter;
    const v = voiceOf(f);
    audio.play('gulp', { position: f?.position, shift: v.shift });
    audio.play('exhale', { position: f?.position, delay: 0.52, volume: 0.8, shift: v.shift });
  });

  on(EV.FOOTSTEP, (p) => {
    audio.play('footstep', { position: p.position, intensity: p.intensity ?? 1 });
  });

  on(EV.STUMBLE, (p) => {
    const f = p.fighter;
    audio.play('footstep', { position: f?.position || p.position, variation: 'scuff', intensity: 1.2 });
    const v = voiceOf(f);
    audio.play('exhale', { position: f?.position, delay: 0.08, volume: 0.7, shift: v.shift });
  });

  on(EV.PROP_BREAK, (p) => {
    audio.play('glassbreak', { position: p.position });
    audio.play('bottleclink', { position: p.position, delay: 0.03, volume: 0.6 });
    audio.surgeCrowd('roar', 1.0);
  });

  on(EV.COMBO, (p) => {
    const n = p.count || 2;
    if (n < 3) return;
    audio.surgeCrowd(n >= 6 ? 'big' : 'roar', clamp(0.6 + n * 0.12, 0.6, 1.7));
    if (n >= 4) audio.play('crowdshout', { pan: (rng() * 2 - 1) * 0.7, power: 1.1 });
  });

  on(EV.CROWD_REACT, (p) => {
    // ooh and roar already fired from HIT_LANDED above; reacting again here
    // would double every single punch.
    if (p.level === 'peak') audio.surgeCrowd('peak', 1.3);
    else if (p.level === 'lastCall') {
      audio.surgeCrowd('lastCall', 1.5);
      audio.music.lastCall(true);
      audio.music.setIntensity(1);
    }
  });

  on(EV.ROUND_START, () => audio.surgeCrowd('roar', 0.7));
  on(EV.FIGHT_START, (p) => {
    audio.play('bell', { volume: 0.9 });
    audio.music.lastCall(false);
    audio.music.setIntensity(0.72);
    audio.music.start();
    audio.surgeCrowd('roar', 1.0);
  });

  on(EV.ROUND_END, () => {
    audio.play('bell', { volume: 0.9, delay: 0.0 });
    audio.play('bell', { volume: 0.8, delay: 0.45 });
    audio.surgeCrowd('big', 1.2);
    audio.music.setIntensity(0.45);
    audio.music.lastCall(false);
  });

  on(EV.MATCH_END, () => {
    audio.surgeCrowd('peak', 1.5);
    audio.duck(0.5, 2.4, 0.8);
    audio.music.setIntensity(0.9);
  });

  on(EV.SLOWMO, (p) => { audio.duck(0.55, (p.duration || 1.5) * 0.8, 0.5); });

  return () => offs.forEach((o) => o());
}

export default AudioEngine;
