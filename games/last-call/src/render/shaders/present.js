import { GLSL_COLOR, GLSL_HASH, GLSL_DEPTH } from './lib.js';
import { GLSL_COC } from './dof.js';

// The one pass the player actually sees. It takes the composited HDR scene,
// folds in the bloom chain and the bokeh buffer, then does every purely
// perceptual thing at once: FXAA, drunk warp, chromatic aberration, ACES,
// grading, vignette and grain. Doing them in a single pass is not only cheaper,
// it is the only way to keep the order honest: grain must land after the tone
// curve, and the warp must happen before anything samples a neighbour.
export const PRESENT_FRAG = /* glsl */`
precision highp float;
${GLSL_DEPTH}
${GLSL_COLOR}
${GLSL_HASH}
${GLSL_COC}

uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform sampler2D tBokeh;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform float uNear, uFar;
uniform float uTime;
uniform float uExposure;
uniform float uBloomStrength;
uniform float uGrain;
uniform float uVignette;
uniform float uChromatic;
uniform float uDrunk;
uniform float uSaturation;
uniform float uContrast;
uniform float uLift, uGamma, uGain;
uniform float uTemperature;
uniform float uFxaa;
uniform vec3 uShadowTint, uHighlightTint;
varying vec2 vUv;

float viewZAt(vec2 uv) {
  return perspectiveDepthToViewZ(texture2D(tDepth, uv).x, uNear, uFar);
}

// Compact FXAA. Full 3.11 is overkill here: the renderer has MSAA off, but the
// post chain already softens everything, so all this has to catch is the hard
// stair-step on a neon tube against black.
vec3 fxaa(vec2 uv) {
  vec3 rgbM = texture2D(tColor, uv).rgb;
  if (uFxaa < 0.5) return rgbM;
  vec3 rgbNW = texture2D(tColor, uv + vec2(-1.0, -1.0) * uTexel).rgb;
  vec3 rgbNE = texture2D(tColor, uv + vec2( 1.0, -1.0) * uTexel).rgb;
  vec3 rgbSW = texture2D(tColor, uv + vec2(-1.0,  1.0) * uTexel).rgb;
  vec3 rgbSE = texture2D(tColor, uv + vec2( 1.0,  1.0) * uTexel).rgb;
  float lNW = luma(rgbNW), lNE = luma(rgbNE), lSW = luma(rgbSW), lSE = luma(rgbSE), lM = luma(rgbM);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  if (lMax - lMin < max(0.035, lMax * 0.14)) return rgbM;

  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, -8.0, 8.0) * uTexel;

  vec3 rgbA = 0.5 * (texture2D(tColor, uv + dir * (1.0 / 3.0 - 0.5)).rgb +
                     texture2D(tColor, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (texture2D(tColor, uv + dir * -0.5).rgb +
                                   texture2D(tColor, uv + dir * 0.5).rgb);
  float lB = luma(rgbB);
  return (lB < lMin || lB > lMax) ? rgbA : rgbB;
}

// Lift/gamma/gain, the grade every colourist reaches for first.
vec3 gradeLGG(vec3 c) {
  c = c * uGain + uLift;
  return pow(max(c, vec3(0.0)), vec3(1.0 / max(uGamma, 1e-3)));
}

void main() {
  vec2 c = vUv - 0.5;
  float r2 = dot(c, c);

  // Drunk warp: a barrel push outward plus a slow swim. It runs first so every
  // later sample, including the ghost, lands in the warped frame.
  vec2 uv = vUv;
  if (uDrunk > 0.001) {
    // The barrel push, the swim and the roll all move the corners outward,
    // and a sample past the edge clamps into a smeared streak. Zooming in by
    // the worst case keeps every sample on screen.
    c *= 1.0 / (1.0 + uDrunk * 0.16);
    r2 = dot(c, c);
    uv = 0.5 + c * (1.0 + uDrunk * 0.18 * r2)
       + vec2(sin(uTime * 0.83), cos(uTime * 0.61)) * 0.006 * uDrunk;
    float roll = sin(uTime * 0.37) * 0.035 * uDrunk;
    float s = sin(roll), co = cos(roll);
    vec2 p = uv - 0.5;
    uv = 0.5 + vec2(p.x * co - p.y * s, p.x * s + p.y * co);
  }

  // Chromatic aberration scales with distance from centre, the way a real lens
  // does, and the drunk layer multiplies it hard.
  // A 7x multiplier put 13 pixels of RGB separation at the frame edge, which
  // is the rubric's "aberration as a mask for missing detail" verbatim.
  float ca = uChromatic * (1.0 + uDrunk * 2.5);
  vec3 col;
  if (ca > 0.00001) {
    col.r = fxaa(uv + c * ca).r;
    col.g = fxaa(uv).g;
    col.b = fxaa(uv - c * ca).b;
  } else {
    col = fxaa(uv);
  }

  // Depth of field: mix the sharp frame with the half-res bokeh buffer by the
  // coverage of the circle of confusion at this pixel.
  float viewZ = viewZAt(uv);
  float coc = cocFromDistance(-viewZ);
  if (abs(coc) > 0.01) {
    vec3 blurred = texture2D(tBokeh, uv).rgb;
    col = mix(col, blurred, smoothstep(0.0, 0.85, abs(coc)));
  }

  // Double vision. The ghost is taken after DOF so it inherits the blur, which
  // is what stops it reading as a cheap offset copy.
  if (uDrunk > 0.02) {
    // Double vision belongs at the edge of the eye, not on the thing you are
    // trying to punch. Keeping the centre single is what lets the effect go
    // hard without costing the silhouette.
    vec2 g = vec2(sin(uTime * 1.31), cos(uTime * 0.97)) * 0.012 * uDrunk;
    vec3 ghost = texture2D(tColor, uv + g).rgb;
    float edge = smoothstep(0.22, 0.72, length(c));
    col = mix(col, max(col, ghost), uDrunk * 0.32 * edge);
  }

  col += texture2D(tBloom, uv).rgb * uBloomStrength;

  // The ACES fit expects middle grey at about 0.18 * (1/0.6). Skipping this
  // pre-scale is what makes a hand-rolled ACES pass look 1.7 stops darker than
  // the engine's built-in tone mapping, which is exactly the bug it caused here.
  col *= uExposure / 0.6;

  // Split tone before the curve: cold in the shadows, warm in the highlights,
  // which is the grade a neon room wants.
  float l = luma(col);
  vec3 splitLo = mix(vec3(1.0), uShadowTint, smoothstep(0.5, 0.0, l));
  vec3 splitHi = mix(vec3(1.0), uHighlightTint, smoothstep(0.35, 1.6, l));
  col *= splitLo * splitHi;

  // Temperature: a simple channel tilt, positive is warmer.
  col *= vec3(1.0 + uTemperature * 0.28, 1.0, 1.0 - uTemperature * 0.28);

  col = ACESFitted(col);
  col = gradeLGG(col);

  l = luma(col);
  col = mix(vec3(l), col, uSaturation);
  col = clamp((col - 0.5) * uContrast + 0.5, 0.0, 1.0);

  float vig = smoothstep(1.05, 0.22, length(c) * (1.0 + uDrunk * 0.4));
  col *= mix(1.0, vig, uVignette);

  // Grain is weighted toward the midtones. Uniform grain over a blown highlight
  // is the tell of a filter rather than a film stock.
  float g = hash12(gl_FragCoord.xy + fract(uTime) * 311.7) - 0.5;
  col += g * uGrain * (0.35 + 1.3 * l * (1.0 - l) * 4.0 * 0.25);

  gl_FragColor = vec4(linearToSRGB(col), 1.0);
}`;
