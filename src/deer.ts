import * as THREE from 'three'
import { World, HALF, WATER_LEVEL } from './world'
import { Rng, angleDelta, clamp, damp, lerp } from './rng'

/**
 * Deer exist to leak information. They are the only thing in the game that
 * reacts to a T-Rex before you can see or hear it yourself, so a herd breaking
 * cover with their tails up tells you where one is - and which way not to go.
 */

const GRAZE_SPEED = 1.1
const TROT_SPEED = 5
/** Faster than a rex's 12 m/s deer-chase, so they are never actually caught. */
const FLEE_SPEED = 16.5

/** How close a rex has to be before the herd bolts. */
const REX_ALARM = 78
/** Headlights and engine noise make them uneasy at much shorter range. */
const JEEP_ALARM = 26
/** Seconds they keep running after whatever spooked them is out of range. */
const PANIC_TAIL = 3.5

/** Anything a deer wants to run away from. Structural: Rex satisfies it. */
export interface Threat {
  position: THREE.Vector3
}

// ---------------------------------------------------------------------------
// shared model
// ---------------------------------------------------------------------------

function limb(rTop: number, rBot: number, len: number, seg = 5): THREE.CylinderGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1)
  g.translate(0, -len / 2, 0)
  return g
}

class DeerAssets {
  coat = new THREE.MeshLambertMaterial({ color: 0x7d6544 })
  belly = new THREE.MeshLambertMaterial({ color: 0xbfae90 })
  flag = new THREE.MeshBasicMaterial({ color: 0xeae4d4 })
  dark = new THREE.MeshLambertMaterial({ color: 0x3a2f22 })

  body: THREE.BufferGeometry
  bellyG: THREE.BufferGeometry
  neck: THREE.BufferGeometry
  head: THREE.BufferGeometry
  muzzle: THREE.BufferGeometry
  ear: THREE.BufferGeometry
  leg: THREE.BufferGeometry
  tail: THREE.BufferGeometry
  antler: THREE.BufferGeometry

  constructor() {
    const body = new THREE.SphereGeometry(1, 8, 6)
    body.scale(0.32, 0.36, 0.72)
    this.body = body

    const bg = new THREE.SphereGeometry(1, 7, 5)
    bg.scale(0.28, 0.2, 0.6)
    this.bellyG = bg

    this.neck = limb(0.11, 0.17, 0.5, 5)

    const head = new THREE.BoxGeometry(0.2, 0.22, 0.34)
    head.translate(0, 0, 0.08)
    this.head = head

    const muzzle = new THREE.BoxGeometry(0.13, 0.13, 0.22)
    muzzle.translate(0, -0.04, 0.32)
    this.muzzle = muzzle

    const ear = new THREE.ConeGeometry(0.06, 0.18, 4)
    this.ear = ear

    this.leg = limb(0.045, 0.065, 0.62, 4)

    const tail = new THREE.BoxGeometry(0.16, 0.22, 0.06)
    tail.translate(0, -0.08, 0)
    this.tail = tail

    const antler = new THREE.ConeGeometry(0.035, 0.3, 4)
    this.antler = antler
  }
}

let assets: DeerAssets | null = null
function getAssets(): DeerAssets {
  if (!assets) assets = new DeerAssets()
  return assets
}

// ---------------------------------------------------------------------------
// one animal
// ---------------------------------------------------------------------------

class Deer {
  readonly root = new THREE.Group()
  readonly position = new THREE.Vector3()
  yaw = 0
  speed = 0
  /** Offset from the herd centre this individual likes to hold. */
  readonly slot = new THREE.Vector2()

  private body = new THREE.Group()
  private legs: THREE.Object3D[] = []
  private neck = new THREE.Group()
  private tail = new THREE.Group()
  private gait = 0

  constructor(rng: Rng, stag: boolean) {
    const a = getAssets()
    this.root.add(this.body)

    const mesh = (g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D) => {
      const x = new THREE.Mesh(g, m)
      parent.add(x)
      return x
    }

    mesh(a.body, a.coat, this.body)
    mesh(a.bellyG, a.belly, this.body).position.set(0, -0.14, 0.02)

    this.neck.position.set(0, 0.2, 0.55)
    this.neck.rotation.x = -2.5 // up and forward
    this.body.add(this.neck)
    mesh(a.neck, a.coat, this.neck)

    const head = new THREE.Group()
    head.position.y = -0.5
    head.rotation.x = 2.5
    this.neck.add(head)
    mesh(a.head, a.coat, head)
    mesh(a.muzzle, a.dark, head)
    for (const sx of [-1, 1]) {
      const ear = mesh(a.ear, a.coat, head)
      ear.position.set(sx * 0.12, 0.14, -0.02)
      ear.rotation.z = sx * 0.7
      if (stag) {
        const ant = mesh(a.antler, a.dark, head)
        ant.position.set(sx * 0.09, 0.22, 0.02)
        ant.rotation.z = sx * 0.45
        ant.rotation.x = -0.3
      }
    }

    // The tail is the whole point: white, and it goes up when they run.
    this.tail.position.set(0, 0.16, -0.66)
    this.body.add(this.tail)
    mesh(a.tail, a.flag, this.tail)

    for (const sx of [-1, 1]) {
      for (const sz of [0.42, -0.42]) {
        const leg = new THREE.Group()
        leg.position.set(sx * 0.2, -0.12, sz)
        this.body.add(leg)
        mesh(a.leg, a.dark, leg)
        this.legs.push(leg)
      }
    }

    this.body.position.y = 0.78
    this.body.scale.setScalar(stag ? 1.12 : rng.range(0.82, 1.0))
    this.gait = rng.range(0, 1)
  }

