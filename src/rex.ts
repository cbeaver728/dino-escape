import * as THREE from 'three'
import { World, HALF } from './world'
import { JEEP_TOP_SPEED } from './jeep'
import { Rng, angleDelta, clamp, damp, lerp } from './rng'

/** The headline number: a locked-on rex runs 1.3x the jeep's top speed. */
export const CHASE_SPEED = JEEP_TOP_SPEED * 1.3
const PATROL_SPEED = 3.4
const INVESTIGATE_SPEED = 7.5
/**
 * A sprint is faster than you can drive, so the escape has to come from the
 * recovery: over one full sprint-and-blow cycle a clean run nets you ground.
 * Clip a tree during the recovery and you hand all of it straight back.
 */
const WINDED_SPEED = JEEP_TOP_SPEED * 0.42

const SPRINT_SECONDS = 6
const WINDED_SECONDS = 6.5
const LOSE_DISTANCE = 120
const LOSE_SECONDS = 3
const CATCH_DISTANCE = 6.4
const ALWAYS_NOTICE = 26

export type RexState = 'patrol' | 'alert' | 'chase' | 'winded'

// ---------------------------------------------------------------------------
// rig constants
//
// Every limb geometry hangs from its joint down the -Y axis, so a joint angle
// of 0 points straight down. Rotating a joint by -x swings it forward (+Z),
// by +x swings it back. All the rest angles below follow from that.
// ---------------------------------------------------------------------------

const SCALE = 0.72 // rig is authored large, then brought down to jeep scale
const HIP_Y = 5.4 // body origin height, so the feet land on the ground

const FEMUR = -0.3
const TIBIA = 0.95
const META = -0.75

const NECK_WALK = -(Math.PI / 2 + 0.72) // head carried high, scanning
const NECK_RUN = -(Math.PI / 2 + 0.38) // lowered and thrown forward
const NECK2_WALK = 0.66
const NECK2_RUN = 0.44

const TAIL_WALK = Math.PI / 2 - 0.08
const TAIL_RUN = Math.PI / 2 - 0.36 // raised to counterbalance the sprint

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------

/** A tapered limb hanging from the origin down the -Y axis. */
function limb(rTop: number, rBot: number, len: number, seg = 7): THREE.CylinderGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1)
  g.translate(0, -len / 2, 0)
  return g
}

