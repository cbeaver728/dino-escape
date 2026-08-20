import * as THREE from 'three'
import { World } from './world'
import { angleDelta, clamp, damp } from './rng'

export const JEEP_TOP_SPEED = 22 // m/s on flat dry ground
const REVERSE_TOP_SPEED = 8
const ACCEL = 12.5
const BRAKE = 28
const ROLL_DRAG = 3.4
const WHEELBASE = 3.1
const MAX_STEER = 0.56
const BODY_RADIUS = 1.55
/** Coast-down with no engine. Low enough that cutting it at speed lets you
 * glide a long way into cover - which is exactly the skill being rewarded. */
const STALL_BRAKE = 4.5
/** The starter is loud - restarting near a rex re-alerts it. */
const RESTART_NOISE = 78

export interface DriveInput {
  /** -1 (full left) .. 1 (full right) */
  steer: number
  throttle: boolean
  brake: boolean
}

export class Jeep {
  readonly group = new THREE.Group()
  readonly position = new THREE.Vector3()
  yaw = 0
  speed = 0

  /** How loud the engine is right now, as a hearing radius in metres. */
  noiseRadius = 22
  engineOn = true

  private fill!: THREE.PointLight
  private lampMat!: THREE.MeshBasicMaterial
  private steerAngle = 0
  private wheels: THREE.Object3D[] = []
  private frontWheels: THREE.Object3D[] = []
  private headlights: THREE.SpotLight[] = []
  private tailMat: THREE.MeshBasicMaterial
  private bodyTilt = new THREE.Group()
  private wheelSpin = 0
  private bumpPhase = 0
  private disposables: Array<{ dispose(): void }> = []

  constructor(private world: World) {
    const paint = new THREE.MeshLambertMaterial({ color: 0x5e8168 })
    const trim = new THREE.MeshLambertMaterial({ color: 0x44584c })
    const rubber = new THREE.MeshLambertMaterial({ color: 0x2a2c31 })
    const chrome = new THREE.MeshStandardMaterial({ color: 0x8a9199, roughness: 0.4, metalness: 0.8 })
    const lamp = new THREE.MeshBasicMaterial({ color: 0xfff6da })
    this.tailMat = new THREE.MeshBasicMaterial({ color: 0x3a0806 })
    this.disposables.push(paint, trim, rubber, chrome, lamp, this.tailMat)

    this.group.add(this.bodyTilt)

    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      this.disposables.push(geo)
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(x, y, z)
      this.bodyTilt.add(mesh)
      return mesh
    }

    // chassis: nose is +Z
    add(new THREE.BoxGeometry(2.3, 0.85, 4.6), paint, 0, 1.05, 0)
    add(new THREE.BoxGeometry(2.15, 0.55, 1.5), paint, 0, 1.62, 1.35) // hood
    add(new THREE.BoxGeometry(2.15, 0.9, 1.7), trim, 0, 1.85, -0.35) // cab
    add(new THREE.BoxGeometry(2.0, 0.7, 1.2), trim, 0, 1.5, -1.9) // bed
    add(new THREE.BoxGeometry(2.5, 0.28, 0.35), chrome, 0, 1.0, 2.35) // bumper
    add(new THREE.BoxGeometry(1.9, 0.7, 0.14), chrome, 0, 2.05, 0.6) // windscreen frame

    // roll cage
    const barGeo = new THREE.CylinderGeometry(0.07, 0.07, 1.5, 5)
    for (const sx of [-1.0, 1.0]) {
      for (const sz of [0.6, -1.3]) {
        const bar = new THREE.Mesh(barGeo, chrome)
        bar.position.set(sx, 2.5, sz)
        this.bodyTilt.add(bar)
      }
    }
    this.disposables.push(barGeo)
    const topGeo = new THREE.BoxGeometry(2.05, 0.1, 2.0)
    add(topGeo, chrome, 0, 3.2, -0.35)

