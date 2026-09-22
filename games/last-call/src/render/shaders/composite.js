import { GLSL_DEPTH, GLSL_COLOR } from './lib.js';

// Resolve pass: fold the two half-resolution buffers (AO, SSR) back onto the
// full-resolution HDR scene colour.
//
// The AO upsample is joint-bilateral against the full-res depth, not a plain
// bilinear stretch. A stretched half-res AO puts a two-pixel grey fringe around
// every fighter, which is the single most obvious "this is a screen-space
// effect" tell there is.
export const RESOLVE_FRAG = /* glsl */`
precision highp float;
${GLSL_DEPTH}
${GLSL_COLOR}

uniform sampler2D tColor;
uniform sampler2D tAO;     // R = ao, G = view Z it was computed at
uniform sampler2D tSSR;    // RGB = reflected colour, A = confidence
uniform sampler2D tDepth;
uniform vec2 uHalfTexel;   // 1 / half-res size
uniform float uNear;
uniform float uFar;
uniform float uAOStrength;
uniform float uSSRStrength;
uniform float uAOTint;     // how much AO leans blue-cold rather than neutral
varying vec2 vUv;

float upsampleAO(float centerZ) {
  float sum = 0.0;
  float wsum = 0.0;
  // Four taps around the pixel at half-res spacing. Weight each by how close
  // its recorded view Z is to ours, so taps from across a silhouette drop out.
  for (int y = -1; y <= 1; y += 2) {
    for (int x = -1; x <= 1; x += 2) {
      vec2 uv = vUv + vec2(float(x), float(y)) * uHalfTexel * 0.5;
      vec2 s = texture2D(tAO, uv).rg;
      float w = 1.0 / (1e-3 + abs(s.g - centerZ) * 4.0);
      sum += s.r * w;
      wsum += w;
    }
  }
  return wsum > 0.0 ? sum / wsum : 1.0;
}

void main() {
  vec3 color = texture2D(tColor, vUv).rgb;
  float depth = texture2D(tDepth, vUv).x;
  float viewZ = perspectiveDepthToViewZ(depth, uNear, uFar);

  float ao = 1.0;
  if (depth < 0.9999) ao = clamp(upsampleAO(viewZ), 0.0, 1.0);

  // AO is an approximation of occluded *ambient* light. Applying it at full
  // strength to a specular hit or an emissive tile would be wrong and looks it,
  // so back it off wherever the pixel is already bright.
  float bright = smoothstep(0.55, 3.0, luma(color));
  float strength = uAOStrength * mix(1.0, 0.22, bright);
  float occ = mix(1.0, ao, strength);

  // Shadowed crevices in a club are lit by the blue rim and the hemisphere, so
  // the darkening is very slightly cold rather than a neutral multiply.
  vec3 tint = mix(vec3(1.0), vec3(0.88, 0.95, 1.12), uAOTint);
  color *= mix(vec3(occ), vec3(occ) * tint, 1.0 - occ);

  // Reflections add energy: the floor's own shading stays, the neon lands on
  // top of it. Modulating instead would darken the floor wherever the SSR ray
  // missed, which shows up as blotches.
  vec4 ssr = texture2D(tSSR, vUv);
  color += ssr.rgb * ssr.a * uSSRStrength;

  gl_FragColor = vec4(color, 1.0);
}`;
