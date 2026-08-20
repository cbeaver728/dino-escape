import { DriveInput } from './jeep'
import { clamp } from './rng'

const STEER_TRAVEL = 78 // px of thumb drag for full lock

/**
 * Phone layout, built for a right-handed grip:
 *   left thumb  -> green GO above red BRAKE/REVERSE
 *   right thumb -> steering wheel, dragged left/right
 * Desktop gets WASD / arrows over the same input struct.
 */
export class Controls {
  readonly input: DriveInput = { steer: 0, throttle: false, brake: false }
  readonly isTouch: boolean
  /** Set by the game; fired by the engine button or the E key. */
  onEngineToggle: (() => void) | null = null

  private keys = new Set<string>()
  private keySteer = 0
  private touchSteer = 0
  private steerPointer: number | null = null
  private steerOrigin = 0
  private wheelArt: HTMLElement | null

  constructor() {
    this.isTouch = matchMedia('(hover: none) and (pointer: coarse)').matches || 'ontouchstart' in window
    if (this.isTouch) document.body.classList.add('touch')

    this.wheelArt = document.getElementById('wheelArt')

    addEventListener('keydown', (e) => {
      if (e.code === 'KeyE' && !e.repeat) this.onEngineToggle?.()
      this.keys.add(e.code)
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault()
    })
    addEventListener('keyup', (e) => this.keys.delete(e.code))
    addEventListener('blur', () => this.keys.clear())

    this.bindPedal('go', (down) => (this.input.throttle = down))
    this.bindPedal('brake', (down) => (this.input.brake = down))
    this.bindWheel()

    // fires on press, not on release: a panic tap should not need a clean lift
    document.getElementById('engine')?.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      this.onEngineToggle?.()
    })
  }

  private bindPedal(id: string, set: (down: boolean) => void) {
    const el = document.getElementById(id)
    if (!el) return
    const down = (e: PointerEvent) => {
      e.preventDefault()
      el.setPointerCapture(e.pointerId)
      el.classList.add('down')
      set(true)
    }
    const up = (e: PointerEvent) => {
      e.preventDefault()
      el.classList.remove('down')
      set(false)
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('lostpointercapture', up)
  }

  private bindWheel() {
    const zone = document.getElementById('wheelzone')
    if (!zone) return
    zone.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      this.steerPointer = e.pointerId
      this.steerOrigin = e.clientX
      zone.setPointerCapture(e.pointerId)
    })
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.steerPointer) return
      e.preventDefault()
      this.touchSteer = clamp((e.clientX - this.steerOrigin) / STEER_TRAVEL, -1, 1)
      // let the thumb keep dragging past full lock without losing the zero point
      this.steerOrigin = clamp(this.steerOrigin, e.clientX - STEER_TRAVEL, e.clientX + STEER_TRAVEL)
    })
    const release = (e: PointerEvent) => {
      if (e.pointerId !== this.steerPointer) return
      this.steerPointer = null
      this.touchSteer = 0
    }
    zone.addEventListener('pointerup', release)
    zone.addEventListener('pointercancel', release)
    zone.addEventListener('lostpointercapture', release)
  }

  /** Set by the dev harness to drive the jeep from a script. */
  override = false

  update(dt: number) {
    if (this.override) return
    if (this.isTouch) {
      this.input.steer = this.touchSteer
    } else {
      const left = this.keys.has('ArrowLeft') || this.keys.has('KeyA')
      const right = this.keys.has('ArrowRight') || this.keys.has('KeyD')
      const want = (right ? 1 : 0) - (left ? 1 : 0)
      // ramp so keyboard steering is not an instant snap to full lock
      const rate = want === 0 ? 7 : 3.6
      this.keySteer = clamp(this.keySteer + clamp(want - this.keySteer, -1, 1) * rate * dt, -1, 1)
      if (want === 0 && Math.abs(this.keySteer) < 0.02) this.keySteer = 0
      this.input.steer = this.keySteer
      this.input.throttle = this.keys.has('ArrowUp') || this.keys.has('KeyW')
      this.input.brake = this.keys.has('ArrowDown') || this.keys.has('KeyS') || this.keys.has('Space')
    }

    if (this.wheelArt) {
      this.wheelArt.style.transform = `rotate(${this.input.steer * 132}deg)`
    }
  }

  release() {
    this.input.throttle = false
    this.input.brake = false
    this.touchSteer = 0
    this.keySteer = 0
    this.keys.clear()
    document.getElementById('go')?.classList.remove('down')
    document.getElementById('brake')?.classList.remove('down')
  }
}
