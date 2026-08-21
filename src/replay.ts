import { angleDelta, clamp } from './rng'

/**
 * Records the run so it can be watched back.
 *
 * This stores state, not inputs. Re-simulating from inputs would be smaller,
 * but it only works if the simulation is perfectly deterministic, and this one
 * is driven by a variable frame clock and a shared RNG. Recording where
 * everything actually was is a few megabytes and cannot drift.
 *
 * Samples land at a fixed rate and playback interpolates between them, so the
 * replay is smooth at any speed and costs the same whatever the frame rate.
 */
export const REPLAY_HZ = 20
const MAX_SECONDS = 180

/** Rex states, as small integers. Order must stay stable within a recording. */
export const REX_STATES = ['patrol', 'alert', 'chase', 'winded', 'search', 'deer'] as const
export type RexStateName = (typeof REX_STATES)[number]

export interface ReplayLayout {
  rexCount: number
  /** Total deer across every herd, in herd order. */
  deerCount: number
  herdCount: number
}

const JEEP_FLOATS = 6 // x, z, yaw, speed, steer, flags
const REX_FLOATS = 5 // x, z, yaw, speed, state
const DEER_FLOATS = 4 // x, z, yaw, speed
const HERD_FLOATS = 1 // panic

export const FLAG_ENGINE = 1
export const FLAG_BRAKE = 2

export class Recording {
  readonly layout: ReplayLayout
  readonly frameSize: number
  private data: Float32Array
  private capacity: number
  /** Frames written in total; may exceed capacity once it wraps. */
  private written = 0
  private accum = 0

  constructor(layout: ReplayLayout) {
    this.layout = layout
    this.frameSize =
      JEEP_FLOATS +
      layout.rexCount * REX_FLOATS +
      layout.deerCount * DEER_FLOATS +
      layout.herdCount * HERD_FLOATS
    this.capacity = REPLAY_HZ * MAX_SECONDS
    this.data = new Float32Array(this.frameSize * this.capacity)
  }

  /** Number of frames available to watch. */
  get frames(): number {
    return Math.min(this.written, this.capacity)
  }

  get seconds(): number {
    return Math.max(0, (this.frames - 1) / REPLAY_HZ)
  }

  get bytes(): number {
    return this.data.byteLength
  }

  /**
   * Call every tick. Writes a frame only when the fixed-rate clock says so, and
   * hands back the slice to fill, or null if this tick is between samples.
   */
  next(dt: number): { buf: Float32Array; at: number } | null {
    this.accum += dt
    const step = 1 / REPLAY_HZ
    if (this.accum < step && this.written > 0) return null
    this.accum = Math.min(this.accum - step, step) // never bank more than one frame
    // Once full, keep the most recent window rather than dropping the ending -
    // the last thirty seconds are the part anyone wants to see again.
    const slot = this.written % this.capacity
    this.written++
    return { buf: this.data, at: slot * this.frameSize }
  }

  /** Oldest retained frame, once the ring has wrapped. */
  private get start(): number {
    return this.written <= this.capacity ? 0 : this.written % this.capacity
  }

  /**
   * Interpolated state at `t` seconds into the replay, written into `out`.
   * Angles are wrapped correctly and state ids snap rather than blend.
   */
  sample(t: number, out: Float32Array) {
    const n = this.frames
    if (n === 0) return
    const pos = clamp(t * REPLAY_HZ, 0, n - 1)
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, n - 1)
    const f = pos - i0
    const a = ((this.start + i0) % this.capacity) * this.frameSize
    const b = ((this.start + i1) % this.capacity) * this.frameSize
    const d = this.data
    const L = this.layout

    let o = 0
    const lerp = (x: number, y: number) => x + (y - x) * f
    const lerpAngle = (x: number, y: number) => x + angleDelta(x, y) * f

    // jeep
    out[o] = lerp(d[a + 0], d[b + 0])
    out[o + 1] = lerp(d[a + 1], d[b + 1])
    out[o + 2] = lerpAngle(d[a + 2], d[b + 2])
    out[o + 3] = lerp(d[a + 3], d[b + 3])
    out[o + 4] = lerp(d[a + 4], d[b + 4])
    out[o + 5] = d[a + 5] // flags: snap
    o += JEEP_FLOATS

    for (let r = 0; r < L.rexCount; r++) {
      out[o] = lerp(d[a + o], d[b + o])
      out[o + 1] = lerp(d[a + o + 1], d[b + o + 1])
      out[o + 2] = lerpAngle(d[a + o + 2], d[b + o + 2])
      out[o + 3] = lerp(d[a + o + 3], d[b + o + 3])
      out[o + 4] = d[a + o + 4] // state: snap
      o += REX_FLOATS
    }

    for (let i = 0; i < L.deerCount; i++) {
      out[o] = lerp(d[a + o], d[b + o])
      out[o + 1] = lerp(d[a + o + 1], d[b + o + 1])
      out[o + 2] = lerpAngle(d[a + o + 2], d[b + o + 2])
      out[o + 3] = lerp(d[a + o + 3], d[b + o + 3])
      o += DEER_FLOATS
    }

    for (let h = 0; h < L.herdCount; h++) {
      out[o] = lerp(d[a + o], d[b + o])
      o += HERD_FLOATS
    }
  }

  /** Offsets into a sampled frame, so callers do not hardcode the layout. */
  rexAt(i: number): number {
    return JEEP_FLOATS + i * REX_FLOATS
  }

  deerAt(i: number): number {
    return JEEP_FLOATS + this.layout.rexCount * REX_FLOATS + i * DEER_FLOATS
  }

  herdAt(i: number): number {
    return (
      JEEP_FLOATS +
      this.layout.rexCount * REX_FLOATS +
      this.layout.deerCount * DEER_FLOATS +
      i * HERD_FLOATS
    )
  }

  scratch(): Float32Array {
    return new Float32Array(this.frameSize)
  }
}
