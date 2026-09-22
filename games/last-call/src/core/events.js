// Tiny synchronous event bus. Subsystems talk through this instead of
// importing each other, which is what keeps the module graph acyclic.
class Bus {
  constructor() { this.map = new Map(); }
  on(type, fn) {
    let set = this.map.get(type);
    if (!set) { set = new Set(); this.map.set(type, set); }
    set.add(fn);
    return () => this.off(type, fn);
  }
  once(type, fn) {
    const off = this.on(type, (p) => { off(); fn(p); });
    return off;
  }
  off(type, fn) { this.map.get(type)?.delete(fn); }
  emit(type, payload) {
    const set = this.map.get(type);
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); } catch (e) { console.error(`[bus:${type}]`, e); }
    }
  }
  clear() { this.map.clear(); }
}
export const bus = new Bus();

export const EV = {
  HIT_LANDED: 'hit:landed',
  HIT_BLOCKED: 'hit:blocked',
  HIT_WHIFF: 'hit:whiff',
  PARRY: 'hit:parry',
  KNOCKDOWN: 'fighter:knockdown',
  GET_UP: 'fighter:getup',
  KO: 'fighter:ko',
  STUMBLE: 'fighter:stumble',
  DRINK: 'fighter:drink',
  FOOTSTEP: 'fighter:footstep',
  COMBO: 'combat:combo',
  ROUND_START: 'match:roundStart',
  ROUND_END: 'match:roundEnd',
  MATCH_END: 'match:end',
  CAMERA_SHAKE: 'camera:shake',
  CAMERA_KICK: 'camera:kick',
  HITSTOP: 'time:hitstop',
  SLOWMO: 'time:slowmo',
  PROP_BREAK: 'world:propBreak',
  CROWD_REACT: 'world:crowdReact',
  SFX: 'audio:sfx',
  UI_STATE: 'ui:state'
};
