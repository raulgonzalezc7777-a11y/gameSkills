import * as THREE from 'three';
import { CFG } from '../core/config.js';

// Placeholder post stack: a single ACES + grade + vignette + grain pass so the
// game has a finished look from the first frame. The RENDER owner replaces this
// with the full deferred-ish stack (SSAO, bloom, SSR, motion blur, DOF).
const FS = /* glsl */`
precision highp float;
uniform sampler2D tDiffuse;
uniform float uTime, uGrain, uVignette, uChromatic, uDrunk, uSat, uExposure;
varying vec2 vUv;

vec3 ACESFilm(vec3 x){
  const float a=2.51, b=0.03, c=2.43, d=0.59, e=0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
}
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main(){
  vec2 uv = vUv;
  vec2 c = uv - 0.5;
  // Drunk barrel warp plus a slow lateral swim.
  float r2 = dot(c, c);
  uv = 0.5 + c * (1.0 + uDrunk * 0.16 * r2) + vec2(sin(uTime*0.9)*0.004, cos(uTime*0.7)*0.003) * uDrunk;

  float ca = uChromatic * (1.0 + uDrunk * 6.0);
  vec3 col;
  col.r = texture2D(tDiffuse, uv + c * ca).r;
  col.g = texture2D(tDiffuse, uv).g;
  col.b = texture2D(tDiffuse, uv - c * ca).b;

  // Double vision ghost when very drunk.
  if (uDrunk > 0.01) {
    vec3 ghost = texture2D(tDiffuse, uv + vec2(sin(uTime*1.7), cos(uTime*1.3)) * 0.010 * uDrunk).rgb;
    col = mix(col, max(col, ghost), uDrunk * 0.45);
  }

  col *= uExposure;
  col = ACESFilm(col);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSat);

  float vig = smoothstep(0.95, 0.25, length(c) * (1.0 + uDrunk * 0.35));
  col *= mix(1.0, vig, uVignette);

  float g = hash(vUv * 1024.0 + fract(uTime) * 91.7) - 0.5;
  col += g * uGrain;

  gl_FragColor = vec4(col, 1.0);
}`;

const VS = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer; this.scene = scene; this.camera = camera;
    this.params = { drunk: 0, exposure: CFG.render.exposure };
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType, samples: 4,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      colorSpace: THREE.LinearSRGBColorSpace
    });
    this.uniforms = {
      tDiffuse: { value: this.target.texture },
      uTime: { value: 0 }, uGrain: { value: CFG.post.grain },
      uVignette: { value: CFG.post.vignette }, uChromatic: { value: CFG.post.chromatic },
      uDrunk: { value: 0 }, uSat: { value: CFG.post.grading.saturation },
      uExposure: { value: CFG.render.exposure }
    };
    this.quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        vertexShader: VS, fragmentShader: FS, uniforms: this.uniforms,
        depthTest: false, depthWrite: false
      })
    );
    this.quad.frustumCulled = false;
    this.fsScene = new THREE.Scene();
    this.fsScene.add(this.quad);
    this.fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  setSize(w, h) {
    const px = this.renderer.getPixelRatio();
    this.target.setSize(Math.floor(w * px), Math.floor(h * px));
  }

  render(dt) {
    this.uniforms.uTime.value += dt;
    this.uniforms.uDrunk.value = this.params.drunk;
    this.uniforms.uExposure.value = this.params.exposure;
    this.renderer.setRenderTarget(this.target);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.fsScene, this.fsCam);
  }

  dispose() { this.target.dispose(); this.quad.geometry.dispose(); this.quad.material.dispose(); }
}
