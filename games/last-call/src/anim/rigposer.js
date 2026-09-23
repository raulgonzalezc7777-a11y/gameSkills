// The poser. It turns a fighter's state into 19 bone rotations every frame:
// a locomotion blendspace at the bottom, additive channels for attacks, hits,
// drunkenness, look at and secondary motion above it, a state machine deciding
// which of those are live, and analytic IK at the end so the feet meet the
// floor and the punches meet the opponent.
//
// Nothing in update() allocates. Every vector, quaternion and pose buffer is
// either module scope scratch or owned by the instance.
import * as THREE from 'three';
import {
  BONES, BONE_ORDER, BI, NB, OFF_HIP, OFF_IKT, OFF_IKW, IK_HAND_L, IK_HAND_R, IK_FOOT_L, IK_FOOT_R,
  createPose, zeroPose, copyPose, lerpPose, subPose, accumPose, LayerStack,
  MASK_ALL, MASK_UPPER, MASK_KICK, MASK_HIT, MASK_HEAD
} from './layers.js';
import { CLIPS, CLIP_NAMES, sampleClip, GUARD_POSE } from './clips.js';
import { StateMachine, STATES, CLIP_TO_STATE } from './statemachine.js';
import { Secondary, DrunkLayer, LookAt } from './procedural.js';
import { solveTwoBone, levelFoot, reachDeficit, AXIS_ARM_L, AXIS_ARM_R, AXIS_LEG } from './ik.js';
import { clamp, clamp01, lerp, expDamp, smoothstep, wrapAngle } from '../core/math.js';
import { bus, EV } from '../core/events.js';

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3();
const _pole = new THREE.Vector3(), _tgt = new THREE.Vector3(), _q = new THREE.Quaternion();
const _step = new THREE.Vector3();   // reused for the FOOTSTEP payload
const UP = new THREE.Vector3(0, 1, 0);

// Gait tuning. Stride length is what keeps the feet from skating: the cycle
// advances with distance travelled, not with wall clock.
const WALK_SPEED = 2.05, RUN_SPEED = 4.35;
const WALK_STRIDE = 1.42, RUN_STRIDE = 2.32;
const ANKLE_H = 0.075;          // foot bone height above the sole
const ARM_REACH_HEAD = 1.52;    // where a head punch aims, above the floor
const ARM_REACH_BODY = 1.16;

const norm01 = (v, def) => (v === undefined || v === null ? def : v > 1.5 ? clamp01(v / 100) : clamp01(v));

