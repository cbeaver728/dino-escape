import * as THREE from 'three'
import { World, HALF } from './world'
import { JEEP_TOP_SPEED } from './jeep'
import { Rng, angleDelta, clamp, damp, lerp } from './rng'

/** The headline number: a locked-on rex runs 1.3x the jeep's top speed. */
export const CHASE_SPEED = JEEP_TOP_SPEED * 1.3
/** A heavy animal ambling, not jogging: slow, but plainly covering ground. */
const PATROL_SPEED = 2.7
const INVESTIGATE_SPEED = 7.5
/**
 * A sprint is faster than you can drive, so the escape has to come from the
 * recovery: over one full sprint-and-blow cycle a clean run nets you ground.
 * Clip a tree during the recovery and you hand all of it straight back.
 */
const WINDED_SPEED = JEEP_TOP_SPEED * 0.42

const SPRINT_SECONDS = 6
const WINDED_SECONDS = 6.5
/**
 * Seconds with no trace of you before it stops chasing and starts hunting.
 * An engine cutting out is obvious immediately; a jeep pulling out of earshot
 * takes it a while to be sure about.
 */
const LOSE_SECONDS_SILENCED = 0.7
const LOSE_SECONDS_OUTRUN = 3
const CATCH_DISTANCE = 6.4
/**
 * Two burning headlights in a black forest are their own giveaway, so with the
 * engine running this is the floor no matter how gently you creep. It sits
 * above the exposed-in-the-open sight range on purpose: going dark has to be an
 * improvement everywhere, and a big one under cover.
 */
const HEADLIGHT_RANGE = 78

/** How long it casts around the last place it had you before giving up. */
const SEARCH_SECONDS = 14
/** Eyesight against a silent jeep: out in the open, versus buried in timber. */
const SIGHT_EXPOSED = 46
const SIGHT_HIDDEN = 6.5

/** How close a herd has to be before a wandering rex takes an interest. Must
 * exceed the deer's own alarm range, or they bolt before it ever commits. */
const DEER_NOTICE = 130
/**
 * Slower than the deer, so these runs never end in a kill - it is a
 * distraction, not a hunt. A rex busy with deer is one not looking for you.
 */
const DEER_CHASE_SPEED = 12
const DEER_GIVE_UP = [9, 19] as const
/** Odds a rex bothers at all; the rest of the time it just watches them go. */
const DEER_INTEREST = 0.72
const DEER_COOLDOWN = 5

export type RexState = 'patrol' | 'alert' | 'chase' | 'winded' | 'search' | 'deer'

/** Something a rex might run at instead of you. Structural: Herd satisfies it. */
export interface Quarry {
  centre: THREE.Vector3
}

