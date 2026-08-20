import * as THREE from 'three'
import { Noise2D, Rng, clamp, lerp, smoothstep } from './rng'

export const WORLD_SIZE = 1300
export const HALF = WORLD_SIZE / 2
const GRID = 224 // cells per side
const CELL = WORLD_SIZE / GRID
const VERTS = GRID + 1

export const WATER_LEVEL = 0
const RIVER_BED = -2.6
const BASE_CLEARING = 34
const BASE_PLATEAU = 46

/** Trunk collision radius, and the smallest gap any two trunks may leave. */
export const TRUNK_RADIUS = 0.95
/** Closest two trunks may ever stand. Well clear of the jeep, so the forest
 * reads as woodland you drive through rather than a fence. */
const MIN_TREE_GAP = 9

export interface Tree {
  x: number
  z: number
  y: number
  r: number // trunk collision radius
}

export interface BaseInfo {
  x: number
  z: number
  y: number
  pad: THREE.Vector3
  padRadius: number
  /** Yaw the fence opening faces. */
  gateYaw: number
}

/** Uniform-grid bucketing so tree collision stays O(1) per query. */
class TreeGrid {
  readonly cell = 12
  private cols: number
  private buckets: number[][]

  constructor(private trees: Tree[]) {
    this.cols = Math.ceil(WORLD_SIZE / this.cell) + 1
    this.buckets = new Array(this.cols * this.cols)
    for (let i = 0; i < this.buckets.length; i++) this.buckets[i] = []
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i]
      this.buckets[this.index(t.x, t.z)].push(i)
    }
  }

  private index(x: number, z: number): number {
    const cx = clamp(Math.floor((x + HALF) / this.cell), 0, this.cols - 1)
    const cz = clamp(Math.floor((z + HALF) / this.cell), 0, this.cols - 1)
    return cz * this.cols + cx
  }

  /** Nearest overlapping tree for a circle of radius `r`, or null. */
  hit(x: number, z: number, r: number): Tree | null {
    const cx = clamp(Math.floor((x + HALF) / this.cell), 0, this.cols - 1)
    const cz = clamp(Math.floor((z + HALF) / this.cell), 0, this.cols - 1)
    let best: Tree | null = null
    let bestPen = 0
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const gx = cx + dx
        const gz = cz + dz
        if (gx < 0 || gz < 0 || gx >= this.cols || gz >= this.cols) continue
        const bucket = this.buckets[gz * this.cols + gx]
        for (const i of bucket) {
          const t = this.trees[i]
          const ddx = x - t.x
          const ddz = z - t.z
          const reach = r + t.r
          const d2 = ddx * ddx + ddz * ddz
          if (d2 < reach * reach) {
            const pen = reach - Math.sqrt(d2)
            if (pen > bestPen) {
              bestPen = pen
              best = t
            }
          }
        }
      }
    }
    return best
  }
}

export class World {
  readonly group = new THREE.Group()
  readonly heights: Float32Array
  readonly trees: Tree[] = []
  readonly base: BaseInfo
  readonly spawn: THREE.Vector3
  readonly spawnYaw: number
  readonly seed: number

  private grid: TreeGrid
  private rotor: THREE.Object3D | null = null
  private beaconMat: THREE.MeshBasicMaterial | null = null
  private disposables: Array<{ dispose(): void }> = []

