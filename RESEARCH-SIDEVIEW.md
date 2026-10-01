# Side-view redesign — research notes

References: Feeding Frenzy 1/2 (side-view eat-to-grow, levels by depth), Ecco the Dolphin (side-view caves,
breaching), Hungry Shark Evolution (side-view open ocean, big predators, size-gated areas), Dave the Diver
(depth = danger), Spelunky / Noita (noise-carved 2D caves), Left 4 Dead "AI Director" (pacing tension vs relief).

## 1. Camera & space
- Gameplay plane = **XY at z=0**. y up, **water surface at y=0**, depth (m) = -y. Perspective camera on +Z looking -Z.
  Perspective (not ortho) gives free parallax for 3D background layers at z<0 and occluding foreground at z>0.
- Camera follows player with look-ahead in velocity direction; pulls back (z distance) as the player grows.
- Above the surface: sky. Breaching (y>0) → gravity, no steering, splash on re-entry (Ecco/Hungry Shark flourish).

## 2. Steering in the side view (unchanged rule, new plane)
- forward = (cos h, sin h, 0). Same capped turn rate → a reversal is a vertical **loop** or wide arc. Feels natural.
- Fish models must stay belly-down: when swimming left, roll 180° around the nose axis (smoothly, ~0.25s) —
  the classic 2D-fish flip. Models are modelled in **side profile** (tall body, vertical tail, dorsal on top,
  eye on the camera-facing side).
- Wall contact (ice-escape style): remove the into-wall velocity component, slide along the tangent, and
  rotate heading toward the tangent. Hitting walls costs speed, so cave navigation is a skill.

## 3. World generation: 2D density field → caves + open ocean
- World is a finite authored-procedural map (≈ 4000 wide × 2200 deep). A **2D signed distance field (SDF)** grid
  (≈ 4 units/cell, ~550k floats) is built once at load from layered rules:
  - Base terrain: seabed height h(x) per region + fBm noise (dunes, cliffs, a continental-shelf drop-off).
  - **Caverns**: carved by "Perlin worms" (random walks of circles with noise-driven direction) + thresholded
    domain-warped noise pockets inside the rock mass below the shelf. Worm radius varies → **narrow tunnels
    act as size gates** (big predators physically can't follow you in; once you're big you can't hide there either).
  - Overhangs, arches, floating rock islands in the open ocean column.
- Mesh the field with **marching squares** → outline polygons → extrude to a 3D rock slab (front face + walls,
  noise-displaced, vertex colored per biome). Chunked (e.g. 128-unit chunks) so only visible chunks render.
- Gameplay queries `sdf(x,y)` (bilinear) and `normal(x,y)` (gradient): collision for every fish, AI feelers
  for wall avoidance, spawn validity (only spawn where sdf > fish radius).

## 4. Biome map (regions, not rings)
```
 x→   0 ──────────── 1300 ─────────── 2500 ────────────────── 4000
 y=0  │ Sunlit Shallows  │ Coral Reef     │      OPEN OCEAN (no walls,
      │ (start, coves)   │                │       blue void, pelagic
 -300 ├──── Kelp Forest ─┴─── shelf drop ─┤       giants, bosses)
      │  CRYSTAL CAVERNS (tunnels, glow)  │
 -900 │  Sunken Ruins / Wreck caves       │      Twilight Zone
      ├───────────────────────────────────┤
-1600 │            THE ABYSS (trench, anglers, final boss)        │
```
Start: top-left shallows, small fish only. Growing pulls you right (open ocean) and down (abyss).

## 5. Flow state: danger ↔ reward pacing
- Flow = challenge ≈ skill. An **AI director** tracks intensity (recent threat, near misses, hunger time) and
  alternates build-up → peak → relief: spawns prey clouds in relief, sends a patrolling predator when calm too long.
- Spawn mix relative to player size (~55% edible / 25% similar / 20% dangerous), skewed per region.
- Telegraphing: danger rim glow, predator "notice" tell (pause + flare) before a chase, off-screen arrows,
  heartbeat audio. Predators give up after a few seconds → escape by out-turning.

## 6. Mini-bosses & bosses
Bigger than you → can't be swallowed. Pattern-based: telegraphed attack → **vulnerable window** (stunned after
ramming a wall / tired after a charge / lure exposed). Bite its **tail/back** during the window = damage (HP bar).
Defeat → big growth burst + score + the region's gate/next area opens up.
| boss | where | pattern |
|---|---|---|
| Moray Eel (mini) | Kelp/caves | lurks in a hole, lunges out along a line; vulnerable while retracting |
| Giant Octopus (mini) | Crystal Caverns | ink cloud (screen darkens), tentacle sweeps; vulnerable after ink |
| Great White (boss) | Open Ocean | circles, then long straight charges; rams walls/islands → stunned |
| Abyssal Angler King (final) | Abyss | darkness + fake lures; strike from dark; vulnerable after a miss |

## 7. Rendering the side view
- Background: vertical gradient by depth (bright surface → black abyss), god rays slanting from the surface,
  far parallax silhouettes (rock spires, kelp, whale shadows) at z = -80…-400, marine snow particles.
- Rock: lit + rim light + caustics on up-facing surfaces near the surface; caves dark with bioluminescent
  crystals; a soft light follows the player in dark areas.
- Foreground: occasional blurry kelp/rocks at z>0 crossing the camera for depth.