/** Concatenate a few small geometries so tooth rows cost one draw call. */
function mergeSimple(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let total = 0
  const parts = geos.map((g) => {
    const ng = g.index ? g.toNonIndexed() : g
    total += ng.getAttribute('position').count
    return ng
  })
  const pos = new Float32Array(total * 3)
  const nor = new Float32Array(total * 3)
  let o = 0
  for (const p of parts) {
    const pa = p.getAttribute('position') as THREE.BufferAttribute
    const na = p.getAttribute('normal') as THREE.BufferAttribute
    pos.set(pa.array as Float32Array, o * 3)
    nor.set(na.array as Float32Array, o * 3)
    o += pa.count
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  for (const p of parts) p.dispose()
  for (const g of geos) g.dispose()
  return out
}

/** Shared across every rex: one material set, one geometry set. */
class RexAssets {
  hide = new THREE.MeshStandardMaterial({ color: 0x3f4530, roughness: 0.95, metalness: 0, flatShading: true })
  belly = new THREE.MeshStandardMaterial({ color: 0x6b6c4e, roughness: 0.95, metalness: 0, flatShading: true })
  spine = new THREE.MeshStandardMaterial({ color: 0x242a1a, roughness: 1, metalness: 0, flatShading: true })
  bone = new THREE.MeshStandardMaterial({ color: 0xefe9d2, roughness: 0.35, metalness: 0.05 })
  eye = new THREE.MeshBasicMaterial({ color: 0xffc21f })
  claw = new THREE.MeshStandardMaterial({ color: 0x1b1812, roughness: 0.55, metalness: 0.1 })

  torso: THREE.BufferGeometry
  bellyG: THREE.BufferGeometry
  hip: THREE.BufferGeometry
  shoulder: THREE.BufferGeometry
  neckA: THREE.BufferGeometry
  neckB: THREE.BufferGeometry
  skull: THREE.BufferGeometry
  snout: THREE.BufferGeometry
  jaw: THREE.BufferGeometry
  brow: THREE.BufferGeometry
  eyeG: THREE.BufferGeometry
  teethTop: THREE.BufferGeometry
  teethBottom: THREE.BufferGeometry
  tail: THREE.BufferGeometry[]
  femur: THREE.BufferGeometry
  tibia: THREE.BufferGeometry
  meta: THREE.BufferGeometry
  foot: THREE.BufferGeometry
  toe: THREE.BufferGeometry
  armA: THREE.BufferGeometry
  armB: THREE.BufferGeometry
  clawG: THREE.BufferGeometry
  scute: THREE.BufferGeometry

  constructor() {
    const torso = new THREE.SphereGeometry(1, 12, 9)
    torso.scale(1.2, 1.32, 2.5)
    this.torso = torso

    const bg = new THREE.SphereGeometry(1, 10, 7)
    bg.scale(1.06, 0.8, 2.05)
    this.bellyG = bg

    const hip = new THREE.SphereGeometry(1, 10, 8)
    hip.scale(1.34, 1.4, 1.3)
    this.hip = hip

    const sh = new THREE.SphereGeometry(1, 10, 8)
    sh.scale(1.06, 1.1, 0.95)
    this.shoulder = sh

    this.neckA = limb(0.9, 1.12, 1.25, 8)
    this.neckB = limb(0.72, 0.9, 1.05, 8)

    // Head: deep and blunt rather than beaky. This is the part the player
    // actually gets a good look at, so it carries the most shape.
    const skull = new THREE.BoxGeometry(1.3, 1.4, 1.7)
    skull.translate(0, 0.05, 0.35)
    this.skull = skull

    const snout = new THREE.CylinderGeometry(0.62, 0.86, 1.25, 6)
    snout.rotateX(Math.PI / 2)
    snout.scale(1.05, 0.92, 1)
    snout.translate(0, -0.02, 1.75)
    this.snout = snout

    const jaw = new THREE.BoxGeometry(0.98, 0.4, 2.25)
    jaw.translate(0, -0.2, 1.0)
    this.jaw = jaw

    const brow = new THREE.BoxGeometry(1.44, 0.34, 0.7)
    brow.translate(0, 0.66, 0.55)
    this.brow = brow

    this.eyeG = new THREE.SphereGeometry(0.17, 8, 6)

    const upper: THREE.BufferGeometry[] = []
    const lower: THREE.BufferGeometry[] = []
    for (let i = 0; i < 8; i++) {
      const z = 0.45 + i * 0.29
      const s = 1 - i * 0.06
      for (const sx of [-1, 1]) {
        const t = new THREE.ConeGeometry(0.1 * s, 0.5 * s, 4)
        t.rotateX(Math.PI)
        t.translate(sx * 0.38, -0.36, z)
        upper.push(t)
        const b = new THREE.ConeGeometry(0.09 * s, 0.4 * s, 4)
        b.translate(sx * 0.35, 0.2, z * 0.95)
        lower.push(b)
      }
    }
    this.teethTop = mergeSimple(upper)
    this.teethBottom = mergeSimple(lower)

    // shorter, fatter tail: the long thin version read as a broom handle
    this.tail = []
    for (let i = 0; i < 6; i++) {
      const r0 = lerp(1.1, 0.16, i / 6)
      const r1 = lerp(1.1, 0.16, (i + 1) / 6)
      this.tail.push(limb(r1, r0, 1.05, 6))
    }

    this.femur = limb(0.64, 1.12, 2.0, 8)
    this.tibia = limb(0.42, 0.64, 2.0, 7)
    this.meta = limb(0.31, 0.42, 1.2, 6)
    const foot = new THREE.BoxGeometry(0.7, 0.32, 0.9)
    foot.translate(0, -0.16, 0.16)
    this.foot = foot
    const toe = new THREE.BoxGeometry(0.26, 0.26, 0.7)
    toe.translate(0, -0.16, 0.62)
    this.toe = toe

    this.armA = limb(0.18, 0.3, 0.85, 5)
    this.armB = limb(0.12, 0.18, 0.7, 5)
    const cl = new THREE.ConeGeometry(0.08, 0.36, 4)
    cl.rotateX(Math.PI / 2)
    this.clawG = cl

    this.scute = new THREE.ConeGeometry(0.24, 0.62, 4)
  }
}

let assets: RexAssets | null = null
function getAssets(): RexAssets {
  if (!assets) assets = new RexAssets()
  return assets
}

// ---------------------------------------------------------------------------
// the animal
// ---------------------------------------------------------------------------

export class Rex {
  readonly root = new THREE.Group()
  readonly position = new THREE.Vector3()
  yaw = 0
  state: RexState = 'patrol'
  /** Distance to the player, refreshed every tick. */
  distance = Infinity

  private body = new THREE.Group()
  private tailRoot = new THREE.Group()
  private tailLinks: THREE.Group[] = []
  private neck = new THREE.Group()
  private neck2 = new THREE.Group()
  private head = new THREE.Group()
  private jaw = new THREE.Group()
  private legs: { hip: THREE.Group; knee: THREE.Group; ankle: THREE.Group }[] = []
  private arms: THREE.Group[] = []
  private scale: number

  private gait = 0
  private speed = 0
  private stamina = SPRINT_SECONDS
  private windedFor = 0
  private lostFor = 0
  private reaction = 0
  private wander = new THREE.Vector2()
  private wanderTimer = 0
  private bodyPitch = 0
  private jawOpen = 0

  constructor(private world: World, rng: Rng) {
    const a = getAssets()
    this.root.add(this.body)

    const mesh = (g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D) => {
      const x = new THREE.Mesh(g, m)
      parent.add(x)
      return x
    }

    // --- torso, hips, shoulders ---
    mesh(a.torso, a.hide, this.body).position.set(0, 0, 0.3)
    mesh(a.bellyG, a.belly, this.body).position.set(0, -0.55, 0.35)
    mesh(a.hip, a.hide, this.body).position.set(0, -0.15, -1.85)
    mesh(a.shoulder, a.hide, this.body).position.set(0, 0.2, 2.0)

    // spinal scutes: they catch a headlight sweeping across the back
    for (let i = 0; i < 10; i++) {
      const t = i / 9
      const s = mesh(a.scute, a.spine, this.body)
      const arc = Math.sin(t * Math.PI)
      s.position.set(0, lerp(0.9, 1.15, arc) + 0.35, lerp(-2.4, 2.1, t))
      s.scale.setScalar(lerp(0.55, 1.2, arc))
      s.rotation.x = -0.2
    }

    // --- tail: a chain that whips out behind ---
    this.tailRoot.position.set(0, 0.15, -2.9)
    this.tailRoot.rotation.x = TAIL_WALK
    this.body.add(this.tailRoot)
    let parent: THREE.Object3D = this.tailRoot
    for (let i = 0; i < a.tail.length; i++) {
      const link = new THREE.Group()
      if (i > 0) link.position.y = -1.05
      mesh(a.tail[i], i > 4 ? a.spine : a.hide, link)
      parent.add(link)
      this.tailLinks.push(link)
      parent = link
    }

    // --- neck: rises from the shoulders, then levels out ---
    this.neck.position.set(0, 0.7, 2.1)
    this.neck.rotation.x = NECK_WALK
    this.body.add(this.neck)
    mesh(a.neckA, a.hide, this.neck)

    this.neck2.position.y = -1.25
    this.neck2.rotation.x = NECK2_WALK
    this.neck.add(this.neck2)
    mesh(a.neckB, a.hide, this.neck2)

    // --- head: cancels the neck angles so the skull sits level ---
    this.head.position.y = -1.05
    this.head.rotation.x = -(NECK_WALK + NECK2_WALK) - 0.08
    this.neck2.add(this.head)
    mesh(a.skull, a.hide, this.head)
    mesh(a.snout, a.hide, this.head)
    mesh(a.brow, a.spine, this.head)
    mesh(a.teethTop, a.bone, this.head)
    for (const sx of [-1, 1]) {
      mesh(a.eyeG, a.eye, this.head).position.set(sx * 0.47, 0.3, 0.52)
    }

    this.jaw.position.set(0, -0.3, 0.2)
    this.head.add(this.jaw)
    mesh(a.jaw, a.hide, this.jaw)
    mesh(a.teethBottom, a.bone, this.jaw)

    // --- legs: femur down-forward, tibia back, foot flat ---
    for (const sx of [-1, 1]) {
      const hip = new THREE.Group()
      hip.position.set(sx * 1.05, -0.5, -1.4)
      hip.rotation.x = FEMUR
      this.body.add(hip)
      mesh(a.femur, a.hide, hip)

      const knee = new THREE.Group()
      knee.position.y = -2.0
      knee.rotation.x = TIBIA
      hip.add(knee)
      mesh(a.tibia, a.hide, knee)

      const ankle = new THREE.Group()
      ankle.position.y = -2.0
      ankle.rotation.x = META
      knee.add(ankle)
      mesh(a.meta, a.hide, ankle)

      const foot = new THREE.Group()
      foot.position.y = -1.2
      ankle.add(foot)
      mesh(a.foot, a.claw, foot)
      for (const tx of [-0.24, 0, 0.24]) {
        const toe = mesh(a.toe, a.claw, foot)
        toe.position.x = tx
        toe.rotation.y = tx * 1.2
      }
      this.legs.push({ hip, knee, ankle })
    }

    // --- famously little arms ---
    for (const sx of [-1, 1]) {
      const up = new THREE.Group()
      up.position.set(sx * 0.95, 0.1, 1.55)
      up.rotation.set(-0.5, 0, sx * 0.35)
      this.body.add(up)
      mesh(a.armA, a.hide, up)
      const fore = new THREE.Group()
      fore.position.y = -0.85
      fore.rotation.x = -1.3
      up.add(fore)
      mesh(a.armB, a.hide, fore)
      for (const cx of [-0.1, 0.1]) {
        mesh(a.clawG, a.claw, fore).position.set(cx, -0.66, 0.12)
      }
      this.arms.push(up)
    }

    // individuals differ a little in size
    this.scale = SCALE * rng.range(0.92, 1.12)
    this.body.scale.setScalar(this.scale)
    this.body.position.y = HIP_Y * this.scale
    this.gait = rng.range(0, 1)
    this.wanderTimer = rng.range(0, 4)
  }

  place(x: number, z: number, yaw: number) {
    this.position.set(x, this.world.heightAt(x, z), z)
    this.yaw = yaw
    this.state = 'patrol'
    this.stamina = SPRINT_SECONDS
    this.speed = PATROL_SPEED
    this.root.position.copy(this.position)
    this.root.rotation.y = yaw
  }

  /**
   * @returns 'spotted' on the tick it locks on, 'caught' if it reaches the jeep.
   */
  update(
    dt: number,
    time: number,
    target: THREE.Vector3,
    noiseRadius: number,
    rng: Rng,
  ): 'none' | 'spotted' | 'caught' {
    const dx = target.x - this.position.x
    const dz = target.z - this.position.z
    this.distance = Math.hypot(dx, dz)
    let event: 'none' | 'spotted' | 'caught' = 'none'

    // ---------------- senses ----------------
    const heard = this.distance < noiseRadius || this.distance < ALWAYS_NOTICE
    if (this.state === 'patrol' || this.state === 'alert') {
      if (heard) {
        this.reaction += dt
        this.state = 'alert'
        if (this.reaction > 0.55) {
          this.state = 'chase'
          this.lostFor = 0
          event = 'spotted'
        }
      } else {
        this.reaction = Math.max(0, this.reaction - dt * 0.8)
        if (this.state === 'alert' && this.reaction <= 0) this.state = 'patrol'
      }
    } else {
      // chasing or winded: it keeps coming until you break contact
      if (this.distance > LOSE_DISTANCE && !heard) {
        this.lostFor += dt
        if (this.lostFor > LOSE_SECONDS) {
          this.state = 'patrol'
          this.reaction = 0
          this.stamina = SPRINT_SECONDS * 0.6
        }
      } else {
        this.lostFor = 0
      }
    }

    // ---------------- stamina ----------------
    if (this.state === 'chase') {
      this.stamina -= dt
      if (this.stamina <= 0) {
        this.state = 'winded'
        this.windedFor = WINDED_SECONDS
      }
    } else if (this.state === 'winded') {
      this.windedFor -= dt
      if (this.windedFor <= 0) {
        this.state = 'chase'
        this.stamina = SPRINT_SECONDS * 0.8
      }
    } else {
      this.stamina = Math.min(SPRINT_SECONDS, this.stamina + dt * 0.9)
    }

    // ---------------- where it wants to go ----------------
    let desiredYaw: number
    let wantSpeed: number
    let turnRate: number

    if (this.state === 'chase' || this.state === 'winded') {
      desiredYaw = Math.atan2(dx, dz)
      wantSpeed = this.state === 'chase' ? CHASE_SPEED : WINDED_SPEED
      // big animal, wide arc: this is the whole counterplay
      turnRate = this.state === 'chase' ? 1.0 : 1.5
    } else if (this.state === 'alert') {
      desiredYaw = Math.atan2(dx, dz)
      wantSpeed = INVESTIGATE_SPEED
      turnRate = 1.6
    } else {
      this.wanderTimer -= dt
      if (this.wanderTimer <= 0) {
        this.wanderTimer = rng.range(4, 11)
        this.wander.set(rng.range(-1, 1), rng.range(-1, 1)).normalize()
      }
      // drift back toward the middle of the map rather than hugging the edge
      const pull = 0.0022
      desiredYaw = Math.atan2(
        this.wander.x - this.position.x * pull,
        this.wander.y - this.position.z * pull,
      )
      wantSpeed = PATROL_SPEED
      turnRate = 0.85
    }

    // ---------------- crude obstacle steering ----------------
    const look = 5 + this.speed * 0.42
    if (this.blocked(desiredYaw, look)) {
      const swing = this.state === 'chase' ? 0.55 : 0.85
      const left = desiredYaw - swing
      const right = desiredYaw + swing
      const lFree = !this.blocked(left, look)
      const rFree = !this.blocked(right, look)
      if (lFree && !rFree) desiredYaw = left
      else if (rFree && !lFree) desiredYaw = right
      else desiredYaw = angleDelta(this.yaw, left) < 0 ? left : right
    }

    // ---------------- move ----------------
    const turn = clamp(angleDelta(this.yaw, desiredYaw), -turnRate * dt, turnRate * dt)
    this.yaw += turn

    const wet = clamp(this.world.waterDepth(this.position.x, this.position.z) / 1.4, 0, 1)
    wantSpeed *= 1 - 0.66 * wet
    // it cannot hold top speed through a hard turn
    wantSpeed *= 1 - clamp(Math.abs(turn / dt) / turnRate, 0, 1) * 0.22
    // Twelve metres of animal pays more for thick timber than a jeep does.
    // In the open it runs you down; in a dense stand you can hold it off.
    wantSpeed *= 1 - this.clutter() * 0.14
    this.speed = damp(this.speed, wantSpeed, 2.2, dt)

    let nx = this.position.x + Math.sin(this.yaw) * this.speed * dt
    let nz = this.position.z + Math.cos(this.yaw) * this.speed * dt
    nx = clamp(nx, -HALF + 30, HALF - 30)
    nz = clamp(nz, -HALF + 30, HALF - 30)
    this.position.set(nx, this.world.heightAt(nx, nz), nz)

    if (this.distance < CATCH_DISTANCE) event = 'caught'

    this.pose(dt, time)
    return event
  }

  /** 0 in the open, 3 when it is shouldering through a stand of trees. */
  private clutter(): number {
    let n = 0
    for (const off of [-0.5, 0, 0.5]) {
      const y = this.yaw + off
      const x = this.position.x + Math.sin(y) * 9
      const z = this.position.z + Math.cos(y) * 9
      if (this.world.treeHit(x, z, 3.4)) n++
    }
    return n
  }

  private blocked(yaw: number, dist: number): boolean {
    const x = this.position.x + Math.sin(yaw) * dist
    const z = this.position.z + Math.cos(yaw) * dist
    if (this.world.treeHit(x, z, 2.4)) return true
    return this.world.waterDepth(x, z) > 1.6
  }

  // ---------------- animation ----------------

  private pose(dt: number, time: number) {
    this.root.position.copy(this.position)
    this.root.rotation.y = this.yaw

    const running = this.state === 'chase'
    const moving = clamp(this.speed / 6, 0, 1)
    // stride frequency scales with speed, but a sprint has a longer stride
    const strideLen = running ? 7.4 : 4.4
    this.gait += (this.speed / strideLen) * dt
    const th = this.gait * Math.PI * 2

    const effort = clamp(this.speed / CHASE_SPEED, 0, 1)
    const amp = lerp(0.34, 0.85, effort)
    const lift = lerp(0.05, 0.3, effort)

    for (let i = 0; i < this.legs.length; i++) {
      const p = th + i * Math.PI
      const { hip, knee, ankle } = this.legs[i]
      hip.rotation.x = FEMUR + Math.sin(p) * amp
      // the knee folds up hard on the recovery stroke
      knee.rotation.x = TIBIA + Math.max(0, Math.sin(p + 1.9)) * (0.35 + amp * 0.55)
      ankle.rotation.x = META - (hip.rotation.x - FEMUR + knee.rotation.x - TIBIA) * 0.55
    }

    // body: bob, roll with the stride, pitch forward at a sprint
    this.bodyPitch = damp(this.bodyPitch, running ? -0.26 : -0.03, 3, dt)
    this.body.rotation.x = this.bodyPitch + Math.sin(th * 2) * 0.03 * moving
    this.body.rotation.z = Math.sin(th) * 0.07 * moving
    this.body.rotation.y = Math.sin(th) * 0.05 * moving
    this.body.position.y = (HIP_Y + Math.sin(th * 2 + 1.2) * lift * moving) * this.scale

    // tail: whips as it walks, stiffens and lifts into a sprint
    this.tailRoot.rotation.x = damp(this.tailRoot.rotation.x, running ? TAIL_RUN : TAIL_WALK, 3, dt)
    for (let i = 0; i < this.tailLinks.length; i++) {
      const l = this.tailLinks[i]
      const lag = i * 0.55
      const w = (i + 1) / this.tailLinks.length
      l.rotation.z = Math.sin(th * 0.5 - lag) * (running ? 0.08 : 0.15) * w * (0.4 + moving)
      l.rotation.x = i === 0 ? 0 : Math.sin(th - lag) * 0.045 * w + (running ? -0.03 : 0.02)
    }

    // neck and head
    this.neck.rotation.x = damp(this.neck.rotation.x, running ? NECK_RUN : NECK_WALK, 3, dt)
    this.neck2.rotation.x = damp(this.neck2.rotation.x, running ? NECK2_RUN : NECK2_WALK, 3, dt)
    // keep the skull level whatever the neck is doing, then add the bob
    this.head.rotation.x =
      -(this.neck.rotation.x + this.neck2.rotation.x) +
      (running ? -0.16 : -0.06) +
      Math.sin(th * 2) * 0.05 * moving
    // an idle animal scans side to side; a hunting one is locked on
    this.head.rotation.y = running ? 0 : Math.sin(time * 0.55 + this.gait) * 0.3

    const wantJaw = running ? 0.44 + Math.sin(time * 7) * 0.1 : 0.03
    this.jawOpen = damp(this.jawOpen, wantJaw, 6, dt)
    this.jaw.rotation.x = this.jawOpen

    for (let i = 0; i < this.arms.length; i++) {
      this.arms[i].rotation.x = -0.5 + Math.sin(th + i * Math.PI) * 0.16 * moving
    }
  }

  dispose() {
    this.root.clear()
  }
}
