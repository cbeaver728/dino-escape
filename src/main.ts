import * as THREE from 'three'
import { World, HALF, WATER_LEVEL } from './world'
import { Jeep, JEEP_TOP_SPEED } from './jeep'
import { Rex, PlayerSense, detectionRange, DETECT_MAX, tuning } from './rex'
import { Herd, spawnHerds } from './deer'
import { Recording, REX_STATES, FLAG_ENGINE, FLAG_BRAKE } from './replay'
import { Controls } from './controls'
import { Postfx } from './postfx'
import { Sound, ENGINE_KINDS, type EngineKind } from './audio'
import { Rng, clamp, damp, lerp, smoothstep } from './rng'

/**
 * How many rexes, and how many of those get seeded along your route so a run
 * actually meets something. On a 1300m map most of the pack never comes near
 * you, so the route seeding is what the difficulty is really felt through.
 */
const DIFFICULTIES = [
  { name: 'Easy', rexes: 5, onRoute: 1, winded: 1 },
  { name: 'Medium', rexes: 10, onRoute: 3, winded: 1 },
  { name: 'Hard', rexes: 30, onRoute: 8, winded: 1 },
  // they get their breath back far quicker, so a blown sprint buys you little
  { name: 'Legend', rexes: 45, onRoute: 11, winded: 0.55 },
]
const COUNT_WORDS: Record<number, string> = { 5: 'Five', 10: 'Ten', 30: 'Thirty', 45: 'Forty-five' }
/** How far either side of the straight run to the base a seeded rex may sit. */
const ROUTE_SPREAD = 80

/** Herds of deer, purely as an early-warning system for the player. */
const HERD_COUNT = 9
/** How far out a locked-on rex starts closing the screen down. */
const FEAR_RANGE = 92

type Phase = 'menu' | 'playing' | 'caught' | 'over' | 'won' | 'replay'

const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4]
/** How high the overhead replay camera sits, in metres above the jeep. */
const REPLAY_TOP_HEIGHT = 95

/** Replay cameras, cycled by one button. */
const VIEW_CHASE = 0 // behind the jeep, looking where you were going
const VIEW_REAR = 1 // up on the back deck, looking at what is gaining on you
const VIEW_TOP = 2 // straight down, to see where it came from
const VIEW_NAMES = ['Chase', 'Rear', 'Top']
/** Rear-camera placement, found by sweeping for the framing that keeps both the
 * jeep and its pursuer on screen most of the time. */
const REAR_CAM = { forward: 13, up: 4.6, lookBack: 22, lookUp: 2.2, track: 0.85 }

const $ = (id: string) => document.getElementById(id) as HTMLElement

// ---------------------------------------------------------------------------
// renderer, scene, camera
// ---------------------------------------------------------------------------

const container = $('app')
const controls = new Controls()
const sound = new Sound()

const renderer = new THREE.WebGLRenderer({
  antialias: !controls.isTouch,
  powerPreference: 'high-performance',
  stencil: false,
})
renderer.setPixelRatio(Math.min(devicePixelRatio, controls.isTouch ? 1.4 : 1.8))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.05
container.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x04060b)
scene.fog = new THREE.FogExp2(0x04060b, 0.0165)

const camera = new THREE.PerspectiveCamera(66, innerWidth / innerHeight, 0.4, 1600)

const AMBIENT_LIT = 0.42
const HEMI_LIT = 0.58
const MOON_LIT = 0.5
const ambient = new THREE.AmbientLight(0x2a3550, AMBIENT_LIT)
scene.add(ambient)
const hemi = new THREE.HemisphereLight(0x2c3a5c, 0x070a10, HEMI_LIT)
scene.add(hemi)
const moon = new THREE.DirectionalLight(0x9db4e8, MOON_LIT)
moon.position.set(-160, 220, 90)
scene.add(moon)

// --- night sky: stars and a moon disc that ride along with the camera ---
const sky = new THREE.Group()
scene.add(sky)
{
  const count = 1100
  const pos = new Float32Array(count * 3)
  const col = new Float32Array(count * 3)
  const r = new Rng(7)
  for (let i = 0; i < count; i++) {
    const u = r.range(-1, 1)
    const a = r.range(0, Math.PI * 2)
    const s = Math.sqrt(1 - u * u)
    const y = Math.abs(u) * 0.9 + 0.05
    pos[i * 3] = Math.cos(a) * s * 1150
    pos[i * 3 + 1] = y * 1150
    pos[i * 3 + 2] = Math.sin(a) * s * 1150
    const b = r.range(0.35, 1)
    col[i * 3] = b
    col[i * 3 + 1] = b * r.range(0.9, 1)
    col[i * 3 + 2] = b * r.range(0.95, 1.1)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  const stars = new THREE.Points(
    g,
    new THREE.PointsMaterial({ size: 2.4, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false }),
  )
  stars.renderOrder = -2
  sky.add(stars)

  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(48, 32),
    new THREE.MeshBasicMaterial({ color: 0xdfe7ff, fog: false, depthWrite: false }),
  )
  disc.position.set(-620, 700, 350)
  disc.lookAt(0, 0, 0)
  disc.renderOrder = -1
  sky.add(disc)
}

const postfx = new Postfx(renderer)

// ---------------------------------------------------------------------------
// game state
// ---------------------------------------------------------------------------

