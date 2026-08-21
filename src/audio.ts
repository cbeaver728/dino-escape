import { clamp } from './rng'

export type EngineKind = 'hum' | 'burble'
export const ENGINE_KINDS: EngineKind[] = ['hum', 'burble']

const MASTER = 0.55

/** One built engine voice: retune it per frame, and tear it down on a swap. */
interface EngineVoice {
  tune(rev: number, load: number): void
  level(rev: number, load: number): number
  stop(): void
}

/** Everything is synthesised, so the game ships with no audio files. */
export class Sound {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  /** Stable node the engine voice feeds; carries the rev-driven level. */
  private engineOut: GainNode | null = null
  private voice: EngineVoice | null = null
  private kind: EngineKind = 'hum'
  private noiseBuf: AudioBuffer | null = null
  private windGain: GainNode | null = null
  private heartTimer = 0
  private previewUntil = 0
  enabled = true

  /** Must be called from a user gesture. */
  start() {
    if (this.ctx) {
      void this.ctx.resume()
      return
    }
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!Ctor) {
      this.enabled = false
      return
    }
    const ctx = new Ctor()
    this.ctx = ctx

    // A limiter on the way out. The engine is deliberately loud now, and
    // without this a roar landing on top of it clips instead of ducking.
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -6
    limiter.knee.value = 8
    limiter.ratio.value = 12
    limiter.attack.value = 0.003
    limiter.release.value = 0.25
    limiter.connect(ctx.destination)

    this.master = ctx.createGain()
    this.master.gain.value = MASTER
    this.master.connect(limiter)

    // ---- noise buffer reused for wind, tyres and roars ----
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    this.noiseBuf = buf

    this.engineOut = ctx.createGain()
    this.engineOut.gain.value = 0
    this.engineOut.connect(this.master)
    this.buildVoice()

