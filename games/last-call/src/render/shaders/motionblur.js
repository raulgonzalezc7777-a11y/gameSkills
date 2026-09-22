import { GLSL_DEPTH, GLSL_HASH } from './lib.js';

// Camera-reprojection motion blur.
//
// The velocity buffer is derived from depth rather than rasterised from a
// second geometry pass with previous-frame model matrices: Three gives no hook
// for per-object previous transforms without patching materials this module
// does not own, and in a third-person brawler the camera is what moves. Whip
// pans, dodges and the hit-reaction shake all reproject correctly here; a
// fighter's fist crossing a static frame does not, and that is the documented
// trade.
//
// SAMPLES arrives as a define (CFG.post.motionBlur.samples).
export const MOTION_BLUR_FRAG = /* glsl */`
precision highp float;
${GLSL_DEPTH}
${GLSL_HASH}

uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform float uStrength;
uniform float uMaxVelocity;  // in UV units, hard ceiling on the smear
uniform float uJitter;
varying vec2 vUv;

void main() {
  float depth = texture2D(tDepth, vUv).x;
  vec3 color = texture2D(tColor, vUv).rgb;

  // The sky has no surface to reproject and would otherwise take the velocity
  // of the far plane, which is enormous.
  if (depth >= 0.9999) { gl_FragColor = vec4(color, 1.0); return; }

  vec4 clip = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 world = uInvViewProj * clip;
  world /= world.w;

  vec4 prevClip = uPrevViewProj * world;
  vec2 prevUv = (prevClip.xy / prevClip.w) * 0.5 + 0.5;

  vec2 velocity = (vUv - prevUv) * uStrength;

  // Clamp before anything else. A round reset teleports the camera and would
  // otherwise smear the entire frame into a grey wash for one frame.
  float speed = length(velocity);
  if (speed < 1e-4) { gl_FragColor = vec4(color, 1.0); return; }
  velocity *= min(speed, uMaxVelocity) / speed;

  // Jitter the tap positions so the blur dissolves into grain rather than
  // showing SAMPLES discrete ghosts of a bright neon strip.
  float offset = hash12(gl_FragCoord.xy + uJitter) - 0.5;

  vec3 sum = color;
  float count = 1.0;
  for (int i = 1; i < SAMPLES; i++) {
    float t = (float(i) + offset) / float(SAMPLES - 1) - 0.5;
    vec2 uv = vUv + velocity * t;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) continue;
    sum += texture2D(tColor, uv).rgb;
    count += 1.0;
  }

  gl_FragColor = vec4(sum / count, 1.0);
}`;
