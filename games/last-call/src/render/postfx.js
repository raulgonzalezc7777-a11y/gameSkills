import * as THREE from 'three';
import { CFG } from '../core/config.js';
import { clamp, expDamp } from '../core/math.js';
import { FS_VERT } from './shaders/lib.js';
import { SSAO_FRAG, BILATERAL_FRAG } from './shaders/ssao.js';
import { BLOOM_PREFILTER_FRAG, BLOOM_DOWN_FRAG, BLOOM_UP_FRAG } from './shaders/bloom.js';
import { SSR_FRAG } from './shaders/ssr.js';
import { MOTION_BLUR_FRAG } from './shaders/motionblur.js';
import { DOF_PREPASS_FRAG, DOF_BOKEH_FRAG } from './shaders/dof.js';
import { RESOLVE_FRAG } from './shaders/composite.js';
import { PRESENT_FRAG } from './shaders/present.js';

const BLOOM_LEVELS = 6;
const SSAO_KERNEL = 16;

// One fullscreen triangle, shared by every pass. Three's PlaneGeometry would
// work too, but a triangle avoids the diagonal seam where the two halves of a
// quad meet, which shows up as a faint crease in a heavy blur.
function fullscreenGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  return g;
}

function makeRT(w, h, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: opts.type ?? THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: !!opts.depth,
    stencilBuffer: false,
    generateMipmaps: false
  });
  rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
  return rt;
}

// Hemisphere kernel, biased toward the origin so most samples land close to the
// shaded point. A uniform sphere would spend its budget on distant geometry and
// produce the grey wash that gives cheap AO away.
function makeSSAOKernel(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random());
    v.normalize();
    let scale = i / n;
    scale = 0.1 + scale * scale * 0.9;
    v.multiplyScalar(scale);
    out.push(v);
  }
  return out;
}