/** What the player is giving away this tick. */
export interface PlayerSense {
  position: THREE.Vector3
  /** Engine noise as a hearing radius; zero when shut down. */
  noiseRadius: number
  /** 0 out in the open, 1 with enough trees around to break up the shape. */
  cover: number
  engineRunning: boolean
}

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

    this.eyeG = new THREE.SphereGeometry(0.21, 8, 6)

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
  /** Current ground speed, for the recorder. */
  get replaySpeed(): number {
    return this.speed
  }

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

  /** Last place it had a fix on the player. */
  private lastKnown = new THREE.Vector3()
  private searchAnchor = new THREE.Vector3()
  private searchPoint = new THREE.Vector3()
  private rangeAtLoss = 0
  private deerTarget: Quarry | null = null
  private deerFor = 0
  private deerCooldown = 0
  private searchFor = 0

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
    // Set proud of the skull, not inside it: with the engine off these two
    // sparks are the only thing the player can actually see coming.
    for (const sx of [-1, 1]) {
      mesh(a.eyeG, a.eye, this.head).position.set(sx * 0.66, 0.42, 0.58)
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
    this.reaction = 0
    this.lostFor = 0
    this.searchFor = 0
    this.lastKnown.copy(this.position)
    this.searchPoint.copy(this.position)
    this.searchAnchor.copy(this.position)
    this.deerTarget = null
    this.deerCooldown = 0
    this.root.position.copy(this.position)
    this.root.rotation.y = yaw
  }

  /**
   * @returns 'spotted' on the tick it locks on, 'caught' if it reaches the jeep.
   */
  update(
    dt: number,
    time: number,
    sense: PlayerSense,
    herds: Quarry[],
    rng: Rng,
  ): 'none' | 'spotted' | 'caught' {
    const dx = sense.position.x - this.position.x
    const dz = sense.position.z - this.position.z
    this.distance = Math.hypot(dx, dz)
    let event: 'none' | 'spotted' | 'caught' = 'none'

    // ---------------- senses ----------------
    // A running engine is heard from a long way off. Shut it down and it comes
    // down to eyesight, which thick cover defeats almost completely.
    const detected = sense.engineRunning
      ? this.distance < Math.max(sense.noiseRadius, HEADLIGHT_RANGE)
      : this.distance < lerp(SIGHT_EXPOSED, SIGHT_HIDDEN, sense.cover)

    if (detected) {
      this.lastKnown.copy(sense.position)
      this.lostFor = 0
    } else {
      // remember how far off it was the instant the trail went cold
      if (this.lostFor === 0) this.rangeAtLoss = this.distance
      this.lostFor += dt
    }

    const hunting = this.state === 'chase' || this.state === 'winded'
    if (this.state === 'patrol' || this.state === 'alert' || this.state === 'deer') {
      if (detected) {
        this.reaction += dt
        this.state = 'alert'
        this.deerTarget = null
        if (this.reaction > 0.55) {
          this.state = 'chase'
          event = 'spotted'
        }
      } else {
        this.reaction = Math.max(0, this.reaction - dt * 0.8)
        if (this.state === 'alert' && this.reaction <= 0) this.state = 'patrol'
        this.considerDeer(dt, herds, rng)
      }
    } else if (hunting) {
      // Break contact - by outrunning it or by going dark - and it drops to
      // hunting the last place it had you.
      const patience = sense.engineRunning ? LOSE_SECONDS_OUTRUN : LOSE_SECONDS_SILENCED
      if (this.lostFor > patience) {
        this.state = 'search'
        this.searchFor = SEARCH_SECONDS
        this.stamina = SPRINT_SECONDS * 0.6
        // It was tracking a sound, not a map pin, and the further off it was
        // when the sound stopped the worse it had you placed. This is what
        // makes killing the engine early pay and killing it late useless.
        const err = clamp(this.rangeAtLoss * 0.5, 8, 50)
        const a = rng.range(0, Math.PI * 2)
        const r = err * Math.sqrt(rng.next())
        this.searchAnchor.set(
          this.lastKnown.x + Math.cos(a) * r,
          0,
          this.lastKnown.z + Math.sin(a) * r,
        )
        this.pickSearchPoint(rng, true)
      }
    } else {
      // searching: re-acquire on any trace, otherwise wind down and wander off
      if (detected) {
        this.state = 'chase'
        this.reaction = 0
        event = 'spotted'
      } else {
        this.searchFor -= dt
        if (this.searchFor <= 0) {
          this.state = 'patrol'
          this.reaction = 0
        } else if (this.position.distanceTo(this.searchPoint) < 11) {
          this.pickSearchPoint(rng, false)
        }
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
      // Homes on the last place it actually sensed you, not on where you are.
      // While it can hear you those are the same point; the moment you go dark
      // they stop being, and that gap is the whole hiding mechanic.
      desiredYaw = Math.atan2(
        this.lastKnown.x - this.position.x,
        this.lastKnown.z - this.position.z,
      )
      wantSpeed = this.state === 'chase' ? CHASE_SPEED : WINDED_SPEED
      // big animal, wide arc: this is the whole counterplay
      turnRate = this.state === 'chase' ? 1.0 : 1.5
    } else if (this.state === 'alert') {
      desiredYaw = Math.atan2(dx, dz)
      wantSpeed = INVESTIGATE_SPEED
      turnRate = 1.6
    } else if (this.state === 'search') {
      desiredYaw = Math.atan2(
        this.searchPoint.x - this.position.x,
        this.searchPoint.z - this.position.z,
      )
      wantSpeed = INVESTIGATE_SPEED * 0.7
      turnRate = 1.6
    } else if (this.state === 'deer' && this.deerTarget) {
      desiredYaw = Math.atan2(
        this.deerTarget.centre.x - this.position.x,
        this.deerTarget.centre.z - this.position.z,
      )
      wantSpeed = DEER_CHASE_SPEED
      turnRate = 1.3
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
    // Only when it is actually driving hard, though - an ambling one picks its
    // way through trees perfectly well, and slowing it further just looked stuck.
    if (this.state === 'chase' || this.state === 'winded') {
      wantSpeed *= 1 - this.clutter() * 0.14
    }
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

  /**
   * Wandering rexes take a run at any herd that strays close, about half the
   * time, and pack it in after a few seconds because they cannot catch deer.
   * It is a distraction that buys the player room, and it is what makes a
   * bolting herd worth reading.
   */
  private considerDeer(dt: number, herds: Quarry[], rng: Rng) {
    this.deerCooldown = Math.max(0, this.deerCooldown - dt)

    if (this.state === 'deer') {
      this.deerFor -= dt
      const gone =
        this.deerFor <= 0 ||
        !this.deerTarget ||
        this.position.distanceTo(this.deerTarget.centre) > DEER_NOTICE * 2
      if (gone) {
        this.state = 'patrol'
        this.deerTarget = null
        this.deerCooldown = DEER_COOLDOWN
      }
      return
    }

    if (this.state !== 'patrol' || this.deerCooldown > 0) return
    for (const h of herds) {
      if (this.position.distanceTo(h.centre) > DEER_NOTICE) continue
      this.deerCooldown = DEER_COOLDOWN
      if (rng.next() > DEER_INTEREST) return // watched them go
      this.state = 'deer'
      this.deerTarget = h
      this.deerFor = rng.range(DEER_GIVE_UP[0], DEER_GIVE_UP[1])
      return
    }
  }

  /**
   * Somewhere to go while hunting. A rex tracks a sound, not a map pin, so the
   * first guess is deliberately off; after that it casts about the area.
   */
  private pickSearchPoint(rng: Rng, first: boolean) {
    const spread = first ? 12 : 22
    const a = rng.range(0, Math.PI * 2)
    const r = spread * Math.sqrt(rng.next())
    const x = clamp(this.searchAnchor.x + Math.cos(a) * r, -HALF + 30, HALF - 30)
    const z = clamp(this.searchAnchor.z + Math.sin(a) * r, -HALF + 30, HALF - 30)
    this.searchPoint.set(x, this.world.heightAt(x, z), z)
  }

  /**
   * Pose the animal from a recorded frame. Gait, jaw and neck all key off speed
   * and state, so replaying those two reproduces the animation exactly without
   * storing a joint angle per frame.
   */
  applyReplay(
    x: number,
    z: number,
    yaw: number,
    speed: number,
    state: RexState,
    player: THREE.Vector3,
    dt: number,
    time: number,
  ) {
    this.position.set(x, this.world.heightAt(x, z), z)
    this.yaw = yaw
    this.speed = speed
    this.state = state
    // kept current during playback too, so anything reading it is not stale
    this.distance = Math.hypot(player.x - x, player.z - z)
    this.pose(dt, time)
  }

  /** 0 in the open, 3 when it is shouldering through a stand of trees. */
  private clutter(): number {
    let n = 0
    for (const off of [-0.5, 0, 0.5]) {
      const y = this.yaw + off
      const x = this.position.x + Math.sin(y) * 9
      const z = this.position.z + Math.cos(y) * 9
      if (this.world.treeHit(x, z, 5)) n++
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
    // Saturates at a walking pace, so an ambling rex still rolls and bobs
    // properly instead of gliding along stiff-legged.
    const moving = clamp(this.speed / 2.6, 0, 1)
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