export class RigPoser {
  constructor(rig) {
    this.rig = rig;
    this.bones = rig?.bones || {};
    this.group = rig?.group || null;
    this.b = new Array(NB);
    for (let i = 0; i < NB; i++) {
      const bone = this.bones[BONES[i]] || null;
      this.b[i] = bone;
      if (bone) bone.rotation.order = BONE_ORDER[i];
    }
    const hips = this.b[BI.hips];
    this.restHip = new THREE.Vector3(0, 0.98, 0);
    if (hips) this.restHip.copy(hips.position);

    // Pose buffers.
    this.loco = createPose();
    this.base = createPose();
    this.prevBase = createPose();
    this.final = createPose();
    this.scratch = createPose();
    this.scratch2 = createPose();

    this.stack = new LayerStack();
    this.stack.add('upperA', { mask: MASK_UPPER, rate: 22 });
    this.stack.add('upperB', { mask: MASK_UPPER, rate: 22 });
    this.stack.add('hitA', { mask: MASK_HIT, rate: 30 });
    this.stack.add('hitB', { mask: MASK_HIT, rate: 30 });
    this.stack.add('drunk', { mask: MASK_ALL, rate: 3.5 });
    this.stack.add('look', { mask: MASK_HEAD, rate: 9 });
    this.stack.add('secondary', { mask: MASK_ALL, rate: 8, weight: 1 });
    this.stack.get('secondary').target = 1;

    // Two slots per additive channel so a clip change crossfades instead of
    // popping: the outgoing pose keeps playing while it fades.
    this.chan = {
      upper: { names: ['upperA', 'upperB'], cur: 0, slots: [{ clip: null, t: 0 }, { clip: null, t: 0 }] },
      hit: { names: ['hitA', 'hitB'], cur: 0, slots: [{ clip: null, t: 0 }, { clip: null, t: 0 }] }
    };

    this.sm = new StateMachine('idle');
    this.sm.onEnter = (def) => this.onEnterState(def);
    this.secondary = new Secondary();
    this.drunkL = new DrunkLayer();
    this.lookAt = new LookAt();

    // Locomotion.
    this.phase = 0;
    this.speedS = 0;
    this.dirF = 1; this.dirR = 0;
    this.drunkIdle = 0;

    // Motion history for the secondary layer.
    this.prevVx = 0; this.prevVz = 0;
    this.accelF = 0; this.accelR = 0;
    this.facing = 0;

    // IK runtime.
    this.footT = [new THREE.Vector3(), new THREE.Vector3()];      // L, R world targets
    this.footInit = false;
    this.footW = [0, 0];
    this.footDown = [false, false];
    this.footPrevY = [0, 0];
    this.hipDrop = 0;
    this.ikEnable = 0;
    this.handW = [0, 0];
    this.armLen = [0.55, 0.55];
    this.legLen = 0.87;
    this.scale = 1;
    this.floorY = 0;
    this.t = 0;
    this.baseScale = 1;
    this.ikScale = 1;
    this.attackName = null;
    this.stateLabel = 'IDLE';
    this.measure();
  }

  // Bone lengths come from the rig, so a different build still solves right.
  measure() {
    const len = (a, b) => (this.b[a] && this.b[b] ? this.b[b].position.length() : 0);
    const uaL = len(BI.upperArmL, BI.forearmL) + len(BI.forearmL, BI.handL);
    const uaR = len(BI.upperArmR, BI.forearmR) + len(BI.forearmR, BI.handR);
    if (uaL > 0.05) this.armLen[0] = uaL;
    if (uaR > 0.05) this.armLen[1] = uaR;
    const leg = len(BI.thighL, BI.shinL) + len(BI.shinL, BI.footL);
    if (leg > 0.1) this.legLen = leg;
  }

  // --- public contract -----------------------------------------------------

  play(name, opts = {}) {
    if (!name) return false;
    const state = STATES[name] ? name : CLIP_TO_STATE[name];
    if (!state) return false;
    if (STATES[state].prio >= 5) this.attackName = STATES[state].upper || null;
    return this.sm.go(state, !!opts.force);
  }

  // 'upper' and 'hit' address both slots of that channel at once.
  setLayerWeight(name, w) {
    const v = clamp01(w);
    if (name === 'upper' || name === 'attack') { this.stack.setUserScale('upperA', v); this.stack.setUserScale('upperB', v); return; }
    if (name === 'hit' || name === 'reaction') { this.stack.setUserScale('hitA', v); this.stack.setUserScale('hitB', v); return; }
    if (name === 'locomotion' || name === 'base') { this.baseScale = v; return; }
    if (name === 'ik') { this.ikScale = v; return; }
    if (name === 'drunk' || name === 'look' || name === 'secondary') { this.stack.setUserScale(name, v); return; }
    this.stack.setUserScale(name, v);
  }

  get state() { return this.sm.cur.name; }
  get label() { return this.stateLabel; }

  // --- channels ------------------------------------------------------------

  onEnterState(def) {
    if (def.upper) this.playChannel(def.channel, def.upper, def);
    for (const key in this.chan) {
      if (def.upper && def.channel === key) continue;
      this.releaseChannel(key, def.layerOut);
    }
  }