let world!: World
let jeep!: Jeep
let ready = false
let rexes: Rex[] = []
let herds: Herd[] = []
let rng = new Rng(1)
let phase: Phase = 'menu'
/** True between webglcontextlost and webglcontextrestored; nothing may draw. */
let contextLost = false
let elapsed = 0
let fear = 0
let caughtTimer = 0
let killer: Rex | null = null
let footTimer = 0
let darkness = 0
let cover = 0
let recording: Recording | null = null
let scratch: Float32Array = new Float32Array(0)
let replayT = 0
let replaySpeed = 2 // index into REPLAY_SPEEDS
let replayPaused = false
let replayView = VIEW_CHASE
let replayFrom: 'over' | 'won' = 'over'
let markers: THREE.Mesh[] = []
let jeepMarker: THREE.Mesh | null = null
let topBlend = 0
let seekSnap = false
const sense: PlayerSense = {
  position: new THREE.Vector3(),
  noiseRadius: 0,
  cover: 0,
  engineRunning: true,
}
let difficulty = clamp(Number(localStorage.getItem('dino-escape-difficulty') ?? 1), 0, 3) | 0
/** Best times are kept per difficulty - they are not comparable across them. */
const bestKey = () => `dino-escape-best-${DIFFICULTIES[difficulty].name.toLowerCase()}`
let bestTime = Number(localStorage.getItem(bestKey()) ?? 0)

const camPos = new THREE.Vector3()
const camLook = new THREE.Vector3()
const tmp = new THREE.Vector3()

function buildWorld(seed: number) {
  if (ready) {
    scene.remove(world.group)
    world.dispose()
    scene.remove(jeep.group)
    jeep.dispose()
  }
  for (const r of rexes) {
    scene.remove(r.root)
    r.dispose()
  }
  rexes = []
  for (const h of herds) {
    scene.remove(h.group)
    h.dispose()
  }
  herds = []

  rng = new Rng(seed)
  world = new World(seed)
  scene.add(world.group)

  // the jeep is bound to the terrain it drives on, so it is rebuilt with it
  jeep = new Jeep(world)
  scene.add(jeep.group)
  jeep.reset(world.spawn, world.spawnYaw)

  // A few are seeded loosely along the route to the base so a run always meets
  // something; the rest are scattered, and all of them wander from there.
  const diff = DIFFICULTIES[difficulty]
  tuning.windedScale = diff.winded
  const routeX = world.base.x - world.spawn.x
  const routeZ = world.base.z - world.spawn.z
  const routeLen = Math.hypot(routeX, routeZ) || 1
  for (let i = 0; i < diff.rexes; i++) {
    const rex = new Rex(world, rng)
    const onRoute = i < diff.onRoute
    let placed = false
    for (let t = 0; t < 400 && !placed; t++) {
      let x: number
      let z: number
      if (onRoute) {
        // Kept close to the line on purpose: at +/-170m these sat in the
        // general area rather than in the way, and a straight run threaded
        // between them. Normalised by the real route length so the spread is
        // the same on a short map as a long one.
        const along = rng.range(0.3, 0.92)
        const side = rng.range(-ROUTE_SPREAD, ROUTE_SPREAD)
        x = world.spawn.x + routeX * along - (routeZ / routeLen) * side
        z = world.spawn.z + routeZ * along + (routeX / routeLen) * side
      } else {
        x = rng.range(-HALF + 80, HALF - 80)
        z = rng.range(-HALF + 80, HALF - 80)
      }
      if (Math.abs(x) > HALF - 70 || Math.abs(z) > HALF - 70) continue
      if (world.heightAt(x, z) < WATER_LEVEL + 1) continue
      if (Math.hypot(x - world.spawn.x, z - world.spawn.z) < 280) continue
      if (Math.hypot(x - world.base.x, z - world.base.z) < 95) continue
      rex.place(x, z, rng.range(0, Math.PI * 2))
      placed = true
    }
    if (!placed) rex.place(rng.range(-200, 200), rng.range(-200, 200), 0)
    scene.add(rex.root)
    rexes.push(rex)
  }

  herds = spawnHerds(world, rng, HERD_COUNT)
  for (const h of herds) scene.add(h.group)

  recording = new Recording({
    rexCount: rexes.length,
    deerCount: herds.reduce((s, h) => s + h.animals.length, 0),
    herdCount: herds.length,
  })
  scratch = recording.scratch()
  buildMarkers()

  ready = true
  // snap the camera behind the jeep so the first frame is not a swoop
  placeCamera(1)
}

/**
 * Floating pips above the jeep and each rex, shown only in the overhead
 * replay. From 95m up the canopy hides almost everything, and the whole point
 * of that view is seeing which direction the thing came from.
 */
function buildMarkers() {
  for (const m of markers) scene.remove(m)
  markers = []
  if (jeepMarker) scene.remove(jeepMarker)

  const ring = new THREE.CircleGeometry(2.6, 16)
  ring.rotateX(-Math.PI / 2)
  const rexMat = new THREE.MeshBasicMaterial({ color: 0xff3b2a, fog: false, transparent: true, opacity: 0.9 })
  const jeepMat = new THREE.MeshBasicMaterial({ color: 0x7dfaa8, fog: false, transparent: true, opacity: 0.9 })
  for (let i = 0; i < rexes.length; i++) {
    const m = new THREE.Mesh(ring, rexMat)
    m.visible = false
    m.renderOrder = 3
    scene.add(m)
    markers.push(m)
  }
  jeepMarker = new THREE.Mesh(ring, jeepMat)
  jeepMarker.visible = false
  jeepMarker.renderOrder = 3
  scene.add(jeepMarker)
}

