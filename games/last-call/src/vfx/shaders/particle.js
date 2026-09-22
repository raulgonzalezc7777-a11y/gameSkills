// One shader pair drives every pooled particle system. The mode is a compile
// time #define rather than a uniform branch, because a club scene runs eight of
// these at once and a dynamically uniform branch still costs register pressure
// on the tile-based GPUs this ships to.
//
// Simulation lives entirely in the vertex shader. Each instance stores only its
// spawn state (position, velocity, birth time, seed) and the motion is
// evaluated in closed form from age, so the CPU never touches a particle again
// after it is written once. That is what lets `emit` stay allocation free and
// `update` stay O(systems) instead of O(particles).

// Closed form ballistic with linear drag:
//   v(t) = (v0 - g/k) e^(-kt) + g/k
//   p(t) = p0 + (v0 - g/k)(1 - e^(-kt))/k + (g/k) t
// Exact, one exp, and it gives a real terminal velocity so foam and smoke slow
// down the way they should instead of accelerating forever.
const SIM = /* glsl */`
  float age = uTime - aLife.x;
  float life = max(aLife.y, 0.0001);
  float t01 = age / life;
  float alive = step(0.0, age) * step(t01, 1.0);

  float k = max(aDyn.y, 0.0001);
  vec3 termV = vec3(0.0, -aDyn.x / k, 0.0);
  float ee = exp(-k * age);
  vec3 p = aPos + (aVel - termV) * (1.0 - ee) / k + termV * age;
  vec3 vel = (aVel - termV) * ee + termV;

  // Flutter: the lateral wander that separates confetti and mist from gravel.
  if (aExtra.w > 0.0001) {
    float ff = 3.4 + aLife.z * 5.0;
    float amp = aExtra.w * min(age * 3.0, 1.0);
    p.x += sin(age * ff + aLife.z * 31.0) * amp;
    p.z += cos(age * ff * 0.83 + aLife.z * 17.0) * amp;
    p.y += sin(age * ff * 1.7 + aLife.z * 7.0) * amp * 0.25;
    vel.x += cos(age * ff + aLife.z * 31.0) * amp * ff;
    vel.z -= sin(age * ff * 0.83 + aLife.z * 17.0) * amp * ff * 0.83;
  }
`;

const COMMON_VARY = /* glsl */`
varying vec2 vUv;
varying vec3 vColor;
varying vec3 vColor2;
varying float vAlpha;
varying float vBright;
varying float vSeed;
varying float vAge;
varying float vSoft;
varying float vViewZ;
`;

const LIGHT_UNIFORMS = /* glsl */`
uniform vec3 uKeyDir;      // all light vectors arrive pre-transformed to view space
uniform vec3 uKeyColor;
uniform vec3 uFillDir;
uniform vec3 uFillColor;
uniform vec3 uRimDirA;
uniform vec3 uRimColA;
uniform vec3 uRimDirB;
uniform vec3 uRimColB;
uniform vec3 uAmbient;
`;

const DEPTH_UNIFORMS = /* glsl */`
uniform sampler2D uDepth;
uniform float uHasDepth;
uniform vec2 uResolution;
uniform float uCamNear;
uniform float uCamFar;
uniform float uSoftness;

float vfxLinearDepth(float d) {
  float z = d * 2.0 - 1.0;
  return (2.0 * uCamNear * uCamFar) / (uCamFar + uCamNear - z * (uCamFar - uCamNear));
}

// Soft particles. With a real depth target we fade where the billboard
// intersects scene geometry. Without one we fall back to the analytic floor
// distance computed in the vertex shader, which covers the case that actually
// matters here (puffs sitting on the dance floor).
float vfxSoft() {
  if (uHasDepth < 0.5) return vSoft;
  vec2 suv = gl_FragCoord.xy / uResolution;
  float sceneZ = vfxLinearDepth(texture2D(uDepth, suv).x);
  return clamp((sceneZ - vViewZ) / uSoftness, 0.0, 1.0) * vSoft;
}
`;

