import { GLSL_DEPTH } from './lib.js';

// Hemisphere-kernel SSAO in view space, the Crytek/Chapman formulation.
//
// Runs at half resolution against the full-res depth buffer and a half-res
// view-normal prepass. Half res is not a compromise for the contact darkening
// we actually care about: the occluder that matters (a boot on a floor, the
// kick plate of the bar meeting the wall) is many pixels across even at half.
// What half res does cost is edge crispness, which the bilateral blur and the
// depth-weighted upsample in the composite pass buy back.
//
// KERNEL_SIZE arrives as a define so the loop bound stays a constant
// expression, which ESSL 1.00 requires.
export const SSAO_FRAG = /* glsl */`
precision highp float;
${GLSL_DEPTH}

uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform sampler2D tNoise;
uniform mat4 uProj;
uniform mat4 uInvProj;
uniform vec3 uKernel[KERNEL_SIZE];
uniform vec2 uNoiseScale;
uniform float uNear;
uniform float uFar;
uniform float uRadius;
uniform float uBias;
uniform float uIntensity;
uniform float uPower;
varying vec2 vUv;

void main() {
  float depth = texture2D(tDepth, vUv).x;

  // Sky and anything at the far plane has no geometry to occlude. Bail before
  // the unprojection so the divide by w never sees a degenerate point.
  if (depth >= 0.9999) {
    gl_FragColor = vec4(1.0, -uFar, 0.0, 1.0);
    return;
  }

  vec3 origin = viewPosFromDepth(vUv, depth, uInvProj);
  vec3 packed = texture2D(tNormal, vUv).xyz;
  vec3 n = unpackNormal(packed);
  float nlen = length(n);
  if (nlen < 0.1) {
    // The normal prepass cleared this texel: background, or a mesh that the
    // half-res raster missed at a silhouette. Unoccluded is the safe answer.
    gl_FragColor = vec4(1.0, origin.z, 0.0, 1.0);
    return;
  }
  n /= nlen;

  // A 4x4 tile of random tangents rotates the kernel per pixel. Without it the
  // same 24 directions repeat everywhere and the AO shows the kernel's own
  // shape as a wallpaper pattern.
  vec3 rvec = texture2D(tNoise, vUv * uNoiseScale).xyz * 2.0 - 1.0;
  vec3 t = normalize(rvec - n * dot(rvec, n));
  vec3 b = cross(n, t);
  mat3 tbn = mat3(t, b, n);

  float occlusion = 0.0;
  for (int i = 0; i < KERNEL_SIZE; i++) {
    vec3 samplePos = origin + tbn * uKernel[i] * uRadius;

    vec4 clip = uProj * vec4(samplePos, 1.0);
    vec2 suv = (clip.xy / clip.w) * 0.5 + 0.5;

    // Off-screen samples would clamp to the border texel and invent occlusion
    // along every screen edge, so weight them out instead of clamping.
    vec2 inside = step(vec2(0.0), suv) * step(suv, vec2(1.0));
    float onScreen = inside.x * inside.y;

    float sceneZ = perspectiveDepthToViewZ(texture2D(tDepth, suv).x, uNear, uFar);

    // View Z is negative going away from the camera, so the stored surface
    // occludes the sample when it sits in front of it.
    float occluded = step(samplePos.z + uBias, sceneZ);

    // Range check kills haloing: a wall 8 metres behind a fighter is not
    // allowed to darken the fighter's outline just because it projects there.
    float range = smoothstep(0.0, 1.0, uRadius / max(1e-4, abs(origin.z - sceneZ)));

    occlusion += occluded * range * onScreen;
  }

  float ao = 1.0 - (occlusion / float(KERNEL_SIZE)) * uIntensity;
  ao = pow(clamp(ao, 0.0, 1.0), uPower);

  // G carries view Z so the bilateral blur does not have to re-read and
  // re-linearise the depth buffer for every one of its taps.
  gl_FragColor = vec4(ao, origin.z, 0.0, 1.0);
}`;

// Separable bilateral blur. The depth term is what stops the AO bleeding across
// a silhouette: a fighter's arm in front of the bar must keep its own contact
// shading instead of smearing it onto the bar three metres behind.
export const BILATERAL_FRAG = /* glsl */`
precision highp float;

uniform sampler2D tAO;
uniform vec2 uTexel;     // 1 / target size
uniform vec2 uDirection; // (1,0) then (0,1)
uniform float uSigma;    // spatial falloff, in taps
uniform float uDepthSigma; // metres of view Z before a tap is rejected
varying vec2 vUv;

void main() {
  vec2 center = texture2D(tAO, vUv).rg;
  float centerZ = center.g;

  float sum = center.r;
  float wsum = 1.0;

  // Unrolled-by-loop 9 tap (4 either side). Weights are evaluated rather than
  // table-driven because ESSL 1.00 cannot index a const array by a loop counter.
  for (int i = 1; i <= 4; i++) {
    float fi = float(i);
    float spatial = exp(-0.5 * (fi * fi) / (uSigma * uSigma));
    vec2 offset = uDirection * uTexel * fi;

    vec2 a = texture2D(tAO, vUv + offset).rg;
    vec2 b = texture2D(tAO, vUv - offset).rg;

    float wa = spatial * exp(-abs(a.g - centerZ) / uDepthSigma);
    float wb = spatial * exp(-abs(b.g - centerZ) / uDepthSigma);

    sum += a.r * wa + b.r * wb;
    wsum += wa + wb;
  }

  gl_FragColor = vec4(sum / wsum, centerZ, 0.0, 1.0);
}`;
