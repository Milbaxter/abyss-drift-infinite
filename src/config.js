// Shared tuning + data tables. Every module reads from here; keep it pure (no side effects).

export const CONFIG = {
  player: {
    startMass: 1,
    baseSpeed: 13,      // units/s at size 1
    speedExp: 0.28,     // speed = baseSpeed * size^speedExp
    baseTurn: 4.2,      // rad/s at size 1  (the "ice skating" cap)
    turnExp: 0.38,      // turn = baseTurn / size^turnExp
    drift: 5.5,         // how fast velocity catches up with heading (lower = more slide)
    dashSpeedMul: 2.4,
    dashTime: 0.35,
    dashCooldown: 2.2,
    invulnTime: 2.5,
  },
  eat: {
    margin: 1.12,       // eater.size must be > eaten.size * margin
    growth: 0.18,       // NPC mass gained = eaten.mass * growth (NPCs keep a fraction, see ecosystem)
    // PLAYER growth (playerMealValue): mass gain = eaten.mass * playerGrowth * relValue * zoneValue
    playerGrowth: 0.13,
    relMin: 0.18, relFull: 0.6,   // prey smaller than relMin x your size gives ~no growth; full value from relFull up
    growthSizeExp: 0.18,          // growth per meal slows as you get bigger
    metabolism: 0.0035,           // fraction of mass lost per second (idling shrinks you slowly; never below startMass)
    reach: 0.55,        // contact if dist < eater.size + eaten.size * reach
  },
  camera: { fov: 50, baseDist: 34, perSize: 9 },
  population: {
    max: 130,
    spawnInner: 1.15,   // spawn ring, multiples of viewRadius
    spawnOuter: 1.7,
    despawn: 2.6,
  },
  npc: { baseSpeed: 9, speedExp: 0.25, baseTurn: 3.4, turnExp: 0.35 },
};

// EVOLUTION tiers by player size. Each tier is a new player FORM (renderer: entity.form = tier).
// Reaching Apex shows the victory card; the run continues endlessly (keep growing, score keeps counting).
export const TIERS = [
  { name: 'Microbe',   size: 1,   form: 'cell'  },
  { name: 'Plankton',  size: 1.6, form: 'larva' },
  { name: 'Shrimp',    size: 2.6, form: 'shrimp'},
  { name: 'Minnow',    size: 4.2, form: 'fry'   },
  { name: 'Reef Fish', size: 6.6, form: 'fish'  },
  { name: 'Hunter',    size: 10,  form: 'hunter'},
  { name: 'Apex',      size: 14,  form: 'apex'  },
];

// ---------- INFINITE SIDE-VIEW SEA ----------
// Gameplay plane is XY (z = 0), y up. There is NO surface, floor or edge: open water in every direction.
// Mobs scale with the PLAYER (not with location). Regions (BIOMES) are only visual moods laid out by noise.
// Floating origin: main.js periodically shifts everything back toward (0,0) and emits bus 'rebase' {dx, dy}
// (subtract from any stored world positions). WORLD.origin accumulates the total shift so region lookups stay stable.
export const WORLD = {
  spawn: { x: 0, y: 0 },
  origin: { x: 0, y: 0 },   // total world offset applied by rebasing (absolute = local + origin)
  rebaseDist: 3000,
  regionCell: 1400,          // size of one visual region cell (world units)
};