export const PARTICLE_VERT = /* glsl */`
attribute vec3 aPos;
attribute vec3 aVel;
attribute vec4 aLife;   // x birth, y lifetime, z seed, w size start
attribute vec4 aDyn;    // x gravity, y drag, z size end, w spin
attribute vec3 aColor;
attribute vec3 aColor2;
attribute vec4 aExtra;  // x opacity, y brightness, z stretch, w flutter

uniform float uTime;
uniform float uFloorY;
uniform float uScale;

${COMMON_VARY}
#if defined(MODE_FLAKE) || defined(MODE_SHARD)
varying vec3 vNormal;
#endif

void main() {
${SIM}

  vUv = uv;
  vColor = aColor;
  vColor2 = aColor2;
  vBright = aExtra.y;
  vSeed = aLife.z;
  vAge = clamp(t01, 0.0, 1.0);

#if defined(MODE_RING) || defined(MODE_FLASH)
  // Impact cards expand fast then hold, so an ease-out on the radius.
  float grow = 1.0 - pow(1.0 - vAge, 2.4);
  float sz = mix(aLife.w, aDyn.z, grow) * uScale;
  float fade = pow(1.0 - vAge, 1.7);
#elif defined(MODE_ADDITIVE)
  float sz = mix(aLife.w, aDyn.z, vAge) * uScale;
  float fade = pow(1.0 - vAge, 2.3);
#else
  float sz = mix(aLife.w, aDyn.z, vAge) * uScale;
  float fade = smoothstep(0.0, 0.10, vAge) * (1.0 - smoothstep(0.55, 1.0, vAge));
#endif

  // Ground contact. Liquids skid to a halt and hand off to a decal, puffs
  // spread rather than tunnelling through the floor.
#ifdef FLOOR_STICK
  float minY = uFloorY + sz * 0.35;
  float contact = 1.0 - smoothstep(minY, minY + sz * 1.6, p.y);
  p.y = max(p.y, minY);
  #ifdef MODE_SMOKE
    sz *= 1.0 + contact * 0.45;
  #else
    fade *= 1.0 - contact * 0.85;
  #endif
  vSoft = smoothstep(0.0, sz * 1.1, p.y - uFloorY);
#else
  vSoft = 1.0;
#endif

  vAlpha = aExtra.x * fade * alive;

#if defined(MODE_FLAKE) || defined(MODE_SHARD)
  // Two independent rotation rates give a genuine tumble instead of a spin
  // about one axis, which is the whole reason confetti reads as confetti.
  float ra = aLife.z * 6.2831 + age * aDyn.w;
  float rb = aLife.z * 11.13 + age * aDyn.w * 0.71;
  vec3 nrm = vec3(sin(ra) * cos(rb), sin(rb), cos(ra) * cos(rb));
  vec3 tx = normalize(cross(nrm, vec3(0.31, 0.07, 0.95)));
  vec3 ty = cross(nrm, tx);
  #ifdef MODE_FLAKE
    vec3 wp = p + (tx * position.x + ty * position.y * 0.58) * sz;
  #else
    vec3 wp = p + (tx * position.x + ty * position.y) * sz;
  #endif
  vec4 mv = modelViewMatrix * vec4(wp, 1.0);
  vNormal = normalMatrix * nrm;

#elif defined(RING_GROUND)
  // Floor aligned ring: lives in world XZ, never faces the camera.
  vec3 wp = p + vec3(position.x, 0.0, -position.y) * sz;
  vec4 mv = modelViewMatrix * vec4(wp, 1.0);

#else
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec2 corner = position.xy * sz;
  #ifdef STRETCH
    // Velocity stretched quad: elongate along the screen space velocity so a
    // spark reads as a streak and a beer droplet reads as a thrown strand.
    vec3 vv = (modelViewMatrix * vec4(vel, 0.0)).xyz;
    float sp = length(vv.xy);
    vec2 dir = sp > 0.0001 ? vv.xy / sp : vec2(0.0, 1.0);
    vec2 perp = vec2(-dir.y, dir.x);
    float st = 1.0 + aExtra.z * min(sp, 24.0);
    mv.xy += perp * corner.x + dir * corner.y * st;
  #else
    float rot = aLife.z * 6.2831 + age * aDyn.w;
    float cr = cos(rot), sr = sin(rot);
    mv.xy += vec2(corner.x * cr - corner.y * sr, corner.x * sr + corner.y * cr);
  #endif
#endif

  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
  // Park dead instances outside the clip volume; cheaper than CPU compaction.
  if (alive < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

export const PARTICLE_FRAG = /* glsl */`
${COMMON_VARY}
${LIGHT_UNIFORMS}
${DEPTH_UNIFORMS}
#if defined(MODE_FLAKE) || defined(MODE_SHARD)
varying vec3 vNormal;
#endif

