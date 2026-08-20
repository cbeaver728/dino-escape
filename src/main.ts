import * as THREE from 'three'
import { World, HALF, WATER_LEVEL } from './world'
import { Jeep, JEEP_TOP_SPEED } from './jeep'
import { Rex } from './rex'
import { Controls } from './controls'
import { Postfx } from './postfx'
import { Sound } from './audio'
import { Rng, clamp, damp, smoothstep } from './rng'

const REX_COUNT = 6
/** How far out a locked-on rex starts closing the screen down. */
const FEAR_RANGE = 92

type Phase = 'menu' | 'playing' | 'caught' | 'over' | 'won'

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

scene.add(new THREE.AmbientLight(0x2a3550, 0.42))
const hemi = new THREE.HemisphereLight(0x2c3a5c, 0x070a10, 0.58)
scene.add(hemi)
const moon = new THREE.DirectionalLight(0x9db4e8, 0.5)
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
let rng = new Rng(1)
let phase: Phase = 'menu'
let elapsed = 0
let fear = 0
let caughtTimer = 0
let killer: Rex | null = null
let footTimer = 0
let bestTime = Number(localStorage.getItem('dino-escape-best') ?? 0)

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

  rng = new Rng(seed)
  world = new World(seed)
  scene.add(world.group)

  // the jeep is bound to the terrain it drives on, so it is rebuilt with it
  jeep = new Jeep(world)
  scene.add(jeep.group)
  jeep.reset(world.spawn, world.spawnYaw)

  // Half the pack is seeded loosely along the route to the base so a run always
  // runs into something; the rest are scattered, and all of them wander from there.
  const routeX = world.base.x - world.spawn.x
  const routeZ = world.base.z - world.spawn.z
  for (let i = 0; i < REX_COUNT; i++) {
    const rex = new Rex(world, rng)
    const onRoute = i < 2
    let placed = false
    for (let t = 0; t < 400 && !placed; t++) {
      let x: number
      let z: number
      if (onRoute) {
        const along = rng.range(0.35, 0.9)
        const side = rng.range(-170, 170)
        x = world.spawn.x + routeX * along - (routeZ / 600) * side
        z = world.spawn.z + routeZ * along + (routeX / 600) * side
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

  ready = true
  // snap the camera behind the jeep so the first frame is not a swoop
  placeCamera(1)
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

function fmtTime(s: number) {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function updateHud(locked: boolean) {
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
  hudAlert.classList.toggle('on', locked)
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
    postfx.render(scene, camera, 0, time)
    return
  }

  controls.update(dt)

  if (phase === 'playing') {
    elapsed += dt
    jeep.update(dt, controls.input)
  } else if (phase === 'caught') {
    jeep.update(dt, { steer: 0, throttle: false, brake: true })
  }

  // --- dinosaurs ---
  let locked = false
  let nearestLocked = Infinity
  if (phase === 'playing' || phase === 'caught') {
    for (const rex of rexes) {
      const wasHunting = rex.state === 'chase' || rex.state === 'winded'
      const ev = rex.update(dt, time, jeep.position, jeep.noiseRadius, rng)
      const hunting = rex.state === 'chase' || rex.state === 'winded'
      if (hunting) {
        locked = true
        nearestLocked = Math.min(nearestLocked, rex.distance)
      }
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
      rex.root.visible = rex.distance < 280
    }
  }

  // --- the screen closing in ---
  const wantFear = locked ? smoothstep(FEAR_RANGE, 8, nearestLocked) : 0
  fear = damp(fear, phase === 'caught' ? 1 : wantFear, locked || phase === 'caught' ? 6 : 1.6, dt)

  // --- audio ---
  if (phase === 'playing') {
    const rev = clamp(Math.abs(jeep.speed) / JEEP_TOP_SPEED, 0, 1)
    sound.engine(rev, controls.input.throttle ? 1 : 0)
    sound.heartbeat(dt, fear)
    if (locked && nearestLocked < 130) {
      footTimer -= dt
      if (footTimer <= 0) {
        footTimer = 0.34 + clamp(nearestLocked / 130, 0, 1) * 0.35
        sound.footstep(clamp(1 - nearestLocked / 130, 0, 1))
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
  updateHud(locked)

  if (!skipRender) postfx.render(scene, camera, fear, time)
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
    localStorage.setItem('dino-escape-best', String(Math.round(elapsed * 100) / 100))
  }
  $('wonStats').innerHTML =
    `Escaped in <b>${fmtTime(elapsed)}</b>` +
    (first ? ' &mdash; new best' : ` &middot; best ${fmtTime(bestTime)}`)
  show('won')
}

function lose() {
  phase = 'over'
  sound.chime(false)
  const dist = Math.hypot(world.base.x - jeep.position.x, world.base.z - jeep.position.z)
  $('overMsg').textContent =
    dist < 120 ? 'It took you almost within sight of the fence.' : 'It ran you down in the dark.'
  $('overStats').innerHTML = `Survived <b>${fmtTime(elapsed)}</b> &middot; <b>${Math.round(dist)}m</b> short of the base`
  show('over')
}

function show(id: string) {
  for (const s of ['start', 'over', 'won']) $(s).classList.toggle('on', s === id)
}

function hideAll() {
  for (const s of ['start', 'over', 'won']) $(s).classList.remove('on')
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

$('ctlHint').textContent = controls.isTouch
  ? 'Left thumb: go and brake. Right thumb: the wheel.'
  : 'W / S to drive, A / D to steer. Arrow keys work too.'

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
      three: { scene, camera, renderer, postfx, get jeep() { return jeep }, get world() { return world } },
    },
  })
}