function captureFrame(dt: number) {
  if (!recording) return
  const slot = recording.next(dt)
  if (!slot) return
  const { buf, at } = slot
  buf[at] = jeep.position.x
  buf[at + 1] = jeep.position.z
  buf[at + 2] = jeep.yaw
  buf[at + 3] = jeep.speed
  buf[at + 4] = jeep.steer
  buf[at + 5] = (jeep.engineOn ? FLAG_ENGINE : 0) | (controls.input.brake ? FLAG_BRAKE : 0)
  for (let i = 0; i < rexes.length; i++) {
    const o = at + recording.rexAt(i)
    const r = rexes[i]
    buf[o] = r.position.x
    buf[o + 1] = r.position.z
    buf[o + 2] = r.yaw
    buf[o + 3] = r.replaySpeed
    buf[o + 4] = REX_STATES.indexOf(r.state)
  }
  let d = 0
  for (let h = 0; h < herds.length; h++) {
    for (const deer of herds[h].animals) {
      const o = at + recording.deerAt(d++)
      buf[o] = deer.position.x
      buf[o + 1] = deer.position.z
      buf[o + 2] = deer.yaw
      buf[o + 3] = deer.speed
    }
    buf[at + recording.herdAt(h)] = herds[h].panic
  }
}

/** Push one sampled frame back onto the live scene objects. */
function applyFrame(dt: number, time: number) {
  if (!recording) return
  recording.sample(replayT, scratch)
  const flags = scratch[5]
  jeep.applyReplay(
    scratch[0],
    scratch[1],
    scratch[2],
    scratch[3],
    scratch[4],
    (flags & FLAG_ENGINE) !== 0,
    (flags & FLAG_BRAKE) !== 0,
    dt,
  )
  for (let i = 0; i < rexes.length; i++) {
    const o = recording.rexAt(i)
    const state = REX_STATES[Math.round(scratch[o + 4])] ?? 'patrol'
    rexes[i].applyReplay(scratch[o], scratch[o + 1], scratch[o + 2], scratch[o + 3], state, jeep.position, dt, time)
    rexes[i].root.visible = rexes[i].position.distanceTo(jeep.position) < (replayView === VIEW_TOP ? 400 : 200)
  }
  let d = 0
  for (let h = 0; h < herds.length; h++) {
    const base = d
    herds[h].applyReplay(
      (i) => {
        const o = recording!.deerAt(base + i)
        return { x: scratch[o], z: scratch[o + 1], yaw: scratch[o + 2], speed: scratch[o + 3] }
      },
      scratch[recording.herdAt(h)],
      dt,
    )
    d += herds[h].animals.length
    herds[h].setVisible(herds[h].centre.distanceTo(jeep.position) < (replayView === VIEW_TOP ? 300 : 150))
  }
}

/**
 * Playback. Everything on screen is posed from the recording; nothing is
 * simulated, so scrubbing backwards works as naturally as playing forwards.
 */
