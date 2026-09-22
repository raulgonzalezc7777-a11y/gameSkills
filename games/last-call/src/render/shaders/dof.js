import { GLSL_DEPTH } from './lib.js';

// Circle-of-confusion model shared by the DOF prepass, the bokeh gather and the
// final composite. All three must agree on the CoC or the sharp and blurred
// layers blend against different ideas of where the focal plane is.
//
// Signed CoC: negative is the near field (between camera and focus), positive
// is the far field. gameplay drives uFocus via params.focusDistance, which the
// camera sets to the distance between the fighters.
export const GLSL_COC = /* glsl */`
uniform float uFocus;
uniform float uFocusRange;  // half-width of the fully sharp slab, metres
uniform float uNearRange;   // metres over which the near blur ramps in
uniform float uFarRange;
float cocFromDistance(float dist) {
  float farC  = clamp((dist - uFocus - uFocusRange) / max(uFarRange, 1e-3), 0.0, 1.0);
  float nearC = clamp((uFocus - uFocusRange - dist) / max(uNearRange, 1e-3), 0.0, 1.0);
  return farC - nearC;
}`;

// Half-res prepass: box-downsample the HDR colour and pack the CoC into alpha.
// Doing the depth work once here means the 28 tap gather never touches the
// depth buffer, which is where a naive bokeh spends most of its bandwidth.
export const DOF_PREPASS_FRAG = /* glsl */`
precision highp float;
${GLSL_DEPTH}
${GLSL_COC}

uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uTexel;   // 1 / full-res size
uniform float uNear;
uniform float uFar;
varying vec2 vUv;

void main() {
  vec2 o = uTexel * 0.5;
  vec3 c = texture2D(tColor, vUv + vec2( o.x,  o.y)).rgb;
  c += texture2D(tColor, vUv + vec2(-o.x,  o.y)).rgb;
  c += texture2D(tColor, vUv + vec2( o.x, -o.y)).rgb;
  c += texture2D(tColor, vUv + vec2(-o.x, -o.y)).rgb;
  c *= 0.25;

  float depth = texture2D(tDepth, vUv).x;
  float dist = -perspectiveDepthToViewZ(depth, uNear, uFar);
  float coc = depth >= 0.9999 ? 1.0 : cocFromDistance(dist);

  gl_FragColor = vec4(c, coc);
}`;

// Bokeh gather on a golden-angle spiral, warped toward a hexagonal aperture.
// A hex reads as a real iris: the crowd behind the fighters dissolves into
// overlapping hexagons around every neon highlight rather than into mush.
//
// TAPS arrives as a define.
export const DOF_BOKEH_FRAG = /* glsl */`
precision highp float;

uniform sampler2D tSource;   // half-res colour + CoC in alpha
uniform vec2 uTexel;         // 1 / half-res size
uniform float uMaxBlur;      // max radius in UV units at |coc| == 1
uniform float uHex;          // 0 circular aperture, 1 fully hexagonal
varying vec2 vUv;

const float GOLDEN = 2.39996323;

// Distance from the centre of a unit hexagon to its edge along 'angle'.
// Scaling the spiral radius by this squeezes the disc into an iris shape.
float hexEdge(float angle) {
  float a = mod(angle, 1.0471975512) - 0.5235987756; // fold into one 60 degree wedge
  return 0.8660254 / max(cos(a), 1e-3);
}

void main() {
  vec4 center = texture2D(tSource, vUv);
  float centerCoC = center.a;
  float radius = abs(centerCoC) * uMaxBlur;

  if (radius < uTexel.x * 0.75) {
    gl_FragColor = center;
    return;
  }

  vec3 sum = center.rgb;
  float wsum = 1.0;

  for (int i = 1; i < TAPS; i++) {
    float fi = float(i);
    float angle = fi * GOLDEN;
    // sqrt spacing distributes the taps evenly over the disc's area instead of
    // clustering them in the middle.
    float r = sqrt(fi / float(TAPS - 1));
    r *= mix(1.0, hexEdge(angle), uHex);

    vec2 offset = vec2(cos(angle), sin(angle)) * r * radius;
    vec4 s = texture2D(tSource, vUv + offset);

    // Scatter-as-gather: a tap only contributes if its own CoC is wide enough
    // to have splatted this far. Without this, sharp background pixels leak
    // into the blurred foreground and the fighters grow a halo.
    float tapDist = r * radius;
    float w = clamp((abs(s.a) * uMaxBlur - tapDist) / max(uTexel.x, 1e-5) + 1.0, 0.0, 1.0);

    // Foreground blur is allowed to bleed forward over sharp geometry, which is
    // what a real lens does. Background blur is not allowed to bleed backward.
    if (s.a < 0.0 && centerCoC >= 0.0) w = max(w, -s.a);

    sum += s.rgb * w;
    wsum += w;
  }

  gl_FragColor = vec4(sum / wsum, centerCoC);
}`;
