import * as THREE from 'three'
import { clamp } from './rng'

/**
 * Full-screen pass that greys the edges of the screen in as a rex closes on you.
 *
 * The design rule is a hard floor: however close it gets, a disc covering at
 * least 60% of the screen area stays completely clear. `solveClearRadius`
 * works that radius out for the current aspect ratio, so the floor holds on a
 * tall phone as well as a wide monitor.
 */
const MIN_CLEAR_FRACTION = 0.6

/** Area of a centred circle of radius r clipped to a 2a x 2b rectangle. */
function circleInRect(r: number, a: number, b: number): number {
  const steps = 512
  const xMax = Math.min(r, a)
  let sum = 0
  for (let i = 0; i < steps; i++) {
    const x = (xMax * (i + 0.5)) / steps
    sum += Math.min(Math.sqrt(Math.max(0, r * r - x * x)), b)
  }
  return 4 * sum * (xMax / steps)
}

/** Radius whose clipped disc covers `fraction` of the screen. */
function solveClearRadius(aspect: number, fraction: number): number {
  const a = aspect / 2
  const b = 0.5
  const wanted = fraction * (2 * a) * (2 * b)
  let lo = 0
  let hi = Math.hypot(a, b)
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (circleInRect(mid, a, b) < wanted) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform float uFear;      // 0 calm .. 1 it is right behind you
uniform float uAspect;
uniform float uMinRadius; // radius that still leaves 60% of the screen clear
uniform float uMaxRadius; // corner distance: the effect is invisible here
uniform float uBreath;    // 0..1 red pulse, phased on the CPU
uniform float uSeed;      // 0..1 grain seed, wrapped so it never grows
varying vec2 vUv;

// Deliberately sin-free and multiply-light: every intermediate stays inside
// [0,1) after the first fract. The usual sin(dot(p, big)) * 43758.0 trick feeds
// its sin a number in the hundreds of thousands, which is past what a fragment
// shader is guaranteed to represent - mediump tops out at 65504 - and overflows
// to inf, then NaN, then a white screen on whichever phone drew the short straw.
float hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

// The scene target is an sRGB texture, so sampling it hands us linear values.
// Nothing re-encodes on the way to the canvas, so this pass has to do it.
vec3 toSRGB(vec3 c) {
  // mix() evaluates both sides, so the pow branch has to be safe even for the
  // pixels that will take the linear one. pow(0, x) is where that bites.
  c = max(c, vec3(1e-8));
  return mix(pow(c, vec3(0.4166667)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
}

void main() {
  vec3 col = toSRGB(texture2D(tScene, vUv).rgb);

  vec2 p = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5);
  float r = length(p);

  // as fear rises the clear disc shrinks, but never past the 60% floor
  float inner = mix(uMaxRadius + 0.05, uMinRadius, uFear);
  // tight enough that the ramp is fully closed by the time it reaches a corner
  float feather = mix(0.30, 0.12, uFear);
  float v = smoothstep(inner, inner + feather, r) * uFear;

  if (v > 0.0) {
    float grey = dot(col, vec3(0.299, 0.587, 0.114));
    // wash to grey, then crush it down so the edges genuinely close in
    vec3 washed = vec3(grey);
    washed = mix(washed, vec3(grey * 0.20), v);
    col = mix(col, washed, clamp(v * 1.15, 0.0, 1.0));
    col *= 1.0 - 0.72 * v;
  }

  // a slow red breath over everything while it is on your tail
  col.r += uFear * uFear * 0.045 * uBreath;
  col = mix(col, vec3(dot(col, vec3(0.299, 0.587, 0.114))), uFear * 0.22);

  // faint grain keeps the flat dark areas from banding
  col += (hash(vUv + uSeed) - 0.5) * 0.018;

  gl_FragColor = vec4(col, 1.0);
}
`

export class Postfx {
  private target: THREE.WebGLRenderTarget
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private material: THREE.ShaderMaterial
  private quad: THREE.Mesh

  constructor(private renderer: THREE.WebGLRenderer) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    this.target = new THREE.WebGLRenderTarget(size.x, size.y, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
    })
    // render the scene already sRGB-encoded so the pass can work on it directly
    this.target.texture.colorSpace = THREE.SRGBColorSpace

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tScene: { value: this.target.texture },
        uFear: { value: 0 },
        uAspect: { value: 1 },
        uMinRadius: { value: 0.6 },
        uMaxRadius: { value: 0.8 },
        uBreath: { value: 0 },
        uSeed: { value: 0 },
      },
    })

    // one oversized triangle, no vertex transform needed
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2))
    this.quad = new THREE.Mesh(geo, this.material)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)

    this.resize()
  }

  resize() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    this.target.setSize(Math.max(1, size.x), Math.max(1, size.y))
    const aspect = Math.max(0.2, size.x / Math.max(1, size.y))
    this.material.uniforms.uAspect.value = aspect
    this.material.uniforms.uMinRadius.value = solveClearRadius(aspect, MIN_CLEAR_FRACTION)
    this.material.uniforms.uMaxRadius.value = Math.hypot(aspect / 2, 0.5)
  }

  render(scene: THREE.Scene, camera: THREE.Camera, fear: number, time: number) {
    this.material.uniforms.uFear.value = clamp(fear, 0, 1)
    // `time` is milliseconds since the page loaded, so it climbs all session and
    // is unbounded by design. Both of its uses are periodic, so the wrap happens
    // here in float64 and the shader only ever sees a small number.
    this.material.uniforms.uBreath.value = 0.5 + 0.5 * Math.sin(time * 3.4)
    this.material.uniforms.uSeed.value = time % 1

    this.renderer.setRenderTarget(this.target)
    this.renderer.clear()
    this.renderer.render(scene, camera)

    this.renderer.setRenderTarget(null)
    this.renderer.render(this.scene, this.camera)
  }

  dispose() {
    this.target.dispose()
    this.material.dispose()
    ;(this.quad.geometry as THREE.BufferGeometry).dispose()
  }
}