// Visual REGIONS (moods) of the infinite sea, laid out as a seeded noise/cell field (see biomeIndexAt).
export const BIOMES = [
  { name: 'Sunlit Shallows', fog: 0x3fb6c9, top: 0x8eeaf2, light: 1.25, caustics: 1.0, glow: 0.0,  rock: 0xd9c49a, accent: 0x7fffd4 },
  { name: 'Coral Reef',      fog: 0x2793b5, top: 0x5fd0e6, light: 1.1,  caustics: 0.8, glow: 0.05, rock: 0xc98f7a, accent: 0xff6f91 },
  { name: 'Kelp Forest',     fog: 0x1a6e70, top: 0x3c9a84, light: 0.8,  caustics: 0.45,glow: 0.15, rock: 0x5f6b45, accent: 0x9be15d },
  { name: 'Midnight Waters', fog: 0x10213d, top: 0x1b3560, light: 0.35, caustics: 0.0, glow: 0.9,  rock: 0x3a3557, accent: 0x7af0ff },
  { name: 'Open Ocean',      fog: 0x1f6fb0, top: 0x4fb3e8, light: 1.0,  caustics: 0.5, glow: 0.05, rock: 0x4a5a6a, accent: 0x9fd8ff },
  { name: 'Twilight Zone',   fog: 0x0b2547, top: 0x123f6b, light: 0.45, caustics: 0.1, glow: 0.6,  rock: 0x2c3a55, accent: 0x6ec6ff },
  { name: 'The Abyss',       fog: 0x03060d, top: 0x071226, light: 0.18, caustics: 0.0, glow: 1.0,  rock: 0x15161f, accent: 0xb48cff },
];
export const B = { SHALLOWS: 0, REEF: 1, KELP: 2, CAVERNS: 3, OCEAN: 4, TWILIGHT: 5, ABYSS: 6 };


// Species. `shape` is a renderer hint; `behavior` drives AI.
//   behavior: 'school' | 'wander' | 'predator' | 'ambush' | 'drifter' | 'giant'
//   biomes: { biomeIndex: spawnWeight }
export const SPECIES = {
  // `tiers`: { playerTierIndex: weight } — which species appear around a player of that tier (anywhere in the sea).
  // Spawn size comes from the PLAYER's size (ecosystem), clamped to [sizeMin, sizeMax].
  microbe:   { shape: 'cell',   behavior: 'school',   sizeMin: 0.15, sizeMax: 1.0,  speedMul: 0.6, turnMul: 1.6,
               colors: [0x9dffb0, 0x7fe8ff, 0xffe27a], glow: 0.7, biomes: {}, tiers: { 0: 6, 1: 2 } },
  krill:     { shape: 'shrimp', behavior: 'school',   sizeMin: 0.2,  sizeMax: 1.6,  speedMul: 0.8, turnMul: 1.5,
               colors: [0xff9a8b, 0xffb3a7], glow: 0.3, biomes: {}, tiers: { 0: 3, 1: 4, 2: 3, 3: 1 } },
  lanternfish:{ shape: 'lantern', behavior: 'school', sizeMin: 0.35, sizeMax: 3.0,  speedMul: 1.0, turnMul: 1.3,
               colors: [0x3a4a6a, 0x2c3550], glow: 0.9, biomes: {}, tiers: { 1: 3, 2: 4, 3: 3 } },
  jelly:     { shape: 'jelly',  behavior: 'drifter',  sizeMin: 0.4,  sizeMax: 8.0,  speedMul: 0.25, turnMul: 0.6,
               colors: [0xff9be8, 0xa6c8ff, 0xc9a6ff], glow: 0.8, biomes: {}, tiers: { 0: 1, 1: 2, 2: 2, 3: 2, 5: 1 } },
  angler:    { shape: 'angler', behavior: 'ambush',   sizeMin: 0.8,  sizeMax: 9.0,  speedMul: 0.9, turnMul: 0.9,
               colors: [0x3b2f4a, 0x2a2238], glow: 1.0, biomes: {}, tiers: { 0: 1.5, 1: 2.5, 2: 2 } },
  squid:     { shape: 'squid',  behavior: 'predator', sizeMin: 1.5,  sizeMax: 12,   speedMul: 1.2, turnMul: 0.9,
               colors: [0xc0475a, 0xe0707a, 0x8a3fa0], glow: 0.5, biomes: {}, tiers: { 2: 2, 3: 3, 4: 1 } },
  sardine:   { shape: 'slim',   behavior: 'school',   sizeMin: 0.5,  sizeMax: 3.5,  speedMul: 1.1, turnMul: 1.3,
               colors: [0xc8e6f0, 0x9fc9dc, 0xdff3ff], glow: 0, biomes: {}, tiers: { 3: 2, 4: 4, 5: 4, 6: 2 } },
  clownfish: { shape: 'standard', behavior: 'wander', sizeMin: 1.5, sizeMax: 5,    speedMul: 0.9, turnMul: 1.1,
               colors: [0xff7b1c, 0xff5a00], glow: 0, biomes: {}, tiers: { 4: 3, 5: 1 } },
  tang:      { shape: 'disc',   behavior: 'wander',   sizeMin: 2,    sizeMax: 7,    speedMul: 0.95, turnMul: 1.0,
               colors: [0x2f6bff, 0xffd400, 0x24c4ff], glow: 0, biomes: {}, tiers: { 4: 3, 5: 3, 6: 1 } },
  puffer:    { shape: 'round',  behavior: 'wander',   sizeMin: 2.5,  sizeMax: 8,    speedMul: 0.7, turnMul: 0.9,
               colors: [0xe9c46a, 0xd4a373], glow: 0, biomes: {}, tiers: { 3: 1, 4: 2, 5: 1 } },
  barracuda: { shape: 'long',   behavior: 'predator', sizeMin: 3,    sizeMax: 16,   speedMul: 1.25, turnMul: 0.8,
               colors: [0x9aa8b5, 0x7d8b99], glow: 0, biomes: {}, tiers: { 3: 1, 4: 2.5, 5: 2, 6: 1 } },
  grouper:   { shape: 'standard', behavior: 'predator', sizeMin: 4, sizeMax: 16,   speedMul: 0.85, turnMul: 0.75,
               colors: [0x8d6e4f, 0x6b5a45, 0xa0805a], glow: 0, biomes: {}, tiers: { 3: 1.5, 4: 2.5, 5: 1 } },
  shark:     { shape: 'shark',  behavior: 'predator', sizeMin: 8,    sizeMax: 40,   speedMul: 1.15, turnMul: 0.6,
               colors: [0x6c7a89, 0x56606e], glow: 0, biomes: {}, tiers: { 4: 0.5, 5: 3, 6: 3 } },
  whale:     { shape: 'whale',  behavior: 'giant',    sizeMin: 18,   sizeMax: 50,   speedMul: 0.6, turnMul: 0.35,
               colors: [0x2b3d5c, 0x1f2d47], glow: 0.2, biomes: {}, tiers: { 5: 1, 6: 2 } },
  // The player. Not spawned by the ecosystem. Its look follows entity.form (TIERS[].form).
  hero:      { shape: 'hero',   behavior: 'player',   sizeMin: 1, sizeMax: 1, speedMul: 1, turnMul: 1,
               colors: [0x3ff5d0], glow: 0.4, biomes: {}, tiers: {} },
};

