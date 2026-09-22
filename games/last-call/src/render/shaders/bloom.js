import { GLSL_COLOR } from './lib.js';

// Call of Duty: Advanced Warfare style bloom: a 6 level downsample chain with
// the 13 tap filter, then a 9 tap tent upsample that accumulates back up the
// pyramid. A single wide gaussian cannot do this: it either misses the broad,
// low-frequency halo that sells a room full of neon, or it hazes the entire
// frame trying to reach that radius.

// Threshold with a soft knee (Jimenez). A hard threshold makes the dance tiles
// pop in and out of bloom as they pulse; the knee lets them ramp.
// The first downsample also carries the Karis average, weighting each 2x2 group
// by 1/(1+luma) so one very bright speculum on a bottle cannot flicker into a
// full-screen firefly on the next frame.
export const BLOOM_PREFILTER_FRAG = /* glsl */`
precision highp float;
${GLSL_COLOR}

uniform sampler2D tSource;
uniform vec2 uTexel;      // 1 / source size
uniform float uThreshold;
uniform float uKnee;
uniform float uClamp;
varying vec2 vUv;

vec3 fetch(vec2 uv) {
  // NaNs and negatives out of a half-float HDR buffer poison the whole chain.
  return min(max(texture2D(tSource, uv).rgb, vec3(0.0)), vec3(uClamp));
}

float karisWeight(vec3 c) {
  return 1.0 / (1.0 + luma(c));
}

vec3 prefilter(vec3 c) {
  float br = maxc(c);
  float knee = max(uKnee, 1e-4);
  float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
  soft = (soft * soft) / (4.0 * knee);
  float contribution = max(soft, br - uThreshold) / max(br, 1e-4);
  return c * contribution;
}

void main() {
  // 13 tap: four 2x2 groups on the diagonals plus a centre group.
  vec2 t = uTexel;
  vec3 a = fetch(vUv + t * vec2(-2.0,  2.0));
  vec3 b = fetch(vUv + t * vec2( 0.0,  2.0));
  vec3 c = fetch(vUv + t * vec2( 2.0,  2.0));
  vec3 d = fetch(vUv + t * vec2(-2.0,  0.0));
  vec3 e = fetch(vUv);
  vec3 f = fetch(vUv + t * vec2( 2.0,  0.0));
  vec3 g = fetch(vUv + t * vec2(-2.0, -2.0));
  vec3 h = fetch(vUv + t * vec2( 0.0, -2.0));
  vec3 i = fetch(vUv + t * vec2( 2.0, -2.0));
  vec3 j = fetch(vUv + t * vec2(-1.0,  1.0));
  vec3 k = fetch(vUv + t * vec2( 1.0,  1.0));
  vec3 l = fetch(vUv + t * vec2(-1.0, -1.0));
  vec3 m = fetch(vUv + t * vec2( 1.0, -1.0));

  vec3 g0 = (j + k + l + m) * 0.25;
  vec3 g1 = (a + b + d + e) * 0.25;
  vec3 g2 = (b + c + e + f) * 0.25;
  vec3 g3 = (d + e + g + h) * 0.25;
  vec3 g4 = (e + f + h + i) * 0.25;

  float w0 = karisWeight(g0) * 0.5;
  float w1 = karisWeight(g1) * 0.125;
  float w2 = karisWeight(g2) * 0.125;
  float w3 = karisWeight(g3) * 0.125;
  float w4 = karisWeight(g4) * 0.125;
  float wsum = max(w0 + w1 + w2 + w3 + w4, 1e-5);

  vec3 color = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / wsum;
  gl_FragColor = vec4(prefilter(color), 1.0);
}`;

// Plain 13 tap downsample for levels 1..5. No Karis here: the fireflies were
// already averaged away at level 0, and re-weighting every level would eat the
// energy out of the broad halo.
export const BLOOM_DOWN_FRAG = /* glsl */`
precision highp float;

uniform sampler2D tSource;
uniform vec2 uTexel;
varying vec2 vUv;

void main() {
  vec2 t = uTexel;
  vec3 a = texture2D(tSource, vUv + t * vec2(-2.0,  2.0)).rgb;
  vec3 b = texture2D(tSource, vUv + t * vec2( 0.0,  2.0)).rgb;
  vec3 c = texture2D(tSource, vUv + t * vec2( 2.0,  2.0)).rgb;
  vec3 d = texture2D(tSource, vUv + t * vec2(-2.0,  0.0)).rgb;
  vec3 e = texture2D(tSource, vUv).rgb;
  vec3 f = texture2D(tSource, vUv + t * vec2( 2.0,  0.0)).rgb;
  vec3 g = texture2D(tSource, vUv + t * vec2(-2.0, -2.0)).rgb;
  vec3 h = texture2D(tSource, vUv + t * vec2( 0.0, -2.0)).rgb;
  vec3 i = texture2D(tSource, vUv + t * vec2( 2.0, -2.0)).rgb;
  vec3 j = texture2D(tSource, vUv + t * vec2(-1.0,  1.0)).rgb;
  vec3 k = texture2D(tSource, vUv + t * vec2( 1.0,  1.0)).rgb;
  vec3 l = texture2D(tSource, vUv + t * vec2(-1.0, -1.0)).rgb;
  vec3 m = texture2D(tSource, vUv + t * vec2( 1.0, -1.0)).rgb;

  vec3 color = e * 0.125;
  color += (a + c + g + i) * 0.03125;
  color += (b + d + f + h) * 0.0625;
  color += (j + k + l + m) * 0.125;
  gl_FragColor = vec4(color, 1.0);
}`;

// 3x3 tent upsample, added onto the next level up. uRadius in texels widens the
// tent, which is the knob that trades a tight glow for a room-filling haze.
export const BLOOM_UP_FRAG = /* glsl */`
precision highp float;

uniform sampler2D tSource;  // the smaller level
uniform sampler2D tTarget;  // the level we are adding into
uniform vec2 uTexel;        // 1 / source size
uniform float uRadius;
varying vec2 vUv;

void main() {
  vec2 t = uTexel * uRadius;
  vec3 a = texture2D(tSource, vUv + vec2(-t.x,  t.y)).rgb;
  vec3 b = texture2D(tSource, vUv + vec2( 0.0,  t.y)).rgb;
  vec3 c = texture2D(tSource, vUv + vec2( t.x,  t.y)).rgb;
  vec3 d = texture2D(tSource, vUv + vec2(-t.x,  0.0)).rgb;
  vec3 e = texture2D(tSource, vUv).rgb;
  vec3 f = texture2D(tSource, vUv + vec2( t.x,  0.0)).rgb;
  vec3 g = texture2D(tSource, vUv + vec2(-t.x, -t.y)).rgb;
  vec3 h = texture2D(tSource, vUv + vec2( 0.0, -t.y)).rgb;
  vec3 i = texture2D(tSource, vUv + vec2( t.x, -t.y)).rgb;

  vec3 blur = e * 0.25;
  blur += (b + d + f + h) * 0.125;
  blur += (a + c + g + i) * 0.0625;

  gl_FragColor = vec4(texture2D(tTarget, vUv).rgb + blur, 1.0);
}`;