function makeNoiseTexture(size = 4) {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    // Rotation only in the tangent plane, so Z stays at the encoded zero.
    data[i * 4] = Math.floor(Math.random() * 255);
    data[i * 4 + 1] = Math.floor(Math.random() * 255);
    data[i * 4 + 2] = 128;
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

export class PostFX {
  constructor(renderer, scene, camera, quality = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.q = {
      ssao: quality.ssao !== false,
      ssr: quality.ssr !== false,
      motionBlur: quality.motionBlur !== false,
      dof: quality.dof !== false,
      bloom: true,
      fxaa: true,
      ...quality
    };

    this.params = {
      drunk: 0,
      exposure: CFG.render.exposure,
      focusDistance: CFG.post.dof.focusDistance,
      bloomStrength: CFG.post.bloom.strength
    };

    this._geo = fullscreenGeometry();
    this._fsScene = new THREE.Scene();
    this._fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._quad = new THREE.Mesh(this._geo, null);
    this._quad.frustumCulled = false;
    this._fsScene.add(this._quad);

    this._normalMat = new THREE.MeshNormalMaterial();
    this._prevViewProj = new THREE.Matrix4();
    this._viewProj = new THREE.Matrix4();
    this._invViewProj = new THREE.Matrix4();
    this._invProj = new THREE.Matrix4();
    this._invView = new THREE.Matrix4();
    this._upView = new THREE.Vector3();
    this._atmos = [];
    this._atmosAge = 999;
    this._time = 0;
    this._focus = CFG.post.dof.focusDistance;

    this._buildMaterials();
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this._allocate(size.x, size.y);
  }

  // ------------------------------------------------------------ materials ---

  _mat(frag, uniforms, defines) {
    return new THREE.ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader: frag,
      uniforms,
      defines: defines || {},
      depthTest: false,
      depthWrite: false
    });
  }

  _buildMaterials() {
    const U = (o) => { const u = {}; for (const k in o) u[k] = { value: o[k] }; return u; };

    this.ssaoMat = this._mat(SSAO_FRAG, U({
      tDepth: null, tNormal: null, tNoise: makeNoiseTexture(),
      uProj: new THREE.Matrix4(), uInvProj: new THREE.Matrix4(),
      uKernel: makeSSAOKernel(SSAO_KERNEL),
      uNoiseScale: new THREE.Vector2(1, 1),
      uNear: 0.1, uFar: 120,
      uRadius: CFG.post.ssao.radius, uBias: CFG.post.ssao.bias,
      uIntensity: CFG.post.ssao.intensity, uPower: 1.4
    }), { KERNEL_SIZE: SSAO_KERNEL });

    this.blurMat = this._mat(BILATERAL_FRAG, U({
      tAO: null, uTexel: new THREE.Vector2(), uDirection: new THREE.Vector2(1, 0),
      uSigma: 2.2, uDepthSigma: 0.45
    }));

    this.prefilterMat = this._mat(BLOOM_PREFILTER_FRAG, U({
      tSource: null, uTexel: new THREE.Vector2(),
      uThreshold: CFG.post.bloom.threshold, uKnee: 0.42, uClamp: 24
    }));
    this.downMat = this._mat(BLOOM_DOWN_FRAG, U({ tSource: null, uTexel: new THREE.Vector2() }));
    this.upMat = this._mat(BLOOM_UP_FRAG, U({
      tSource: null, tTarget: null, uTexel: new THREE.Vector2(), uRadius: CFG.post.bloom.radius
    }));

    this.ssrMat = this._mat(SSR_FRAG, U({
      tColor: null, tDepth: null, tNormal: null,
      uProj: new THREE.Matrix4(), uInvProj: new THREE.Matrix4(), uInvView: new THREE.Matrix4(),
      uUpView: new THREE.Vector3(0, 1, 0), uTexel: new THREE.Vector2(),
      uNear: 0.1, uFar: 120, uMaxDistance: 9, uThickness: 0.32,
      uIntensity: 0.9, uRoughness: 0.24, uMaxHeight: 0.12, uJitter: 0
    }), { STEPS: 24, REFINE_STEPS: 5 });

    this.resolveMat = this._mat(RESOLVE_FRAG, U({
      tColor: null, tAO: null, tSSR: null, tDepth: null,
      uHalfTexel: new THREE.Vector2(), uNear: 0.1, uFar: 120,
      uAOStrength: 0.85, uSSRStrength: 1.0, uAOTint: 0.45
    }));

    this.mbMat = this._mat(MOTION_BLUR_FRAG, U({
      tColor: null, tDepth: null,
      uInvViewProj: new THREE.Matrix4(), uPrevViewProj: new THREE.Matrix4(),
      uStrength: CFG.post.motionBlur.strength, uMaxVelocity: 0.045, uJitter: 0
    }), { SAMPLES: CFG.post.motionBlur.samples });

    this.dofPreMat = this._mat(DOF_PREPASS_FRAG, U({
      tColor: null, tDepth: null, uTexel: new THREE.Vector2(),
      uNear: 0.1, uFar: 120,
      uFocus: 5, uFocusRange: CFG.post.dof.focusRange,
      uNearRange: CFG.post.dof.nearRange, uFarRange: CFG.post.dof.farRange
    }));
    this.bokehMat = this._mat(DOF_BOKEH_FRAG, U({
      tSource: null, uTexel: new THREE.Vector2(),
      uMaxBlur: CFG.post.dof.maxBlur, uHex: 0.8
    }), { TAPS: 28 });

    const g = CFG.post.grading;
    this.presentMat = this._mat(PRESENT_FRAG, U({
      tColor: null, tBloom: null, tBokeh: null, tDepth: null,
      uTexel: new THREE.Vector2(), uNear: 0.1, uFar: 120,
      uTime: 0, uExposure: CFG.render.exposure,
      uBloomStrength: CFG.post.bloom.strength,
      uGrain: CFG.post.grain, uVignette: CFG.post.vignette,
      uChromatic: CFG.post.chromatic, uDrunk: 0,
      uSaturation: g.saturation, uContrast: 1.04,
      uLift: g.lift, uGamma: g.gamma, uGain: g.gain,
      uTemperature: g.temperature, uFxaa: this.q.fxaa ? 1 : 0,
      uShadowTint: new THREE.Color(0.78, 0.88, 1.18),
      uHighlightTint: new THREE.Color(1.12, 1.02, 0.88),
      uFocus: 5, uFocusRange: CFG.post.dof.focusRange,
      uNearRange: CFG.post.dof.nearRange, uFarRange: CFG.post.dof.farRange
    }));
  }

  // ---------------------------------------------------------------- alloc ---

  _allocate(w, h) {
    this._disposeTargets();
    this.width = w; this.height = h;
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);

    const depth = new THREE.DepthTexture(w, h);
    depth.type = THREE.UnsignedIntType;
    depth.minFilter = depth.magFilter = THREE.NearestFilter;
    this.sceneRT = makeRT(w, h, { depth: true });
    this.sceneRT.depthTexture = depth;

    this.normalRT = makeRT(hw, hh, { type: THREE.UnsignedByteType, depth: true });
    this.aoRT = makeRT(hw, hh, { type: THREE.HalfFloatType });
    this.aoTmpRT = makeRT(hw, hh, { type: THREE.HalfFloatType });
    this.ssrRT = makeRT(hw, hh);
    this.resolveRT = makeRT(w, h);
    this.mbRT = makeRT(w, h);
    this.dofRT = makeRT(hw, hh);
    this.bokehRT = makeRT(hw, hh);

    // Two chains: the downsampled levels, and a separate upsampled level for
    // each size but the smallest. The upsample reads its own size's down level
    // and writes the up level, so no pass ever samples its own target.
    this.bloomRTs = [];
    this.bloomUpRTs = [];
    let bw = hw, bh = hh;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      this.bloomRTs.push(makeRT(bw, bh));
      if (i < BLOOM_LEVELS - 1) this.bloomUpRTs.push(makeRT(bw, bh));
      bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
    }
  }

  _disposeTargets() {
    for (const k of ['sceneRT', 'normalRT', 'aoRT', 'aoTmpRT', 'ssrRT', 'resolveRT', 'mbRT', 'dofRT', 'bokehRT']) {
      this[k]?.dispose();
    }
    this.bloomRTs?.forEach((rt) => rt.dispose());
    this.bloomUpRTs?.forEach((rt) => rt.dispose());
    this.sceneRT?.depthTexture?.dispose();
  }

  setSize(w, h) {
    const px = this.renderer.getPixelRatio();
    this._allocate(Math.max(1, Math.floor(w * px)), Math.max(1, Math.floor(h * px)));
  }

  // ----------------------------------------------------------------- draw ---

  _draw(material, target) {
    this._quad.material = material;
    this.renderer.setRenderTarget(target ?? null);
    this.renderer.clear(true, false, false);
    this.renderer.render(this._fsScene, this._fsCam);
  }

  // The normal prepass must not see haze, light shafts, dust or particles:
  // they write no depth, so a normal from them would make AO and SSR read a
  // surface that is not there. The list is cached and refreshed occasionally
  // because VFX add and remove objects at runtime.
  _collectAtmosphere() {
    this._atmos.length = 0;
    this.scene.traverse((o) => {
      if (!o.isMesh && !o.isPoints && !o.isLine) return;
      const m = o.material;
      if (!m) return;
      const mats = Array.isArray(m) ? m : [m];
      if (mats.some((x) => x.transparent || x.blending === THREE.AdditiveBlending || x.depthWrite === false)) {
        this._atmos.push(o);
      }
    });
  }

  render(dt) {
    const r = this.renderer;
    const cam = this.camera;
    this._time += dt;

    const near = cam.near, far = cam.far;
    this._invProj.copy(cam.projectionMatrixInverse);
    this._invView.copy(cam.matrixWorld);
    this._upView.set(0, 1, 0).transformDirection(cam.matrixWorldInverse);

    // 1. Scene into the HDR buffer, with depth.
    const prevBg = this.scene.background;
    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(this.scene, cam);

    // 2. View-space normals at half res, opaque geometry only.
    if (this.q.ssao || this.q.ssr) {
      if (++this._atmosAge > 120) { this._collectAtmosphere(); this._atmosAge = 0; }
      for (let i = 0; i < this._atmos.length; i++) this._atmos[i].visible = false;
      this.scene.overrideMaterial = this._normalMat;
      this.scene.background = null;
      r.setRenderTarget(this.normalRT);
      r.setClearColor(0x000000, 0);
      r.clear();
      r.render(this.scene, cam);
      this.scene.overrideMaterial = null;
      this.scene.background = prevBg;
      for (let i = 0; i < this._atmos.length; i++) this._atmos[i].visible = true;
    }

    const hw = this.width >> 1, hh = this.height >> 1;

    // 3. SSAO, then a separable bilateral blur that respects silhouettes.
    if (this.q.ssao) {
      const u = this.ssaoMat.uniforms;
      u.tDepth.value = this.sceneRT.depthTexture;
      u.tNormal.value = this.normalRT.texture;
      u.uProj.value.copy(cam.projectionMatrix);
      u.uInvProj.value.copy(this._invProj);
      u.uNoiseScale.value.set(hw / 4, hh / 4);
      u.uNear.value = near; u.uFar.value = far;
      this._draw(this.ssaoMat, this.aoRT);

      const b = this.blurMat.uniforms;
      b.uTexel.value.set(1 / hw, 1 / hh);
      b.tAO.value = this.aoRT.texture; b.uDirection.value.set(1, 0);
      this._draw(this.blurMat, this.aoTmpRT);
      b.tAO.value = this.aoTmpRT.texture; b.uDirection.value.set(0, 1);
      this._draw(this.blurMat, this.aoRT);
    }

    // 4. Screen-space reflections, half res. The floor is the only thing low
    // enough to pass the height mask, which is exactly the intent.
    if (this.q.ssr) {
      const u = this.ssrMat.uniforms;
      u.tColor.value = this.sceneRT.texture;
      u.tDepth.value = this.sceneRT.depthTexture;
      u.tNormal.value = this.normalRT.texture;
      u.uProj.value.copy(cam.projectionMatrix);
      u.uInvProj.value.copy(this._invProj);
      u.uInvView.value.copy(this._invView);
      u.uUpView.value.copy(this._upView);
      u.uTexel.value.set(1 / hw, 1 / hh);
      u.uNear.value = near; u.uFar.value = far;
      u.uJitter.value = (this._time * 60) % 64;
      this._draw(this.ssrMat, this.ssrRT);
    }

    // 5. Fold AO and reflections into the lit image.
    {
      const u = this.resolveMat.uniforms;
      u.tColor.value = this.sceneRT.texture;
      u.tAO.value = this.q.ssao ? this.aoRT.texture : null;
      u.tSSR.value = this.q.ssr ? this.ssrRT.texture : null;
      u.tDepth.value = this.sceneRT.depthTexture;
      u.uHalfTexel.value.set(1 / hw, 1 / hh);
      u.uNear.value = near; u.uFar.value = far;
      u.uAOStrength.value = this.q.ssao ? 0.85 : 0.0;
      u.uSSRStrength.value = this.q.ssr ? 1.0 : 0.0;
      this._draw(this.resolveMat, this.resolveRT);
    }

    // 6. Camera motion blur by depth reprojection.
    let colorRT = this.resolveRT;
    this._viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._invViewProj.copy(this._viewProj).invert();
    if (this.q.motionBlur) {
      const u = this.mbMat.uniforms;
      u.tColor.value = colorRT.texture;
      u.tDepth.value = this.sceneRT.depthTexture;
      u.uInvViewProj.value.copy(this._invViewProj);
      u.uPrevViewProj.value.copy(this._prevViewProj);
      u.uJitter.value = (this._time * 133.7) % 97;
      this._draw(this.mbMat, this.mbRT);
      colorRT = this.mbRT;
    }
    this._prevViewProj.copy(this._viewProj);

    // 7. Depth of field. The focal plane eases toward the requested distance so
    // a fighter stepping back does not snap the whole room in and out.
    this._focus = expDamp(this._focus, this.params.focusDistance, 4.0, Math.min(dt, 0.1));
    if (this.q.dof) {
      const p = this.dofPreMat.uniforms;
      p.tColor.value = colorRT.texture;
      p.tDepth.value = this.sceneRT.depthTexture;
      p.uTexel.value.set(1 / this.width, 1 / this.height);
      p.uNear.value = near; p.uFar.value = far;
      p.uFocus.value = this._focus;
      this._draw(this.dofPreMat, this.dofRT);

      const b = this.bokehMat.uniforms;
      b.tSource.value = this.dofRT.texture;
      b.uTexel.value.set(1 / hw, 1 / hh);
      this._draw(this.bokehMat, this.bokehRT);
    }

    // 8. Bloom: threshold once, then a mip chain down and back up. The upsample
    // adds into the larger level, so the result is one wide, soft halo instead
    // of six visible rings.
    {
      const pf = this.prefilterMat.uniforms;
      pf.tSource.value = colorRT.texture;
      pf.uTexel.value.set(1 / this.width, 1 / this.height);
      this._draw(this.prefilterMat, this.bloomRTs[0]);

      for (let i = 1; i < BLOOM_LEVELS; i++) {
        const src = this.bloomRTs[i - 1];
        this.downMat.uniforms.tSource.value = src.texture;
        this.downMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
        this._draw(this.downMat, this.bloomRTs[i]);
      }
      for (let i = BLOOM_LEVELS - 1; i > 0; i--) {
        // The smallest level starts the climb; every later step reads the
        // up level the previous step wrote. Writing into the down level it
        // was also reading was a feedback loop, and WebGL drops such draws.
        const src = i === BLOOM_LEVELS - 1 ? this.bloomRTs[i] : this.bloomUpRTs[i];
        this.upMat.uniforms.tSource.value = src.texture;
        this.upMat.uniforms.tTarget.value = this.bloomRTs[i - 1].texture;
        this.upMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
        this._draw(this.upMat, this.bloomUpRTs[i - 1]);
      }
    }

    // 9. Present.
    {
      const u = this.presentMat.uniforms;
      u.tColor.value = colorRT.texture;
      u.tBloom.value = this.bloomUpRTs[0].texture;
      u.tBokeh.value = this.q.dof ? this.bokehRT.texture : this.bloomUpRTs[0].texture;
      u.tDepth.value = this.sceneRT.depthTexture;
      u.uTexel.value.set(1 / this.width, 1 / this.height);
      u.uNear.value = near; u.uFar.value = far;
      u.uTime.value = this._time;
      u.uExposure.value = this.params.exposure;
      u.uBloomStrength.value = this.params.bloomStrength;
      u.uDrunk.value = this.params.drunk;
      u.uFocus.value = this._focus;
      this._draw(this.presentMat, null);
    }

    r.setRenderTarget(null);
  }

  dispose() {
    this._disposeTargets();
    this._geo.dispose();
    this._normalMat.dispose();
    for (const k of ['ssaoMat', 'blurMat', 'prefilterMat', 'downMat', 'upMat', 'ssrMat',
                     'resolveMat', 'mbMat', 'dofPreMat', 'bokehMat', 'presentMat']) {
      this[k]?.dispose();
    }
  }
}