function tickReplay(dt: number, time: number) {
  if (!recording) return
  const total = recording.seconds

  if (!replayPaused) {
    replayT += dt * REPLAY_SPEEDS[replaySpeed]
    if (replayT >= total) {
      replayT = total
      replayPaused = true
      syncReplayUi()
    }
  }

  // Pose at the wall-clock rate, not the replay rate, so damped things like
  // the body tilt settle the same however fast you are watching.
  applyFrame(dt, time)

  // The overhead view has to see through a night forest from 95m up, so it
  // lifts the ambient, thins the fog, and floats a pip over each animal.
  topBlend = damp(topBlend, replayView === VIEW_TOP ? 1 : 0, 6, dt)
  ambient.intensity = AMBIENT_LIT * lerp(1, 5.5, topBlend)
  hemi.intensity = HEMI_LIT * lerp(1, 4, topBlend)
  moon.intensity = MOON_LIT * lerp(1, 2.4, topBlend)
  ;(scene.fog as THREE.FogExp2).density = lerp(0.0165, 0.0022, topBlend)

  const showPips = topBlend > 0.15
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i]
    m.visible = showPips && rexes[i].root.visible
    if (m.visible) {
      m.position.set(rexes[i].position.x, rexes[i].position.y + 26, rexes[i].position.z)
      const s = rexes[i].state
      const hot = s === 'chase' || s === 'winded'
      ;(m.material as THREE.MeshBasicMaterial).opacity = hot ? 0.95 : 0.45
      m.scale.setScalar(hot ? 1.35 : 1)
    }
  }
  if (jeepMarker) {
    jeepMarker.visible = showPips
    jeepMarker.position.set(jeep.position.x, jeep.position.y + 26, jeep.position.z)
  }

  // Same vignette the player had at the time, recomputed rather than recorded -
  // watching a chase without the screen closing in loses most of the menace.
  // Skipped overhead, where it would just crop the map.
  let wantFear = 0
  if (replayView !== VIEW_TOP) {
    for (const rex of rexes) {
      if (rex.state === 'chase' || rex.state === 'winded') {
        wantFear = Math.max(wantFear, smoothstep(FEAR_RANGE, 8, rex.position.distanceTo(jeep.position)))
      }
    }
  }
  fear = seekSnap ? wantFear : damp(fear, wantFear, 6, dt)

  // --- camera ---
  const snap = seekSnap
  if (replayView === VIEW_TOP) {
    tmp.set(jeep.position.x, jeep.position.y + REPLAY_TOP_HEIGHT, jeep.position.z)
    camPos.lerp(tmp, snap ? 1 : 1 - Math.exp(-6 * dt))
    camera.position.copy(camPos)
    // world-aligned rather than following the jeep's heading: the question this
    // view answers is "which direction did it come from", and that needs a
    // stable compass, not one that spins with the driving
    camera.up.set(0, 0, -1)
    camera.lookAt(camPos.x, jeep.position.y, camPos.z + 0.001)
  } else if (replayView === VIEW_REAR) {
    camera.up.set(0, 1, 0)
    // Looking back over the jeep at whatever is gaining on you. The camera has
    // to sit FORWARD of the vehicle for this: put it astern and the jeep ends
    // up behind the lens, out of shot. Far enough forward, and low enough, that
    // the tail of the jeep sits in the bottom of frame with the pursuer centred.
    const fx = Math.sin(jeep.yaw)
    const fz = Math.cos(jeep.yaw)
    // Well forward, or the roll cage is a foot from the lens and fills the shot.
    // At this range the jeep sits small and low in frame and you see past it.
    tmp.set(
      jeep.position.x + fx * REAR_CAM.forward,
      jeep.position.y + REAR_CAM.up,
      jeep.position.z + fz * REAR_CAM.forward,
    )
    camPos.lerp(tmp, snap ? 1 : 1 - Math.exp(-9 * dt))
    camera.position.copy(camPos)
    // Aimed nearly level so the shot is ground and pursuer rather than half sky.
    tmp.set(
      jeep.position.x - fx * REAR_CAM.lookBack,
      jeep.position.y + REAR_CAM.lookUp,
      jeep.position.z - fz * REAR_CAM.lookBack,
    )
    // A pursuer arcs in from the side rather than sitting neatly astern, so a
    // fixed rearward aim loses it off the edge of frame. Track whatever is
    // actually hunting you, as someone in the back would. Only things behind
    // the jeep count, or the "rear" camera would swing round to face forwards.
    let hunter: Rex | null = null
    let hunterDist = Infinity
    for (const rex of rexes) {
      if (rex.state !== 'chase' && rex.state !== 'winded') continue
      const dx = rex.position.x - jeep.position.x
      const dz = rex.position.z - jeep.position.z
      if (dx * fx + dz * fz > 5) continue // ahead of us: not the rear view's job
      const dd = Math.hypot(dx, dz)
      if (dd < hunterDist && dd < 110) {
        hunterDist = dd
        hunter = rex
      }
    }
    if (hunter) {
      tmp.lerp(hunter.position.clone().setY(hunter.position.y + 3.6), REAR_CAM.track)
    }
    camLook.lerp(tmp, snap ? 1 : 1 - Math.exp(-9 * dt))
    camera.lookAt(camLook)
  } else {
    camera.up.set(0, 1, 0)
    placeCamera(snap ? 1 : 1 - Math.exp(-7 * dt))
  }
  seekSnap = false

  sky.position.copy(camera.position)
  world.update(dt, time, false)
  updateReplayUi(total)
  if (!contextLost) postfx.render(scene, camera, fear, time)
}