    // wheels
    const wheelGeo = new THREE.CylinderGeometry(0.72, 0.72, 0.52, 12)
    wheelGeo.rotateZ(Math.PI / 2)
    const hubGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.56, 6)
    hubGeo.rotateZ(Math.PI / 2)
    this.disposables.push(wheelGeo, hubGeo)
    for (const sx of [-1.25, 1.25]) {
      for (const sz of [1.55, -1.55]) {
        const pivot = new THREE.Group()
        pivot.position.set(sx, 0.72, sz)
        const tyre = new THREE.Mesh(wheelGeo, rubber)
        const hub = new THREE.Mesh(hubGeo, chrome)
        pivot.add(tyre, hub)
        this.bodyTilt.add(pivot)
        this.wheels.push(tyre)
        if (sz > 0) this.frontWheels.push(pivot)
      }
    }

    // headlights
    const lensGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.12, 10)
    lensGeo.rotateX(Math.PI / 2)
    this.disposables.push(lensGeo)
    for (const sx of [-0.78, 0.78]) {
      add(lensGeo, lamp, sx, 1.62, 2.2)
      // Low decay on purpose: physical falloff puts a blinding pool at the
      // bumper and nothing beyond it. This reaches far enough to drive by.
      const spot = new THREE.SpotLight(0xfff1d0, 620, 180, 0.55, 0.5, 1.05)
      spot.position.set(sx, 1.62, 2.25)
      const target = new THREE.Object3D()
      target.position.set(sx * 1.6, -1.4, 34)
      this.bodyTilt.add(spot, target)
      spot.target = target
      this.headlights.push(spot)
    }

    // tail lights
    const tailGeo = new THREE.BoxGeometry(0.34, 0.24, 0.1)
    this.disposables.push(tailGeo)
    for (const sx of [-0.8, 0.8]) add(tailGeo, this.tailMat, sx, 1.5, -2.32)

    // Soft fill behind and above, on the camera's side of the truck. Without it
    // the jeep is a black cut-out, because its own headlights face away.
    this.fill = new THREE.PointLight(0xbccadd, 45, 20, 2)
    this.fill.position.set(0, 5, -4.5)
    this.group.add(this.fill)
    this.lampMat = lamp
  }

  /**
   * Kill the engine and you are a dark, silent, immobile lump - which is the
   * only way to make a rex lose you once it has locked on, and a very bad idea
   * anywhere it can still see you.
   */
  setEngine(on: boolean) {
    if (on === this.engineOn) return
    this.engineOn = on
    if (on) {
      // the starter is loud: restarting under a rex's nose gives you away
      this.noiseRadius = Math.max(this.noiseRadius, RESTART_NOISE)
    }
  }

  reset(pos: THREE.Vector3, yaw: number) {
    this.position.copy(pos)
    this.yaw = yaw
    this.speed = 0
    this.steerAngle = 0
    this.engineOn = true
    this.noiseRadius = 22
    this.group.position.copy(pos)
    this.group.rotation.set(0, yaw, 0)
  }

  get inWater(): boolean {
    return this.world.waterDepth(this.position.x, this.position.z) > 0.25
  }

  update(dt: number, input: DriveInput) {
    // --- steering ---
    const target = clamp(input.steer, -1, 1) * MAX_STEER
    // the faster you go the less lock you get, and the wheel returns to centre
    const grip = 1 - 0.42 * clamp(Math.abs(this.speed) / JEEP_TOP_SPEED, 0, 1)
    this.steerAngle = damp(this.steerAngle, target * grip, 9, dt)

    // --- surface ---
    const depth = this.world.waterDepth(this.position.x, this.position.z)
    const wet = clamp(depth / 1.4, 0, 1)
    const speedCap = JEEP_TOP_SPEED * (1 - 0.55 * wet)
    const dragMul = 1 + wet * 1.7

    // hills: climbing costs you, descending gives it back
    const fwdX = Math.sin(this.yaw)
    const fwdZ = Math.cos(this.yaw)
    const ahead = this.world.heightAt(this.position.x + fwdX * 3, this.position.z + fwdZ * 3)
    const here = this.world.heightAt(this.position.x, this.position.z)
    // capped so a riverbank or a hillside slows you down without ever trapping you
    const slope = clamp((ahead - here) / 3, -0.55, 0.55)

    // --- longitudinal ---
    if (!this.engineOn) {
      // Dead engine: rolls to a stop and stays put. Skipping the slope term
      // matters, or a parked jeep creeps downhill all night.
      this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), STALL_BRAKE * dt)
      if (Math.abs(this.speed) < 0.06) this.speed = 0
    } else {
      if (input.throttle && !input.brake) {
        this.speed += ACCEL * (1 - 0.3 * wet) * dt
      } else if (input.brake) {
        if (this.speed > 0.4) this.speed -= BRAKE * dt
        else this.speed -= ACCEL * 0.7 * dt // rolls into reverse once stopped
      } else {
        this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), ROLL_DRAG * dt)
      }
      this.speed -= slope * 9 * dt
      this.speed -= this.speed * (dragMul - 1) * 1.4 * dt
      this.speed = clamp(this.speed, -REVERSE_TOP_SPEED, speedCap)
    }

    // --- bicycle-model heading ---
    // Heading is `forward = (sin yaw, cos yaw)`, and three.js is right-handed,
    // so from behind the wheel the driver's right is -X: turning right means
    // yaw goes DOWN. Positive steer is right, hence the minus.
    if (Math.abs(this.speed) > 0.05) {
      this.yaw -= (this.speed / WHEELBASE) * Math.tan(this.steerAngle) * dt
    }

    // --- integrate + collide ---
    let nx = this.position.x + Math.sin(this.yaw) * this.speed * dt
    let nz = this.position.z + Math.cos(this.yaw) * this.speed * dt

    // Resolve twice: pushing clear of one trunk can shove you into its neighbour.
    for (let pass = 0; pass < 2; pass++) {
      const tree = this.world.treeHit(nx, nz, BODY_RADIUS)
      if (!tree) break
      const dx = nx - tree.x
      const dz = nz - tree.z
      const d = Math.hypot(dx, dz) || 0.001
      const ux = dx / d
      const uz = dz / d
      nx += ux * (BODY_RADIUS + tree.r - d)
      nz += uz * (BODY_RADIUS + tree.r - d)
      if (pass > 0) continue

      // Head-on is a dead stop; a glancing blow scrapes past and turns you.
      // Getting this right is what makes a chase through the trees survivable.
      const dirX = Math.sign(this.speed) * Math.sin(this.yaw)
      const dirZ = Math.sign(this.speed) * Math.cos(this.yaw)
      const head = clamp(-(dirX * ux + dirZ * uz), 0, 1)
      this.speed *= clamp(1 - head * head * 1.25, 0, 0.98)

      // Always turn a little away from the trunk, even nose-on with no speed
      // left: without this the jeep pins itself against a tree and never gets off.
      const delta = angleDelta(this.yaw, Math.atan2(ux, uz))
      const nudge = (0.05 + 0.2 * (1 - head)) * (dt * 60)
      this.yaw += (delta >= 0 ? 1 : -1) * Math.min(Math.abs(delta), nudge)
    }

    // Scrape along the boundary hills rather than stopping dead: the clamp and
    // the speed penalty have to use the same limit or the jeep gets pinned here.
    if (!this.world.inBounds(nx, nz)) {
      const lim = this.world.limit
      nx = clamp(nx, -lim, lim)
      nz = clamp(nz, -lim, lim)
      this.speed *= 0.6
    }

    this.position.x = nx
    this.position.z = nz
    this.position.y = this.world.heightAt(nx, nz)

    // --- pose ---
    this.group.position.copy(this.position)
    this.group.rotation.y = this.yaw

    // Sit the body on the ground: pitch from how much the surface normal leans
    // fore/aft, roll from how much it leans across. Both signs follow the same
    // right-handed convention as the steering - nose up is a positive rotation
    // about X, and the driver's right is -X.
    const n = this.world.normalAt(nx, nz, _n)
    const pitch = Math.asin(clamp(n.x * Math.sin(this.yaw) + n.z * Math.cos(this.yaw), -1, 1))
    const roll = Math.asin(clamp(n.z * Math.sin(this.yaw) - n.x * Math.cos(this.yaw), -1, 1))
    this.bumpPhase += Math.abs(this.speed) * dt * 3
    const jitter = Math.sin(this.bumpPhase) * 0.012 * clamp(Math.abs(this.speed) / 10, 0, 1)
    this.bodyTilt.rotation.x = damp(this.bodyTilt.rotation.x, pitch + jitter, 8, dt)
    this.bodyTilt.rotation.z = damp(this.bodyTilt.rotation.z, roll, 8, dt)
    this.bodyTilt.position.y = damp(this.bodyTilt.position.y, wet * -0.45, 5, dt)

    this.wheelSpin -= (this.speed / 0.72) * dt
    for (const w of this.wheels) w.rotation.x = this.wheelSpin
    // negated for the same reason as the yaw: positive steer is the driver's right
    for (const p of this.frontWheels) p.rotation.y = -this.steerAngle

    // --- lights follow the ignition ---
    const lit = this.engineOn
    for (const s of this.headlights) s.visible = lit
    this.fill.intensity = damp(this.fill.intensity, lit ? 45 : 0, 6, dt)
    this.lampMat.color.setHex(lit ? 0xfff6da : 0x14161a)
    this.tailMat.color.setHex(lit && input.brake ? 0xff2a1c : 0x3a0806)

    // --- how far the engine carries ---
    // Silent when shut down, so nothing can hear you; the decay is not instant,
    // which is why cutting it early matters more than cutting it close.
    const rev = clamp(Math.abs(this.speed) / JEEP_TOP_SPEED, 0, 1)
    const wantsNoise = lit ? 26 + rev * 72 + (input.throttle ? 8 : 0) : 0
    this.noiseRadius = damp(this.noiseRadius, wantsNoise, 3, dt)
  }

  dispose() {
    for (const d of this.disposables) d.dispose()
  }
}

const _n = new THREE.Vector3()
