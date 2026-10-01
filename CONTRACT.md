# ⚠️ v2 — SIDE VIEW (supersedes the top-down parts below). Read RESEARCH-SIDEVIEW.md too.

Same gameplay & vibe as v1 (ice-skate turn-limited fish, eat smaller / flee bigger), but **seen from the side**:
- Gameplay plane = **XY, z = 0**. y up. **Water surface at y = 0**; deeper = more negative y. `WORLD` in config.js
  (x 0..4000, y down to -2200). Player spawns top-left in the Sunlit Shallows (`WORLD.spawn`).
- Heading: forward = `(cos h, sin h, 0)`. Fish models face +X, `rotation.z = heading`, and roll 180° about the
  nose (smoothly) when facing left so the belly stays down. Models are side profiles (tall body, vertical tail,
  dorsal on top, eye facing the camera).
- Camera: perspective at +z looking -z; distance = `cameraDistFor(size)`. `viewRadius` = half the visible
  WIDTH on the z=0 plane.
- Biomes are 2D REGIONS: `biomeIndexAt(x, y)`, smooth `biomeWeightsAt(x, y, out)` (there is no ring/blend index
  anymore; `biomeBlendAt`, `cameraHeightFor`, `rMin/rMax`, `seabedY` were removed). `B` = index constants.
  `depthMetersAt(x, y)`.
- **Terrain** (`src/terrain.js`, owned by the world agent; currently an analytic stub with the FINAL API):
  `createTerrain()` → `{ bounds, sdf(x,y) (>0 water, <0 rock, ~distance), normal(x,y,out{x,y}) (points into
  water), collide(e, radius=e.size) → bool (pushes e.pos out, removes into-wall velocity, sets e.wallHit,
  e.lastWallNx/Ny), raycast(x,y,dx,dy,maxDist) → dist|Infinity, isOpen(x,y,r), mapCanvas (HTMLCanvasElement
  minimap of the whole world: rock/water tinted by biome; null in stub) }`.
  main creates it and passes `terrain` into createWorld / createPlayer / createCameraRig / createEcosystem /
  createBosses. Everything that moves MUST collide with it. Above the surface (y > 0) is air: the player can
  breach (gravity, no steering, splash) — NPCs stay below y = -size.
- **Bosses** (`src/bosses.js`, new boss agent): `createBosses({scene, bus, terrain})` → `{list, reset(),
  update(dt, t, player, {active, viewRadius})}`. `BOSSES` table in config.js. Boss entities = `makeFish(key,…)`
  with `isBoss:true, hp, maxHp, vulnerable(bool), phase(string)`; drawn by fishRenderer (species keys
  `moray`, `octopus`, `greatwhite`, `anglerking`; `BOSSES[key].shape`). New bus events:
  `bossEngage {boss}`, `bossDisengage {}`, `bossHit {boss, pos}`, `bossDefeated {boss}`, `ink {pos, radius}`
  (octopus). Boss eating the player = normal `eat` event. main applies boss rewards.
- New state fields: `maxDepth` (m), `biomesSeen` [], `bossesDefeated` [], `boss` (engaged boss entity|null).
  `biome` event payload is now `{index, first}`. `ui.update(dt, state, player, eco, viewRadius, bosses)`.
- Player also emits `splash {pos, strength}` when crossing the surface.

---
# Abyss Drift — build contract

Browser game, Three.js r170 via importmap (`three`, `three/addons/...` from jsdelivr). No build step, no assets:
**every model, texture, sound is generated in code.** Plain ES modules in `src/`. Served by
`python3 -m http.server 8123` from this folder → http://localhost:8123.

## The game
Underwater eat-or-be-eaten (Feeding Frenzy / agar.io) with **WC3 ice-escape steering**: the fish always swims
forward; clicking (main input) or WASD only sets a *desired heading*, and the fish rotates toward it at a capped
turn rate (`playerTurn(size)`, slower as you grow). A 180° turn is an arc → dodging takes skill. Eat fish smaller
than you (`canEat`), avoid bigger ones. World is concentric biome rings around the origin; farther = deeper,
darker, bigger fish, more points. Reach tier "Leviathan" = victory (can continue). Expansive, beautiful, juicy.

## Fixed files (owned by lead — do NOT edit; ask in your final report if you need a change)
- `src/config.js` — CONFIG, TIERS, BIOMES, SPECIES + pure helpers (`biomeAt`, `biomeBlendAt`, `playerTurn`,
  `npcSpeed`, `canEat`, `turnToward`, `cameraHeightFor`, ...). Read it fully.
- `src/entities.js` — `makeFish()` = the single fish entity shape. `feed()`.
- `src/bus.js` — event bus. `src/main.js` — loop + game state. `index.html`.

