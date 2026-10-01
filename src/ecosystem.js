// Ecosystem (INFINITE SIDE-VIEW SEA): NPC spawning / despawning, AI, eating, danger-density director.
//
// Plane XY, y up, open water in every direction. forward = (cos h, sin h, 0). Mobs scale with the PLAYER (size P,
// tier = tierIndexFor(P)), anywhere:
//   ambient spawns: prey 0.3–0.85·P (~72%) and similar 0.85–1.1·P (~28%) — never dangerous; species from
//   SPECIES[*].tiers[tier] (size-range fit preferred, then clamped).
// EVERY DANGEROUS FISH IS A STRAIGHT-LINE MOVER (fixed heading, constant speed, never turns toward anything; only
//   rare landmark rocks deflect it). Two kinds, spawned by the director:
//   CROSSER — line passing 0.2–0.8·viewRadius from the player's (led) path, any direction.
//   DARTER  — spawns off-screen aimed at the player's position AT SPAWN, 0.75–0.9× player speed, shoots past.
//   Jellies and puffers (any size) are slow straight-line movers too. No statics, no lunges, no homing.
//   NPCs NEVER eat each other: the only eats are player→NPC and NPC/boss→player (mouth contact).
// Fairness: spawns are placed outside the actual screen rectangle (half-width = viewRadius, half-height =
//   viewRadius/aspect); a darter's speed/angle is chosen so that — unless the player swims straight at it — it needs
//   ≥ T.reactTime seconds from appearing on screen to reaching the player. Dash/line speeds ≤ fairSpeed·playerSpeed.
// Director: danger density 5–8 (crossers + darters) within 1.5·vr, ramping with tier and with time since the last
//   breather (shmup stage); darters every ~3–5 s (faster at higher tiers). Breathers (4 s) only on evolve / wave end /
//   boss defeated. Mild easing after ≥2 near misses in 10 s (−30% for 6 s). No director spawns during boss fights,
//   formation waves (pauseCrossers) or the first 10 s. ~8 meaningful prey (≥ 0.3·P) kept nearby, ahead.
// Exposed: fish, threat, intensity, phase ('flow'|'breather'), danger, food, darters (count spawned), nearMisses,
//   spawnLiner(), pauseCrossers(), breather(sec), pickSpecies(tier,size). Rebase: nothing stored in world coords
//   except fish positions (shifted by main). Bosses (opts.bosses): fled from, never eaten. Puffer twist: puffed
//   puffers can only be eaten by fish ≥ 1.4× their size (player included).
import { CONFIG, SPECIES, tierIndexFor, npcSpeed, npcTurn, playerSpeed, canEat, turnToward, wrapAngle } from './config.js';
import { makeFish } from './entities.js';

// ---------- tuning knobs ----------
const T = {
  sightBase: 6, sightPerSize: 4, sightMax: 40,
  maxNeighbors: 18,
  fleeBoost: 1.45,
  // spawn mix around the player (sizes × P)
  prey: [0.3, 0.85], similar: [0.85, 1.1], danger: [1.3, 2.5],
  ambientSimilar: 0.28, spawnAhead: 0.6, spawnPerFrame: 6,
  schoolSize: [8, 22], schoolWeight: 0.4, schoolShareMax: 0.45,
  slowLiners: { jelly: true, puffer: true },   // always straight-line movers (slow)
  slowLinerSpeed: 0.6,                          // × their npcSpeed
  frontDot: -0.2, giantMouthDot: 0.45,
  fairSpeed: 0.9, fairLungeSpeed: 1.4, fairTurn: 0.75,
  rockNear: 30, wallClear: 1.6, wallWeight: 8,
  aspect: 16 / 9,           // fallback when window size is unknown (headless)
  reactTime: 2.0,           // ≥ this from appearing on screen to impact (unless the player charges it)
  // director
  safeStart: 10,
  dangerRadius: 1.5, dangerIncoming: 2.2,
  densityMin: 5, densityMax: 8,                 // dangerous movers within dangerRadius (crossers + darters)
  rampTier: 0.35, rampTime: 90,                 // ramp = tierShare·tier/6 + timeSinceBreather/rampTime
  crossCd: [0.6, 1.4], crossDist: [1.3, 1.7], crossOffset: [0.2, 0.8], crossLead: [0.4, 1.6],
  darterEvery: [3, 5], darterTierK: 0.12,       // interval / (1 + K·tier) / (0.8 + 0.4·ramp)
  darterDist: [1.2, 1.4], darterSpeed: [0.75, 0.95], darterSize: [1.3, 2.0],
  darterNoHeadOn: 0.55,     // don't spawn darters within ±this rad of the player's heading
  darterOverflow: 2,        // darters pause while danger ≥ target + this
  nearMissPad: 1.2,
  easyCalls: 2, easyWindow: 10, easyTime: 6, easyScale: 0.7,
  breather: 4,
  foodTarget: 8, foodRadius: 1.2, foodMinRel: 0.3, foodSize: [0.35, 0.8],
  foodRing: [1.05, 1.35], foodAhead: 0.7, foodPerFrame: 2, popOverflow: 1.3,
  intensityDecay: 0.15,
};
const PUFF_PROTECT = 1.4;
const MAXF = 1024;
const M_FREE = 0, M_LINE = 1;
const K_NONE = 0, K_CROSSER = 1, K_DARTER = 2, K_FORMATION = 3;