const vec3 VIEWDIR = vec3(0.0, 0.0, 1.0);

// Wrap-lit response for a billboard pretending to be a sphere. The half-lambert
// wrap keeps the shadow side from going pure black, which is what makes flat
// quads look like cardboard.
vec3 vfxLight(vec3 N, vec3 base, float wrapAmt) {
  float ndl = max((dot(N, uKeyDir) + wrapAmt) / (1.0 + wrapAmt), 0.0);
  float ndf = max((dot(N, uFillDir) + wrapAmt) / (1.0 + wrapAmt), 0.0);
  vec3 col = base * (uAmbient + uKeyColor * ndl + uFillColor * ndf * 0.6);
  col += base * uRimColA * pow(max(dot(N, uRimDirA), 0.0), 2.5) * 0.85;
  col += base * uRimColB * pow(max(dot(N, uRimDirB), 0.0), 2.5) * 0.85;
  return col;
}

void main() {
  vec2 q = vUv * 2.0 - 1.0;

#if defined(MODE_LIQUID)
  float d2 = dot(q, q);
  if (d2 > 1.0) discard;
  float z = sqrt(max(0.0, 1.0 - d2));
  vec3 N = vec3(q, z);
  vec3 col = vfxLight(N, vColor, 0.45);
  float fres = pow(1.0 - z, 3.0);
  // Neon caught in the meniscus, then the pinpoint specular that bloom eats.
  col += (uRimColA + uRimColB) * 0.5 * fres * 0.55;
  col += vColor2 * fres * 0.5;
  vec3 H = normalize(uKeyDir + VIEWDIR);
  float spec = pow(max(dot(N, H), 0.0), 90.0);
  float spec2 = pow(max(dot(N, normalize(uRimDirA + VIEWDIR)), 0.0), 50.0);
  col += uKeyColor * spec * 3.4 + uRimColA * spec2 * 1.4;
  col *= vBright;
  float alpha = smoothstep(1.0, 0.78, sqrt(d2)) * vAlpha;
  gl_FragColor = vec4(col, alpha);

#elif defined(MODE_SMOKE)
  float d = length(q);
  if (d > 1.0) discard;
  float z = sqrt(max(0.0, 1.0 - d * d));
  vec3 N = vec3(q * 0.88, z);
  vec3 col = vfxLight(N, vColor, 0.85);
  col += vColor2 * pow(1.0 - z, 2.0) * 0.45;
  col *= vBright;
  // Cheap two-lobe breakup so the puff is not a perfect airbrushed circle.
  float n = 0.5 + 0.5 * sin(q.x * 6.7 + vSeed * 19.0) * sin(q.y * 5.9 + vSeed * 11.0 + 1.7);
  float a = pow(max(0.0, 1.0 - d), 1.8) * (0.55 + 0.55 * n) * vAlpha * vfxSoft();
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));