## Conventions
- World: Y up. Gameplay on the XZ plane at y≈0 (fish `pos.y` is cosmetic bob only, keep within ±1.5·size... small).
  Seabed below at `BIOMES[i].seabedY`. Camera looks down from above, tilted (camera z = player z + h·tilt).
- Heading: forward = `(cos h, 0, sin h)`. Fish models face **+X** locally → `rotation.y = -heading`.
- Units: fish `size` = collision radius. Player starts at size 1, ends ~16+. Whales up to 32.
- Perf budget: 60fps on a laptop iGPU. ~200 fish + player. Use InstancedMesh / merged geometry, avoid per-frame
  allocations, no shadows. Keep each module small-ish and self-contained.
- Styling for DOM: fonts 'Fredoka' (display) and 'JetBrains Mono' (numbers) are loaded. UI root is `#ui`
  (pointer-events:none; enable on your interactive elements only).

## Module APIs (each agent owns exactly its files)
| file | export | called as |
|---|---|---|
| world.js | `createWorld({scene, renderer, camera})` → `{update(dt, t, playerPos, camera)}` | owns scene.background, scene.fog, all lights, seabed, props, ambient particles |
| fishRenderer.js | `createFishRenderer({scene})` → `{sync(list, t, player, {showRelation})}` | draws every fish entity in `list` (player included, `isPlayer:true`) each frame |
| player.js | `createPlayer({scene, camera, dom, bus})` → `{entity, reset(), update(dt, t, {active})}` | input + steering physics; `reset()` makes a fresh hero entity at origin |
| camera.js | `createCameraRig({camera, bus})` → `{viewRadius, update(dt, player, state)}` | follow cam; `viewRadius` = ground-plane radius that covers the screen |
| ecosystem.js | `createEcosystem({scene, bus})` → `{fish, threat, reset(), update(dt, t, player, {active, viewRadius})}` | NPC spawn/despawn/AI/eating |
| effects.js | `createEffects({renderer, scene, camera, bus})` → `{update(dt,t,player,state,eco), render(), setSize(w,h)}` | particles + post-processing; `render()` draws the frame |
| ui.js | `createUI({bus, camera, state})` → `{update(dt, state, player, eco, viewRadius)}` | all DOM: title, HUD, menus |
| audio.js | `createAudio({bus})` → `{update(dt, state, player, eco)}` | procedural WebAudio |

`state` (read-only for everyone except main): `{mode:'title'|'playing'|'dead'|'victory', paused, time, runTime,
score, eaten, tier, biome, maxDepthBiome, victoryShown, killer, best}`.
During `title` the player entity exists but is not drawn and `player.update` gets `active:false`;
the ecosystem still runs (`active:false` → ignore the player) so the title screen shows a living ocean.

## Bus events
| event | payload | emitted by |
|---|---|---|
| `start` | – | ui (Play button / Enter / Space on title), player may also emit on first click during title |
| `restart` | – | ui (after death) |
| `continue` | – | ui (victory screen "keep swimming") |
| `pause` | `bool?` (toggle if undefined) | main (Esc/P), ui (pause button) |
| `eat` | `{eater, eaten}` | ecosystem — for ANY eat incl. player eating NPC and NPC eating player. Ecosystem sets `alive=false` and removes eaten **NPCs**; never touches the player's alive/size (main does). |
| `playerAte` | `{eaten, gain, points, pos}` | main |
| `grow` | `{tier, name}` | main |
| `victory` / `playerDeath` `{killer}` | | main |
| `biome` | `{index}` | main (player crossed into a new biome) |
| `dash` | `{pos, heading}` | player |
| `click` | `{point: Vector3}` | player (ground-plane click target) |
| `shake` | `{amount}` 0..1.5 | anyone; camera consumes |
| `nearMiss` | `{fish}` | ecosystem (predator lunged and barely missed the player) |
| `spawnBurst` | `{pos, color, count}` | optional, anyone → effects particles |

Ecosystem also exposes `eco.threat` (0..1, how close/committed the nearest hunting predator is) — effects (vignette),
UI (warning) and audio (heartbeat) use it. Each NPC entity may set `f.ai.hunting = true` when chasing the player
(UI draws off-screen arrows for those).

## Verify your work
`node --check src/<file>.js` at minimum. The game runs at any time with the other modules as stubs / in-progress
versions, so you can load http://localhost:8123 (the server is already running) if you have a browser tool;
`window.__abyss` exposes `{scene, camera, state, player, eco, bus, ...}`. Don't edit files you don't own.
Final report: what you built, any API deviations, anything the lead must wire up.
