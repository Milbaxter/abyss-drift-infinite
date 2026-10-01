// Ecosystem (INFINITE SIDE-VIEW SEA): NPC spawning / despawning, AI, eating, density director.
//
// Plane XY, y up, open water in every direction (no surface/floor). forward = (cos h, sin h, 0).
// Mobs scale with the PLAYER (size P, tier = tierIndexFor(P)), anywhere:
//   ambient spawns: prey 0.3–0.85·P (~72%) and similar 0.85–1.1·P (~28%) — never dangerous;
//   the DIRECTOR adds the dangerous ones (1.3–2.5·P) so their density is controlled: overall ≈ 55–60 / 20 / 20–25.
//   Species: SPECIES[*].tiers[tier] weights, preferring species whose [sizeMin,sizeMax] fits, then clamped.
// DANGEROUS FISH ARE 100% PREDICTABLE:
//   LINE   — fixed heading chosen at spawn (crossing 0.2–0.8·viewRadius from the player's path), constant speed,
//            no wander / curve / turning toward anything, until off-screen (only rare landmark rocks push them).
//   STATIC — hover in place with a tiny bob: anglers, jellies, puffers. The angler keeps its ambush strike.
//   No lunges. NPCs NEVER eat each other: the only eats are player→NPC and NPC/boss→player (mouth contact).
//   The angler's strike only targets the player.
//   Prey (smaller than the player) flee / school naturally.
// Director: ~2–4 dangerous crossers within 1.5·vr (+ incoming), ~1 static hazard nearby, ~8 meaningful prey
//   (≥ 0.3·P) biased ahead. Adaptive easing after ≥2 near misses in 10 s; 5 s breathers on evolve / bossDefeated;
//   no crossings during boss fights; ~10 s safe start. eco.threat / eco.intensity / eco.phase ('flow'|'breather').
// Floating origin: main shifts fish.pos on 'rebase' {dx,dy}; we shift stored homes. Bosses (opts.bosses): fled
//   from, never eaten. Puffer twist: puffed puffers can only be eaten by fish ≥ 1.4× their size.
import { CONFIG, SPECIES, tierIndexFor, npcSpeed, npcTurn, playerSpeed, canEat, turnToward, wrapAngle } from './config.js';
import { makeFish } from './entities.js';

// ---------- tuning knobs ----------
const T = {
  sightBase: 6, sightPerSize: 4, sightMax: 40,
  maxNeighbors: 18,         // in-range neighbours processed per fish (big fish first)
  fleeBoost: 1.45,
  // spawn mix around the player (sizes × P)
  prey: [0.3, 0.85], similar: [0.85, 1.1], danger: [1.3, 2.5],
  ambientSimilar: 0.28,     // share of ambient spawns that are similar-sized (rest prey)
  spawnAhead: 0.6,          // share of spawns biased ahead of the player's heading
  spawnPerFrame: 6,
  schoolSize: [8, 22], schoolWeight: 0.4, schoolShareMax: 0.45,
  staticSpecies: { angler: true, jelly: true, puffer: true },
  bobAmp: 0.18, bobRate: 0.9,
  // angler ambush strike (unchanged)
  ambushStrikeMul: 2.2, ambushStrikeTime: 0.45, ambushCd: 3.0,
  // eating / NPC growth
  frontDot: -0.2, giantMouthDot: 0.45,   // mouth checks vs the player
  // fairness vs the player
  fairSpeed: 0.9, fairLungeSpeed: 1.4, fairTurn: 0.75,
  // terrain (rare landmark rocks): only probe when near rock
  wallClear: 1.6, wallWeight: 8, feelerAngle: 0.61, rockNear: 30,
  // director
  safeStart: 10,
  dangerRadius: 1.5, dangerIncoming: 2.2,
  dangerTarget: [2, 4], dangerReroll: 6, crossCd: [1.0, 2.0],
  crossDist: [1.3, 1.7], crossOffset: [0.2, 0.8], crossLead: [0.4, 1.6],
  staticWanted: 1, staticRing: [1.1, 1.45], staticCd: 3,
  nearMissPad: 1.2,         // a dangerous fish passing within pad + 0.3·size (surface gap) = near miss
  easyCalls: 2, easyWindow: 10, easyTime: 8, easyTarget: [1, 2],
  calmDanger: 12,
  breather: 5, breatherTarget: 1,
  foodTarget: 8, foodRadius: 1.2, foodMinRel: 0.3, foodSize: [0.35, 0.8],
  foodRing: [1.05, 1.35], foodAhead: 0.7, foodPerFrame: 2, popOverflow: 1.2,
  intensityDecay: 0.15,
};
const PUFF_PROTECT = 1.4;
const MAXF = 1024;
const M_FREE = 0, M_LINE = 1, M_STATIC = 2;

// ---------- spatial hash (rebuilt every frame → nothing to rebase) ----------
const CELL = 16, TSIZE = 1 << 10, TMASK = TSIZE - 1;
const cellStart = new Int32Array(TSIZE + 1);
const cellFill = new Int32Array(TSIZE);
const cellItems = new Int32Array(MAXF);
const fishCell = new Int32Array(MAXF);
const mark = new Int32Array(MAXF);
const nbr = new Int32Array(MAXF);
const bigList = new Int32Array(MAXF);
const hcos = new Float32Array(MAXF), hsin = new Float32Array(MAXF);
let queryId = 1;
const hashCell = (ix, iy) => (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663)) & TMASK;

const SPECIES_KEYS = Object.keys(SPECIES).filter((k) => SPECIES[k].behavior !== 'player');
const rand = (a, b) => a + Math.random() * (b - a);
const lrand = (a, b) => Math.exp(rand(Math.log(a), Math.log(b)));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function canEatNow(eater, eaten) {
  if (eaten.isBoss || eater.isBoss) return false;
  if (!canEat(eater, eaten)) return false;
  if (eaten.puff > 0.5 && eater.size < eaten.size * PUFF_PROTECT) return false;
  return true;
}

