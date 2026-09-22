import { GLSL_DEPTH, GLSL_HASH } from './lib.js';

// Screen-space reflections, view-space ray march with a binary-search refine.
//
// This is the highest-impact effect in the club: the dance floor is lacquered
// and beer-wet, so the neon and the fighters have to live in it. Without SSR the
// floor reads as matte paint no matter what roughness the material claims.
//
// We have no G-buffer roughness, only depth and view normals, so "which surfaces
// are mirrors" is decided geometrically: up-facing, below head height. That
// covers the dance floor, the bar top and spilled puddles, and deliberately
// excludes a fighter's shoulders, which would otherwise turn into chrome.
//
// STEPS and REFINE_STEPS arrive as defines so the loop bounds stay constant.
export const SSR_FRAG = /* glsl */`
precision highp float;
${GLSL_DEPTH}
${GLSL_HASH}

uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform mat4 uProj;
uniform mat4 uInvProj;
uniform mat4 uInvView;   // view -> world, for the height mask
uniform vec3 uUpView;    // world up expressed in view space
uniform vec2 uTexel;     // 1 / colour-buffer size
uniform float uNear;
uniform float uFar;
uniform float uMaxDistance;
uniform float uThickness;
uniform float uIntensity;
uniform float uRoughness;  // 0 mirror, 1 fully diffuse: drives the blur cone
uniform float uMaxHeight;  // world Y above which nothing reflects
uniform float uJitter;
varying vec2 vUv;

// Blur the reflected colour by how far the ray travelled. A real rough
// reflection widens with distance; a single sharp tap at 6 metres looks like a
// decal, not a wet floor.
vec3 sampleReflected(vec2 uv, float spread) {
  if (spread < 0.5) return texture2D(tColor, uv).rgb;
  vec2 o = uTexel * spread;
  vec3 c = texture2D(tColor, uv).rgb * 0.4;
  c += texture2D(tColor, uv + vec2( o.x,  0.0)).rgb * 0.15;
  c += texture2D(tColor, uv + vec2(-o.x,  0.0)).rgb * 0.15;
  c += texture2D(tColor, uv + vec2( 0.0,  o.y)).rgb * 0.15;
  c += texture2D(tColor, uv + vec2( 0.0, -o.y)).rgb * 0.15;
  return c;
}

void main() {
  float depth = texture2D(tDepth, vUv).x;
  if (depth >= 0.9999) { gl_FragColor = vec4(0.0); return; }

  vec3 packed = texture2D(tNormal, vUv).xyz;
  vec3 n = unpackNormal(packed);
  if (length(n) < 0.1) { gl_FragColor = vec4(0.0); return; }
  n = normalize(n);

  // Only near-horizontal surfaces get reflections, ramped rather than cut so
  // the edge of the dance floor does not show a hard mask boundary.
  float flatness = smoothstep(0.72, 0.94, dot(n, uUpView));
  if (flatness <= 0.001) { gl_FragColor = vec4(0.0); return; }

  vec3 origin = viewPosFromDepth(vUv, depth, uInvProj);

  float worldY = (uInvView * vec4(origin, 1.0)).y;
  float heightMask = 1.0 - smoothstep(uMaxHeight, uMaxHeight + 0.6, worldY);
  if (heightMask <= 0.001) { gl_FragColor = vec4(0.0); return; }

  vec3 viewDir = normalize(origin);        // camera sits at the view-space origin
  vec3 reflected = normalize(reflect(viewDir, n));

  // A ray heading back toward the camera can only hit geometry we already know
  // is in front of the surface, which is always a false positive.
  if (reflected.z > -0.02) { gl_FragColor = vec4(0.0); return; }

  float stepSize = uMaxDistance / float(STEPS);

  // Interleaved jitter breaks the marching cadence into noise instead of the
  // concentric rings a fixed step leaves on a flat floor.
  float noise = hash12(gl_FragCoord.xy + uJitter);

  float t = stepSize * (0.35 + noise * 0.65);
  float prevT = 0.0;
  float hitT = -1.0;
  vec2 hitUv = vec2(0.0);

  for (int i = 0; i < STEPS; i++) {
    vec3 p = origin + reflected * t;
    if (p.z > -uNear) break;

    vec4 clip = uProj * vec4(p, 1.0);
    vec2 uv = (clip.xy / clip.w) * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;

    float sceneZ = perspectiveDepthToViewZ(texture2D(tDepth, uv).x, uNear, uFar);
    float delta = sceneZ - p.z;   // positive once the ray is behind geometry

    if (delta > 0.0 && delta < uThickness) {
      hitT = t;
      hitUv = uv;
      break;
    }

    prevT = t;
    // Steps grow with distance: near the contact point we want precision,
    // far away we want reach, and a uniform step gives neither cheaply.
    t += stepSize * (1.0 + float(i) * 0.16);
  }

  if (hitT < 0.0) { gl_FragColor = vec4(0.0); return; }

  // Binary search between the last miss and the hit. Without it the reflection
  // of a fighter's leg lands a visible step-length away from the leg itself.
  float lo = prevT;
  float hi = hitT;
  for (int i = 0; i < REFINE_STEPS; i++) {
    float mid = (lo + hi) * 0.5;
    vec3 p = origin + reflected * mid;
    vec4 clip = uProj * vec4(p, 1.0);
    vec2 uv = (clip.xy / clip.w) * 0.5 + 0.5;
    float sceneZ = perspectiveDepthToViewZ(texture2D(tDepth, uv).x, uNear, uFar);
    if (sceneZ - p.z > 0.0) { hi = mid; hitUv = uv; } else { lo = mid; }
  }
  hitT = hi;

  // --- confidence ------------------------------------------------------
  // Screen edges: the information simply is not in the buffer, so fade out
  // rather than smear the border texel down the floor.
  vec2 edge = smoothstep(vec2(0.0), vec2(0.14), hitUv) *
              smoothstep(vec2(0.0), vec2(0.14), 1.0 - hitUv);
  float edgeFade = edge.x * edge.y;

  // Long rays are both less accurate and physically dimmer.
  float distFade = 1.0 - smoothstep(uMaxDistance * 0.45, uMaxDistance, hitT);

  // Schlick-ish: a wet floor is nearly black looking straight down and a mirror
  // at a grazing angle. This is what makes the reflection read as a surface
  // property instead of a pasted-on second image.
  float ndv = clamp(dot(n, -viewDir), 0.0, 1.0);
  float fresnel = mix(0.06, 1.0, pow(1.0 - ndv, 4.0));

  float spread = uRoughness * hitT * 26.0;
  vec3 color = sampleReflected(hitUv, spread);

  float alpha = edgeFade * distFade * fresnel * flatness * heightMask * uIntensity;
  gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
}`;