function placeCamera(snap: number) {
  const back = 10.5
  const up = 4.6
  tmp.set(
    jeep.position.x - Math.sin(jeep.yaw) * back,
    jeep.position.y + up,
    jeep.position.z - Math.cos(jeep.yaw) * back,
  )
  const ground = world.heightAt(tmp.x, tmp.z) + 2.2
  tmp.y = Math.max(tmp.y, ground)
  camPos.lerp(tmp, snap)
  camera.position.copy(camPos)

  tmp.set(
    jeep.position.x + Math.sin(jeep.yaw) * 9,
    jeep.position.y + 2.2,
    jeep.position.z + Math.cos(jeep.yaw) * 9,
  )
  camLook.lerp(tmp, snap)
  camera.lookAt(camLook)
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

const hudClock = $('clock')
const hudKph = $('kph')
const hudDist = $('dist')
const hudNeedle = $('needle')
const hudAlert = $('alert')
const radarCanvas = document.querySelector('#radar canvas') as HTMLCanvasElement
const radarCtx = radarCanvas.getContext('2d')
const engineBtn = $('engine')
const engineLabel = $('engineState')

function fmtTime(s: number) {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

/**
 * Handicap radar. The dish spans twice a rex's maximum detection range, so the
 * rim sits exactly at the distance one could notice you flat out with the
 * lights on. The inner ring is your detection radius *right now* - it shrinks
 * as you slow down and collapses when you kill the engine, which makes the
 * whole noise mechanic visible instead of something you have to infer.
 */
function drawRadar() {
  const g = radarCtx
  if (!g) return
  const size = radarCanvas.width
  const mid = size / 2
  const scale = mid / DETECT_MAX // pixels per metre
  g.clearRect(0, 0, size, size)

  const now = detectionRange(sense)
  g.strokeStyle = 'rgba(90, 200, 240, 0.22)'
  g.lineWidth = 2
  for (const frac of [0.5, 1]) {
    g.beginPath()
    g.arc(mid, mid, mid * frac - 1, 0, Math.PI * 2)
    g.stroke()
  }

  // how far you are currently audible
  g.strokeStyle = jeep.engineOn ? 'rgba(255, 196, 92, 0.55)' : 'rgba(125, 250, 168, 0.6)'
  g.lineWidth = 2
  g.beginPath()
  g.arc(mid, mid, Math.max(3, now * scale), 0, Math.PI * 2)
  g.stroke()

  // Rexes, rotated so the top of the dish is where the jeep is pointing.
  // Driver's right is -X in this right-handed world, same as the steering.
  const sy = Math.sin(jeep.yaw)
  const cy = Math.cos(jeep.yaw)
  for (const rex of rexes) {
    const dx = rex.position.x - jeep.position.x
    const dz = rex.position.z - jeep.position.z
    if (Math.hypot(dx, dz) > DETECT_MAX) continue
    const fwd = dx * sy + dz * cy
    const right = dz * sy - dx * cy
    const px = mid + right * scale
    const py = mid - fwd * scale
    const hunting = rex.state === 'chase' || rex.state === 'winded'
    g.fillStyle = hunting ? '#ff3b2a' : 'rgba(224, 74, 58, 0.65)'
    g.beginPath()
    g.arc(px, py, hunting ? 7 : 5, 0, Math.PI * 2)
    g.fill()
  }

  g.fillStyle = '#7dfaa8'
  g.beginPath()
  g.arc(mid, mid, 5, 0, Math.PI * 2)
  g.fill()
}

function updateHud(locked: boolean, searching: boolean) {
  hudClock.textContent = fmtTime(elapsed)
  hudKph.textContent = Math.round(Math.abs(jeep.speed) * 3.6).toString()
  const dx = world.base.x - jeep.position.x
  const dz = world.base.z - jeep.position.z
  const dist = Math.hypot(dx, dz)
  hudDist.textContent = dist > 999 ? '1k+' : `${Math.round(dist)}m`
  // Same handedness catch as the steering: the driver's right is -X, so a
  // target clockwise of the nose on screen is at yaw MINUS its world bearing.
  const bearing = jeep.yaw - Math.atan2(dx, dz)
  hudNeedle.style.transform = `rotate(${(bearing * 180) / Math.PI}deg)`

  // Shut down, the player cannot see much, so the HUD has to tell them whether
  // the spot they picked is actually hiding them.
  let status = ''
  let tone = ''
  if (!jeep.engineOn) {
    const hidden = cover > 0.55
    status = hidden ? 'Hidden · in cover' : 'Hidden · out in the open'
    tone = hidden ? 'safe' : 'warn'
  } else if (locked) {
    status = 'Chased'
    tone = 'bad'
  } else if (searching) {
    status = 'Something is hunting'
    tone = 'warn'
  }
  hudAlert.textContent = status
  hudAlert.className = status ? `on ${tone}` : ''

  if (handicap) drawRadar()

  engineBtn.classList.toggle('off', !jeep.engineOn)
  engineLabel.textContent = jeep.engineOn ? 'On' : 'Off'
}

// ---------------------------------------------------------------------------
// loop
// ---------------------------------------------------------------------------

let last = performance.now()
let simTime = 0
let skipRender = false

function frame(now: number) {
  requestAnimationFrame(frame)
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  tick(dt, now / 1000)
}

function tick(dt: number, time: number) {

  if (!ready) {
    sky.position.copy(camera.position)
    if (!contextLost) postfx.render(scene, camera, 0, time)
    return
  }

  if (phase === 'replay') {
    tickReplay(dt, time)
    return
  }

  controls.update(dt)

  if (phase === 'playing') {
    elapsed += dt
    jeep.update(dt, controls.input)
    captureFrame(dt)
  } else if (phase === 'caught') {
    jeep.update(dt, { steer: 0, throttle: false, brake: true })
    captureFrame(dt)
  }

  // --- dinosaurs ---
  let locked = false
  let searching = false
  let nearestLocked = Infinity
  let nearestHunter = Infinity
  cover = world.coverAt(jeep.position.x, jeep.position.z)
  sense.position = jeep.position
  sense.noiseRadius = jeep.noiseRadius
  sense.cover = cover
  sense.engineRunning = jeep.engineOn
  if (phase === 'playing' || phase === 'caught') {
    for (const herd of herds) {
      herd.update(dt, rexes, jeep.position, rng)
      // fog swallows everything past ~120m, so drawing them further is waste
      herd.setVisible(herd.centre.distanceTo(jeep.position) < 150)
    }
    for (const rex of rexes) {
      const wasHunting = rex.state === 'chase' || rex.state === 'winded'
      const ev = rex.update(dt, time, sense, herds, rng)
      const hunting = rex.state === 'chase' || rex.state === 'winded'
      if (hunting) {
        locked = true
        nearestLocked = Math.min(nearestLocked, rex.distance)
      }
      if (rex.state === 'search') searching = true
      if (hunting || rex.state === 'search') nearestHunter = Math.min(nearestHunter, rex.distance)
      if (ev === 'spotted' && !wasHunting) {
        sound.roar(clamp(1 - rex.distance / 140, 0, 1))
      }
      if (ev === 'caught' && phase === 'playing') {
        killer = rex
        phase = 'caught'
        caughtTimer = 0
        controls.release()
        sound.silenceEngine()
        sound.roar(1)
      }
      rex.root.visible = rex.distance < 200
    }
  }

  // --- the screen closing in ---
  const wantFear = locked ? smoothstep(FEAR_RANGE, 8, nearestLocked) : 0
  fear = damp(fear, phase === 'caught' ? 1 : wantFear, locked || phase === 'caught' ? 6 : 1.6, dt)

  // --- going dark ---
  // With the engine off the world drops away to almost nothing. The stars and
  // the moon are unlit materials so they stay, and so do a rex's eyes, which is
  // usually the only warning you get while sitting there.
  darkness = damp(darkness, jeep.engineOn ? 0 : 1, 3.5, dt)
  ambient.intensity = AMBIENT_LIT * lerp(1, 0.1, darkness)
  hemi.intensity = HEMI_LIT * lerp(1, 0.1, darkness)
  moon.intensity = MOON_LIT * lerp(1, 0.2, darkness)

  // --- audio ---
  if (phase === 'playing') {
    if (jeep.engineOn) {
      const rev = clamp(Math.abs(jeep.speed) / JEEP_TOP_SPEED, 0, 1)
      sound.engine(rev, controls.input.throttle ? 1 : 0)
    } else {
      sound.silenceEngine()
    }
    // Sitting in the dark, footsteps are most of what you have to go on, so
    // they keep playing for a rex that is only hunting rather than chasing.
    const tension = locked ? fear : smoothstep(90, 10, nearestHunter) * 0.8
    sound.heartbeat(dt, tension)
    if (nearestHunter < 130) {
      footTimer -= dt
      if (footTimer <= 0) {
        footTimer = 0.34 + clamp(nearestHunter / 130, 0, 1) * 0.35
        sound.footstep(clamp(1 - nearestHunter / 130, 0, 1))
      }
    }
  }

  // --- win check ---
  if (phase === 'playing') {
    const d = Math.hypot(jeep.position.x - world.base.pad.x, jeep.position.z - world.base.pad.z)
    if (d < world.base.padRadius) win()
  }

  // --- camera ---
  if (phase === 'caught') {
    caughtTimer += dt
    // swing round to watch the thing that got you
    if (killer) {
      camLook.lerp(tmp.set(killer.position.x, killer.position.y + 5, killer.position.z), 1 - Math.exp(-4 * dt))
      const angle = Math.atan2(jeep.position.x - killer.position.x, jeep.position.z - killer.position.z)
      tmp.set(
        jeep.position.x - Math.sin(angle) * 11 + Math.sin(time * 9) * 0.25,
        jeep.position.y + 5.5,
        jeep.position.z - Math.cos(angle) * 11,
      )
      camPos.lerp(tmp, 1 - Math.exp(-3 * dt))
      camera.position.copy(camPos)
      camera.lookAt(camLook)
    }
    if (caughtTimer > 1.9 && phase === 'caught') lose()
  } else {
    placeCamera(1 - Math.exp(-7 * dt))
    if (fear > 0.05) {
      const shake = fear * fear * 0.34
      camera.position.x += Math.sin(time * 31) * shake
      camera.position.y += Math.sin(time * 27 + 1.3) * shake
    }
  }

  sky.position.copy(camera.position)
  world.update(dt, time, phase === 'won')
  updateHud(locked, searching)

  if (!skipRender && !contextLost) postfx.render(scene, camera, fear, time)
}

// ---------------------------------------------------------------------------
// phase transitions
// ---------------------------------------------------------------------------

function win() {
  phase = 'won'
  controls.release()
  sound.silenceEngine()
  sound.chime(true)
  const first = bestTime === 0 || elapsed < bestTime
  if (first) {
    bestTime = elapsed
    localStorage.setItem(bestKey(), String(Math.round(elapsed * 100) / 100))
  }
  $('wonStats').innerHTML =
    `${DIFFICULTIES[difficulty].name} &middot; escaped in <b>${fmtTime(elapsed)}</b>` +
    (first ? ' &mdash; new best' : ` &middot; best ${fmtTime(bestTime)}`)
  show('won')
}

function lose() {
  phase = 'over'
  sound.chime(false)
  const dist = Math.hypot(world.base.x - jeep.position.x, world.base.z - jeep.position.z)
  $('overMsg').textContent =
    dist < 120 ? 'It took you almost within sight of the fence.' : 'It ran you down in the dark.'
  $('overStats').innerHTML =
    `${DIFFICULTIES[difficulty].name} &middot; survived <b>${fmtTime(elapsed)}</b> &middot; ` +
    `<b>${Math.round(dist)}m</b> short of the base`
  show('over')
}

function show(id: string) {
  for (const s of ['start', 'over', 'won']) $(s).classList.toggle('on', s === id)
}

// ---------------------------------------------------------------------------
// replay controls
// ---------------------------------------------------------------------------

const rSeek = $('rSeek') as HTMLInputElement
let seekDragging = false

function startReplay() {
  if (!recording || recording.frames < 2) return
  replayFrom = phase === 'won' ? 'won' : 'over'
  phase = 'replay'
  replayT = 0
  replaySpeed = 2
  replayPaused = false
  replayView = VIEW_CHASE
  sound.silenceEngine()
  hideAll()
  document.body.classList.add('replay')
  seekSnap = true
  syncReplayUi()
}

function endReplay() {
  phase = replayFrom
  document.body.classList.remove('replay')
  camera.up.set(0, 1, 0)
  // put the world lighting back the way the game expects it
  topBlend = 0
  ambient.intensity = AMBIENT_LIT
  hemi.intensity = HEMI_LIT
  moon.intensity = MOON_LIT
  ;(scene.fog as THREE.FogExp2).density = 0.0165
  for (const m of markers) m.visible = false
  if (jeepMarker) jeepMarker.visible = false
  show(replayFrom)
}

function syncReplayUi() {
  $('rPlay').textContent = replayPaused ? 'Play' : 'Pause'
  $('rSpeed').textContent = `${REPLAY_SPEEDS[replaySpeed]}×`
  $('rView').textContent = `Cam: ${VIEW_NAMES[replayView]}`
}

function updateReplayUi(total: number) {
  if (!seekDragging) rSeek.value = String(total > 0 ? Math.round((replayT / total) * 1000) : 0)
  $('rTime').textContent = fmtTime(replayT)
}

for (const b of Array.from(document.querySelectorAll('.replay'))) {
  b.addEventListener('click', startReplay)
}
$('rBack').addEventListener('click', endReplay)
$('rPlay').addEventListener('click', () => {
  // restarting from the end is the common case, so rewind rather than stick
  if (replayPaused && recording && replayT >= recording.seconds - 0.01) replayT = 0
  replayPaused = !replayPaused
  syncReplayUi()
})
$('rSlower').addEventListener('click', () => {
  replaySpeed = Math.max(0, replaySpeed - 1)
  syncReplayUi()
})
$('rFaster').addEventListener('click', () => {
  replaySpeed = Math.min(REPLAY_SPEEDS.length - 1, replaySpeed + 1)
  syncReplayUi()
})
$('rView').addEventListener('click', () => {
  replayView = (replayView + 1) % VIEW_NAMES.length
  seekSnap = true // cut between cameras rather than swinging through the world
  syncReplayUi()
})
rSeek.addEventListener('pointerdown', () => (seekDragging = true))
rSeek.addEventListener('pointerup', () => (seekDragging = false))
rSeek.addEventListener('input', () => {
  if (!recording) return
  replayT = (Number(rSeek.value) / 1000) * recording.seconds
  seekSnap = true // jump the camera rather than swooping across the map
})

function hideAll() {
  for (const s of ['start', 'over', 'won', 'lost']) $(s).classList.remove('on')
}

function newGame(seed?: number) {
  $('loading').classList.remove('off')
  hideAll()
  // let the loading frame paint before the generator blocks the thread
  setTimeout(() => {
    buildWorld(seed ?? (Math.random() * 0xffffffff) >>> 0)
    elapsed = 0
    fear = 0
    killer = null
    phase = 'playing'
    last = performance.now()
    $('loading').classList.add('off')
  }, 30)
}

$('startBtn').addEventListener('click', () => {
  sound.start()
  newGame()
})
for (const b of Array.from(document.querySelectorAll('.again'))) {
  b.addEventListener('click', () => {
    sound.start()
    newGame()
  })
}

controls.onEngineToggle = () => {
  if (phase !== 'playing') return
  const turningOn = !jeep.engineOn
  jeep.setEngine(turningOn)
  if (turningOn) sound.starter()
  else sound.silenceEngine()
}

// ---------------------------------------------------------------------------
// difficulty picker
// ---------------------------------------------------------------------------

function syncDifficulty() {
  const row = $('difficulty')
  row.dataset.sel = String(difficulty)
  for (const b of Array.from(row.querySelectorAll('.diff'))) {
    b.classList.toggle('on', Number((b as HTMLElement).dataset.d) === difficulty)
  }
  $('rexCountWord').textContent = COUNT_WORDS[DIFFICULTIES[difficulty].rexes]
  bestTime = Number(localStorage.getItem(bestKey()) ?? 0)
}

// ---------------------------------------------------------------------------
// engine sound picker
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// handicap: radar
// ---------------------------------------------------------------------------

let handicap = localStorage.getItem('dino-escape-radar') === '1'

function syncHandicap() {
  const b = $('handicap')
  b.classList.toggle('on', handicap)
  const label = b.querySelector('small')
  if (label) label.textContent = handicap ? 'on' : 'off'
  document.body.classList.toggle('radar', handicap)
}

$('handicap').addEventListener('click', () => {
  handicap = !handicap
  localStorage.setItem('dino-escape-radar', handicap ? '1' : '0')
  syncHandicap()
})
syncHandicap()

function syncEngineKind() {
  for (const b of Array.from(document.querySelectorAll('.eng'))) {
    b.classList.toggle('on', (b as HTMLElement).dataset.e === sound.engineKind)
  }
}

{
  const saved = localStorage.getItem('dino-escape-engine')
  sound.setEngineKind(ENGINE_KINDS.includes(saved as EngineKind) ? (saved as EngineKind) : 'hum')
  for (const b of Array.from(document.querySelectorAll('.eng'))) {
    b.addEventListener('click', () => {
      const kind = (b as HTMLElement).dataset.e as EngineKind
      localStorage.setItem('dino-escape-engine', kind)
      // the click is the user gesture audio needs, so audition it right away
      sound.previewEngine(kind)
      syncEngineKind()
    })
  }
  syncEngineKind()
}

for (const b of Array.from(document.querySelectorAll('.menu'))) {
  b.addEventListener('click', () => {
    phase = 'menu'
    show('start')
  })
}

for (const b of Array.from($('difficulty').querySelectorAll('.diff'))) {
  b.addEventListener('click', () => {
    difficulty = clamp(Number((b as HTMLElement).dataset.d), 0, DIFFICULTIES.length - 1) | 0
    localStorage.setItem('dino-escape-difficulty', String(difficulty))
    syncDifficulty()
  })
}
syncDifficulty()

$('ctlHint').textContent = controls.isTouch
  ? 'Left thumb: go, brake, and the engine switch. Right thumb: the wheel.'
  : 'W / S to drive, A / D to steer, E to cut the engine. Arrow keys work too.'

/**
 * Aim for a usable horizontal view. A fixed vertical FOV on a tall phone
 * leaves you peering down a slot, so derive it from the aspect and clamp.
 */
function fitCamera() {
  const aspect = innerWidth / innerHeight
  camera.aspect = aspect
  const hFov = (78 * Math.PI) / 180
  const vFov = 2 * Math.atan(Math.tan(hFov / 2) / aspect)
  camera.fov = clamp((vFov * 180) / Math.PI, 48, 74)
  camera.updateProjectionMatrix()
}

// ---------------------------------------------------------------------------
// losing the GL context
// ---------------------------------------------------------------------------
// Phones reclaim GPU memory from background or heavy pages, and when that
// happens every draw call quietly becomes a no-op. Without this the screen just
// stops updating with no clue why, which is indistinguishable from a crash. The
// preventDefault is what makes the loss recoverable at all.
renderer.domElement.addEventListener('webglcontextlost', (e) => {
  e.preventDefault()
  contextLost = true
  phase = 'menu'
  sound.silenceEngine()
  hideAll()
  $('loading').classList.add('off')
  $('lostDetail').textContent = `${DIFFICULTIES[difficulty].name} - ${rexes.length} rex on the map`
  $('lost').classList.add('on')
})

renderer.domElement.addEventListener('webglcontextrestored', () => {
  contextLost = false
})

addEventListener('resize', () => {
  fitCamera()
  renderer.setSize(innerWidth, innerHeight)
  postfx.resize()
})
fitCamera()

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    controls.release()
    sound.silenceEngine()
  }
  last = performance.now()
})