  playChannel(key, clipName, def) {
    const ch = this.chan[key];
    const clip = CLIPS[clipName];
    if (!ch || !clip) return;
    const next = ch.cur ^ 1;
    const outName = ch.names[ch.cur], inName = ch.names[next];
    const out = this.stack.get(outName), inc = this.stack.get(inName);
    out.target = 0;
    out.rate = 3 / Math.max(0.02, def.layerOut);
    ch.slots[next].clip = clip;
    ch.slots[next].t = 0;
    ch.slots[next].def = def;
    inc.mask = def.mask === 'kick' ? MASK_KICK : def.mask === 'hit' ? MASK_HIT : MASK_UPPER;
    inc.rate = 3 / Math.max(0.02, def.layerIn);
    inc.target = 1;
    ch.cur = next;
  }

  releaseChannel(key, outTime = 0.15) {
    const ch = this.chan[key];
    if (!ch) return;
    for (const n of ch.names) {
      const l = this.stack.get(n);
      if (l.target !== 0) { l.target = 0; l.rate = 3 / Math.max(0.02, outTime); }
    }
  }

  // --- locomotion blendspace ----------------------------------------------

  updateLocomotion(dt, speed, dirF, dirR, drunk) {
    const gait = clamp01(speed / (WALK_SPEED * 0.92));
    const run01 = clamp01((speed - WALK_SPEED) / (RUN_SPEED - WALK_SPEED));
    const stride = lerp(WALK_STRIDE, RUN_STRIDE, run01);
    // The cycle idles slowly when standing so a step never starts frozen.
    const rate = lerp(0.85, Math.max(0.25, speed / stride), gait);
    this.phase += dt * rate * (1 - this.drunkL.footLag * 1.2);
    if (this.phase >= 1) this.phase -= Math.floor(this.phase);

    let nf = Math.max(0, dirF), nb = Math.max(0, -dirF);
    let nl = Math.max(0, -dirR), nr = Math.max(0, dirR);
    const sum = nf + nb + nl + nr;
    if (sum < 1e-4) nf = 1; else { nf /= sum; nb /= sum; nl /= sum; nr /= sum; }

    // Drunk fighters idle differently: the sober guard gives way to a sway.
    this.drunkIdle = expDamp(this.drunkIdle, smoothstep((drunk - 0.22) / 0.4), 2.5, dt);
    const di = this.drunkIdle;

    const p = this.phase;
    const out = this.loco;
    zeroPose(out);
    const idleW = 1 - gait;
    if (idleW > 0.001) {
      if (di < 0.999) accumPose(out, sampleClip(CLIPS.idleGuard, this.t, zeroPose(this.scratch)), idleW * (1 - di));
      if (di > 0.001) accumPose(out, sampleClip(CLIPS.idleDrunk, this.t, zeroPose(this.scratch)), idleW * di);
    }
    if (gait > 0.001) {
      const wf = gait * nf;
      if (wf > 0.001) {
        if (run01 < 0.999) accumPose(out, sampleClip(CLIPS.walk, p * CLIPS.walk.duration, zeroPose(this.scratch)), wf * (1 - run01));
        if (run01 > 0.001) accumPose(out, sampleClip(CLIPS.run, p * CLIPS.run.duration, zeroPose(this.scratch)), wf * run01);
      }
      if (nb * gait > 0.001) accumPose(out, sampleClip(CLIPS.backstep, p * CLIPS.backstep.duration, zeroPose(this.scratch)), gait * nb);
      if (nl * gait > 0.001) accumPose(out, sampleClip(CLIPS.strafeL, p * CLIPS.strafeL.duration, zeroPose(this.scratch)), gait * nl);
      if (nr * gait > 0.001) accumPose(out, sampleClip(CLIPS.strafeR, p * CLIPS.strafeR.duration, zeroPose(this.scratch)), gait * nr);
    }
    return out;
  }