// ---------- pure helpers ----------
// Region field: the infinite sea is cut into ~regionCell-sized jittered cells; each cell gets a seeded mood.
// Absolute coords (local + WORLD.origin) so rebasing never changes the scenery.
function _h(ix, iy, k) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(k, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296;
}
const _REGION_POOL = [0, 0, 1, 1, 2, 2, 3, 4, 4, 4, 5, 5, 6];   // weighted: more open blue water than abyss
export function biomeIndexAt(x, y) {
  const C = WORLD.regionCell, ax = (x + WORLD.origin.x) / C, ay = (y + WORLD.origin.y) / C;
  const cx = Math.floor(ax), cy = Math.floor(ay);
  let best = 1e9, bi = 4;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const gx = cx + i, gy = cy + j;
    const px = gx + 0.15 + 0.7 * _h(gx, gy, 1), py = gy + 0.15 + 0.7 * _h(gx, gy, 2);
    const d = (px - ax) * (px - ax) + (py - ay) * (py - ay);
    if (d < best) { best = d; bi = _REGION_POOL[(_h(gx, gy, 3) * _REGION_POOL.length) | 0]; }
  }
  return bi;
}
export function biomeAt(x, y) { return BIOMES[biomeIndexAt(x, y)]; }
// Smooth per-biome weights (sum = 1) by sampling a 3x3 kernel (spacing 70u). `out` = array of BIOMES.length.
// Use for color/fog/light blending so region borders never pop. Cheap: call once per frame, not per fish.
export function biomeWeightsAt(x, y, out = new Array(BIOMES.length)) {
  out.fill(0);
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) out[biomeIndexAt(x + i * 90, y + j * 90)] += 1 / 25;
  return out;
}
// Distance shown in the HUD (meters), from the run's start. 1 unit ≈ 0.6 m.
export function metersFrom(x0, y0, x1, y1) { return Math.round(Math.hypot(x1 - x0, y1 - y0) * 0.6); }