  constructor(seed: number) {
    this.seed = seed
    const rng = new Rng(seed)
    const terrainNoise = new Noise2D(rng)
    const forestNoise = new Noise2D(rng)
    const detailNoise = new Noise2D(rng)
    const groveNoise = new Noise2D(rng)

    this.heights = new Float32Array(VERTS * VERTS)

    // ---- 1. base terrain -------------------------------------------------
    const warp = rng.range(0, 1000)
    for (let r = 0; r < VERTS; r++) {
      const z = -HALF + r * CELL
      for (let c = 0; c < VERTS; c++) {
        const x = -HALF + c * CELL
        const nx = (x + warp) / 340
        const nz = (z + warp) / 340
        const broad = terrainNoise.fbm(nx, nz, 4)
        const ridge = Math.abs(detailNoise.fbm(nx * 2.2, nz * 2.2, 3) - 0.5) * 2
        let h = 3.2 + (broad - 0.42) * 34 + (1 - ridge) * 3.5
        // gentle bowl so the map edges rise into unclimbable hills
        const edge = Math.max(Math.abs(x), Math.abs(z)) / HALF
        h += smoothstep(0.86, 1.0, edge) * 46
        this.heights[r * VERTS + c] = h
      }
    }

    // ---- 2. rivers -------------------------------------------------------
    const rivers = this.makeRivers(rng)
    this.carveRivers(rivers)

    // ---- 3. pick the base, then the spawn --------------------------------
    // Vector2 carries (x, z) here: .y is the world Z axis.
    const basePos = this.pickBaseSite(rng)
    const spawnPos = this.pickSpawn(rng, basePos)
    const bx = basePos.x
    const bz = basePos.y
    const sx = spawnPos.x
    const sz = spawnPos.y
    this.flatten(bx, bz, BASE_CLEARING, BASE_PLATEAU)

    const baseY = this.heightAt(bx, bz)
    this.base = {
      x: bx,
      z: bz,
      y: baseY,
      pad: new THREE.Vector3(bx, baseY, bz),
      padRadius: 11,
      gateYaw: Math.atan2(sx - bx, sz - bz),
    }

    this.spawn = new THREE.Vector3(sx, this.heightAt(sx, sz), sz)
    this.spawnYaw = Math.atan2(bx - sx, bz - sz) + rng.range(-0.9, 0.9)

    // ---- 4. scatter the forest ------------------------------------------
    this.plantForest(rng, forestNoise, groveNoise)
    this.grid = new TreeGrid(this.trees)

    // ---- 5. meshes -------------------------------------------------------
    this.group.add(this.buildTerrainMesh())
    this.group.add(this.buildWater())
    this.buildForestMeshes(rng)
    this.buildBase(rng)
  }

  // ======================= terrain queries ===============================