// ---------- spatial hash (rebuilt every frame) ----------
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
const OPEN_TERRAIN = {
  sdf: () => 1e6, normal: (x, y, o) => { o.x = 0; o.y = 1; return o; },
  collide: () => false, raycast: () => Infinity, isOpen: () => true,
};
// screen half-extent along direction (dx,dy) (unit): distance from the player to the screen-rectangle edge
export function screenEdgeDist(dx, dy, vr, aspect) {
  const hw = vr, hh = vr / aspect;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  return Math.min(ax > 1e-6 ? hw / ax : 1e9, ay > 1e-6 ? hh / ay : 1e9);
}
export function viewAspect() {
  if (typeof window !== 'undefined' && window.innerWidth > 0 && window.innerHeight > 0) return window.innerWidth / window.innerHeight;
  return T.aspect;
}

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
  let runClock = 0, crossCd = 0, darterCd = 0, stageT = 0;
  let breatherT = 0, bossActive = false, easyUntil = -1, crossersPaused = false;
  const dangerT = [-99, -99, -99, -99]; let dangerI = 0;
  const noteDanger = () => { dangerT[dangerI] = runClock; dangerI = (dangerI + 1) & 3; };

  const api = {
    fish, threat: 0, intensity: 0, phase: 'flow', danger: 0, food: 0, darters: 0, nearMisses: 0, target: 0,
    reset, update, spawnLiner, pauseCrossers,
    breather: (sec) => { breatherT = Math.max(breatherT, sec || T.breather); stageT = 0; },
    pickSpecies: pickHunterSpecies,
  };
  bus.on('evolve', () => api.breather(T.breather));
  bus.on('bossDefeated', () => { bossActive = false; api.breather(T.breather); });
  bus.on('bossEngage', () => { bossActive = true; });
  bus.on('bossDisengage', () => { bossActive = false; });

  function reset() {
    for (const f of fish) f.alive = false;
    fish.length = 0;
    schooled = 0; needFill = true;
    runClock = 0; crossCd = 0; darterCd = 0; stageT = 0;
    breatherT = 0; bossActive = false; easyUntil = -1; crossersPaused = false; dangerT.fill(-99);
    Object.assign(api, { threat: 0, intensity: 0, phase: 'flow', danger: 0, food: 0, darters: 0, nearMisses: 0, target: 0 });
  }

  // ---------- species selection ----------
  // Ambient species for `size` around tier (prefers species whose range fits; clamps).
  function pickAmbient(tier, size, out) {
    let total = 0, fit = 0;
    const shareMax = CONFIG.population.max * T.schoolShareMax;
    for (let i = 0; i < SPECIES_KEYS.length; i++) {
      const sp = SPECIES[SPECIES_KEYS[i]], tw = sp.tiers || {};
      let w = tw[tier] || 0;
      if (!w) w = 0.15 * ((tw[tier - 1] || 0) + (tw[tier + 1] || 0));
      if (w > 0 && sp.behavior === 'school') w = schooled > shareMax ? 0 : w * T.schoolWeight;
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
    const k = wpick(total);
    const sp = SPECIES[SPECIES_KEYS[k]];
    out.species = SPECIES_KEYS[k];
    out.size = clamp(size, sp.sizeMin, sp.sizeMax);
    return true;
  }
  // Hunter species (crossers / darters / formations): predators of the tier (+ next tier); school shapes sized up
  // at small tiers; giants only when big. Sizes stay relative (not clamped by the caller).
  function pickHunterSpecies(tier, size) {
    const smallTier = tier <= 2;
    let total = 0;
    for (let i = 0; i < SPECIES_KEYS.length; i++) {
      const key = SPECIES_KEYS[i], sp = SPECIES[key], tw = sp.tiers || {};
      let w = (tw[tier] || 0) + 0.5 * (tw[tier + 1] || 0) + 0.25 * (tw[tier + 2] || 0);
      if (T.slowLiners[key] || sp.behavior === 'ambush') w = 0;
      else if (sp.behavior === 'predator') w *= smallTier ? 1.5 : 4;
      else if (sp.behavior === 'school') w *= smallTier ? 3 : 0.5;
      else if (sp.behavior === 'giant') w *= size > 14 ? 1 : 0;
      else w *= 0.3;
      candW[i] = w; total += w;
    }
    if (total <= 0) return 'sardine';
    return SPECIES_KEYS[wpick(total)];
  }
  function wpick(total) {
    let pick = Math.random() * total, k = 0;
    for (; k < SPECIES_KEYS.length - 1; k++) { pick -= candW[k]; if (pick <= 0 && candW[k] > 0) break; }
    while (candW[k] === 0 && k > 0) k--;
    return k;
  }

  // All ai fields initialised in a fixed order (stable hidden classes).
  function initFish(f, mode) {
    const ai = f.ai;
    ai.behavior = SPECIES[f.species].behavior;
    ai.mode = mode; ai.kind = K_NONE;
    ai.wanderA = f.heading;
    ai.seed = Math.random() * 100;
    ai.speedJitter = rand(0.9, 1.1);
    ai.schoolId = 0;
    ai.alarm = 0; ai.fleeX = 0; ai.fleeY = 0;
    ai.hunting = false; ai.notice = 0; ai.lunge = 0;
    ai.lineA = f.heading;
    ai.passMin = 1e9; ai.passDone = false;
    ai.spawnSize = f.size;
    ai.spd = 0; ai.turn = 0; ai.sight = 0;
    ai.cSepX = 0; ai.cSepY = 0; ai.cAliX = 0; ai.cAliY = 0; ai.cCohX = 0; ai.cCohY = 0; ai.cMates = 0;
    ai.cThrX = 0; ai.cThrY = 0; ai.cThreat = 1e9; ai.cAlarm = 0; ai.cAlarmX = 0; ai.cAlarmY = 0;
    ai.speed = 0;
    ai.formation = 0; ai.fixedSpeed = 0; ai.despawnMul = 1; ai.entered = false;
    refreshStats(f);
    f.invuln = 0;
    f.lastWallNx = 0; f.lastWallNy = 0;
  }
  function refreshStats(f) {
    const ai = f.ai, b = ai.behavior;
    ai.spd = npcSpeed(f.species, f.size);
    ai.turn = npcTurn(f.species, f.size);
    ai.sight = ai.mode === M_LINE ? 0
      : b === 'school' ? Math.min(25, 4 + f.size * 3)
      : Math.min(T.sightMax, T.sightBase + f.size * T.sightPerSize);
  }
  function newFish(key, size, x, y, heading, mode) {
    const f = makeFish(key, size, x, y, heading);
    initFish(f, mode);
    fish.push(f);
    return f;
  }

  // Ambient (non-dangerous) spawn at x,y around player size P. Returns count.
  function spawnAmbient(x, y, P, tier, sizeOverride = 0) {
    if (fish.length >= MAXF - 30) return 0;
    const R = Math.random() < T.ambientSimilar && !sizeOverride ? T.similar : T.prey;
    const want = sizeOverride || P * lrand(R[0], R[1]);
    if (!pickAmbient(tier, want, pickOut)) return 0;
    const key = pickOut.species, sp = SPECIES[key];
    const size = pickOut.size;
    if (size > P * 1.1) return 0;                       // clamping made it dangerous: skip (danger is director-only)
    if (!ter.isOpen(x, y, size * 2)) return 0;
    const heading = Math.random() * Math.PI * 2;
    if (sp.behavior === 'school') {
      const n = rand(T.schoolSize[0], T.schoolSize[1] + 1) | 0;
      const id = nextSchool++, rad = size * 6 + 3;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * rad;
        const s = Math.min(clamp(size * rand(0.85, 1.15), sp.sizeMin, sp.sizeMax), P * 1.1);
        newFish(key, s, x + Math.cos(a) * d, y + Math.sin(a) * d, heading + rand(-0.3, 0.3), M_FREE).ai.schoolId = id;
      }
      schooled += n;
      return n;
    }
    if (T.slowLiners[key]) {
      const f = newFish(key, size, x, y, heading, M_LINE);
      f.ai.fixedSpeed = f.ai.spd * T.slowLinerSpeed;
      return 1;
    }
    newFish(key, size, x, y, heading, M_FREE);
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
    if (!active) for (let k = 0; k < 4; k++) spawnCrossing(cx, cy, 0, 0, P, tier, vr, false);   // living title scene
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
    const reach = CONFIG.eat.reach;
    const pSpeed = playerSpeed(ps);
    let nearMissNow = 0;

    // --- spatial hash + census ---
    const n = fish.length;
    const BIG = Math.max(6, ps * 2.2);
    let nBig = 0, danger = 0, food = 0;
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
          if (e2 < dR2) danger++;
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
    api.danger = danger; api.food = food;

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
      if (f.gulp > 0) f.gulp = Math.max(0, f.gulp - dt * 2.5);
      if (f.wallHit > 0) f.wallHit = Math.max(0, f.wallHit - dt * 3);

      let sepX = 0, sepY = 0, aliX = 0, aliY = 0, cohX = 0, cohY = 0, mates = 0;
      let thrX = 0, thrY = 0, threatNear = 1e9;
      let schoolAlarm = 0, schoolFX = 0, schoolFY = 0;

      // perception (free fish only), staggered every other frame
      if (mode === M_FREE) {
        if (((i + frameNo) & 1) === 0 || f.age < 0.05) {
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
            if (o.size > f.size * 0.3) {   // mild separation (NPCs never eat each other; they just don't clump)
              const sr = (f.size + o.size) * 1.25 + 0.4;
              if (d < sr) { const w = (1 - d / sr) / d; sepX -= dx * w; sepY -= dy * w; }
            }
            if (ai.schoolId && o.ai.schoolId === ai.schoolId) {
              aliX += hcos[nbr[k]]; aliY += hsin[nbr[k]];
              cohX += dx; cohY += dy; mates++;
              if (o.ai.alarm > schoolAlarm) { schoolAlarm = o.ai.alarm; schoolFX = o.ai.fleeX; schoolFY = o.ai.fleeY; }
            }
            if (canEat(o, f)) {   // bigger fish look scary: flee (they never actually eat us)
              const w = 1 - clamp(surf / sight, 0, 1);
              if (w > 0) { thrX -= (dx / d) * w; thrY -= (dy / d) * w; if (surf < threatNear) threatNear = surf; }
            }
          }
          for (let k = 0; k < bosses.length; k++) {
            const bo = bosses[k];
            if (!bo || !bo.alive || bo.size < f.size * 1.05) continue;
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
          ai.cThrX = thrX; ai.cThrY = thrY; ai.cThreat = threatNear; ai.cAlarm = schoolAlarm; ai.cAlarmX = schoolFX; ai.cAlarmY = schoolFY;
        } else {
          sepX = ai.cSepX; sepY = ai.cSepY; aliX = ai.cAliX; aliY = ai.cAliY; cohX = ai.cCohX; cohY = ai.cCohY; mates = ai.cMates;
          thrX = ai.cThrX; thrY = ai.cThrY; threatNear = ai.cThreat; schoolAlarm = ai.cAlarm; schoolFX = ai.cAlarmX; schoolFY = ai.cAlarmY;
        }
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
        if (playerPrey && dangerToPlayer && player.alive) {               // mouth contact eats the player
          const ok = beh === 'giant'
            ? pFwd > T.giantMouthDot && pd < f.size * 1.3 + player.size * reach
            : pFwd > T.frontDot && pd < f.size + player.size * reach;
          if (ok) { bus.emit('eat', { eater: f, eaten: player }); f.gulp = 1; }
        }
        if (mode === M_FREE && pSurf < sight && canEat(player, f)) {
          const w = 1 - clamp(pSurf / sight, 0, 1);
          thrX -= (pdx / pd) * w * 1.3; thrY -= (pdy / pd) * w * 1.3;
          if (pSurf < threatNear) threatNear = pSurf;
        }
        if (dangerToPlayer && mode === M_LINE && !ai.passDone) {   // near miss: passed very close (once per fish)
          if (pSurf < ai.passMin) ai.passMin = pSurf;
          else if (ai.passMin < T.nearMissPad + f.size * 0.3 && pSurf > ai.passMin + f.size * 0.5 + 1 && player.alive) {
            ai.passDone = true; bus.emit('nearMiss', { fish: f }); nearMissNow = 1; noteDanger(); api.nearMisses++;
          }
        }
      }

      if (f.species === 'puffer') {
        const want = threatNear < Math.max(sight, 6) * 0.55 || (playerOn && pSurf < f.size * 3) ? 1 : 0;
        f.puff += (want - f.puff) * (1 - Math.exp(-(want ? 7 : 1.5) * dt));
      }

      // --- movement ---
      const prevH = f.heading;
      let spd = 0, fleeing = false;
      if (mode === M_LINE) {
        // fixed heading, constant speed; only rare rocks deflect (the line resumes after)
        spd = ai.fixedSpeed > 0 ? ai.fixedSpeed : ai.spd * ai.speedJitter;
        if (dangerToPlayer) spd = Math.min(spd, pSpeed * T.fairSpeed);
        const s0 = ter.sdf(fx, fy);
        if (s0 < T.rockNear + f.size * 3) {
          let hd = ai.lineA;
          const look = f.size * T.wallClear + spd * 0.6 + 2;
          const sC = ter.sdf(fx + cosH * look, fy + sinH * look);
          if (sC < f.size * 2.5 + 2) {
            ter.normal(fx + cosH * look, fy + sinH * look, nrm);
            const tx = -nrm.y, ty = nrm.x, sg = tx * Math.cos(ai.lineA) + ty * Math.sin(ai.lineA) >= 0 ? 1 : -1;
            hd = Math.atan2(ty * sg + nrm.y * 0.5, tx * sg + nrm.x * 0.5);
          }
          f.heading = wrapAngle(turnToward(f.heading, hd, ai.turn * dt));
        } else f.heading = ai.lineA;
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
        }
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

      const ch = Math.cos(f.heading), sh = Math.sin(f.heading);
      f.vel.set(ch * spd, sh * spd, 0);
      f.pos.x += ch * spd * dt; f.pos.y += sh * spd * dt; f.pos.z = 0;
      ai.speed = spd;
      if (ter.sdf(f.pos.x, f.pos.y) < f.size + 1 && ter.collide(f) && mode === M_FREE) {
        const tx = -f.lastWallNy, ty = f.lastWallNx, sg = tx * ch + ty * sh >= 0 ? 1 : -1;
        ai.wanderA = Math.atan2(ty * sg + f.lastWallNy * 0.3, tx * sg + f.lastWallNx * 0.3);
      }
      ai.hunting = ai.kind === K_DARTER && dangerToPlayer && pd < vr * 1.6;

      // --- cosmetics ---
      const turn01 = clamp(wrapAngle(f.heading - prevH) / dt / ai.turn, -1, 1);
      const kb = 1 - Math.exp(-6 * dt);
      f.bank += (turn01 * 0.5 - f.bank) * kb;
      const rate = 1 + (fleeing ? 1.3 : 0) + Math.abs(turn01) * 0.5 + (ai.kind === K_DARTER ? 0.8 : 0);
      f.swimRate += (rate - f.swimRate) * kb;

      // --- threat: dangerous movers whose path is about to cross the player ---
      if (dangerToPlayer && pd < vr * 1.6) {
        let th = 0;
        const rvx = f.vel.x - player.vel.x, rvy = f.vel.y - player.vel.y, rv2 = rvx * rvx + rvy * rvy;
        if (rv2 > 1e-3) {
          const tc = clamp((pdx * rvx + pdy * rvy) / rv2, 0, 3);
          const mx = pdx - rvx * tc, my = pdy - rvy * tc;
          const miss = Math.sqrt(mx * mx + my * my) - f.size - player.size;
          th = (1 - clamp(miss / (f.size * 1.5 + 6), 0, 1)) * (1 - tc / 3.2) * 0.9;
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
      const raw = Math.max(api.threat, nearMissNow, Math.min(0.5, danger * 0.07));
      api.intensity = raw > api.intensity
        ? api.intensity + (raw - api.intensity) * (1 - Math.exp(-5 * dt))
        : Math.max(raw, api.intensity - T.intensityDecay * dt);
    }
    api.phase = active && breatherT <= 0 && !bossActive ? 'flow' : 'breather';

    const vlen = Math.hypot(player.vel.x, player.vel.y);
    const baseA = vlen > 0.5 ? Math.atan2(player.vel.y, player.vel.x) : player.heading;
    if (active) director(dt, player, ps, tier, cx, cy, vr, danger, baseA);

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

  // ---------- director: danger density (crossers + darters) ----------
  function director(dt, player, ps, tier, cx, cy, vr, danger, baseA) {
    crossCd -= dt; darterCd -= dt;
    const hold = bossActive || runClock < T.safeStart || crossersPaused || breatherT > 0;
    if (!hold) stageT += dt;
    let calls = 0;
    for (let i = 0; i < 4; i++) if (runClock - dangerT[i] < T.easyWindow) calls++;
    if (calls >= T.easyCalls && easyUntil < runClock) easyUntil = runClock + T.easyTime;
    const ramp = clamp(T.rampTier * tier / 6 + stageT / T.rampTime, 0, 1);
    const easy = easyUntil > runClock ? T.easyScale : 1;
    const target = hold ? 0 : Math.round((T.densityMin + (T.densityMax - T.densityMin) * ramp) * easy);
    api.target = target;
    if (hold) return;
    // darters on a cadence (they count toward the density too)
    if (darterCd <= 0 && danger < target + T.darterOverflow) {
      const base = rand(T.darterEvery[0], T.darterEvery[1]) / (1 + T.darterTierK * tier) / (0.8 + 0.4 * ramp) / easy;
      darterCd = spawnDarter(player, ps, tier, cx, cy, vr) ? base : 0.5;
    }
    // crossers fill the density target
    if (crossCd <= 0 && danger < target) {
      crossCd = spawnCrossing(cx, cy, player.vel.x, player.vel.y, ps, tier, vr, false) ? rand(T.crossCd[0], T.crossCd[1]) : 0.4;
    }
  }

  function hunterSize(ps, R) { return ps * rand(R[0], R[1]); }

  // A crosser: fixed straight line passing 0.2–0.8·vr from the player's (led) path, any direction, starting
  // outside the screen rectangle.
  function spawnCrossing(cx, cy, vx, vy, ps, tier, vr, ahead) {
    const aspect = viewAspect();
    for (let k = 0; k < 8; k++) {
      const lead = ahead ? T.crossLead[1] * 1.2 : rand(T.crossLead[0], T.crossLead[1]);
      const px = cx + vx * lead, py = cy + vy * lead;
      const dir = Math.random() * Math.PI * 2;
      const ux = Math.cos(dir), uy = Math.sin(dir);
      const off = rand(T.crossOffset[0], T.crossOffset[1]) * vr * (Math.random() < 0.5 ? -1 : 1);
      const size = hunterSize(ps, T.danger);
      const back = Math.max(rand(T.crossDist[0], T.crossDist[1]) * vr, screenEdgeDist(ux, uy, vr, aspect) * 1.25 + size + lead * Math.hypot(vx, vy));
      const sx = px - uy * off - ux * back, sy = py + ux * off - uy * back;
      // must start off-screen relative to the player NOW
      const ex = sx - cx, ey = sy - cy, el = Math.hypot(ex, ey) || 1;
      if (el < screenEdgeDist(ex / el, ey / el, vr, aspect) + size * 1.5) continue;
      if (!ter.isOpen(sx, sy, size * 2)) continue;
      const key = pickHunterSpecies(tier, size);
      const f = newFish(key, size, sx, sy, dir, M_LINE);
      f.ai.kind = K_CROSSER;
      return true;
    }
    return false;
  }

  // A darter: off-screen, aimed at the player's position NOW, never turns. Angle/speed chosen so that (unless the
  // player charges it) it needs ≥ reactTime from appearing on screen to impact.
  function spawnDarter(player, ps, tier, cx, cy, vr) {
    const aspect = viewAspect();
    const sp = playerSpeed(ps);
    const ph = Math.hypot(player.vel.x, player.vel.y) > 0.5 ? Math.atan2(player.vel.y, player.vel.x) : player.heading;
    for (let k = 0; k < 10; k++) {
      // direction FROM the player TO the darter's spawn; avoid dead-ahead (head-on closing is too fast)
      const rel = (Math.random() < 0.5 ? 1 : -1) * rand(T.darterNoHeadOn, Math.PI);
      const a = ph + rel, ux = Math.cos(a), uy = Math.sin(a);
      const size = hunterSize(ps, T.darterSize);
      const edge = screenEdgeDist(ux, uy, vr, aspect);
      const dist = Math.max(rand(T.darterDist[0], T.darterDist[1]) * vr, edge * 1.15) + size;
      const sx = cx + ux * dist, sy = cy + uy * dist;
      if (!ter.isOpen(sx, sy, size * 2)) continue;
      // worst-case closing if the player keeps swimming: darter speed + player's velocity component toward it
      const toward = Math.max(0, Math.cos(rel)) * sp;
      let v = Math.min(rand(T.darterSpeed[0], T.darterSpeed[1]), T.fairSpeed) * sp;
      const vMax = (edge - size - ps) / T.reactTime - toward;
      if (vMax < T.darterSpeed[0] * sp * 0.9) continue;          // this side is too tight: try another angle
      v = Math.min(v, vMax);
      const key = pickHunterSpecies(tier, size);
      const heading = Math.atan2(cy - sy, cx - sx);              // aimed at the player's position at spawn
      const f = newFish(key, size, sx, sy, heading, M_LINE);
      f.ai.kind = K_DARTER; f.ai.fixedSpeed = v; f.ai.despawnMul = 1.4;
      api.darters++;
      return true;
    }
    return false;
  }

  // ---------- formation API (used by formations.js) ----------
  // Straight-line mover: fixed heading + fixed speed, no swerving except rare rocks. Size not clamped (relative).
  function spawnLiner(species, size, x, y, heading, speed, opts = {}) {
    if (fish.length >= MAXF - 4 || !SPECIES[species]) return null;
    if (!ter.isOpen(x, y, size)) return null;   // never spawn inside a landmark rock (collision would shove it on-screen)
    const f = makeFish(species, size, x, y, heading);
    initFish(f, M_LINE);
    f.ai.kind = K_FORMATION;
    f.ai.formation = opts.waveId || 0;
    f.ai.fixedSpeed = speed;
    f.ai.despawnMul = opts.despawnMul || 1.6;
    f.vel.set(Math.cos(heading) * speed, Math.sin(heading) * speed, 0);
    fish.push(f);
    return f;
  }
  function pauseCrossers(on) { crossersPaused = !!on; }

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
