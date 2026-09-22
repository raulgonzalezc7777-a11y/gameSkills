// Shared GLSL fragments for the post stack.
//
// Five passes need the same depth linearisation and the same view-space
// reconstruction. Keeping one copy here is not tidiness: a divergent copy is
// exactly how you end up with AO that sits one pixel off the reflections and
// nobody can tell which pass is lying.
//
// Everything here is ESSL 1.00 (texture2D / gl_FragColor) because Three
// compiles ShaderMaterial without 'glslVersion' as GLSL1, and WebGL2 accepts
// ESSL1 shaders natively. No textureLod anywhere: ESSL1 would need
// EXT_shader_texture_lod, and every mip in this stack is its own target.

// Fullscreen triangle. The vertex positions are already clip space, so the
// camera passed to renderer.render() is irrelevant and never transforms us.
export const FS_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// ---------------------------------------------------------------- depth ----

export const GLSL_DEPTH = /* glsl */`
// Window-space depth (0..1, what a DEPTH_COMPONENT24 texture hands back) to
// view-space Z. The result is negative: OpenGL view space looks down -Z.
float perspectiveDepthToViewZ(const in float invClipZ, const in float near, const in float far) {
  return (near * far) / ((far - near) * invClipZ - far);
}

// 0 at the near plane, 1 at the far plane. Handy for depth-aware weights where
// the absolute distance does not matter.
float viewZToOrthographicDepth(const in float viewZ, const in float near, const in float far) {
  return (viewZ + near) / (near - far);
}

// Unproject a pixel back to view space. The inverse-projection form costs one
// mat4 multiply but survives any projection the camera throws at it, including
// the off-centre frustum a future split-screen would need.
vec3 viewPosFromDepth(const in vec2 uv, const in float depth, const in mat4 invProj) {
  vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 view = invProj * clip;
  return view.xyz / view.w;
}

// Normals arrive from MeshNormalMaterial, which packs view-space normals as
// n * 0.5 + 0.5. A cleared (background) texel decodes to a zero-length vector,
// which is how every pass detects "no geometry here".
vec3 unpackNormal(const in vec3 packed) {
  return packed * 2.0 - 1.0;
}`;

// ---------------------------------------------------------------- color ----

export const GLSL_COLOR = /* glsl */`
float luma(const in vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Cheap max-component brightness. Bloom thresholds on this rather than on luma
// so a saturated pure-blue neon is not quietly thrown away.
float maxc(const in vec3 c) { return max(c.r, max(c.g, c.b)); }

// Stephen Hill's ACES fit (RRT + ODT baked into one rational curve), with the
// sRGB <-> AP1 matrices around it. The cheap Narkowicz curve loses the highlight
// desaturation that makes a blown-out neon strip read as light rather than as
// clipped paint, and this scene is nothing but blown-out neon.
const mat3 ACES_IN = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777
);
const mat3 ACES_OUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602
);
vec3 RRTAndODTFit(const in vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 ACESFitted(in vec3 color) {
  color = ACES_IN * color;
  color = RRTAndODTFit(color);
  color = ACES_OUT * color;
  return clamp(color, 0.0, 1.0);
}

vec3 linearToSRGB(const in vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}`;

// ---------------------------------------------------------------- noise ----

export const GLSL_HASH = /* glsl */`
// Dave Hoskins' hash without the sin(), which is what keeps the grain stable
// across drivers instead of banding differently on every GPU.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}`;