export function tierIndexFor(size) {
  let t = 0;
  for (let i = 0; i < TIERS.length; i++) if (size >= TIERS[i].size) t = i;
  return t;
}
export function playerSpeed(size) { return CONFIG.player.baseSpeed * Math.pow(size, CONFIG.player.speedExp); }
export function playerTurn(size)  { return CONFIG.player.baseTurn / Math.pow(size, CONFIG.player.turnExp); }
export function npcSpeed(species, size) { return CONFIG.npc.baseSpeed * SPECIES[species].speedMul * Math.pow(size, CONFIG.npc.speedExp); }
export function npcTurn(species, size)  { return CONFIG.npc.baseTurn * SPECIES[species].turnMul / Math.pow(size, CONFIG.npc.turnExp); }
// Camera distance from the z=0 gameplay plane (camera sits at +z looking -z).
export function cameraDistFor(size) { return CONFIG.camera.baseDist + CONFIG.camera.perSize * size; }
// How much a meal is worth to the player (0..1). Tiny prey (relative to you) gives ~nothing.
// out.rel = prey-size factor, out.value = final factor. Growth also slows with size (playerGrowthAt).
export function playerMealValue(p, eaten, out = {}) {
  const E = CONFIG.eat;
  const ratio = eaten.size / p.size;
  const t = Math.min(1, Math.max(0, (ratio - E.relMin) / (E.relFull - E.relMin)));
  out.rel = t * t * (3 - 2 * t);
  out.zone = 1;
  out.value = out.rel;
  return out;
}
export function playerGrowthAt(size) { return CONFIG.eat.playerGrowth * Math.pow(size, -CONFIG.eat.growthSizeExp); }
export function canEat(eater, eaten) { return eater.size > eaten.size * CONFIG.eat.margin; }

export function wrapAngle(a) { a = (a + Math.PI) % (Math.PI * 2); if (a < 0) a += Math.PI * 2; return a - Math.PI; }
// Rotate `current` toward `target` by at most maxStep. Returns new angle.
export function turnToward(current, target, maxStep) {
  const d = wrapAngle(target - current);
  return current + Math.max(-maxStep, Math.min(maxStep, d));
}

// ---------- BOSSES ----------
// Bigger than the player when met → can't be swallowed. Telegraphed attack → vulnerable window → bite = 1 hp.
// `home` must be open water (terrain.js carves an arena around each home of radius `arena`).
// Defeat grants `reward` mass to the player (main applies it) + score.
export const BOSSES = {
  // Appear near the player (off-screen, ahead) when the player first reaches `tier`. `home` is unused now.
  anglerking: { name: 'Angler King',      mini: true,  tier: 2, shape: 'angler',  size: 3.5, hp: 5,  home: { x: 3300, y: -1990 }, arena: 180, reward: 6,   colors: [0x2b1f3a] },
  octopus:    { name: 'Giant Octopus',    mini: true,  tier: 3, shape: 'octopus', size: 7,   hp: 6,  home: { x: 3300, y: -1100 }, arena: 170, reward: 22,  colors: [0xc0443a] },
  moray:      { name: 'Moray Eel',        mini: true,  tier: 4, shape: 'eel',     size: 11,  hp: 7,  home: { x: 1572, y: -499 },  arena: 120, reward: 60,  colors: [0x5a7d2a] },
  greatwhite: { name: 'Great White',      mini: false, tier: 6, shape: 'shark',   size: 22,  hp: 10, home: { x: 3250, y: -160 },  arena: 0,   reward: 160, colors: [0x8a98a8] },
};
