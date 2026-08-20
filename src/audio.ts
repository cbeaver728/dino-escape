import { clamp } from './rng'

/** Everything is synthesised, so the game ships with no audio files. */
export class Sound {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private engineGain: GainNode | null = null
  private engineOsc: OscillatorNode[] = []
  private engineFilter: BiquadFilterNode | null = null
  private noiseBuf: AudioBuffer | null = null
  private windGain: GainNode | null = null
  private heartTimer = 0
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
    this.master = ctx.createGain()
    this.master.gain.value = 0.55
    this.master.connect(ctx.destination)

    // ---- noise buffer reused for wind, tyres and roars ----
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    this.noiseBuf = buf

    // ---- engine: two detuned saws through a lowpass ----
    this.engineFilter = ctx.createBiquadFilter()
    this.engineFilter.type = 'lowpass'
    this.engineFilter.frequency.value = 420
    this.engineGain = ctx.createGain()
    this.engineGain.gain.value = 0
    this.engineFilter.connect(this.engineGain).connect(this.master)
    for (const detune of [0, 7, -11]) {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = 55
      o.detune.value = detune
      o.connect(this.engineFilter)
      o.start()
      this.engineOsc.push(o)
    }

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

  setMuted(muted: boolean) {
    if (this.master) this.master.gain.value = muted ? 0 : 0.55
  }

  /** rev 0..1, load 0..1 (throttle down) */
  engine(rev: number, load: number) {
    if (!this.ctx || !this.engineGain || !this.engineFilter) return
    const t = this.ctx.currentTime
    const f = 42 + rev * 108
    for (const o of this.engineOsc) o.frequency.setTargetAtTime(f, t, 0.08)
    this.engineFilter.frequency.setTargetAtTime(320 + rev * 1500 + load * 420, t, 0.1)
    this.engineGain.gain.setTargetAtTime(0.1 + rev * 0.13 + load * 0.05, t, 0.1)
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

  silenceEngine() {
    if (this.engineGain && this.ctx) {
      this.engineGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15)
    }
  }
}