  place(x: number, z: number, y: number, yaw: number) {
    this.position.set(x, y, z)
    this.yaw = yaw
    this.root.position.copy(this.position)
    this.root.rotation.y = yaw
  }

  /** `panic` 0..1 drives gait, tail flag and how hard it leans into the run. */
  pose(dt: number, panic: number) {
    this.root.position.copy(this.position)
    this.root.rotation.y = this.yaw

    const moving = clamp(this.speed / 3, 0, 1)
    this.gait += (this.speed / 1.9) * dt
    const th = this.gait * Math.PI * 2
    const amp = lerp(0.3, 0.95, clamp(this.speed / FLEE_SPEED, 0, 1))

    // diagonal pairs, like a real quadruped
    for (let i = 0; i < this.legs.length; i++) {
      const diagonal = i === 0 || i === 3 ? 0 : Math.PI
      this.legs[i].rotation.x = Math.sin(th + diagonal) * amp
    }
    this.body.position.y = 0.78 + Math.abs(Math.sin(th)) * 0.1 * moving
    this.body.rotation.x = -panic * 0.12

    // head down to graze, up and forward when running
    this.neck.rotation.x = damp(this.neck.rotation.x, panic > 0.2 ? -2.5 : -1.85, 4, dt)
    // tail clamped down at rest, flared straight up in flight
    this.tail.rotation.x = damp(this.tail.rotation.x, panic > 0.2 ? -2.1 : -0.2, 8, dt)
  }
}

// ---------------------------------------------------------------------------
// the herd
// ---------------------------------------------------------------------------

export class Herd {
  readonly group = new THREE.Group()
  readonly centre = new THREE.Vector3()
  /** 0 grazing, 1 flat-out. Drives what the player sees from a distance. */
  panic = 0

  private deer: Deer[] = []
  private target = new THREE.Vector2()
  private wanderTimer = 0
  private panicFor = 0
  private fleeDir = new THREE.Vector2(0, 1)

  constructor(
    private world: World,
    rng: Rng,
    x: number,
    z: number,
  ) {
    const n = rng.int(4, 6)
    for (let i = 0; i < n; i++) {
      const deer = new Deer(rng, i === 0)
      const a = rng.range(0, Math.PI * 2)
      const r = rng.range(2, 9)
      deer.slot.set(Math.cos(a) * r, Math.sin(a) * r)
      const dx = x + deer.slot.x
      const dz = z + deer.slot.y
      deer.place(dx, dz, world.heightAt(dx, dz), rng.range(0, Math.PI * 2))
      this.group.add(deer.root)
      this.deer.push(deer)
    }
    this.centre.set(x, world.heightAt(x, z), z)
    this.target.set(x, z)
    this.wanderTimer = rng.range(0, 6)
  }

