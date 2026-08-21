# Dino Escape

A 3D night-driving survival game. You are in a jeep, somewhere in a forest, in the dark.
T-Rexes are out there. The base with the helipad is a long way off. Go.

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
- **Kill the engine.** You go dark, silent and immobile. It can no longer hear
  you, so it hunts the last place it *did* — and it never had that place pinned
  exactly. Get this right and it casts around the wrong patch of forest, gives
  up, and wanders off.
- **Water.** It slows you down. It slows them down more.
- **Read the deer.** Herds graze quietly until a rex comes within 78m, then they
  bolt with their white tails flared. They react to something you cannot yet see
  or hear, so a herd breaking cover tells you a rex is out there and roughly
  where it came from. A wandering rex takes a run at a nearby herd about half
  the time it notices one, and gives up after nine to nineteen seconds because
  deer are faster than it is. Around a third of all rex activity is these runs,
  so the forest is busy with them — and a rex committed to a herd is one that is
  not wandering across your route.

Going dark is a real gamble, not a get-out-of-jail card, because two things have
to be true at once:

- **Early enough.** Its guess at where you are is off by roughly half the
  distance it was at when the sound stopped. Cut out at 90m and it hunts a patch
  a long way from you; cut out at 25m and it has you placed well enough to walk
  over and find you.
- **Under cover.** Silent and still in thick timber, it has to almost tread on
  you to notice. Silent and still out on the open grass, it just looks over and
  sees you.

Measured over repeated trials in one map, with a single rex and the jeep already
stopped (the worst case — coasting in adds distance):

| | cut at 25m | cut at 55m | cut at 90m |
| --- | --- | --- | --- |
| deep in a grove | 0/6 got away | 3/6 | 6/6 |
| patchy scrub | 0/6 | 0/6 | 1/6 |
| open ground | 0/6 | 0/6 | 0/6 |

Sitting there is its own problem: you cannot see, you cannot move, the other
the rest are still wandering, and restarting fires a very loud starter motor. In
the dark the only warning you get is a pair of amber eyes and the footsteps.

Break contact for long enough and it loses interest and goes back to wandering.

While something is chasing you the edges of the screen grey out and close in, and
the closer it gets the less you can see. It never takes more than 40% of the
screen — a clear disc covering at least 60% of the view always remains, whatever
the aspect ratio of your screen.

The base is **fenced**, and the fence is solid. There is one way in, marked by
two amber lamps — driving at the wall just bounces you off it, which is a bad
place to be with something behind you. The gate always faces back the way you
came from, so a straight run from your start puts you in front of it.

Reach the helipad and you live.

## Difficulty

Picked before the run and remembered between sessions. Best times are kept per
difficulty, since they are not comparable across them.

| | T-Rexes | seeded on your route | scripted driver wins |
| --- | --- | --- | --- |
| Easy | 5 | 1 | 61% |
| Medium | 10 | 3 | 35% |
| Hard | 30 | 8 | 5% |
| Legend | 40 | 11 | 5-10% |

The win rates are for a bot that drives for the base and swerves from anything
chasing it but never uses the engine kill, over 18-20 generated maps each. At
that sample the 95% interval is around +/-20pp, so treat them as a ladder rather
than precise figures.

Below roughly 15% the bot stops being a difficulty meter and becomes a floor
detector: it dies at first contact either way, so it cannot separate Hard from
Legend. Legend is harder by construction - half again as many animals, more of
them in your lane, and a recovery window a bit over half as long - but that last
knob only bites for someone good enough to survive first contact and then have
to shake the thing off, which is exactly the player the bot is not.

Seeded rexes sit within `ROUTE_SPREAD` (80m) of the straight line from your
start to the base, so driving it directly is contested rather than a free run.
Averaged over 16 maps, the number sitting within 60m of that line is 1.0 on
Easy, 2.6 on Medium, 4.1 on Hard and 6.4 on Legend; outside Easy no generated
map leaves the lane empty. A person
has the hiding mechanic on top of that.

Worth knowing: on a map this size most of the pack never comes near you. Across
full runs only **2 to 6 distinct rexes** ever get within 200m, with an average of
1.8 within 200m and 0.55 within 120m at any instant. That is why the count of
those seeded along your route matters as much as the total.