  sampleBase(def, t, out) {
    if (def.kind === 'full' && def.clip) {
      const clip = CLIPS[def.clip];
      const time = clip.loop ? t : Math.min(t, clip.duration);
      sampleClip(clip, time, zeroPose(out));
    } else {
      copyPose(out, this.loco);
    }
    return out;
  }

  // --- the frame -----------------------------------------------------------

  update(dt, state = {}) {
    if (!(dt > 0)) dt = 0.0001;
    if (dt > 0.1) dt = 0.1;
    this.t += dt;

    const drunk = norm01(state.drunk, 0);
    const stamina = norm01(state.stamina, 1);
    const health = norm01(state.health, 1);
    const speed = Math.max(0, state.speed ?? 0);
    const grounded = state.grounded !== false;
    const downed = !!state.downed;
    const ko = !!state.ko || (state.health !== undefined && health <= 0.001);

    // Facing and local move direction, when the caller gives us enough to know.
    const facing = state.facing ?? (this.group?.parent ? this.group.parent.rotation.y : this.facing);
    const sinF = Math.sin(facing), cosF = Math.cos(facing);
    let vx = 0, vz = 0;
    if (state.velocity) { vx = state.velocity.x; vz = state.velocity.z; }
    else { vx = sinF * speed; vz = cosF * speed; }
    let dirF = 1, dirR = 0;
    const sp = Math.hypot(vx, vz);
    if (sp > 0.05) {
      dirF = (vx * sinF + vz * cosF) / sp;
      dirR = (vx * cosF - vz * sinF) / sp;
    }
    this.dirF = expDamp(this.dirF, dirF, 10, dt);
    this.dirR = expDamp(this.dirR, dirR, 10, dt);

    // Acceleration in the fighter's own frame, for the weight shift.
    const ax = (vx - this.prevVx) / dt, az = (vz - this.prevVz) / dt;
    this.prevVx = vx; this.prevVz = vz;
    this.accelF = expDamp(this.accelF, ax * sinF + az * cosF, 14, dt);
    this.accelR = expDamp(this.accelR, ax * cosF - az * sinF, 14, dt);
    this.facing = facing;

    // --- state machine ---------------------------------------------------
    const stun = state.stun ?? 0;
    this.sm.update(dt, {
      speed, blocking: !!state.blocking, downed, ko, stun,
      stagger: !!state.stagger, downedForward: !!state.downedForward
    });
    this.stateLabel = this.sm.cur.label;

    // --- base ------------------------------------------------------------
    this.updateLocomotion(dt, speed, this.dirF, this.dirR, drunk);
    this.sampleBase(this.sm.cur, this.sm.t, this.base);
    let basePose = this.base;
    if (this.sm.prev && this.sm.blend < 1) {
      this.sampleBase(this.sm.prev, this.sm.prevT, this.prevBase);
      lerpPose(this.final, this.prevBase, this.base, smoothstep(this.sm.blend));
      basePose = this.final;
    } else if (basePose !== this.final) {
      copyPose(this.final, basePose);
      basePose = this.final;
    }

    // --- additive channels ------------------------------------------------
    this.stack.update(dt);
    let ikwHandL = 0, ikwHandR = 0;
    for (const key in this.chan) {
      const ch = this.chan[key];
      for (let i = 0; i < 2; i++) {
        const slot = ch.slots[i];
        const layer = this.stack.get(ch.names[i]);
        if (!slot.clip) { zeroPose(layer.pose); continue; }
        slot.t += dt;
        const w = layer.effective;
        if (w <= 0.0005) { zeroPose(layer.pose); continue; }
        const held = slot.def && slot.def.hold;
        const time = held ? Math.min(slot.t, slot.clip.duration) : slot.t;
        sampleClip(slot.clip, time, zeroPose(this.scratch));
        subPose(layer.pose, this.scratch, GUARD_POSE);
        ikwHandL += this.scratch[OFF_IKW + IK_HAND_L] * w;
        ikwHandR += this.scratch[OFF_IKW + IK_HAND_R] * w;
      }
    }

    // Drunk layer: its own sway plus the balance spring, weight follows buzz.
    const dl = this.stack.get('drunk');
    dl.target = downed || ko ? 0 : drunk;
    const lurched = this.drunkL.update(dt, dl.effective > 0.001 ? drunk : 0, state, dl.pose);
    if (lurched) bus.emit(EV.STUMBLE, { poser: this, drunk, position: this.stepPosition() });

    // Secondary motion. Always on, but it backs off while the body is down.
    const downW = downed || ko ? 1 : 0;
    const sec = this.stack.get('secondary');
    sec.target = downed || ko ? 0.25 : 1;
    this.secondary.update(dt, {
      facing, accelF: this.accelF, accelR: this.accelR,
      speed01: clamp01(speed / RUN_SPEED), stamina01: stamina, health01: health,
      downWeight: downW
    }, sec.pose);

    // Fold the additive stack down onto the base.
    this.stack.apply(basePose);

    // --- look at -----------------------------------------------------------
    const look = this.stack.get('look');
    zeroPose(look.pose);
    const tgt = state.target && (state.target.isVector3 ? state.target : state.target.position);
    if (tgt && !downed && !ko) {
      const head = this.b[BI.head];
      if (head) {
        head.getWorldPosition(_v1);
        _v2.copy(tgt).sub(_v1);
        const wantYaw = wrapAngle(Math.atan2(_v2.x, _v2.z) - facing) + this.drunkL.lookError;
        const flat = Math.hypot(_v2.x, _v2.z);
        const wantPitch = Math.atan2(_v2.y + 0.1, Math.max(0.2, flat));
        // Subtract what the pose already turned, so look at only adds the rest.
        const poseYaw = basePose[BI.hips * 3 + 1] + basePose[BI.spine * 3 + 1] + basePose[BI.chest * 3 + 1];
        this.lookAt.update(dt, wantYaw - poseYaw, wantPitch, lerp(9, 3.5, drunk), look.pose);
        look.target = this.drunkL.lookScale;
      }
    } else {
      look.target = 0;
    }
    if (look.effective > 0.0005) {
      for (let i = 0; i < NB; i++) {
        const m = MASK_HEAD[i] * look.effective;
        if (m === 0) continue;
        const o = i * 3;
        basePose[o] += look.pose[o] * m;
        basePose[o + 1] += look.pose[o + 1] * m;
        basePose[o + 2] += look.pose[o + 2] * m;
      }
    }

    // setLayerWeight('locomotion', w) turns the animation down toward the
    // stance rather than toward an empty T pose.
    if (this.baseScale < 0.999) lerpPose(basePose, GUARD_POSE, basePose, this.baseScale);

    // --- commit ------------------------------------------------------------
    this.applyPose(basePose);
    this.solveIK(dt, state, basePose, { drunk, downed, ko, grounded, speed, ikwHandL, ikwHandR });
  }