  heightAt(x: number, z: number): number {
    const fx = clamp((x + HALF) / CELL, 0, GRID - 0.0001)
    const fz = clamp((z + HALF) / CELL, 0, GRID - 0.0001)
    const c = Math.floor(fx)
    const r = Math.floor(fz)
    const tx = fx - c
    const tz = fz - r
    const h00 = this.heights[r * VERTS + c]
    const h10 = this.heights[r * VERTS + c + 1]
    const h01 = this.heights[(r + 1) * VERTS + c]
    const h11 = this.heights[(r + 1) * VERTS + c + 1]
    return lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz)
  }

  /** Positive when the point is submerged. */
  waterDepth(x: number, z: number): number {
    return WATER_LEVEL - this.heightAt(x, z)
  }

  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const d = CELL
    const hl = this.heightAt(x - d, z)
    const hr = this.heightAt(x + d, z)
    const hd = this.heightAt(x, z - d)
    const hu = this.heightAt(x, z + d)
    return out.set(hl - hr, 2 * d, hd - hu).normalize()
  }

  treeHit(x: number, z: number, r: number): Tree | null {
    return this.grid.hit(x, z, r)
  }

  /** Furthest the jeep may get from the middle; past here the hills take over. */
  readonly limit = HALF - 26

  inBounds(x: number, z: number): boolean {
    return x > -this.limit && x < this.limit && z > -this.limit && z < this.limit
  }

  // ======================= generation helpers ============================

  private makeRivers(rng: Rng): THREE.Vector2[][] {
    const rivers: THREE.Vector2[][] = []
    const count = rng.int(2, 3)
    for (let i = 0; i < count; i++) {
      const pts: THREE.Vector2[] = []
      // start on one edge, aim for the opposite side
      const side = rng.int(0, 3)
      const t = rng.range(-0.7, 0.7) * HALF
      const start = new THREE.Vector2()
      const dir = new THREE.Vector2()
      if (side === 0) {
        start.set(-HALF, t)
        dir.set(1, rng.range(-0.5, 0.5))
      } else if (side === 1) {
        start.set(HALF, t)
        dir.set(-1, rng.range(-0.5, 0.5))
      } else if (side === 2) {
        start.set(t, -HALF)
        dir.set(rng.range(-0.5, 0.5), 1)
      } else {
        start.set(t, HALF)
        dir.set(rng.range(-0.5, 0.5), -1)
      }
      dir.normalize()
      let angle = Math.atan2(dir.y, dir.x)
      const cur = start.clone()
      const step = 16
      const meander = rng.range(0.13, 0.26)
      let phase = rng.range(0, 10)
      for (let s = 0; s < 200; s++) {
        pts.push(cur.clone())
        phase += rng.range(0.18, 0.34)
        angle += Math.sin(phase) * meander + rng.range(-0.05, 0.05)
        cur.x += Math.cos(angle) * step
        cur.y += Math.sin(angle) * step
        if (Math.abs(cur.x) > HALF + 30 || Math.abs(cur.y) > HALF + 30) break
      }
      rivers.push(pts)
    }
    return rivers
  }

  private carveRivers(rivers: THREE.Vector2[][]) {
    const widths: number[][] = rivers.map((pts) =>
      pts.map((_, i) => 11 + 5 * Math.sin(i * 0.11) + 4 * Math.sin(i * 0.037 + 1.7)),
    )
    // Banks are graded over a fixed run, not a multiple of the channel width, so
    // even the narrow stretches stay shallow enough to drive back out of.
    const BANK = 24
    for (let r = 0; r < VERTS; r++) {
      const z = -HALF + r * CELL
      for (let c = 0; c < VERTS; c++) {
        const x = -HALF + c * CELL
        let best = Infinity
        let bestW = 12
        for (let ri = 0; ri < rivers.length; ri++) {
          const pts = rivers[ri]
          for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i]
            const b = pts[i + 1]
            const abx = b.x - a.x
            const abz = b.y - a.y
            const t = clamp(((x - a.x) * abx + (z - a.y) * abz) / (abx * abx + abz * abz), 0, 1)
            const px = a.x + abx * t
            const pz = a.y + abz * t
            const d = Math.hypot(x - px, z - pz)
            if (d < best) {
              best = d
              bestW = widths[ri][i]
            }
          }
        }
        const half = bestW * 0.5
        if (best < half + BANK) {
          const idx = r * VERTS + c
          const h = this.heights[idx]
          const k = smoothstep(half, half + BANK, best)
          this.heights[idx] = lerp(RIVER_BED, h, k)
        }
      }
    }
  }

  private flatten(cx: number, cz: number, inner: number, outer: number) {
    const target = this.heightAt(cx, cz)
    const r0 = Math.max(0, Math.floor((cz - outer + HALF) / CELL))
    const r1 = Math.min(VERTS - 1, Math.ceil((cz + outer + HALF) / CELL))
    const c0 = Math.max(0, Math.floor((cx - outer + HALF) / CELL))
    const c1 = Math.min(VERTS - 1, Math.ceil((cx + outer + HALF) / CELL))
    for (let r = r0; r <= r1; r++) {
      const z = -HALF + r * CELL
      for (let c = c0; c <= c1; c++) {
        const x = -HALF + c * CELL
        const d = Math.hypot(x - cx, z - cz)
        if (d > outer) continue
        const k = smoothstep(inner, outer, d)
        const idx = r * VERTS + c
        this.heights[idx] = lerp(target, this.heights[idx], k)
      }
    }
  }

  private pickBaseSite(rng: Rng): THREE.Vector2 {
    let best = new THREE.Vector2(0, 0)
    let bestScore = -Infinity
    for (let i = 0; i < 400; i++) {
      const x = rng.range(-HALF + 120, HALF - 120)
      const z = rng.range(-HALF + 120, HALF - 120)
      const h = this.heightAt(x, z)
      if (h < 4) continue
      // prefer flat, dry, high-ish ground away from the map edge
      let score = h * 0.35 - this.roughness(x, z) * 22
      let nearWater = 0
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2
        const d = this.heightAt(x + Math.cos(ang) * 46, z + Math.sin(ang) * 46)
        if (d < WATER_LEVEL + 1) nearWater++
      }
      score -= nearWater * 9
      if (score > bestScore) {
        bestScore = score
        best = new THREE.Vector2(x, z)
      }
    }
    return best
  }

  private pickSpawn(rng: Rng, base: THREE.Vector2): THREE.Vector2 {
    let fallback = new THREE.Vector2(-base.x, -base.y)
    let bestScore = -Infinity
    for (let i = 0; i < 600; i++) {
      const x = rng.range(-HALF + 90, HALF - 90)
      const z = rng.range(-HALF + 90, HALF - 90)
      const h = this.heightAt(x, z)
      if (h < 2.5) continue
      if (this.roughness(x, z) > 0.16) continue
      const d = Math.hypot(x - base.x, z - base.y)
      if (d < 460) continue
      const score = -Math.abs(d - 600) + rng.range(0, 40)
      if (score > bestScore) {
        bestScore = score
        fallback = new THREE.Vector2(x, z)
      }
    }
    return fallback
  }

  private roughness(x: number, z: number): number {
    const h = this.heightAt(x, z)
    let m = 0
    for (let a = 0; a < 4; a++) {
      const ang = (a / 4) * Math.PI * 2
      m = Math.max(m, Math.abs(this.heightAt(x + Math.cos(ang) * 7, z + Math.sin(ang) * 7) - h))
    }
    return m / 7
  }

  private plantForest(rng: Rng, forest: Noise2D, grove: Noise2D) {
    const step = 6.0
    const jitter = step * 0.6
    const clearBase = BASE_PLATEAU + 8

    // Thickets are allowed to be dense, but never so dense that the jeep can
    // wedge between two trunks with no way out: every pair keeps a gap wider
    // than the truck. Rejecting candidates (rather than snapping them to a
    // lattice) keeps the stands looking scattered.
    const cell = MIN_TREE_GAP
    const cols = Math.ceil(WORLD_SIZE / cell) + 2
    const claimed: Array<[number, number][]> = new Array(cols * cols)
    const tooClose = (x: number, z: number) => {
      const cx = clamp(Math.floor((x + HALF) / cell), 0, cols - 1)
      const cz = clamp(Math.floor((z + HALF) / cell), 0, cols - 1)
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const b = claimed[(cz + dz) * cols + (cx + dx)]
          if (!b) continue
          for (const [ox, oz] of b) {
            if ((x - ox) ** 2 + (z - oz) ** 2 < MIN_TREE_GAP * MIN_TREE_GAP) return true
          }
        }
      }
      const i = cz * cols + cx
      ;(claimed[i] ??= []).push([x, z])
      return false
    }
    for (let z = -HALF + 20; z < HALF - 20; z += step) {
      for (let x = -HALF + 20; x < HALF - 20; x += step) {
        const px = x + rng.range(-jitter, jitter)
        const pz = z + rng.range(-jitter, jitter)
        const y = this.heightAt(px, pz)
        if (y < WATER_LEVEL + 1.4) continue // no trees standing in the river
        if (y > 44) continue // bare hilltops out at the world edge
        if (this.roughness(px, pz) > 0.42) continue
        if (Math.hypot(px - this.base.x, pz - this.base.z) < clearBase) continue
        if (Math.hypot(px - this.spawn.x, pz - this.spawn.z) < 11) continue

        // Two scales of noise. The broad one decides where forest exists at
        // all, with a sharp edge so fields are genuinely empty rather than
        // sprinkled with stragglers; the fine one breaks that forest into
        // groves with clearings between them.
        const region = smoothstep(0.44, 0.56, forest.fbm(px / 330, pz / 330, 3))
        if (region <= 0) continue
        // No floor under the grove term on purpose: where it bottoms out the
        // glade is properly empty, instead of thin scrub filling every gap.
        const groves = smoothstep(0.42, 0.6, grove.fbm(px / 74, pz / 74, 3))
        if (rng.next() > region * groves) continue
        if (tooClose(px, pz)) continue
        this.trees.push({ x: px, z: pz, y, r: TRUNK_RADIUS })
      }
    }
  }

  // ======================= mesh building =================================

  private buildTerrainMesh(): THREE.Mesh {
    const positions = new Float32Array(VERTS * VERTS * 3)
    const colors = new Float32Array(VERTS * VERTS * 3)
    const grass = new THREE.Color(0x44693c)
    const deepGrass = new THREE.Color(0x32502f)
    const dirt = new THREE.Color(0x5c5137)
    const sand = new THREE.Color(0x6d6349)
    const rock = new THREE.Color(0x565b63)
    const tmp = new THREE.Color()

    for (let r = 0; r < VERTS; r++) {
      const z = -HALF + r * CELL
      for (let c = 0; c < VERTS; c++) {
        const i = r * VERTS + c
        const x = -HALF + c * CELL
        const h = this.heights[i]
        positions[i * 3] = x
        positions[i * 3 + 1] = h
        positions[i * 3 + 2] = z

        const slope = this.roughness(x, z)
        tmp.copy(h < 22 ? grass : deepGrass)
        tmp.lerp(sand, smoothstep(3.4, 0.2, h))
        tmp.lerp(dirt, smoothstep(0.4, 0.0, h) * 0.7)
        tmp.lerp(rock, smoothstep(0.4, 0.95, slope))
        colors[i * 3] = tmp.r
        colors[i * 3 + 1] = tmp.g
        colors[i * 3 + 2] = tmp.b
      }
    }

    const indices = new Uint32Array(GRID * GRID * 6)
    let k = 0
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        const a = r * VERTS + c
        const b = a + 1
        const d = a + VERTS
        const e = d + 1
        indices[k++] = a
        indices[k++] = d
        indices[k++] = b
        indices[k++] = b
        indices[k++] = d
        indices[k++] = e
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.setIndex(new THREE.BufferAttribute(indices, 1))
    geo.computeVertexNormals()

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true })
    this.disposables.push(geo, mat)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.name = 'terrain'
    return mesh
  }

  private buildWater(): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, 1, 1)
    geo.rotateX(-Math.PI / 2)
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0a1922,
      roughness: 0.12,
      metalness: 0.65,
      transparent: true,
      opacity: 0.92,
    })
    this.disposables.push(geo, mat)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.y = WATER_LEVEL - 0.06
    mesh.renderOrder = 1
    return mesh
  }

  private buildForestMeshes(rng: Rng) {
    const pines: Tree[] = []
    const broads: Tree[] = []
    for (const t of this.trees) (rng.next() < 0.58 ? pines : broads).push(t)

    const trunkGeo = new THREE.CylinderGeometry(0.42, 0.72, 1, 5, 1)
    trunkGeo.translate(0, 0.5, 0)
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x4b3827 })

    const pineGeo = new THREE.ConeGeometry(1, 1, 6, 2)
    pineGeo.translate(0, 0.5, 0)
    const pineMat = new THREE.MeshLambertMaterial({ color: 0x2e5c39, flatShading: true })

    const blobGeo = new THREE.IcosahedronGeometry(1, 0)
    const blobMat = new THREE.MeshLambertMaterial({ color: 0x386640, flatShading: true })

    this.disposables.push(trunkGeo, trunkMat, pineGeo, pineMat, blobGeo, blobMat)

    const total = this.trees.length
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, total)
    const pineTops = new THREE.InstancedMesh(pineGeo, pineMat, pines.length * 2)
    const blobTops = new THREE.InstancedMesh(blobGeo, blobMat, broads.length * 2)
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const pos = new THREE.Vector3()
    const scl = new THREE.Vector3()

    let ti = 0
    let pi = 0
    let bi = 0

    for (const t of pines) {
      const h = rng.range(9, 17)
      const yaw = rng.range(0, Math.PI * 2)
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
      trunks.setMatrixAt(ti++, m.compose(pos.set(t.x, t.y - 0.4, t.z), q, scl.set(1, h * 0.42, 1)))
      const canopy = rng.range(2.6, 4.1)
      pineTops.setMatrixAt(
        pi++,
        m.compose(pos.set(t.x, t.y + h * 0.24, t.z), q, scl.set(canopy, h * 0.5, canopy)),
      )
      pineTops.setMatrixAt(
        pi++,
        m.compose(pos.set(t.x, t.y + h * 0.55, t.z), q, scl.set(canopy * 0.72, h * 0.42, canopy * 0.72)),
      )
    }

    for (const t of broads) {
      const h = rng.range(7.5, 14)
      const yaw = rng.range(0, Math.PI * 2)
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
      trunks.setMatrixAt(ti++, m.compose(pos.set(t.x, t.y - 0.4, t.z), q, scl.set(1.05, h * 0.6, 1.05)))
      const canopy = rng.range(3.2, 5.0)
      blobTops.setMatrixAt(
        bi++,
        m.compose(pos.set(t.x, t.y + h * 0.68, t.z), q, scl.set(canopy, canopy * 0.78, canopy)),
      )
      blobTops.setMatrixAt(
        bi++,
        m.compose(
          pos.set(t.x + rng.range(-1.4, 1.4), t.y + h * 0.92, t.z + rng.range(-1.4, 1.4)),
          q,
          scl.set(canopy * 0.66, canopy * 0.6, canopy * 0.66),
        ),
      )
    }

    trunks.count = ti
    pineTops.count = pi
    blobTops.count = bi
    for (const im of [trunks, pineTops, blobTops]) {
      im.instanceMatrix.needsUpdate = true
      im.frustumCulled = false
      this.group.add(im)
    }

    // a handful of boulders so the open fields are not featureless
    const rockGeo = new THREE.DodecahedronGeometry(1, 0)
    const rockMat = new THREE.MeshLambertMaterial({ color: 0x585c64, flatShading: true })
    this.disposables.push(rockGeo, rockMat)
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, 220)
    let ri = 0
    for (let i = 0; i < 900 && ri < 220; i++) {
      const x = rng.range(-HALF + 40, HALF - 40)
      const z = rng.range(-HALF + 40, HALF - 40)
      const y = this.heightAt(x, z)
      if (y < WATER_LEVEL + 0.5 || y > 40) continue
      const s = rng.range(0.7, 2.1)
      q.setFromEuler(new THREE.Euler(rng.range(0, 3), rng.range(0, 6), rng.range(0, 3)))
      rocks.setMatrixAt(ri++, m.compose(pos.set(x, y + s * 0.35, z), q, scl.set(s, s * 0.7, s * 1.1)))
    }
    rocks.count = ri
    rocks.instanceMatrix.needsUpdate = true
    rocks.frustumCulled = false
    this.group.add(rocks)
  }

  private buildBase(rng: Rng) {
    const g = new THREE.Group()
    const { x, z, y } = this.base
    g.position.set(x, y, z)
    g.rotation.y = this.base.gateYaw

    const concrete = new THREE.MeshLambertMaterial({ color: 0x6a7078 })
    const metal = new THREE.MeshStandardMaterial({ color: 0x53585f, roughness: 0.55, metalness: 0.7 })
    const paint = new THREE.MeshLambertMaterial({ color: 0xd8e2ea })
    const dark = new THREE.MeshLambertMaterial({ color: 0x33383f })
    const glow = new THREE.MeshBasicMaterial({ color: 0xfff0c8 })
    this.disposables.push(concrete, metal, paint, dark, glow)

    // --- apron + helipad ---
    const apronGeo = new THREE.CylinderGeometry(BASE_CLEARING * 0.78, BASE_CLEARING * 0.8, 0.5, 28)
    const apron = new THREE.Mesh(apronGeo, concrete)
    apron.position.y = 0.15
    g.add(apron)
    this.disposables.push(apronGeo)

    const padGeo = new THREE.CylinderGeometry(11, 11, 0.24, 40)
    const pad = new THREE.Mesh(padGeo, dark)
    pad.position.y = 0.44
    g.add(pad)
    this.disposables.push(padGeo)

    const ringGeo = new THREE.TorusGeometry(8.6, 0.42, 6, 44)
    ringGeo.rotateX(-Math.PI / 2)
    const ring = new THREE.Mesh(ringGeo, paint)
    ring.position.y = 0.6
    g.add(ring)
    this.disposables.push(ringGeo)

    // the "H"
    const barGeo = new THREE.BoxGeometry(1.3, 0.2, 8)
    const crossGeo = new THREE.BoxGeometry(4.6, 0.2, 1.3)
    this.disposables.push(barGeo, crossGeo)
    for (const dx of [-2.6, 2.6]) {
      const bar = new THREE.Mesh(barGeo, paint)
      bar.position.set(dx, 0.62, 0)
      g.add(bar)
    }
    const cross = new THREE.Mesh(crossGeo, paint)
    cross.position.y = 0.62
    g.add(cross)

    // --- helicopter waiting on the pad ---
    const heli = new THREE.Group()
    const bodyGeo = new THREE.CapsuleGeometry(1.5, 3.4, 4, 10)
    bodyGeo.rotateZ(Math.PI / 2)
    const body = new THREE.Mesh(bodyGeo, metal)
    heli.add(body)
    const boomGeo = new THREE.CylinderGeometry(0.32, 0.6, 5.4, 7)
    boomGeo.rotateZ(Math.PI / 2)
    const boom = new THREE.Mesh(boomGeo, metal)
    boom.position.set(-4.1, 0.35, 0)
    heli.add(boom)
    const finGeo = new THREE.BoxGeometry(0.9, 1.9, 0.24)
    const fin = new THREE.Mesh(finGeo, metal)
    fin.position.set(-6.5, 1.1, 0)
    heli.add(fin)
    const skidGeo = new THREE.BoxGeometry(5.2, 0.22, 0.22)
    for (const dz of [-1.3, 1.3]) {
      const skid = new THREE.Mesh(skidGeo, dark)
      skid.position.set(0.4, -1.85, dz)
      heli.add(skid)
    }
    const mastGeo = new THREE.CylinderGeometry(0.2, 0.2, 1.1, 6)
    const mast = new THREE.Mesh(mastGeo, metal)
    mast.position.y = 1.9
    heli.add(mast)
    const rotor = new THREE.Group()
    const bladeGeo = new THREE.BoxGeometry(12.5, 0.1, 0.62)
    for (let i = 0; i < 2; i++) {
      const blade = new THREE.Mesh(bladeGeo, dark)
      blade.rotation.y = (i * Math.PI) / 2
      rotor.add(blade)
    }
    rotor.position.y = 2.4
    heli.add(rotor)
    this.rotor = rotor
    heli.position.set(0, 3.2, 0)
    heli.rotation.y = Math.PI * 0.15
    g.add(heli)
    this.disposables.push(bodyGeo, boomGeo, finGeo, skidGeo, mastGeo, bladeGeo)

    // --- hangar ---
    const hangarGeo = new THREE.BoxGeometry(16, 7, 11)
    const hangar = new THREE.Mesh(hangarGeo, concrete)
    hangar.position.set(-6, 3.5, -22)
    hangar.rotation.y = 0.2
    g.add(hangar)
    this.disposables.push(hangarGeo)

    // --- perimeter fence with a gate facing the player ---
    const postGeo = new THREE.BoxGeometry(0.5, 4.6, 0.5)
    const railGeo = new THREE.BoxGeometry(0.16, 0.16, 4.4)
    this.disposables.push(postGeo, railGeo)
    const R = BASE_CLEARING - 2
    const steps = 64
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2
      // gate opening points back toward the player's approach (local +Z)
      if (Math.abs(Math.atan2(Math.sin(a), Math.cos(a)) - Math.PI / 2) < 0.36) continue
      const px = Math.cos(a) * R
      const pz = Math.sin(a) * R
      const post = new THREE.Mesh(postGeo, metal)
      post.position.set(px, 2.3 + this.localGround(px, pz), pz)
      post.rotation.y = a
      g.add(post)
      for (const h of [1.4, 2.6, 3.8]) {
        const rail = new THREE.Mesh(railGeo, metal)
        rail.position.set(px, h + this.localGround(px, pz), pz)
        rail.rotation.y = -a
        g.add(rail)
      }
    }

    // --- floodlights ---
    const poleGeo = new THREE.CylinderGeometry(0.3, 0.42, 13, 6)
    const headGeo = new THREE.BoxGeometry(1.8, 1.1, 1.1)
    this.disposables.push(poleGeo, headGeo)
    for (let i = 0; i < 3; i++) {
      const a = rng.range(0, Math.PI * 2)
      const px = Math.cos(a) * (BASE_CLEARING - 10)
      const pz = Math.sin(a) * (BASE_CLEARING - 10)
      const pole = new THREE.Mesh(poleGeo, metal)
      pole.position.set(px, 6.5, pz)
      g.add(pole)
      const head = new THREE.Mesh(headGeo, glow)
      head.position.set(px, 13, pz)
      g.add(head)
    }
    const flood = new THREE.PointLight(0xffe9c0, 4200, 115, 2)
    flood.position.set(0, 15, 0)
    g.add(flood)

    // --- beacon mast: a red blink above the canopy, if the trees let you see it ---
    const mastGeo2 = new THREE.CylinderGeometry(0.28, 0.5, 26, 6)
    const beaconMast = new THREE.Mesh(mastGeo2, metal)
    beaconMast.position.set(16, 13, -12)
    g.add(beaconMast)
    const beaconGeo = new THREE.SphereGeometry(0.9, 10, 8)
    this.beaconMat = new THREE.MeshBasicMaterial({ color: 0xff2a1a })
    const beacon = new THREE.Mesh(beaconGeo, this.beaconMat)
    beacon.position.set(16, 26.4, -12)
    g.add(beacon)
    this.disposables.push(mastGeo2, beaconGeo, this.beaconMat)

    this.group.add(g)
  }

  /** Terrain height relative to the base origin, for props sitting on the plateau. */
  private localGround(lx: number, lz: number): number {
    const yaw = this.base.gateYaw
    const wx = this.base.x + lx * Math.cos(yaw) + lz * Math.sin(yaw)
    const wz = this.base.z - lx * Math.sin(yaw) + lz * Math.cos(yaw)
    return this.heightAt(wx, wz) - this.base.y
  }

  update(dt: number, t: number, escaped: boolean) {
    if (this.rotor) this.rotor.rotation.y += dt * (escaped ? 34 : 0.55)
    const blink = Math.sin(t * 2.4) > 0.55 ? 1 : 0.05
    if (this.beaconMat) this.beaconMat.color.setRGB(blink, 0.14 * blink, 0.1 * blink)
  }

  dispose() {
    for (const d of this.disposables) d.dispose()
    this.group.clear()
  }
}