## Watching it back

Win or lose, the result screen offers **Watch the replay**. It plays back the
whole run with pause, scrub, and speed from 0.25× to 4×, and one button cycles
three cameras:

- **Chase** — behind the jeep, exactly as you drove it, including the screen
  closing in when something was on you.
- **Rear** — looking back over the jeep at whatever is gaining on you, and it
  tracks the pursuer rather than staring straight astern, because a rex arcs in
  from the side and a fixed rearward aim loses it off the edge of frame. This is
  the one that is unpleasant to watch.
- **Top** — 95m up, world-aligned so directions stay put, with a green pip over
  the jeep and a red one over each rex. This is the one that answers "where did
  that thing come from".

The rear camera has to sit *forward* of the jeep looking back — put it on the
tail and the vehicle ends up behind the lens, and put it close and the roll cage
fills the shot. Sweeping the placement against a recorded chase, 13m ahead and
4.6m up keeps the jeep in frame about 90% of the time and the pursuer about 80%;
the rest is a rex attacking from in front, which a rear camera should not show.

The overhead view lifts the ambient light and thins the fog while it is active,
because a night forest from 95m up is otherwise a black rectangle. The pips
float above the canopy so you can follow an animal you cannot see through the
trees, and brighten when it is actively chasing.

It records state, not inputs. Replaying from inputs would be far smaller, but
only if the simulation is perfectly deterministic, and this one runs on a
variable frame clock with a shared RNG. Recording where everything actually was
costs about 3MB for a run and cannot drift out of sync. Samples are taken at
20Hz and interpolated on playback, so it is smooth at any speed and any frame
rate; angles are wrapped properly and discrete things like a rex's state snap
rather than blend. Poses are not stored — gait, jaw and neck all key off speed
and state, so replaying those two reproduces the animation exactly.

## Engine sound

Two voices, picked on the start screen and remembered between sessions. Tapping
one auditions it, since the tap is the user gesture the audio context needs
anyway.

- **Soft hum** — sines and a triangle, nothing sharp in it.
- **Round burble** — four harmonics and a detune wobble that smooths out as it
  revs, for a V8 shape without the bite.

Both roll off 15dB above 1.1kHz, which is what lets them sit roughly **8.5dB
louder** than the sawtooth engine they replaced without being tiring. That
volume is doing real work: engine loudness is how far a rex can hear you, so
the sound has to make speed obvious. Measured idle-to-full-throttle range is
8.1dB for the hum and 9.0dB for the burble, on top of a pitch sweep and an
opening filter.

A limiter now sits on the master output. The engine is loud enough that a roar
landing on top of it would otherwise clip rather than duck.

## Handicap: radar

Optional, toggled on the start screen and remembered. A dish at the top left
spanning twice a rex’s maximum detection range, so its rim sits exactly where
one could notice you flat out with the lights on. Green centre dot is you,
oriented so up is where you are pointing; red dots are rexes, brighter and
larger when actively hunting.

The amber ring is your detection radius *right now*. It shrinks as you slow
down and collapses to almost nothing when you kill the engine, which makes the
noise mechanic visible instead of something you infer. It reads from the same
`detectionRange()` the AI uses, so it cannot drift out of step with the rule it
is drawing.

## Controls

**Phone** (laid out for a right-handed grip):

- **Left thumb** — green **GO** on the bottom, red **BRAKE** above it. Hold brake
  once you have stopped and the jeep backs up.
- **Right thumb** — the steering wheel. Drag left and right; it self-centres when
  you let go.
- The small amber **ENGINE** button sits above the pedals, under the same thumb.

**Desktop** — `W`/`S` to drive, `A`/`D` to steer, `E` for the engine. Arrow keys
and space also work.

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
| `src/rex.ts` | The T-Rex: a jointed skeleton with walk and sprint gaits, plus the hearing, chasing, stamina and deer-baiting behaviour. |
| `src/deer.ts` | Herds: formation wandering, panic flight, and the white tail flag that makes them readable. |
| `src/postfx.ts` | The closing-in vignette, as a full-screen shader pass. |
| `src/controls.ts` | Touch pedals and wheel, and the keyboard fallback. |

## Holding up on a phone