  applyPose(pose) {
    for (let i = 0; i < NB; i++) {
      const bone = this.b[i];
      if (!bone) continue;
      const o = i * 3;
      bone.rotation.set(pose[o], pose[o + 1], pose[o + 2], BONE_ORDER[i]);
    }
    const hips = this.b[BI.hips];
    if (hips) {
      hips.position.set(
        this.restHip.x + pose[OFF_HIP],
        this.restHip.y + pose[OFF_HIP + 1],
        this.restHip.z + pose[OFF_HIP + 2]
      );
    }
  }

  stepPosition() {
    const hips = this.b[BI.hips];
    if (hips) hips.getWorldPosition(_step); else _step.set(0, 0, 0);
    return _step;
  }

  // --- IK ------------------------------------------------------------------

  solveIK(dt, state, pose, ctx) {
    const group = this.group;
    if (!group) return;
    group.updateWorldMatrix(true, true);
    _v1.setFromMatrixColumn(group.matrixWorld, 0);
    this.scale = _v1.length() || 1;
    group.getWorldQuaternion(_q);
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    _right.set(1, 0, 0).applyQuaternion(_q);
    _up.set(0, 1, 0).applyQuaternion(_q);
    const groundY = state.floorY ?? 0;
    this.floorY = groundY;

    // The solver is off while the body is on the floor: the rig group pitch is
    // owned by combat code there, and planting to a flat plane would fight it.
    const wantIk = ctx.downed || ctx.ko || !ctx.grounded ? 0 : 1;
    this.ikEnable = expDamp(this.ikEnable, wantIk, wantIk > 0 ? 4 : 12, dt);
    const enable = this.ikEnable * (this.ikScale ?? 1);

    // --- legs -------------------------------------------------------------
    const ankle = ANKLE_H * this.scale;
    const sides = [
      { thigh: BI.thighL, shin: BI.shinL, foot: BI.footL, slot: IK_FOOT_L, i: 0, out: -1 },
      { thigh: BI.thighR, shin: BI.shinR, foot: BI.footR, slot: IK_FOOT_R, i: 1, out: 1 }
    ];
    let drop = 0;
    const release = this.footRelease();
    for (const s of sides) {
      const foot = this.b[s.foot];
      if (!foot) continue;
      foot.getWorldPosition(_v1);
      // Drunk feet land late and off line; the nudge rides in on the pose.
      _v2.copy(_v1);
      _v2.addScaledVector(_right, pose[OFF_IKT + s.slot * 3]);
      _v2.y = Math.max(_v1.y, groundY + ankle);
      if (!this.footInit) this.footT[s.i].copy(_v2);
      const lag = this.drunkL.footLag;
      const lambda = lag > 0.001 ? 1 / (0.012 + lag) : 60;
      this.footT[s.i].x = expDamp(this.footT[s.i].x, _v2.x, lambda, dt);
      this.footT[s.i].z = expDamp(this.footT[s.i].z, _v2.z, lambda, dt);
      this.footT[s.i].y = expDamp(this.footT[s.i].y, _v2.y, Math.max(lambda, 22), dt);
      const rel = s.i === 1 ? release : 0;
      this.footW[s.i] = enable * (1 - rel);
      if (this.footW[s.i] > 0.01) {
        drop = Math.max(drop, reachDeficit(this.b[s.thigh], this.footT[s.i], this.legLen, this.scale) * this.footW[s.i]);
      }
      this.trackPlant(s.i, s.i === 0 ? 'L' : 'R', _v1.y - groundY, ctx);
    }
    this.footInit = true;

    // Hip adjustment: the pelvis drops just enough for the longest leg to
    // reach without locking straight, which is what sells a planted foot.
    this.hipDrop = expDamp(this.hipDrop, Math.min(drop, 0.34 * this.scale), 16, dt);
    const hips = this.b[BI.hips];
    if (hips && this.hipDrop > 0.0005) {
      hips.position.y -= this.hipDrop / this.scale;
      group.updateWorldMatrix(false, true);
    }

    for (const s of sides) {
      if (this.footW[s.i] <= 0.01) continue;
      const thigh = this.b[s.thigh], shin = this.b[s.shin], foot = this.b[s.foot];
      if (!thigh || !shin || !foot) continue;
      thigh.getWorldPosition(_v1);
      // Knees bend forward and a touch outward, always.
      _pole.copy(_v1).addScaledVector(_fwd, 1.1).addScaledVector(_right, 0.22 * s.out).addScaledVector(_up, -0.25);
      solveTwoBone(thigh, shin, foot, this.footT[s.i], _pole, AXIS_LEG, this.footW[s.i], this.scale);
      levelFoot(foot, UP, this.footW[s.i] * 0.7);
    }

    // --- arms --------------------------------------------------------------
    const tgtObj = state.target && (state.target.isVector3 ? state.target : state.target.position);
    const arms = [
      { ua: BI.upperArmL, fa: BI.forearmL, hand: BI.handL, axis: AXIS_ARM_L, w: ctx.ikwHandL, i: 0, out: -1 },
      { ua: BI.upperArmR, fa: BI.forearmR, hand: BI.handR, axis: AXIS_ARM_R, w: ctx.ikwHandR, i: 1, out: 1 }
    ];
    for (const a of arms) {
      const w = clamp01(a.w) * (this.ikScale ?? 1);
      this.handW[a.i] = w;
      if (w <= 0.01) continue;
      const ua = this.b[a.ua], fa = this.b[a.fa], hand = this.b[a.hand];
      if (!ua || !fa || !hand) continue;
      ua.getWorldPosition(_v1);
      const body = this.attackName === 'kick';
      if (tgtObj) {
        _tgt.copy(tgtObj);
        _tgt.y = groundY + (body ? ARM_REACH_BODY : ARM_REACH_HEAD) * this.scale;
        // Drunk aim wanders, which is why a wasted fighter whiffs on camera.
        _tgt.addScaledVector(_right, this.drunkL.lookError * 0.45);
        _tgt.addScaledVector(_up, this.drunkL.lookError * 0.25);
      } else {
        // No opponent: punch straight out from the shoulder at full extension.
        hand.getWorldPosition(_tgt);
        _v3.copy(_tgt).sub(_v1);
        _tgt.copy(_v1).addScaledVector(_v3.normalize(), this.armLen[a.i] * this.scale * 0.97);
      }
      _v3.copy(_tgt).sub(_v1);
      const maxLen = this.armLen[a.i] * this.scale * 0.985;
      const len = _v3.length();
      if (len > maxLen) _tgt.copy(_v1).addScaledVector(_v3.multiplyScalar(1 / len), maxLen);
      // Elbows stay under the punch, never above it.
      _pole.copy(_v1).addScaledVector(_up, -0.9).addScaledVector(_fwd, -0.35).addScaledVector(_right, 0.35 * a.out);
      solveTwoBone(ua, fa, hand, _tgt, _pole, a.axis, w, this.scale);
    }
  }