    // ---- night wind bed ----
    const wind = ctx.createBufferSource()
    wind.buffer = buf
    wind.loop = true
    const wf = ctx.createBiquadFilter()
    wf.type = 'bandpass'
    wf.frequency.value = 340
    wf.Q.value = 0.5
    this.windGain = ctx.createGain()
    this.windGain.gain.value = 0.05
    wind.connect(wf).connect(this.windGain).connect(this.master)
    wind.start()
  }

  /** Swap the engine voice. Safe before or after the context exists. */
  setEngineKind(kind: EngineKind) {
    if (kind === this.kind && this.voice) return
    this.kind = kind
    if (this.ctx) this.buildVoice()
  }

  get engineKind(): EngineKind {
    return this.kind
  }

  private buildVoice() {
    const ctx = this.ctx
    const out = this.engineOut
    if (!ctx || !out) return
    this.voice?.stop()
    this.voice = this.kind === 'burble' ? this.buildBurble(ctx, out) : this.buildHum(ctx, out)
  }

  /**
   * Sines and triangles only, rolled off hard above 1.1kHz. Nothing in it is
   * sharp, so it can sit much louder than a sawtooth engine without wearing
   * on you - which matters, because engine volume is also the tell for how far
   * away a rex can hear you.
   */
  private buildHum(ctx: AudioContext, out: GainNode): EngineVoice {
    const tame = ctx.createBiquadFilter()
    tame.type = 'highshelf'
    tame.frequency.value = 1100
    tame.gain.value = -15
    tame.connect(out)

    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.Q.value = 0.6
    lp.connect(tame)

    const a1 = ctx.createOscillator()
    a1.type = 'sine'
    const a2 = ctx.createOscillator()
    a2.type = 'sine'
    a2.detune.value = 5 // slow beat against a1 so it breathes
    const a3 = ctx.createOscillator()
    a3.type = 'triangle'
    const a3g = ctx.createGain()
    a3g.gain.value = 0.35
    a3.connect(a3g)
    a1.connect(lp)
    a2.connect(lp)
    a3g.connect(lp)
    a1.start()
    a2.start()
    a3.start()

    return {
      tune(rev, load) {
        const t = ctx.currentTime
        const f = 38 + rev * 112
        a1.frequency.setTargetAtTime(f, t, 0.09)
        a2.frequency.setTargetAtTime(f * 2, t, 0.09)
        a3.frequency.setTargetAtTime(f, t, 0.09)
        lp.frequency.setTargetAtTime(380 + rev * 1450 + load * 200, t, 0.1)
      },
      level(rev, load) {
        return 0.16 + rev * 0.33 + load * 0.03
      },
      stop() {
        for (const o of [a1, a2, a3]) {
          try {
            o.stop()
          } catch {
            /* already stopped */
          }
        }
      },
    }
  }

  /** Four harmonics and nothing above them: a V8 shape without the bite. */
  private buildBurble(ctx: AudioContext, out: GainNode): EngineVoice {
    const tame = ctx.createBiquadFilter()
    tame.type = 'highshelf'
    tame.frequency.value = 1100
    tame.gain.value = -15
    tame.connect(out)

    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.Q.value = 0.6
    lp.connect(tame)

    const harmonics = [1, 0.45, 0.2, 0.09]
    const re = new Float32Array(harmonics.length + 1)
    const im = new Float32Array(harmonics.length + 1)
    harmonics.forEach((h, i) => (im[i + 1] = h))
    const ov = ctx.createOscillator()
    ov.setPeriodicWave(ctx.createPeriodicWave(re, im))

    const pk = ctx.createBiquadFilter()
    pk.type = 'peaking'
    pk.frequency.value = 112
    pk.Q.value = 1.1
    pk.gain.value = 7
    ov.connect(pk).connect(lp)

    // detune wobble at half the firing rate gives the lumpy idle
    const lump = ctx.createOscillator()
    lump.type = 'sine'
    const lumpAmt = ctx.createGain()
    lumpAmt.gain.value = 5
    lump.connect(lumpAmt)
    lumpAmt.connect(ov.detune)
    ov.start()
    lump.start()

    return {
      tune(rev, load) {
        const t = ctx.currentTime
        const f = 36 + rev * 88
        ov.frequency.setTargetAtTime(f, t, 0.08)
        lump.frequency.setTargetAtTime(f * 0.5, t, 0.08)
        lumpAmt.gain.setTargetAtTime(7 - rev * 5, t, 0.12) // smooths out as it revs
        lp.frequency.setTargetAtTime(560 + rev * 1200 + load * 200, t, 0.1)
      },
      level(rev, load) {
        return 0.24 + rev * 0.24 + load * 0.03
      },
      stop() {
        for (const o of [ov, lump]) {
          try {
            o.stop()
          } catch {
            /* already stopped */
          }
        }
      },
    }
  }

  setMuted(muted: boolean) {
    if (this.master) this.master.gain.value = muted ? 0 : MASTER
  }

  /** rev 0..1, load 0..1 (throttle down) */
  engine(rev: number, load: number) {
    if (!this.ctx || !this.engineOut || !this.voice) return
    if (this.ctx.currentTime < this.previewUntil) return // a preview is running
    this.voice.tune(rev, load)
    this.engineOut.gain.setTargetAtTime(this.voice.level(rev, load), this.ctx.currentTime, 0.1)
  }

  /**
   * A short blip of the selected engine, for auditioning it from the menu.
   * Holds off `engine()` for its duration so a running game cannot fight it.
   */
  previewEngine(kind: EngineKind) {
    this.start()
    this.setEngineKind(kind)
    const ctx = this.ctx
    if (!ctx || !this.engineOut || !this.voice) return
    const t = ctx.currentTime
    this.previewUntil = t + 1.9
    const g = this.engineOut.gain
    g.cancelScheduledValues(t)
    g.setValueAtTime(0.0001, t)
    const at = (rev: number, when: number) => {
      this.voice?.tune(rev, 1)
      g.linearRampToValueAtTime(this.voice ? this.voice.level(rev, 1) : 0, t + when)
    }
    // idle, wind up, hold, drop away
    at(0.12, 0.15)
    setTimeout(() => this.voice?.tune(1, 1), 200)
    at(1, 0.95)
    at(0.9, 1.35)
    g.linearRampToValueAtTime(0.0001, t + 1.85)
    setTimeout(() => this.voice?.tune(0.12, 0), 1500)
  }

  /** Distant when it first hears you, close and wet when it is on top of you. */
  roar(closeness: number) {
    const ctx = this.ctx
    if (!ctx || !this.master || !this.noiseBuf) return
    const t = ctx.currentTime
    const vol = 0.22 + closeness * 0.5

    const o = ctx.createOscillator()
    o.type = 'sawtooth'
    o.frequency.setValueAtTime(150 + closeness * 60, t)
    o.frequency.exponentialRampToValueAtTime(48, t + 1.5)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(vol, t + 0.12)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.7)
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.setValueAtTime(900, t)
    f.frequency.exponentialRampToValueAtTime(250, t + 1.6)
    o.connect(f).connect(g).connect(this.master)
    o.start(t)
    o.stop(t + 1.8)

    const n = ctx.createBufferSource()
    n.buffer = this.noiseBuf
    const nf = ctx.createBiquadFilter()
    nf.type = 'bandpass'
    nf.frequency.setValueAtTime(760, t)
    nf.frequency.exponentialRampToValueAtTime(190, t + 1.4)
    nf.Q.value = 1.1
    const ng = ctx.createGain()
    ng.gain.setValueAtTime(0.0001, t)
    ng.gain.exponentialRampToValueAtTime(vol * 0.75, t + 0.1)
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 1.5)
    n.connect(nf).connect(ng).connect(this.master)
    n.start(t)
    n.stop(t + 1.6)
  }

  /** Low thud that gets faster and louder as it closes. */
  footstep(closeness: number) {
    const ctx = this.ctx
    if (!ctx || !this.master) return
    const t = ctx.currentTime
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(80, t)
    o.frequency.exponentialRampToValueAtTime(34, t + 0.25)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.12 + closeness * 0.4, t + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34)
    o.connect(g).connect(this.master)
    o.start(t)
    o.stop(t + 0.36)
  }

  /** Call every frame while a rex is locked on; fear 0..1 sets the pulse rate. */
  heartbeat(dt: number, fear: number) {
    const ctx = this.ctx
    if (!ctx || !this.master || fear <= 0.02) {
      this.heartTimer = 0
      return
    }
    this.heartTimer -= dt
    if (this.heartTimer > 0) return
    this.heartTimer = 1.05 - clamp(fear, 0, 1) * 0.62
    const t = ctx.currentTime
    for (const [delay, amp] of [
      [0, 1],
      [0.16, 0.62],
    ] as const) {
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.setValueAtTime(64, t + delay)
      o.frequency.exponentialRampToValueAtTime(38, t + delay + 0.14)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t + delay)
      g.gain.exponentialRampToValueAtTime((0.06 + fear * 0.26) * amp, t + delay + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.22)
      o.connect(g).connect(this.master)
      o.start(t + delay)
      o.stop(t + delay + 0.24)
    }
  }

  chime(up: boolean) {
    const ctx = this.ctx
    const bus = this.master
    if (!ctx || !bus) return
    const t = ctx.currentTime
    const notes = up ? [392, 523, 659, 784] : [330, 262, 196]
    notes.forEach((f, i) => {
      const o = ctx.createOscillator()
      o.type = 'triangle'
      o.frequency.value = f
      const g = ctx.createGain()
      const s = t + i * 0.14
      g.gain.setValueAtTime(0.0001, s)
      g.gain.exponentialRampToValueAtTime(0.18, s + 0.03)
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.6)
      o.connect(g).connect(bus)
      o.start(s)
      o.stop(s + 0.62)
    })
  }

  /** Starter motor: deliberately conspicuous, because restarting is a gamble. */
  starter() {
    const ctx = this.ctx
    if (!ctx || !this.master) return
    const t = ctx.currentTime
    const o = ctx.createOscillator()
    o.type = 'square'
    o.frequency.setValueAtTime(38, t)
    o.frequency.linearRampToValueAtTime(72, t + 0.5)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.14, t + 0.05)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.62)
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = 700
    o.connect(f).connect(g).connect(this.master)
    o.start(t)
    o.stop(t + 0.65)
  }

  silenceEngine() {
    if (this.engineOut && this.ctx && this.ctx.currentTime >= this.previewUntil) {
      this.engineOut.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15)
    }
  }
}