Legend puts about 3,200 meshes on the map, and a phone is a much smaller machine
than the one this was written on, so a few things are deliberate:

- **Distant rexes are not animated.** Past `VISIBLE_RANGE` (150 m, comfortably
  beyond what the fog lets through) the rig is hidden and the joints are left
  alone. The AI still runs, so behaviour is identical; only the posing stops.
  Measured at 3.0 ms -> 1.4 ms per frame with 40-odd rexes on screen versus
  culled. Visibility has exactly one owner - `Rex.setVisible`, which always
  writes **both** `visible` and `matrixWorldAutoUpdate`. They have to move
  together: visible with matrix updates off means three keeps drawing the rig at
  whatever world matrix it last had, which is the origin. Three separate places
  used to assign `.visible` directly, and any one of them could leave the pair
  disagreeing.
- **Nothing unbounded reaches the shader.** `performance.now()` climbs for as
  long as the tab is open, and both of its uses in the vignette are periodic, so
  the wrap happens on the CPU in float64. The grain hash is also sin-free: the
  usual `sin(dot(p, big)) * 43758.0` trick feeds its sin a number in the
  hundreds of thousands, which overflows a mediump fragment shader to inf, then
  NaN, then white.
- **A lost GL context is survivable.** Phones reclaim GPU memory whenever they
  feel like it, and when that happens every draw call silently becomes a no-op.
  The page itself is untouched though - the map, the jeep and every rex are
  ordinary JS objects and are all still there - so a loss is treated as a pause
  rather than the end of the run. `preventDefault()` is what makes the context
  recoverable at all; the simulation freezes so nothing can creep up on a player
  who cannot see it; and if the browser hands the context back, the run resumes
  from exactly where it stopped. Only if it has not returned in 2.5 seconds does
  the player get a screen about it, naming the difficulty, the elapsed time, and
  whether the tab had just been in the background.
- **The radar has no CSS effects on it at all.** It began as a translucent div
  with `backdrop-filter: blur(4px)`, which reads far worse than it sounds: what
  sits behind the dish is the live WebGL canvas, so the compositor had to read
  that region back and re-blur it on every frame the game painted - 60 times a
  second, whatever the canvas redraw rate. It was the one thing the handicap
  added that scaled with framerate rather than with content, and turning the
  radar on was enough to cost phones their GL context. The canvas now paints its
  own dish and rim, so the whole radar is a single plain layer.
- **The radar redraws at 15 Hz, not 60.** Every redraw pushes a fresh texture to
  the compositor, and nothing on the dish moves fast enough to notice.

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
| `HEADLIGHT_RANGE` | `rex.ts` | How far your lights give you away with the engine on. |
| `SIGHT_EXPOSED` / `SIGHT_HIDDEN` | `rex.ts` | Eyesight against a shut-down jeep, open versus under cover. |
| `SEARCH_SECONDS` | `rex.ts` | How long it hunts before wandering off. |
| `COVER_TREES` | `world.ts` | Trees needed nearby to count as properly hidden. |
| `PATROL_SPEED` | `rex.ts` | Wandering pace - drives how often you blunder into one. |
| `DEER_INTEREST` / `DEER_GIVE_UP` | `rex.ts` | Odds a rex chases a herd, and for how long. |
| `REX_ALARM` | `deer.ts` | How far off a rex has to be before the herd bolts. |
| `HERD_COUNT` | `main.ts` | How much wildlife there is to read. |
| `DIFFICULTIES` | `main.ts` | Rex counts and route seeding per difficulty. |
| `ROUTE_SPREAD` | `main.ts` | How far off the direct line a seeded rex may sit. Tighten it and each seeded rex counts for roughly two. |
| `tuning.windedScale` | `rex.ts` | Per-difficulty recovery window. Legend uses 0.55 - past ~30 rexes, count stops mattering and this is the lever left. |
| `buildHum` / `buildBurble` | `audio.ts` | The two engine voices; `level()` sets loudness against revs. |
| `MIN_TREE_GAP` | `world.ts` | Closest two trunks may stand - how open the woods feel. |
| `MIN_CLEAR_FRACTION` | `postfx.ts` | The 60% visibility floor. |
| `REPLAY_HZ` | `replay.ts` | Recording rate; trades replay memory against fidelity. |
