# Handoff — Abyss Drift Infinite

## 1. Goal and latest instructions
A browser game in Three.js. Everything is generated in code: no asset files and no build step.

It's a side-view, endless sea game of eat or be eaten:
- **Steering** works like the Warcraft 3 "ice escape" maps. The fish always swims forward and can only turn at a capped rate. Click or hold to steer; WASD also steers.
- **Core loop:** eat smaller fish while dodging bigger ones.

**Latest user instructions (all implemented in commit `59820a7`):**
- Formations spawn fully off-screen and come aimed at you, so you can dodge them.
- More straight-line attackers ("aimed darters").
- Higher danger density.
- Remove anglers: every enemy is a straight-line fish.
- Audio is sound effects only, with silence underneath. No background hum, no music, no "pling", and no deep-sea sounds (whales, sonar).

**Acceptance criteria:**
- Constant flow: food is always available and dangerous fish keep coming.
- Every threat is predictable, and none home in on you.
- The game is readable: green outline = edible, red = danger.
- It's fair: nothing hits you within about 2 s of appearing.

## 2. Status
- **Repo:** https://github.com/Milbaxter/abyss-drift-infinite. Working tree is clean at `59820a7`.
- **Live:** https://abyss-drift-infinite.vercel.app (Vercel project `abyss-drift-infinite`, account milbaxter). The latest deploy shows Ready.
- **Archived earlier version** ("ascent": start at the vents, reach the surface): https://github.com/Milbaxter/abyss-drift-ascent, live at https://abyss-drift.vercel.app, local copy at `~/Desktop/abyss-drift`. Do not edit it.

**Verified in the browser at :8124 (no console errors):**
- the title screen and HUD
- the boss spawning at tier 2
- floating-origin rebase after teleporting the player to x≈3000: `WORLD.origin` shifts, the camera stays locked to the player, and the region mood changes
- a forced "lanes" wave: the warning banner and the wave both appeared
- at about 15 s into a run, danger in range was 7 and there were 0 anglers

**Verified by the agents' headless sims (not by playing):**
- danger averages 5–8 fish
- 8–13 darters per minute
- 0.75–1 waves per minute
- no hits within 2 s of a fish appearing on screen
- the AI and formation code costs about 0.3 ms per frame

**UNTESTED:**
- a full run from Microbe to Apex, and overall balance or difficulty
- boss fights against a human player
- mobile and touch
- performance on an integrated GPU
- the new sound effects by ear. Note that the mute flag saved in the :8124 browser's localStorage may currently be ON.

## 3. Unfinished or uncommitted work
Nothing is uncommitted. `CONTRACT.md` and `RESEARCH-SIDEVIEW.md` are stale design docs from older iterations; `INFINITE.md` is the current one. These docs are kept out of deploys by `.vercelignore`.

## 4. Architecture (`src/`)
- **`index.html`:** an importmap loads three@0.170.0 from jsdelivr, then `src/main.js`.
- **`main.js`:** the orchestrator. It owns the renderer, scene, camera, the shared `state` object and the frame loop. It also handles:
  - eat rewards (`playerMealValue` × `playerGrowthAt`)
  - metabolism
  - tier and evolve checks
  - victory when the player first reaches Apex, after which play continues endlessly
  - wave bonus and boss rewards
  - the floating-origin `rebase()`
  - the debug handle `window.__abyss`
- **`config.js`:** the single source of tuning. It holds `CONFIG`, `TIERS` (7 forms), `WORLD` (spawn, origin, rebaseDist, regionCell), `BIOMES` (visual moods placed by a jittered-cell field via `biomeIndexAt` and `biomeWeightsAt`), `SPECIES` (with `tiers` weights saying which tier each species appears around), `BOSSES` (with the `tier` that triggers each), plus helpers.
- **`entities.js`:** `makeFish()`, the single entity shape. Heading convention: forward = (cos h, sin h, 0).
- **`bus.js`:** the event bus. Events are listed in `INFINITE.md` and `CONTRACT.md`. The main ones: `eat`, `playerAte`, `grow`, `evolve`, `biome`, `rebase`, `waveWarn`, `waveStart`, `waveEnd`, `waveBonus`, `bossEngage`, `bossHit`, `bossDefeated`, `playerDeath`, `victory`, `dash`, `shake`, `nearMiss`.
- **Per-module roles:**

