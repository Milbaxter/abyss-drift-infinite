# Abyss Drift — INFINITE (v4). Supersedes CONTRACT.md progression/world parts. Project: ~/Desktop/abyss-drift-infinite

Served at http://localhost:8124 (python http.server). DO NOT touch ~/Desktop/abyss-drift (that's the archived ascent build).

## The game now
- **Infinite side-view sea.** Gameplay plane XY (z=0), y up. No surface, no floor, no edges — open water in every
  direction. Swim anywhere.
- **Mobs scale with the PLAYER, not the location.** Around a player of size P, spawns are ~55–60% prey
  (0.3–0.85·P), ~20% similar (0.85–1.2·P), ~20–25% dangerous (1.3–2.5·P). Which SPECIES appear depends on the
  player's tier: `SPECIES[*].tiers = {tierIndex: weight}` (microbes/krill around a Microbe … sharks/whales around a Hunter).
- **Enemies are predictable**: dangerous fish move in STRAIGHT LINES (fixed heading, constant speed, from off-screen
  across and out) or are STATIC (hover/bob in place). No wandering, no curving, no homing, no lunges at the player.
  Exception kept: the angler's ambush strike (static fish that strikes when you're right in front — players love it).
  Prey can still flee/school.
- **Growth**: `playerMealValue` (prey-size factor: tiny prey ≈ 0 growth) × `playerGrowthAt(size)` (slows with size)
  + metabolism (slow mass loss; idling shrinks you). 7 evolution forms (TIERS). Reaching Apex → `victory` card,
  then the run continues endlessly.
- **Bosses** appear near the player (off-screen, ahead) the first time the player reaches `BOSSES[k].tier`
  (Angler King t2, Octopus t3, Moray t4, Great White t6), sized ≥1.6× player; same telegraph→vulnerable fights.
- **Visual regions**: `BIOMES` are now moods laid out by a seeded jittered-cell field over the infinite plane
  (`biomeIndexAt`, `biomeWeightsAt` unchanged API; they use absolute coords incl. WORLD.origin). Swimming far changes
  colours/fog/light/backdrop/music. There is no depth: "light" is just a mood value.
- **Floating origin**: when the player gets > `WORLD.rebaseDist` from (0,0), main shifts player/eco.fish/bosses/
  camera.position by (-dx,-dy), adds to `WORLD.origin`, and emits **`rebase {dx, dy}`**. Any module storing world
  positions of its own (camera rig smoothing state, particles, chunks, markers, boss homes/targets, AI waypoints)
  MUST subtract (dx, dy) on that event.

## Removed (delete usages)
`ZONES`, `zoneIndexAt`, `zoneScaleAt`, `OCEAN_SCALE_MUL`, `depthMetersAt`, `WORLD.xMin/xMax/yMin/surface/shelfX`,
state `zone/maxZone/zonesSeen/zoneSaturated/maxDepth/maxDepthBiome`, bus `zone`, surface breach/splash/air physics,
terrain SDF world map (caves/seamount/vents as walls).

## Added
- config: `WORLD.{spawn:(0,0), origin, rebaseDist, regionCell}`, `metersFrom()`, `playerGrowthAt()`,
  `CONFIG.eat.{growthSizeExp, metabolism}`, `SPECIES[*].tiers`, `BOSSES[*].tier`.
- state: `distance` (m swum), `maxSize`, `mealValue`, `biomesSeen`.
- bus: `rebase {dx, dy}`. `biome {index, first}` still fires when entering a new region mood.

## Terrain API (terrain.js) — keep the same functions so callers don't break
`createTerrain()` → `{ sdf, normal, collide, raycast, isOpen, features, mapCanvas:null, bounds:null }` over an
INFINITE plane: open water everywhere except optional sparse landmark rocks (chunk-seeded, absolute coords).
`sdf` returns a large positive value in open water.
