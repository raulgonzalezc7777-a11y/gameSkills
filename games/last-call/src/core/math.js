// Small, allocation-free math helpers shared by every subsystem.
export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b - a === 0 ? 0 : (v - a) / (b - a));
export const remap = (v, a, b, c, d) => lerp(c, d, clamp01(invLerp(a, b, v)));
export const smoothstep = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
export const smootherstep = (t) => { t = clamp01(t); return t * t * t * (t * (t * 6 - 15) + 10); };

// Framerate-independent exponential smoothing. 'rate' is "how much of the gap
// is closed per second"; at 0.99 the value is essentially snapped.
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.pow(1 - rate, dt * 60));
export const expDamp = (a, b, lambda, dt) => b + (a - b) * Math.exp(-lambda * dt);

export const wrapAngle = (a) => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};
export const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;
export const dampAngle = (a, b, lambda, dt) => a + wrapAngle(b - a) * (1 - Math.exp(-lambda * dt));

export const moveTowards = (a, b, maxDelta) => {
  const d = b - a;
  return Math.abs(d) <= maxDelta ? b : a + Math.sign(d) * maxDelta;
};

// Critically damped spring. Returns the new value and mutates 'state.v'.
export function spring(current, target, state, stiffness, dt) {
  const damping = 2 * Math.sqrt(stiffness);
  const accel = (target - current) * stiffness - state.v * damping;
  state.v += accel * dt;
  return current + state.v * dt;
}

export const pulse = (t, freq, phase = 0) => Math.sin(t * freq * TAU + phase);
export const tri = (t) => Math.abs(((t % 1) + 1) % 1 * 2 - 1);