#elif defined(MODE_FLAKE)
  vec3 N = normalize(vNormal);
  vec3 base = gl_FrontFacing ? vColor : vColor2;
  if (!gl_FrontFacing) N = -N;
  vec3 col = vfxLight(N, base, 0.35);
  vec3 H = normalize(uKeyDir + VIEWDIR);
  col += uKeyColor * pow(max(dot(N, H), 0.0), 26.0) * 1.3;   // foil sheen
  col += uRimColA * pow(max(dot(N, uRimDirA), 0.0), 8.0) * 0.6;
  gl_FragColor = vec4(col, vAlpha);

#elif defined(MODE_SHARD)
  // Carve a triangular shard out of the quad: three seeded half planes.
  float m = 1.0;
  for (int i = 0; i < 3; i++) {
    float a = vSeed * 6.2831 + float(i) * 2.0944;
    m = min(m, 0.66 - dot(q, vec2(cos(a), sin(a))));
  }
  if (m < 0.0) discard;
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  float edge = smoothstep(0.0, 0.16, m);
  vec3 H = normalize(uKeyDir + VIEWDIR);
  float spec = pow(max(dot(N, H), 0.0), 200.0);
  float specA = pow(max(dot(N, normalize(uRimDirA + VIEWDIR)), 0.0), 110.0);
  float specB = pow(max(dot(N, normalize(uRimDirB + VIEWDIR)), 0.0), 110.0);
  vec3 col = vColor * (uAmbient * 0.6 + max(dot(N, uKeyDir), 0.0) * 0.30);
  col += uKeyColor * spec * 9.0 + uRimColA * specA * 4.0 + uRimColB * specB * 4.0;
  col += vColor2 * (1.0 - edge) * 1.1;                        // lit cut edge
  col *= vBright;
  float alpha = clamp(0.24 + (1.0 - edge) * 0.5 + spec * 4.0 + (specA + specB) * 2.0, 0.0, 1.0) * vAlpha;
  gl_FragColor = vec4(col, alpha);

#elif defined(MODE_RING)
  float d = length(q);
  float thick = mix(0.34, 0.035, vAge);
  float r0 = 0.84;
  // Per channel radius offset reads as refractive fringing without needing a
  // scene copy to actually refract.
  float rr = 1.0 - smoothstep(0.0, thick, abs(d - r0 + 0.030));
  float gg = 1.0 - smoothstep(0.0, thick, abs(d - r0));
  float bb = 1.0 - smoothstep(0.0, thick, abs(d - r0 - 0.030));
  vec3 col = vec3(rr, gg, bb) * vColor;
  col += vColor2 * gg * gg * 1.6;                              // hot leading edge
  col += vColor2 * smoothstep(r0, 0.25, d) * 0.10 * (1.0 - vAge);
  gl_FragColor = vec4(col * vBright * vAlpha, 1.0);

#elif defined(MODE_FLASH)
  float d = length(q);
  if (d > 1.0) discard;
  float ang = atan(q.y, q.x);
  float core = pow(max(0.0, 1.0 - d), 6.0);
  float halo = pow(max(0.0, 1.0 - d), 1.7);
  float s1 = abs(cos(ang * 2.0 + vSeed * 6.2831));
  float s2 = abs(cos(ang * 4.0 + vSeed * 3.1416));
  float spikes = pow(s1, 12.0) + pow(s2, 30.0) * 0.45;
  float streak = spikes * pow(max(0.0, 1.0 - d), 2.0);
  vec3 col = vColor2 * core * 3.6 + vColor * (halo * 0.55 + streak * 2.0);
  gl_FragColor = vec4(col * vBright * vAlpha, 1.0);

#else   // MODE_ADDITIVE
  float d = length(q);
  if (d > 1.0) discard;
  float core = pow(max(0.0, 1.0 - d), 5.0);
  float glow = pow(max(0.0, 1.0 - d), 1.6);
  vec3 col = mix(vColor, vColor2, core) * (core * 2.6 + glow * 0.6) * vBright;
  gl_FragColor = vec4(col * vAlpha, 1.0);
#endif
}
`;
