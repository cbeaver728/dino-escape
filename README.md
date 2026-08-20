# Dino Escape

A 3D night-driving survival game. You are in a jeep, somewhere in a forest, in the dark.
Six T-Rexes are out there. The base with the helipad is a long way off. Go.

**Play: https://cbeaver728.github.io/dino-escape/**

## The idea

Every game generates a brand new map — rolling terrain, meandering rivers, thick
forest, open fields, and a fenced base with a lit helipad somewhere far from
where you start. You have headlights and a compass. That is it.

The T-Rexes plod around on their own until they **hear your engine**. The faster
you drive, the further that sound carries, so there is a real choice between
covering ground and staying quiet.

Once one locks on, it sprints at **1.3× your top speed**. You cannot outrun it in
a straight line. What you can do:

- **Use the trees.** A twelve-metre animal pays a much bigger price in thick
  timber than a jeep does. In the open it will run you down; in a dense stand you
  can hold it off.
- **Wait out the sprint.** It can only sprint in bursts. When it blows up and has
  to lope, you gain ground — but only if you are still driving clean. Clip a tree
  during the recovery and you hand all of it back.
- **Water.** It slows you down. It slows them down more.

Break contact for long enough and it loses interest and goes back to wandering.

While something is chasing you the edges of the screen grey out and close in, and
the closer it gets the less you can see. It never takes more than 40% of the
screen — a clear disc covering at least 60% of the view always remains, whatever
the aspect ratio of your screen.

Reach the helipad and you live.

## Controls

**Phone** (laid out for a right-handed grip):

- **Left thumb** — green **GO** on the bottom, red **BRAKE** above it. Hold brake
  once you have stopped and the jeep backs up.
- **Right thumb** — the steering wheel. Drag left and right; it self-centres when
  you let go.

**Desktop** — `W`/`S` to drive, `A`/`D` to steer. Arrow keys and space also work.

## Running it locally

```bash
pnpm install
```

```bash
pnpm run dev
```

`pnpm run build` type-checks and produces `dist/`. Pushing to `main` builds and
publishes to GitHub Pages automatically.

## How it is put together

No art assets, no model files, no audio files — everything is generated at runtime.

| File | What it does |
| --- | --- |
| `src/world.ts` | Map generation: heightmap terrain, carved rivers, forest scatter, the base and helipad. Also owns terrain height/water queries and tree collision. |
| `src/jeep.ts` | The jeep model and its driving physics — bicycle-model steering, slope and water drag, tree collisions. |
| `src/rex.ts` | The T-Rex: a jointed skeleton with walk and sprint gaits, plus the hearing, chasing, and stamina behaviour. |
| `src/postfx.ts` | The closing-in vignette, as a full-screen shader pass. |
| `src/controls.ts` | Touch pedals and wheel, and the keyboard fallback. |
| `src/audio.ts` | Synthesised engine, roars, footsteps and heartbeat via WebAudio. |
| `src/rng.ts` | Seeded random and value noise, so a seed always rebuilds the same map. |

A few things worth knowing if you go poking around:

- Every limb geometry in `rex.ts` hangs from its joint down the **-Y** axis, so a
  joint angle of zero points straight down and a negative angle swings forward.
  The rest-pose constants at the top all follow from that.
- The forest keeps a **minimum gap between any two trunks** wider than the jeep.
  Without that rule, dense stands generate pockets a player can drive into and
  never get out of.
- Headlights use a deliberately low light decay. Physically correct falloff puts
  a blinding pool at the bumper and pitch black past it.

## Playtesting it without playing it

Balance here is hard to eyeball, so `main.ts` exposes a `window.__dino` handle in
dev builds only (it is compiled out of `pnpm run build`). It can step the
simulation without waiting on the frame clock, drive the jeep from a script,
teleport, drop a T-Rex on top of you, and photograph the result:

```js
__dino.newGame(96028)            // a specific seed, so a map is reproducible
__dino.drive(0.2, true)          // steer, throttle
__dino.step(600)                 // ten seconds, as fast as the CPU manages
__dino.state()                   // speed, distance to base, what each rex is doing
__dino.probe(0.4, 20)            // is it clear 20m ahead, 0.4rad off the nose?
__dino.warpRex(0, 0, -60)        // put one 60m behind you
```

`__dino.snap(fear)` renders a frame and returns a PNG data URL; POSTing it to
`/__shot` (a dev-server-only middleware in `vite.config.ts`) writes it to
`.shots/`. That loop is how the lighting, the T-Rex rig and the win rate were
checked.

## Tuning

The numbers that decide how the game feels:

| Constant | File | Meaning |
| --- | --- | --- |
| `JEEP_TOP_SPEED` | `jeep.ts` | Everything else is expressed relative to this. |
| `CHASE_SPEED` | `rex.ts` | 1.3× the jeep. |
| `SPRINT_SECONDS` / `WINDED_SECONDS` | `rex.ts` | The sprint-and-recover cycle. A clean run nets you ground over one full cycle; that is the whole escape. |
| `LOSE_DISTANCE` | `rex.ts` | How far ahead you must get to break contact. |
| `REX_COUNT` | `main.ts` | How crowded the map is. |
| `MIN_TREE_GAP` | `world.ts` | Closest two trunks may stand - how open the woods feel. |
| `MIN_CLEAR_FRACTION` | `postfx.ts` | The 60% visibility floor. |