// fallback terrain: open water everywhere
const OPEN_TERRAIN = {
  sdf: () => 1e6, normal: (x, y, o) => { o.x = 0; o.y = 1; return o; },
  collide: () => false, raycast: () => Infinity, isOpen: () => true,
};

export function createEcosystem({ scene, bus, terrain }) {
  const ter = terrain || OPEN_TERRAIN;
  const fish = [];
  let needFill = true;
  let schooled = 0, nextSchool = 1, frameNo = 0;
  const candW = new Float32Array(SPECIES_KEYS.length);
  const nrm = { x: 0, y: 0 };
  const pickOut = { species: '', size: 1 };
  const pt = { x: 0, y: 0 };
  const NO_BOSSES = [];

  // director state
  let runClock = 0, crossCd = 0, staticCd = 0, rerollT = 0, dangerTarget = 3;
  let breatherT = 0, bossActive = false, easyUntil = -1, lastDanger = 0;
  const dangerT = [-99, -99, -99, -99]; let dangerI = 0;
  const noteDanger = () => { dangerT[dangerI] = runClock; dangerI = (dangerI + 1) & 3; };

  let crossersPaused = false;
  const api = { fish, threat: 0, intensity: 0, phase: 'flow', danger: 0, statics: 0, food: 0, nearMisses: 0, reset, update,
    spawnLiner, pauseCrossers, clearStatics, breather: (sec) => { breatherT = Math.max(breatherT, sec || T.breather); }, pickSpecies: pickFormationSpecies };

  const breather = () => { breatherT = Math.max(breatherT, T.breather); };
  bus.on('evolve', breather);
  bus.on('bossDefeated', () => { bossActive = false; breather(); });
  bus.on('bossEngage', () => { bossActive = true; });
  bus.on('bossDisengage', () => { bossActive = false; });
  // floating origin: main shifts f.pos; we shift the world positions we store ourselves
  bus.on('rebase', (r) => {
    if (!r) return;
    const dx = r.dx || 0, dy = r.dy || 0;
    for (let i = 0; i < fish.length; i++) { const ai = fish[i].ai; ai.homeX -= dx; ai.homeY -= dy; }
  });

  function reset() {
    for (const f of fish) f.alive = false;
    fish.length = 0;
    schooled = 0; needFill = true;
    runClock = 0; crossCd = 0; staticCd = 0; rerollT = 0; dangerTarget = 3;
    breatherT = 0; bossActive = false; easyUntil = -1; lastDanger = 0; dangerT.fill(-99);
    crossersPaused = false;
    Object.assign(api, { threat: 0, intensity: 0, phase: 'flow', danger: 0, statics: 0, food: 0, nearMisses: 0 });
  }

  // ---------- species / size selection ----------
  // Pick a species for `size` around a player of tier `tier`. filter: 0 any, 1 line-movers (predator/giant first),
  // 2 static species only, 3 non-static. Prefers species whose size range contains `size`; clamps.
  function pickSpecies(tier, size, filter, out) {
    let total = 0, fit = 0;
    const shareMax = CONFIG.population.max * T.schoolShareMax;
    for (let i = 0; i < SPECIES_KEYS.length; i++) {
      const key = SPECIES_KEYS[i], sp = SPECIES[key];
      const tw = sp.tiers || {};
      let w = tw[tier] || 0;
      if (filter === 1 || filter === 2) w += 0.5 * (tw[tier + 1] || 0) + 0.25 * (tw[tier + 2] || 0);   // hazards: bigger casts too
      else if (!w) w = 0.15 * ((tw[tier - 1] || 0) + (tw[tier + 1] || 0));   // weak fallback so every tier has a cast
      const isStatic = !!T.staticSpecies[key];
      if (filter === 2 && !isStatic) w = 0;
      if (filter === 3 && isStatic) w *= 0.5;
      if (filter === 1) { if (isStatic) w = 0; else if (sp.behavior === 'predator' || sp.behavior === 'giant') w *= 4; }
      if (w > 0 && sp.behavior === 'school' && filter === 3) w = schooled > shareMax ? 0 : w * T.schoolWeight;
      candW[i] = w; total += w;
      if (w > 0 && size >= sp.sizeMin && size <= sp.sizeMax) fit += w;
    }
    if (total <= 0) return false;
    if (fit > 0) {
      for (let i = 0; i < SPECIES_KEYS.length; i++) {
        const sp = SPECIES[SPECIES_KEYS[i]];
        if (!(size >= sp.sizeMin && size <= sp.sizeMax)) candW[i] = 0;
      }
      total = fit;
    }
    let pick = Math.random() * total, k = 0;
    for (; k < SPECIES_KEYS.length - 1; k++) { pick -= candW[k]; if (pick <= 0 && candW[k] > 0) break; }
    while (candW[k] === 0 && k > 0) k--;
    const sp = SPECIES[SPECIES_KEYS[k]];
    out.species = SPECIES_KEYS[k];
    out.size = clamp(size, sp.sizeMin, sp.sizeMax);
    return true;
  }

  // All ai fields initialised in a fixed order (stable hidden classes).
  function initFish(f, mode) {
    const ai = f.ai;
    ai.behavior = SPECIES[f.species].behavior;
    ai.mode = mode;
    ai.wanderA = f.heading;
    ai.seed = Math.random() * 100;
    ai.speedJitter = rand(0.9, 1.1);
    ai.schoolId = 0;
    ai.alarm = 0; ai.fleeX = 0; ai.fleeY = 0;
    ai.hunting = false;
    ai.lineA = f.heading;
    ai.homeX = f.pos.x; ai.homeY = f.pos.y;
    ai.lunge = 0; ai.lungeMin = 1e9; ai.lungeAtPlayer = false; ai.lungeDirX = 0; ai.lungeDirY = 0; ai.notice = 0;
    ai.strike = 0; ai.strikeCd = rand(0, 1);
    ai.passMin = 1e9; ai.passDone = false;
    ai.spawnSize = f.size;
    ai.spd = 0; ai.turn = 0; ai.sight = 0;
    ai.cSepX = 0; ai.cSepY = 0; ai.cAliX = 0; ai.cAliY = 0; ai.cCohX = 0; ai.cCohY = 0; ai.cMates = 0;
    ai.cThrX = 0; ai.cThrY = 0; ai.cThreat = 1e9; ai.cPrey = null; ai.cPreyDist = 0; ai.cAlarm = 0; ai.cAlarmX = 0; ai.cAlarmY = 0;
    ai.speed = 0;
    ai.formation = 0; ai.fixedSpeed = 0; ai.despawnMul = 1;
    refreshStats(f);
    f.invuln = 0;
    f.lastWallNx = 0; f.lastWallNy = 0;
  }
  function refreshStats(f) {
    const ai = f.ai, b = ai.behavior;
    ai.spd = npcSpeed(f.species, f.size);
    ai.turn = npcTurn(f.species, f.size);
    ai.sight = ai.mode !== M_FREE ? Math.min(T.sightMax, 4 + f.size * 2)           // line/static: only mouth checks
      : b === 'school' ? Math.min(25, 4 + f.size * 3)
      : b === 'drifter' ? 2 + f.size * 1.2
      : Math.min(T.sightMax, T.sightBase + f.size * T.sightPerSize);
  }
  function newFish(key, size, x, y, heading, mode) {
    const f = makeFish(key, size, x, y, heading);
    initFish(f, mode);
    fish.push(f);
    return f;
  }
  const modeFor = (key, dangerous) => T.staticSpecies[key] ? M_STATIC : dangerous ? M_LINE : M_FREE;

  // Ambient (non-dangerous) spawn at x,y around player size P. Returns count.
  function spawnAmbient(x, y, P, tier, sizeOverride = 0) {
    if (fish.length >= MAXF - 30) return 0;
    const R = Math.random() < T.ambientSimilar && !sizeOverride ? T.similar : T.prey;
    const want = sizeOverride || P * lrand(R[0], R[1]);
    if (!pickSpecies(tier, want, 3, pickOut)) return 0;
    const key = pickOut.species, sp = SPECIES[key];
    let size = pickOut.size;
    if (size > P * 1.1) return 0;                       // clamping made it dangerous: skip (danger is director-only)
    if (!ter.isOpen(x, y, size * 2)) return 0;
    const heading = Math.random() * Math.PI * 2;
    if (sp.behavior === 'school') {
      const n = rand(T.schoolSize[0], T.schoolSize[1] + 1) | 0;
      const id = nextSchool++, rad = size * 6 + 3;
      let c = 0;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * rad;
        const s = Math.min(clamp(size * rand(0.85, 1.15), sp.sizeMin, sp.sizeMax), P * 1.1);
        const f = newFish(key, s, x + Math.cos(a) * d, y + Math.sin(a) * d, heading + rand(-0.3, 0.3), M_FREE);
        f.ai.schoolId = id; c++;
      }
      schooled += c;
      return c;
    }
    newFish(key, size, x, y, heading, modeFor(key, false));
    return 1;
  }

  function ringPoint(cx, cy, r0, r1, r, biasA, biasP, spread = 1.3) {
    for (let k = 0; k < 6; k++) {
      const a = biasP > 0 && Math.random() < biasP ? biasA + rand(-spread, spread) : Math.random() * Math.PI * 2;
      const d = rand(r0, r1);
      const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
      if (ter.isOpen(x, y, r)) { pt.x = x; pt.y = y; return true; }
    }
    return false;
  }

  function fill(cx, cy, P, tier, vr, active) {
    const rMax = CONFIG.population.despawn * vr * 0.95, rMin = vr * (active ? 0.3 : 0.1);
    let guard = 0;
    while (fish.length < CONFIG.population.max && guard++ < 3000) {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(rand((rMin / rMax) ** 2, 1)) * rMax;
      spawnAmbient(cx + Math.cos(a) * d, cy + Math.sin(a) * d, P, tier);
    }
    if (!active) {   // title screen: a few predictable hazards for a living scene
      for (let k = 0; k < 4; k++) spawnCrossing(cx, cy, 0, 0, P, tier, vr, false);
    }
  }

  // ---------- per-frame update ----------
  function update(dt, t, player, opts = {}) {
    const active = !!opts.active;
    const vr = opts.viewRadius || 30;
    const bosses = opts.bosses || NO_BOSSES;
    const P = CONFIG.population;
    const cx = player.pos.x, cy = player.pos.y;
    const ps = active ? player.size : 1;
    const tier = tierIndexFor(ps);
    if (needFill) { needFill = false; fill(cx, cy, ps, tier, vr, active); }
    if (!(dt > 0)) return;
    if (active) runClock += dt;
    frameNo++;
    breatherT = Math.max(0, breatherT - dt);
    const playerOn = active && player.alive;
    const playerPrey = playerOn && player.invuln <= 0;
    const strikeOK = playerPrey && runClock > T.safeStart && breatherT <= 0 && !bossActive;
    const reach = CONFIG.eat.reach;
    const pSpeed = playerSpeed(ps);
    let nearMissNow = 0;

    // --- spatial hash + census ---
    const n = fish.length;
    const BIG = Math.max(6, ps * 2.2);
    let nBig = 0, danger = 0, statics = 0, food = 0;
    schooled = 0;
    cellStart.fill(0);
    const dR2 = (T.dangerRadius * vr) ** 2, inR2 = (T.dangerIncoming * vr) ** 2, foodR2 = (T.foodRadius * vr) ** 2;
    const fMin = ps * T.foodMinRel;
    for (let i = 0; i < n; i++) {
      const f = fish[i], ai = f.ai;
      if (ai.schoolId) schooled++;
      if (active) {
        const ex = f.pos.x - cx, ey = f.pos.y - cy, e2 = ex * ex + ey * ey;
        if (canEat(f, player)) {
          if (ai.mode === M_STATIC) { if (e2 < dR2) statics++; }
          else if (e2 < dR2) { danger++; lastDanger = runClock; }
          else if (e2 < inR2 && f.vel.x * ex + f.vel.y * ey < 0) danger++;   // incoming
        } else if (f.size >= fMin && e2 < foodR2 && canEat(player, f)) food++;
      }
      const h = hashCell(Math.floor(f.pos.x / CELL), Math.floor(f.pos.y / CELL));
      fishCell[i] = h; cellStart[h + 1]++;
      hcos[i] = Math.cos(f.heading); hsin[i] = Math.sin(f.heading);
      if (f.size > BIG) bigList[nBig++] = i;
    }
    for (let h = 0; h < TSIZE; h++) { cellStart[h + 1] += cellStart[h]; cellFill[h] = cellStart[h]; }
    for (let i = 0; i < n; i++) cellItems[cellFill[fishCell[i]]++] = i;
    api.danger = danger; api.statics = statics; api.food = food;

    const despawnR2 = (P.despawn * vr) ** 2;
    let threatRaw = 0;

    // --- AI + eating ---
    for (let i = 0; i < n; i++) {
      const f = fish[i];
      if (!f.alive) continue;
      const ai = f.ai;
      const fx = f.pos.x, fy = f.pos.y;
      const cosH = hcos[i], sinH = hsin[i];
      const sight = ai.sight, beh = ai.behavior, mode = ai.mode;
      f.age += dt;
      ai.strikeCd -= dt;
      if (f.gulp > 0) f.gulp = Math.max(0, f.gulp - dt * 2.5);
      if (f.wallHit > 0) f.wallHit = Math.max(0, f.wallHit - dt * 3);

      let sepX = 0, sepY = 0, aliX = 0, aliY = 0, cohX = 0, cohY = 0, mates = 0;
      let thrX = 0, thrY = 0, threatNear = 1e9;
      let prey = null, preyScore = 0, preyDist = 0;
      let ate = false;
      let schoolAlarm = 0, schoolFX = 0, schoolFY = 0;
      const isAngler = beh === 'ambush';

      // perception staggered: rescan every other frame (line fish only need mouth checks → every frame is cheap)
      const scan = mode !== M_LINE && (((i + frameNo) & 1) === 0 || f.age < 0.05);
      if (scan) {
        if (++queryId > 0x3fffffff) { mark.fill(0); queryId = 1; }
        mark[i] = queryId;
        let n0 = 0;
        for (let b = 0; b < nBig; b++) { const j = bigList[b]; if (j !== i) { mark[j] = queryId; nbr[n0++] = j; } }
        n0 = gather(fx, fy, sight + BIG + f.size, n0);
        let inRange = 0;
        for (let k = 0; k < n0; k++) {
          const o = fish[nbr[k]];
          if (!o.alive) continue;
          const dx = o.pos.x - fx, dy = o.pos.y - fy;
          const d2 = dx * dx + dy * dy;
          const lim = sight + o.size + f.size;
          if (d2 > lim * lim) continue;
          if (++inRange > T.maxNeighbors) break;
          const d = Math.sqrt(d2) + 1e-6;
          const surf = d - o.size - f.size;
          const ux = dx / d, uy = dy / d;
          // NPCs never eat each other (only the player eats NPCs / NPCs eat the player)
          if (o.size > f.size * 0.3) {
            const sr = (f.size + o.size) * 1.25 + 0.4;
            if (d < sr) { const w = (1 - d / sr) / d; sepX -= dx * w; sepY -= dy * w; }
          }
          if (ai.schoolId && o.ai.schoolId === ai.schoolId) {
            aliX += hcos[nbr[k]]; aliY += hsin[nbr[k]];
            cohX += dx; cohY += dy; mates++;
            if (o.ai.alarm > schoolAlarm) { schoolAlarm = o.ai.alarm; schoolFX = o.ai.fleeX; schoolFY = o.ai.fleeY; }
          }
          if (mode === M_FREE && beh !== 'drifter' && canEat(o, f)) {
            const w = 1 - clamp(surf / sight, 0, 1);
            if (w > 0) { thrX -= ux * w; thrY -= uy * w; if (surf < threatNear) threatNear = surf; }
          }
        }
        {
          for (let k = 0; k < bosses.length; k++) {   // bosses: smaller free fish flee
            const bo = bosses[k];
            if (mode !== M_FREE || !bo || !bo.alive || bo.size < f.size * 1.05) continue;
            const dx = bo.pos.x - fx, dy = bo.pos.y - fy;
            const d = Math.sqrt(dx * dx + dy * dy) + 1e-6;
            const surf = d - bo.size - f.size, range = sight * 1.4 + bo.size;
            if (surf < range) {
              const w = (1 - clamp(surf / range, 0, 1)) * 1.5;
              thrX -= (dx / d) * w; thrY -= (dy / d) * w;
              if (surf < threatNear) threatNear = surf;
            }
          }
          ai.cSepX = sepX; ai.cSepY = sepY; ai.cAliX = aliX; ai.cAliY = aliY; ai.cCohX = cohX; ai.cCohY = cohY; ai.cMates = mates;
          ai.cThrX = thrX; ai.cThrY = thrY; ai.cThreat = threatNear; ai.cPrey = prey; ai.cPreyDist = preyDist;
          ai.cAlarm = schoolAlarm; ai.cAlarmX = schoolFX; ai.cAlarmY = schoolFY;
        }
      } else {
        sepX = ai.cSepX; sepY = ai.cSepY; aliX = ai.cAliX; aliY = ai.cAliY; cohX = ai.cCohX; cohY = ai.cCohY; mates = ai.cMates;
        thrX = ai.cThrX; thrY = ai.cThrY; threatNear = ai.cThreat; prey = ai.cPrey; preyDist = ai.cPreyDist;
        if (prey && !prey.alive) prey = null;
        schoolAlarm = ai.cAlarm; schoolFX = ai.cAlarmX; schoolFY = ai.cAlarmY;
      }

      // player relations
      let pdx = 0, pdy = 0, pd = 1e9, pSurf = 1e9, pFwd = -1;
      const dangerToPlayer = playerOn && canEat(f, player);
      if (playerOn) {
        pdx = player.pos.x - fx; pdy = player.pos.y - fy;
        pd = Math.sqrt(pdx * pdx + pdy * pdy) + 1e-6;
        pSurf = pd - player.size - f.size;
        pFwd = (cosH * pdx + sinH * pdy) / pd;
        if (canEatNow(player, f) && pd < player.size + f.size * reach) {   // player eats (any contact)
          bus.emit('eat', { eater: player, eaten: f });
          f.alive = false;
          continue;
        }
        if (playerPrey && !ate && dangerToPlayer && player.alive) {      // mouth contact eats the player
          const ok = beh === 'giant'
            ? pFwd > T.giantMouthDot && pd < f.size * 1.3 + player.size * reach
            : pFwd > T.frontDot && pd < f.size + player.size * reach;
          if (ok) { ai.lungeAtPlayer = false; bus.emit('eat', { eater: f, eaten: player }); f.gulp = 1; ate = true; }
        }
        if (mode === M_FREE && pSurf < sight && beh !== 'drifter' && canEat(player, f)) {
          const w = 1 - clamp(pSurf / sight, 0, 1);
          thrX -= (pdx / pd) * w * 1.3; thrY -= (pdy / pd) * w * 1.3;
          if (pSurf < threatNear) threatNear = pSurf;
        }
        // near miss: a dangerous moving fish passed very close (once per fish)
        if (dangerToPlayer && mode === M_LINE && !ai.passDone) {
          if (pSurf < ai.passMin) ai.passMin = pSurf;
          else if (ai.passMin < T.nearMissPad + f.size * 0.3 && pSurf > ai.passMin + f.size * 0.5 + 1 && player.alive) {
            ai.passDone = true; bus.emit('nearMiss', { fish: f }); nearMissNow = 1; noteDanger(); api.nearMisses++;
          }
        }
        // angler may strike the player (gated by breathers / boss / safe start)
        if (isAngler && strikeOK && dangerToPlayer && canEatNow(f, player) && pSurf < sight && (!prey || pSurf < preyDist)) { prey = player; preyDist = pSurf; }
      }
      if (isAngler && ai.strike > 0 && ai.lungeAtPlayer) { prey = player; preyDist = pSurf; }

      if (f.species === 'puffer') {
        const want = threatNear < sight * 0.55 || (playerOn && pSurf < f.size * 3) ? 1 : 0;
        f.puff += (want - f.puff) * (1 - Math.exp(-(want ? 7 : 1.5) * dt));
      }

      // --- movement by mode ---
      const prevH = f.heading;
      let spd = 0, fleeing = false;
      if (mode === M_LINE) {
        // fixed heading, constant speed; only rare rocks deflect (and the line resumes after)
        spd = ai.fixedSpeed > 0 ? ai.fixedSpeed : ai.spd * ai.speedJitter;
        if (dangerToPlayer) spd = Math.min(spd, pSpeed * T.fairSpeed);
        let hd = ai.lineA;
        const s0 = ter.sdf(fx, fy);
        if (s0 < T.rockNear + f.size * 3) {
          const look = f.size * T.wallClear + spd * 0.6 + 2;
          const sC = ter.sdf(fx + cosH * look, fy + sinH * look);
          if (sC < f.size * 2.5 + 2) {
            ter.normal(fx + cosH * look, fy + sinH * look, nrm);
            const tx = -nrm.y, ty = nrm.x, sg = tx * Math.cos(ai.lineA) + ty * Math.sin(ai.lineA) >= 0 ? 1 : -1;
            hd = Math.atan2(ty * sg + nrm.y * 0.5, tx * sg + nrm.x * 0.5);
          }
          f.heading = wrapAngle(turnToward(f.heading, hd, ai.turn * dt));
        } else f.heading = ai.lineA;
      } else if (mode === M_STATIC) {
        // hover at home with a tiny bob; anglers keep their ambush strike
        let hx = ai.homeX, hy = ai.homeY + Math.sin(t * T.bobRate + ai.seed) * T.bobAmp * f.size;
        if (isAngler) {
          if (prey && ai.strike <= 0) {
            const tx = prey.pos.x - fx, ty = prey.pos.y - fy, td = Math.hypot(tx, ty) + 1e-6;
            let tr = ai.turn * 0.6; if (prey === player) tr = Math.min(tr, playerTurnCap(player));
            f.heading = wrapAngle(turnToward(f.heading, Math.atan2(ty, tx), tr * dt));
            const fwd = (cosH * tx + sinH * ty) / td;
            if (ai.strikeCd <= 0 && preyDist < f.size * 2.2 + 4 && fwd > 0.55) {
              ai.strike = T.ambushStrikeTime; ai.strikeCd = T.ambushCd;
              ai.lungeAtPlayer = prey === player; ai.lungeMin = 1e9;
              ai.lungeDirX = cosH; ai.lungeDirY = sinH;
            }
            if (ai.lungeAtPlayer && preyDist < ai.lungeMin) ai.lungeMin = preyDist;
          }
          ai.notice = ai.strike > 0 && ai.lungeAtPlayer ? 1 : Math.max(0, ai.notice - dt * 2);
          if (ai.strike > 0) {
            spd = ai.spd * (0.3 + T.ambushStrikeMul * (ai.strike / T.ambushStrikeTime));
            if (playerOn && pSurf < sight * 1.5) spd = Math.min(spd, pSpeed * T.fairLungeSpeed);
            ai.strike -= dt;
            if (ai.lungeAtPlayer && pSurf < ai.lungeMin) ai.lungeMin = pSurf;
            if (ai.strike <= 0) {
              ai.homeX = fx + Math.cos(f.heading) * spd * dt; ai.homeY = fy + Math.sin(f.heading) * spd * dt;   // settles where it ended
              if (ai.lungeAtPlayer) {
                ai.lungeAtPlayer = false;
                if (playerOn && player.alive && ai.lungeMin < T.nearMissPad + f.size * 0.35) { bus.emit('nearMiss', { fish: f }); nearMissNow = 1; noteDanger(); api.nearMisses++; }
              }
            }
          }
        }
        if (ai.strike <= 0) {   // ease toward home (no forward motion)
          const k = 1 - Math.exp(-3 * dt);
          f.pos.x += (hx - fx) * k; f.pos.y += (hy - fy) * k;
          f.vel.set(0, 0, 0);
        }
      } else {
        // FREE (prey / similar): wander, school, flee
        ai.wanderA += (Math.sin(t * 0.37 + ai.seed) + 0.6 * Math.sin(t * 0.91 + ai.seed * 1.7)) * dt * 0.9;
        let dX = Math.cos(ai.wanderA), dY = Math.sin(ai.wanderA) * 0.6;
        let speedMul = 1;
        const tl = Math.hypot(thrX, thrY);
        if (beh === 'school') {
          if (tl > 0.02) { ai.alarm = 1; ai.fleeX = thrX / tl; ai.fleeY = thrY / tl; }
          else if (schoolAlarm > 0.25 && ai.alarm < schoolAlarm * 0.85) { ai.alarm = schoolAlarm * 0.85; ai.fleeX = schoolFX; ai.fleeY = schoolFY; }
          else ai.alarm = Math.max(0, ai.alarm - dt * 0.8);
          dX *= 0.3; dY *= 0.3;
          if (mates > 0) {
            const al = Math.hypot(aliX, aliY) + 1e-6;
            dX += aliX / al; dY += aliY / al;
            const cl = Math.hypot(cohX, cohY) + 1e-6;
            const cw = clamp(cl / mates / (f.size * 6 + 2), 0, 1) * 0.9 * (1 - ai.alarm * 0.7);
            dX += (cohX / cl) * cw; dY += (cohY / cl) * cw;
          }
          dX += sepX * 2.2; dY += sepY * 2.2;
          if (f.species === 'microbe') {
            dX += Math.sin(t * 7.3 + ai.seed * 3) * 1.1; dY += Math.cos(t * 8.9 + ai.seed) * 1.1;
            speedMul *= 0.55 + 0.75 * Math.max(0, Math.sin(t * 4.7 + ai.seed * 5)) ** 2;
          }
          if (ai.alarm > 0.05) {
            const side = Math.sin(ai.seed * 13.1) * 0.9;
            const fxv = ai.fleeX - ai.fleeY * side, fyv = ai.fleeY + ai.fleeX * side;
            dX += fxv * 4 * ai.alarm; dY += fyv * 4 * ai.alarm;
            fleeing = true; speedMul = 1 + (T.fleeBoost - 1) * ai.alarm * 1.2;
          }
        } else {
          dX += sepX * 1.6; dY += sepY * 1.6;
          if (tl > 0.02) { dX += thrX * 5; dY += thrY * 5; fleeing = true; speedMul = T.fleeBoost; }
          if (beh === 'drifter') speedMul *= 0.5;
        }
        // rare rocks: probe only when near
        const s0 = ter.sdf(fx, fy);
        if (s0 < T.rockNear + f.size * 3) {
          const look = f.size * T.wallClear + ai.spd * 0.55 + 2;
          const sC = ter.sdf(fx + cosH * look, fy + sinH * look), clear = f.size * 1.2 + 1;
          if (sC < clear * 2.2) {
            ter.normal(fx + cosH * look, fy + sinH * look, nrm);
            const w = T.wallWeight * clamp(1 - (sC - clear) / (clear * 1.2), 0, 1);
            dX += nrm.x * w; dY += nrm.y * w;
          }
        }
        if (dX * dX + dY * dY > 1e-6) f.heading = wrapAngle(turnToward(f.heading, Math.atan2(dY, dX), ai.turn * dt));
        if (beh !== 'school' && !fleeing) ai.wanderA += wrapAngle(f.heading - ai.wanderA) * Math.min(1, dt * 0.5);
        spd = ai.spd * ai.speedJitter * speedMul;
      }

      if (mode !== M_STATIC || ai.strike > 0) {
        const ch = Math.cos(f.heading), sh = Math.sin(f.heading);
        f.vel.set(ch * spd, sh * spd, 0);
        f.pos.x += ch * spd * dt; f.pos.y += sh * spd * dt;
      }
      f.pos.z = 0;
      ai.speed = spd;
      if (ter.sdf(f.pos.x, f.pos.y) < f.size + 1 && ter.collide(f) && mode === M_FREE) {
        const tx = -f.lastWallNy, ty = f.lastWallNx, sg = tx * Math.cos(f.heading) + ty * Math.sin(f.heading) >= 0 ? 1 : -1;
        ai.wanderA = Math.atan2(ty * sg + f.lastWallNy * 0.3, tx * sg + f.lastWallNx * 0.3);
      }
      ai.hunting = isAngler && ai.strike > 0 && ai.lungeAtPlayer;

      // --- cosmetics ---
      const turn01 = clamp(wrapAngle(f.heading - prevH) / dt / ai.turn, -1, 1);
      const kb = 1 - Math.exp(-6 * dt);
      f.bank += (turn01 * 0.5 - f.bank) * kb;
      const rate = mode === M_STATIC ? (ai.strike > 0 ? 2.5 : 0.45) : 1 + (fleeing ? 1.3 : 0) + Math.abs(turn01) * 0.5;
      f.swimRate += (rate - f.swimRate) * kb;

      // --- threat: anglers about to strike / striking; moving dangerous fish on a crossing path ---
      if (dangerToPlayer && pd < vr * 1.6) {
        let th = 0;
        if (isAngler) {
          if (ai.strike > 0 && ai.lungeAtPlayer) th = 1;
          else if (pFwd > 0.4 && pSurf < f.size * 2.2 + 6) th = 0.6 * (1 - clamp(pSurf / (f.size * 2.2 + 6), 0, 1)) + 0.2;
        } else if (mode === M_LINE) {
          const rvx = f.vel.x - player.vel.x, rvy = f.vel.y - player.vel.y, rv2 = rvx * rvx + rvy * rvy;
          if (rv2 > 1e-3) {
            const tc = clamp((pdx * rvx + pdy * rvy) / rv2, 0, 3);
            const mx = pdx - rvx * tc, my = pdy - rvy * tc;
            const miss = Math.sqrt(mx * mx + my * my) - f.size - player.size;
            th = (1 - clamp(miss / (f.size * 1.5 + 6), 0, 1)) * (1 - tc / 3.2) * 0.9;
          }
        }
        if (pSurf < f.size) th = Math.max(th, 0.5 * (1 - pSurf / f.size));
        if (th > threatRaw) threatRaw = th;
      }

      // --- despawn ---
      const ddx = f.pos.x - cx, ddy = f.pos.y - cy;
      if (ddx * ddx + ddy * ddy > despawnR2 * ai.despawnMul) f.alive = false;
    }

    for (let i = fish.length - 1; i >= 0; i--) {
      if (!fish[i].alive) { fish[i] = fish[fish.length - 1]; fish.length--; }
    }

    // --- threat + intensity + phase ---
    if (!active) { api.threat = 0; api.intensity = 0; }
    else {
      api.threat += (threatRaw - api.threat) * (1 - Math.exp(-(threatRaw > api.threat ? 8 : 3) * dt));
      const raw = Math.max(api.threat, nearMissNow, Math.min(0.45, danger * 0.1));
      api.intensity = raw > api.intensity
        ? api.intensity + (raw - api.intensity) * (1 - Math.exp(-5 * dt))
        : Math.max(raw, api.intensity - T.intensityDecay * dt);
    }
    api.phase = active && breatherT <= 0 && !bossActive ? 'flow' : 'breather';

    const vlen = Math.hypot(player.vel.x, player.vel.y);
    const baseA = vlen > 0.5 ? Math.atan2(player.vel.y, player.vel.x) : player.heading;

    if (active) director(dt, player, ps, tier, cx, cy, vr, danger, statics, baseA);

    // --- ambient spawns: ring off-screen, 60% ahead ---
    let budget = T.spawnPerFrame;
    while (fish.length < P.max && budget-- > 0) {
      if (!ringPoint(cx, cy, P.spawnInner * vr, P.spawnOuter * vr, 2, baseA, T.spawnAhead)) continue;
      spawnAmbient(pt.x, pt.y, ps, tier);
    }
    // --- FOOD: ~foodTarget meaningful prey near the player, ahead ---
    if (active && food < T.foodTarget) {
      let fb = T.foodPerFrame;
      for (let k = 0; k < 4 && fb > 0 && fish.length < P.max * T.popOverflow; k++) {
        if (!ringPoint(cx, cy, T.foodRing[0] * vr, T.foodRing[1] * vr, 2, baseA, T.foodAhead, 1.0)) continue;
        if (spawnAmbient(pt.x, pt.y, ps, tier, ps * rand(T.foodSize[0], T.foodSize[1])) > 0) fb--;
      }
    }
  }

  function playerTurnCap(player) { return CONFIG.player.baseTurn / Math.pow(player.size, CONFIG.player.turnExp) * T.fairTurn; }

  // ---------- formation API (used by formations.js) ----------
  // A straight-line mover: fixed heading + fixed speed, no swerving except rare rocks. Sizes are NOT clamped to the
  // species range (formation sizes stay relative to the player). opts: { waveId, edible, despawnMul }.
  function spawnLiner(species, size, x, y, heading, speed, opts = {}) {
    if (fish.length >= MAXF - 4 || !SPECIES[species]) return null;
    const f = makeFish(species, size, x, y, heading);
    initFish(f, M_LINE);
    f.ai.formation = opts.waveId || 0;
    f.ai.fixedSpeed = speed;
    f.ai.despawnMul = opts.despawnMul || 1.6;
    f.vel.set(Math.cos(heading) * speed, Math.sin(heading) * speed, 0);
    fish.push(f);
    return f;
  }
  function pauseCrossers(on) { crossersPaused = !!on; }
  // Remove static hazards in the annulus [rMin, rMax] around (x,y) (call with rMin ≥ viewRadius: off-screen only).
  function clearStatics(x, y, rMin, rMax) {
    let c = 0;
    for (let i = 0; i < fish.length; i++) {
      const f = fish[i];
      if (f.ai.mode !== M_STATIC || !f.alive) continue;
      const d = Math.hypot(f.pos.x - x, f.pos.y - y);
      if (d >= rMin && d <= rMax) { f.alive = false; c++; }
    }
    return c;
  }
  // Species for a formation squad around tier: predators/line-movers preferred, school shapes for small tiers.
  function pickFormationSpecies(tier, size) {
    const smallTier = tier <= 2;
    let total = 0;
    for (let i = 0; i < SPECIES_KEYS.length; i++) {
      const key = SPECIES_KEYS[i], sp = SPECIES[key], tw = sp.tiers || {};
      let w = (tw[tier] || 0) + 0.5 * (tw[tier + 1] || 0);
      if (T.staticSpecies[key]) w = 0;
      else if (sp.behavior === 'predator') w *= smallTier ? 1 : 4;
      else if (sp.behavior === 'school') w *= smallTier ? 3 : 0.6;
      else if (sp.behavior === 'giant') w *= size > 14 ? 1 : 0;
      else w *= 0.3;
      candW[i] = w; total += w;
    }
    if (total <= 0) return 'sardine';
    let pick = Math.random() * total, k = 0;
    for (; k < SPECIES_KEYS.length - 1; k++) { pick -= candW[k]; if (pick <= 0 && candW[k] > 0) break; }
    while (candW[k] === 0 && k > 0) k--;
    return SPECIES_KEYS[k];
  }

  function director(dt, player, ps, tier, cx, cy, vr, danger, statics, baseA) {
    crossCd -= dt; staticCd -= dt; rerollT -= dt;
    let calls = 0;
    for (let i = 0; i < 4; i++) if (runClock - dangerT[i] < T.easyWindow) calls++;
    if (calls >= T.easyCalls && easyUntil < runClock) easyUntil = runClock + T.easyTime;
    if (rerollT <= 0) {
      rerollT = T.dangerReroll;
      const R = easyUntil > runClock ? T.easyTarget : T.dangerTarget;
      dangerTarget = Math.round(rand(R[0], R[1]));
    }
    let target = dangerTarget;
    if (easyUntil > runClock) target = Math.min(target, T.easyTarget[1]);
    if (breatherT > 0) target = Math.min(target, T.breatherTarget);
    const hold = bossActive || runClock < T.safeStart || crossersPaused;
    if (hold) target = 0;
    const calm = !hold && runClock - lastDanger > T.calmDanger;
    if (crossCd <= 0 && target > 0 && (danger < target || (calm && breatherT <= 0))) {
      if (spawnCrossing(cx, cy, player.vel.x, player.vel.y, ps, tier, vr, calm)) {
        crossCd = rand(T.crossCd[0], T.crossCd[1]);
        if (calm) lastDanger = runClock;
      } else crossCd = 0.4;
    }
    if (!hold && breatherT <= 0 && staticCd <= 0 && statics < T.staticWanted) {
      staticCd = T.staticCd;
      spawnStatic(cx, cy, ps, tier, vr, baseA);
    }
  }

  // A dangerous fish on a fixed straight line passing 0.2–0.8·vr from the player's (led) path. Any direction.
  function spawnCrossing(cx, cy, vx, vy, ps, tier, vr, ahead) {
    for (let k = 0; k < 8; k++) {
      const lead = ahead ? T.crossLead[1] * 1.2 : rand(T.crossLead[0], T.crossLead[1]);
      const px = cx + vx * lead, py = cy + vy * lead;
      const dir = Math.random() * Math.PI * 2;
      const ux = Math.cos(dir), uy = Math.sin(dir);
      const off = rand(T.crossOffset[0], T.crossOffset[1]) * vr * (Math.random() < 0.5 ? -1 : 1);
      const back = rand(T.crossDist[0], T.crossDist[1]) * vr;
      const sx = px - uy * off - ux * back, sy = py + ux * off - uy * back;
      if (!pickSpecies(tier, ps * lrand(T.danger[0], T.danger[1]), 1, pickOut)) return false;
      const size = pickOut.size;
      if (!(size > ps * CONFIG.eat.margin)) continue;   // nothing in this tier is big enough
      if (!ter.isOpen(sx, sy, size * 2)) continue;
      newFish(pickOut.species, size, sx, sy, dir, M_LINE);
      return true;
    }
    return false;
  }

  // A static hazard (angler / jelly / puffer) hovering just off-screen ahead.
  function spawnStatic(cx, cy, ps, tier, vr, baseA) {
    for (let k = 0; k < 4; k++) {
      if (!pickSpecies(tier, ps * lrand(T.danger[0], T.danger[1]), 2, pickOut)) return false;
      const size = pickOut.size;
      if (!(size > ps * CONFIG.eat.margin)) return false;
      if (!ringPoint(cx, cy, T.staticRing[0] * vr, T.staticRing[1] * vr, size * 2, baseA, 0.9, 0.8)) continue;
      // face roughly toward where the player is heading from (anglers point their lure at the lane)
      const face = Math.atan2(cy - pt.y, cx - pt.x) + rand(-0.6, 0.6);
      newFish(pickOut.species, size, pt.x, pt.y, face, M_STATIC);
      return true;
    }
    return false;
  }

  // Append fish indices within r of (x,y) to nbr[] from c (current queryId marks already-added ones).
  function gather(x, y, r, c) {
    const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL);
    const y0 = Math.floor((y - r) / CELL), y1 = Math.floor((y + r) / CELL);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const h = hashCell(ix, iy);
        for (let k = cellStart[h], e = cellStart[h + 1]; k < e; k++) {
          const j = cellItems[k];
          if (mark[j] === queryId) continue;
          mark[j] = queryId;
          nbr[c++] = j;
        }
      }
    }
    return c;
  }

  return api;
}