  // The kicking foot has to leave the ground, so the plant is released across
  // the window the clip declares.
  footRelease() {
    const ch = this.chan.upper;
    let rel = 0;
    for (let i = 0; i < 2; i++) {
      const slot = ch.slots[i];
      if (!slot.clip || !slot.clip.release) continue;
      const w = this.stack.get(ch.names[i]).effective;
      if (w <= 0.001) continue;
      const r = slot.clip.release;
      if (slot.t < r.from || slot.t > r.to) continue;
      const span = Math.min(0.12, (r.to - r.from) * 0.3);
      const inW = clamp01((slot.t - r.from) / span);
      const outW = clamp01((r.to - slot.t) / span);
      rel = Math.max(rel, Math.min(inW, outW) * w);
    }
    return rel;
  }

  // Footsteps are detected geometrically rather than keyed, so a stagger, a
  // get up and a drunk stumble all report plants without any extra authoring.
  trackPlant(i, foot, height, ctx) {
    const wasDown = this.footDown[i];
    const prev = this.footPrevY[i];
    const down = height < 0.045;
    this.footDown[i] = down;
    this.footPrevY[i] = height;
    if (down && !wasDown) {
      const fall = Math.max(0, prev - height);
      const intensity = clamp01(0.3 + fall * 9 + ctx.speed * 0.14 + ctx.drunk * 0.2);
      const b = this.b[foot === 'L' ? BI.footL : BI.footR];
      if (b) b.getWorldPosition(_step);
      bus.emit(EV.FOOTSTEP, { position: _step, foot, intensity, drunk: ctx.drunk });
    }
  }
}

export { CLIP_NAMES, CLIPS };