| File | Role | Tuning |
|---|---|---|
| `ecosystem.js` | Spawning sized relative to the player; prey AI; straight-line crossers and aimed darters; the danger-density director | `T` table |
| `formations.js` | Shmup-style waves (wall, lanes, chevron, rain, crossfire, pincer, ring), aimed, with reachable gaps; debug: `formations.debugStart(pattern, player, vr, state)` | `F` table |
| `bosses.js` | Tier-triggered bosses: telegraph, attack, vulnerable window; scaled to at least 1.6× the player | `T` table |
| `player.js` | Input, steering, dash, click markers | — |
| `camera.js` | Follow camera; `viewRadius` = half the visible width | — |
| `terrain.js` | Infinite open water plus sparse rounded landmark rocks (SDF API) | — |
| `world.js` | Region moods, parallax layers, marine snow, god rays | — |
| `fishRenderer.js` | Instanced procedural fish models; green/red outline code; the 7 hero forms | — |
| `effects.js` | Particles and post-processing | — |
| `ui.js` | All DOM: title, HUD, radar, wave warnings, boss UI, cards | — |
| `audio.js` | Sound effects only (WebAudio) | — |

## 5. Decisions that must survive
- **Infinite sea.** No surface, floor, walls or depth goal. Mobs scale with the player, not with location.
- **Dangerous fish only move in straight lines:** crossers, aimed darters and formation waves. No homing, no wandering, no lunges at the player, no static hazards, no anglers. Jellies and puffers are slow straight-line movers. NPCs never eat each other.
- **Fairness caps:**
  - attackers move at no more than 0.9× player speed
  - nothing reaches the player within 2–2.5 s of appearing
  - formation gaps must be reachable given the player's turn rate
- **Readability:** green outline = edible, red = danger (thicker when hunting), no outline for fish about your size. No other green or red glow, and minimal particles. Eat feedback (flakes, puff, bubbles) stays.
- **Growth:** prey under about 0.18× your size gives roughly no growth. Growth slows with size, and metabolism slowly shrinks you if you idle.
- **Audio:** sound effects only, with silence underneath. The eat sound is a visceral bite and crunch with no musical note.

**Superseded decisions:**
- top-down camera
- caves and tunnels
- start at the bottom and reach the surface; zones
- homing hunters or the "director hunter"
- telegraphed lunges with aim lines
- anglers and static hazards
- the world map and minimap
- music and ambient soundscape

## 6. Known issues and failed approaches
- **Seeker missiles** (homing chasers): rejected as unfun, because players couldn't eat while being chased.
- **Caves:** rejected as not fun.
- **Anglers:** they sat still, like sitting ducks.
- **`node --check` on `.js` files** can miss errors that only occur in ES modules, such as a duplicate `const`. Check a `.mjs` copy instead, or load the page in the browser.
- **Bloom smears NaN pixels into black rectangles.** It was caused by degenerate normals in the fish geometry; fixed in `fishRenderer.normalize()`. If black boxes come back, suspect NaN from a shader.
- **Hypothesis:** one unexplained case of a non-wave dangerous fish appearing on-screen at player size 10, reported by the sim agent. Not reproduced.
- **Possible issue:** bosses with sim deaths. The Octopus's sweep reliably killed a bot hugging it; the Great White is hard. Untested with a human player.

## 7. Commands
```bash
cd ~/Desktop/abyss-drift-infinite && python3 -m http.server 8124      # play at http://localhost:8124
for f in src/*.js; do cp "$f" /tmp/c.mjs && node --check /tmp/c.mjs || echo "FAIL $f"; done
vercel deploy --prod --yes                                            # deploy (logged in as milbaxter)
```
**Debug from the console:**
```js
__abyss.player.entity.invuln = 9999          // make the player invulnerable
__abyss.player.entity.mass = 4.2 ** 2;        // set mass for a size of 4.2 ...
__abyss.player.entity.size = 4.2              // ... and the size itself
__abyss.eco.danger                            // inspect the ecosystem director:
__abyss.eco.food                              //   also .phase and .fish
__abyss.formations.debugStart('ring', __abyss.player.entity, __abyss.camRig.viewRadius, __abyss.state)
```

## 8. Next action and remaining work
**Next:** play a full run on the live URL and collect the user's feel feedback on density, darters, waves and growth pace. Tune the `T` and `F` tables accordingly.

1. **Balance pass:** run length per tier (target about 2–3 min per tier), darter frequency, and the danger ramp.
2. **Boss fights:** playtest them, especially the Octopus sweep and the Great White.
3. **Visual pass:** coral silhouettes are crude; kelp silhouettes are dense.
4. **Mobile and touch** check, and an integrated-GPU performance check.
