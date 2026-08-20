/** Seeded randomness + value noise. Every run gets a fresh seed, so every map is new. */

export class Rng {
  private s: number

  constructor(seed: number) {
    this.s = seed >>> 0 || 1
  }

  /** mulberry32 */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next()
  }

  int(lo: number, hi: number): number {
    return Math.floor(this.range(lo, hi + 1))
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))]
  }
}

function fade(t: number): number {
  return t * t * (3 - 2 * t)
}

/** Tiling-free 2D value noise built off a permutation table. */
export class Noise2D {
  private perm: Uint8Array

  constructor(rng: Rng) {
    const p = new Uint8Array(256)
    for (let i = 0; i < 256; i++) p[i] = i
    for (let i = 255; i > 0; i--) {
      const j = rng.int(0, i)
      const tmp = p[i]
      p[i] = p[j]
      p[j] = tmp
    }
    this.perm = new Uint8Array(512)
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]
  }

  private hash(x: number, y: number): number {
    return this.perm[(this.perm[x & 255] + y) & 255] / 255
  }

  at(x: number, y: number): number {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const xf = fade(x - xi)
    const yf = fade(y - yi)
    const a = this.hash(xi, yi)
    const b = this.hash(xi + 1, yi)
    const c = this.hash(xi, yi + 1)
    const d = this.hash(xi + 1, yi + 1)
    return (a + (b - a) * xf) * (1 - yf) + (c + (d - c) * xf) * yf
  }

  /** Fractal sum in [0,1]. */
  fbm(x: number, y: number, octaves = 4, lacunarity = 2.05, gain = 0.5): number {
    let amp = 1
    let freq = 1
    let sum = 0
    let norm = 0
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.at(x * freq, y * freq)
      norm += amp
      amp *= gain
      freq *= lacunarity
    }
    return sum / norm
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Shortest signed angle from a to b. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return d
}

/** Frame-rate independent exponential smoothing. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt))
}