$('loading').classList.add('off')
requestAnimationFrame(frame)

if (import.meta.env.DEV) {
  // dev-only hook so the harness can drive and photograph the game
  Object.assign(window, {
    __dino: {
      snap(f = fear) {
        postfx.render(scene, camera, f, performance.now() / 1000)
        return renderer.domElement.toDataURL('image/png')
      },
      state: () => ({
        phase,
        elapsed,
        fear,
        x: Math.round(jeep?.position.x),
        z: Math.round(jeep?.position.z),
        yaw: jeep?.yaw,
        baseBearing: world ? Math.atan2(world.base.x - jeep.position.x, world.base.z - jeep.position.z) : 0,
        gateYaw: world?.base.gateYaw,
        fenceRadius: world?.base.fenceRadius,
        baseX: world?.base.x,
        baseZ: world?.base.z,
        depth: world ? +world.waterDepth(jeep.position.x, jeep.position.z).toFixed(2) : 0,
        slope: world
          ? +(
              (world.heightAt(jeep.position.x + Math.sin(jeep.yaw) * 3, jeep.position.z + Math.cos(jeep.yaw) * 3) -
                world.heightAt(jeep.position.x, jeep.position.z)) /
              3
            ).toFixed(2)
          : 0,
        trees: world?.trees.length,
        speed: jeep?.speed,
        baseDist: world ? Math.hypot(world.base.x - jeep.position.x, world.base.z - jeep.position.z) : -1,
        cover: +cover.toFixed(2),
        replayBytes: recording?.bytes ?? 0,
        replaySeconds: +(recording?.seconds ?? 0).toFixed(1),
        engineOn: jeep?.engineOn,
        rexes: rexes.map((r) => ({
          state: r.state,
          d: Math.round(r.distance),
          bearing: Math.atan2(r.position.x - jeep.position.x, r.position.z - jeep.position.z),
        })),
      }),
      teleport(x: number, z: number, yaw = 0) {
        jeep.reset(new THREE.Vector3(x, world.heightAt(x, z), z), yaw)
        placeCamera(1)
      },
      warpRex(i: number, dx: number, dz: number) {
        rexes[i].place(jeep.position.x + dx, jeep.position.z + dz, 0)
      },
      drive(steer: number, throttle: boolean, brake = false) {
        controls.override = true
        Object.assign(controls.input, { steer, throttle, brake })
      },
      engine(on: boolean) {
        jeep.setEngine(on)
      },
      manual() {
        controls.override = false
      },
      /** Is the ground `dist` ahead (offset from the jeep's heading) drivable? */
      probe(yawOffset: number, dist: number) {
        const y = jeep.yaw + yawOffset
        const x = jeep.position.x + Math.sin(y) * dist
        const z = jeep.position.z + Math.cos(y) * dist
        return { tree: !!world.treeHit(x, z, 2.2), depth: world.waterDepth(x, z) }
      },
      /** Advance the simulation without waiting on requestAnimationFrame. */
      step(n = 1, dt = 1 / 60, render = false) {
        skipRender = !render
        for (let i = 0; i < n; i++) tick(dt, (simTime += dt))
        skipRender = false
      },
      newGame,
      rearCam: REAR_CAM,
      three: {
        scene,
        camera,
        renderer,
        postfx,
        get jeep() { return jeep },
        get world() { return world },
        get rexes() { return rexes },
        get herds() { return herds },
      },
    },
  })
}