  update(dt: number, threats: Threat[], jeep: THREE.Vector3, rng: Rng) {
    // ---- is anything worrying them? ----
    let nearest: Threat | null = null
    let nearestD = Infinity
    for (const t of threats) {
      const d = Math.hypot(t.position.x - this.centre.x, t.position.z - this.centre.z)
      if (d < nearestD) {
        nearestD = d
        nearest = t
      }
    }
    const jeepD = Math.hypot(jeep.x - this.centre.x, jeep.z - this.centre.z)

    if (nearest && nearestD < REX_ALARM) {
      this.panicFor = PANIC_TAIL
      this.fleeDir
        .set(this.centre.x - nearest.position.x, this.centre.z - nearest.position.z)
        .normalize()
    } else if (jeepD < JEEP_ALARM) {
      // wary of the jeep, but it is a trot away rather than a stampede
      this.panicFor = Math.max(this.panicFor, 0.9)
      this.fleeDir.set(this.centre.x - jeep.x, this.centre.z - jeep.z).normalize()
    } else {
      this.panicFor = Math.max(0, this.panicFor - dt)
    }
    const running = this.panicFor > 0
    const hard = nearest !== null && nearestD < REX_ALARM
    this.panic = damp(this.panic, running ? (hard ? 1 : 0.45) : 0, 6, dt)

    // ---- where the herd is headed ----
    if (running) {
      this.target.set(
        this.centre.x + this.fleeDir.x * 90,
        this.centre.z + this.fleeDir.y * 90,
      )
    } else {
      this.wanderTimer -= dt
      if (this.wanderTimer <= 0) {
        this.wanderTimer = rng.range(5, 13)
        const a = rng.range(0, Math.PI * 2)
        const r = rng.range(15, 55)
        this.target.set(this.centre.x + Math.cos(a) * r, this.centre.z + Math.sin(a) * r)
      }
    }
    // keep them out of the water and off the map edge
    this.target.x = clamp(this.target.x, -HALF + 60, HALF - 60)
    this.target.y = clamp(this.target.y, -HALF + 60, HALF - 60)

    const herdSpeed = running ? (hard ? FLEE_SPEED : TROT_SPEED) : GRAZE_SPEED

    // ---- move each animal toward its slot in the formation ----
    let cx = 0
    let cz = 0
    for (const deer of this.deer) {
      const wantX = this.target.x + deer.slot.x
      const wantZ = this.target.y + deer.slot.y
      const dx = wantX - deer.position.x
      const dz = wantZ - deer.position.z
      const dist = Math.hypot(dx, dz)

      let want = herdSpeed
      if (!running && dist < 4) want = 0 // arrived: stop and graze
      deer.speed = damp(deer.speed, want, 3, dt)

      if (dist > 0.5) {
        const desired = Math.atan2(dx, dz)
        const turn = clamp(angleDelta(deer.yaw, desired), -3.4 * dt, 3.4 * dt)
        deer.yaw += turn
      }

      let nx = deer.position.x + Math.sin(deer.yaw) * deer.speed * dt
      let nz = deer.position.z + Math.cos(deer.yaw) * deer.speed * dt
      // They slip between trunks rather than colliding, but they keep out of
      // the rivers. Veer along the bank rather than stopping dead at it, or a
      // fleeing herd piles up on the water and gets run down.
      if (this.world.waterDepth(nx, nz) > 0.4) {
        let dry = false
        for (const off of [0.9, -0.9, 1.8, -1.8, 2.7, -2.7]) {
          const y2 = deer.yaw + off
          const tx = deer.position.x + Math.sin(y2) * deer.speed * dt
          const tz = deer.position.z + Math.cos(y2) * deer.speed * dt
          if (this.world.waterDepth(tx, tz) <= 0.4) {
            deer.yaw = y2
            nx = tx
            nz = tz
            dry = true
            break
          }
        }
        if (!dry) {
          nx = deer.position.x
          nz = deer.position.z
        }
      }
      nx = clamp(nx, -HALF + 40, HALF - 40)
      nz = clamp(nz, -HALF + 40, HALF - 40)
      deer.position.set(nx, this.world.heightAt(nx, nz), nz)
      deer.pose(dt, this.panic)
      cx += nx
      cz += nz
    }
    cx /= this.deer.length
    cz /= this.deer.length
    this.centre.set(cx, this.world.heightAt(cx, cz), cz)
  }

  /** Deer in this herd, in a stable order, for recording and playback. */
  get animals(): { position: THREE.Vector3; yaw: number; speed: number }[] {
    return this.deer
  }

  /** Pose the herd from recorded frames. `read` yields one deer at a time. */
  applyReplay(
    read: (i: number) => { x: number; z: number; yaw: number; speed: number },
    panic: number,
    dt: number,
  ) {
    this.panic = panic
    let cx = 0
    let cz = 0
    for (let i = 0; i < this.deer.length; i++) {
      const d = read(i)
      const deer = this.deer[i]
      deer.position.set(d.x, this.world.heightAt(d.x, d.z), d.z)
      deer.yaw = d.yaw
      deer.speed = d.speed
      deer.pose(dt, panic)
      cx += d.x
      cz += d.z
    }
    cx /= this.deer.length
    cz /= this.deer.length
    this.centre.set(cx, this.world.heightAt(cx, cz), cz)
  }

  setVisible(v: boolean) {
    this.group.visible = v
  }

  dispose() {
    this.group.clear()
  }
}

/** Scatter herds across the dry, open-ish parts of the map. */
export function spawnHerds(world: World, rng: Rng, count: number): Herd[] {
  const herds: Herd[] = []
  for (let i = 0; i < count; i++) {
    let x = 0
    let z = 0
    let ok = false
    for (let t = 0; t < 300 && !ok; t++) {
      x = rng.range(-HALF + 110, HALF - 110)
      z = rng.range(-HALF + 110, HALF - 110)
      if (world.heightAt(x, z) < WATER_LEVEL + 1.5) continue
      if (Math.hypot(x - world.base.x, z - world.base.z) < 90) continue
      ok = true
    }
    herds.push(new Herd(world, rng, x, z))
  }
  return herds
}
