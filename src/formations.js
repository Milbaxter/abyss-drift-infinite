// FORMATION WAVES — shmup-style geometric herds of fish on straight lines that the player must dodge.
//
// createFormations({ bus, eco, terrain }) → { update(dt, t, player, state, viewRadius), reset(), active, ... }
//
// How a wave is built (fair by construction):
//   1. Pick a pattern for the player's tier, a squad species (eco.pickSpecies) sized 1.3–1.8·P, speed ≤ 0.9·playerSpeed.
//   2. Simulate a REFERENCE PATH the player can actually swim: keep heading through a reaction delay, then turn (at the
//      player's real turn rate, ≤ ~100°, never a 180°) onto a new straight course. Start = player state at the warning.
//   3. Lay out the pattern's straight-line fish (entering from off-screen, relative to the player & camera).
//   4. CARVE: remove every fish whose line comes within gap/2 + fishSize of the reference path at any time → each
//      wall gets a gap ≥ gapWidth = (3·P + margin) × turn-scale exactly where the reachable path crosses it.
//   5. Put a few edible riders (0.5–0.8·P) into the carved gaps / at the tail: risk-reward.
// Patterns: wall (with gap), lanes (staggered parallel walls), chevron (V), rain (rhythmic diagonal columns),
//   crossfire (two opposite walls), ring (burst of rays from a point off to the side), pincer (two converging walls).
// Scheduling: level-up wave ~10 s after each evolve; otherwise every 60–90 s of play. Never during boss fights
//   (state.boss), the first 30 s of a run, or eco breathers. After a wave: 5 s breather (eco.breather).
// Bus: waveWarn {id, name, dirs:[{x,y}], time} ~1.8 s before fish enter (dirs = unit vectors player → entry side),
//   waveStart {id}, waveEnd {id, cleared}. Rebase: stored anchors/paths/pending spawns shift by (-dx,-dy).
import { CONFIG, SPECIES, tierIndexFor, playerSpeed, playerTurn, wrapAngle } from './config.js';

const F = {
  warn: 1.8,                // seconds of warning before the first fish enters
  levelUpDelay: 10,         // level-up wave this long after 'evolve'
  interval: [60, 90],       // regular waves
  firstAfter: 30,           // no waves in the first 30 s of a run
  breatherAfter: 5,         // eco breather after each wave
  endRadius: 1.5,           // wave ends when its fish have all left this × viewRadius
  timeout: 30,
  sizeMul: [1.3, 1.8],      // squad fish size × P
  speed: [0.6, 0.85],       // × playerSpeed, by difficulty (hard cap fairSpeedCap)
  fairSpeedCap: 0.9,
  gapBase: 3, gapMargin: 3, // gap width ≥ (gapBase·P + gapMargin) × turnScale
  turnScaleK: 0.3,          // turnScale = 1 + K·(baseTurn/playerTurn(P) − 1)
  spacing: 1.08,            // fish spacing along a wall, × fish diameter (no squeezing between fish)
  enterDist: 1.45,          // groups start this × vr from their anchor (off-screen)
  intercept: 0.85,          // anchor = reference-path point at (warn + t0 + travelTime·intercept)
  offscreen: 1.12,          // every group must start ≥ this × vr from the player's predicted position
  halfWidth: 1.4,           // wall half-length × vr
  reaction: 0.5,            // reference path: seconds before the player reacts
  maxTurn: 1.75,            // reference path max heading change (rad, ~100°)
  turnUse: 0.8,             // reference path uses this fraction of the player's turn rate
  pathTime: 34, pathDt: 1 / 20,   // reference path covers the whole wave (timeout + warn)
  edible: [0.5, 0.8], riders: [2, 4],
  pools: [                  // patterns by tier (difficulty grows with tier inside each pattern too)
    ['wall', 'chevron'], ['wall', 'chevron'],
    ['wall', 'chevron', 'lanes', 'rain'], ['lanes', 'rain', 'chevron', 'wall'],
    ['lanes', 'rain', 'crossfire', 'pincer', 'ring'], ['crossfire', 'pincer', 'ring', 'lanes', 'rain'],
    ['crossfire', 'pincer', 'ring', 'lanes', 'rain'],
  ],
  names: { wall: 'Wall', lanes: 'Lanes', chevron: 'Chevron', rain: 'Rain', crossfire: 'Crossfire', ring: 'Burst', pincer: 'Pincer' },
};
const EDIBLE_SPECIES = ['krill', 'sardine', 'lanternfish', 'clownfish', 'tang', 'microbe'];
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function createFormations({ bus, eco, terrain }) {
  let runClock = 0, nextAt = 0, levelUpAt = -1, nextId = 1;
  let wave = null;                 // current wave or null
  let playerEaten = false;
  const stats = { waves: 0, cleared: 0, lastMinClear: 0 };

  const api = {
    active: false, wave: null, stats,
    update, reset,
    debugStart: (pattern, player, viewRadius, state) => startWave(player, viewRadius, state || {}, pattern),
  };

  bus.on('evolve', () => { levelUpAt = runClock + F.levelUpDelay; });
  bus.on('eat', (p) => { if (wave && p && p.eaten && p.eaten.isPlayer) playerEaten = true; });
  bus.on('playerDeath', () => { if (wave) playerEaten = true; });
  bus.on('rebase', (r) => {
    if (!wave || !r) return;
    const dx = r.dx || 0, dy = r.dy || 0;
    for (const s of wave.spawns) { s.x -= dx; s.y -= dy; }
    for (let i = 0; i < wave.path.length; i += 2) { wave.path[i] -= dx; wave.path[i + 1] -= dy; }
    wave.ox -= dx; wave.oy -= dy;
  });

  function reset() {
    if (wave) endWave(false, true);
    runClock = 0; nextAt = rand(F.interval[0], F.interval[1]); levelUpAt = -1; playerEaten = false;
    wave = null; api.active = false; api.wave = null;
  }
  reset();

  function update(dt, t, player, state, viewRadius) {
    const vr = viewRadius || 30;
    const playing = state && (state.mode === 'playing' || state.mode === 'victory');
    if (wave && !playing) { endWave(false); return; }
    if (!playing || !(dt > 0) || (state && state.paused)) return;
    runClock += dt;

    if (!wave) {
      const due = (levelUpAt > 0 && runClock >= levelUpAt) || runClock >= nextAt;
      const allowed = runClock >= F.firstAfter && !(state && state.boss) && eco.phase !== 'breather' && player.alive;
      if (due && allowed) {
        const lvl = levelUpAt > 0 && runClock >= levelUpAt;
        if (startWave(player, vr, state, null)) { if (lvl) levelUpAt = -1; }
        else nextAt = runClock + 3;
      }
      return;
    }
    // boss showed up mid-wave: let the wave finish but nothing new gets scheduled
    stepWave(dt, player, vr);
  }

  // ---------- building a wave ----------
  function startWave(player, vr, state, forcePattern) {
    const P = player.size;
    const tier = Math.min(F.pools.length - 1, state && state.tier != null ? state.tier : tierIndexFor(P));
    const d = clamp(tier / 6, 0, 1);                       // difficulty 0..1
    const pool = F.pools[tier];
    const pattern = forcePattern || pool[(Math.random() * pool.length) | 0];
    const sp = playerSpeed(P), tr = playerTurn(P);
    const V = Math.min(F.fairSpeedCap, rand(F.speed[0], F.speed[1]) * (0.85 + 0.15 * d) + 0.05 * d) * sp;
    const fishSize = P * rand(F.sizeMul[0], F.sizeMul[1]);
    const species = eco.pickSpecies ? eco.pickSpecies(tier, fishSize) : 'sardine';
    const turnScale = 1 + F.turnScaleK * (CONFIG.player.baseTurn / tr - 1);
    const gapW = (F.gapBase * P + F.gapMargin) * turnScale;
    const clr = gapW / 2 + fishSize;                       // path-to-fish-centre clearance

    // reference path: player state now → warn → reaction → turn ≤ maxTurn → straight
    const h0 = Math.atan2(player.vel.y, player.vel.x);
    const heading0 = Math.hypot(player.vel.x, player.vel.y) > 0.5 ? h0 : player.heading;
    const target = heading0 + rand(-F.maxTurn, F.maxTurn);
    const N = Math.ceil(F.pathTime / F.pathDt) + 1;
    const path = new Float32Array(N * 2);
    let px = player.pos.x, py = player.pos.y, ph = heading0;
    for (let k = 0; k < N; k++) {
      const tt = k * F.pathDt;
      path[k * 2] = px; path[k * 2 + 1] = py;
      if (tt > F.warn * 0.4 + F.reaction) ph += clamp(wrapAngle(target - ph), -tr * F.turnUse * F.pathDt, tr * F.turnUse * F.pathDt);
      px += Math.cos(ph) * sp * F.pathDt; py += Math.sin(ph) * sp * F.pathDt;
    }
    const pathAt = (tt, out) => {   // tt = seconds since warning start
      const f = clamp(tt / F.pathDt, 0, N - 1.001), k = f | 0, a = f - k;
      out.x = path[k * 2] + (path[k * 2 + 2] - path[k * 2]) * a; out.y = path[k * 2 + 1] + (path[k * 2 + 3] - path[k * 2 + 1]) * a;
      return out;
    };

    // Layout around (0,0), then translate each group to the INTERCEPT point: where the reference path will be when
    // that group's fish reach the middle (so waves really sweep across the player's likely route).
    const O = pathAt(F.warn, { x: 0, y: 0 });
    const groups = layout(pattern, { x: 0, y: 0 }, heading0, vr, fishSize, d, tr);
    const tmp = { x: 0, y: 0 };
    const spawns = [];
    const D = F.enterDist * vr;
    let fixedA = null;
    for (const g of groups) {
      const travel = (g.fixed ? 1.6 * vr : D) / V;
      let A;
      if (g.fixed) { if (!fixedA) fixedA = pathAt(F.warn + g.t0 + travel * F.intercept, { x: 0, y: 0 }); A = fixedA; }
      else A = pathAt(F.warn + g.t0 + travel * F.intercept, { x: 0, y: 0 });
      for (const f of g.fish) { f.x += A.x; f.y += A.y; }
    }
    for (const g of groups) {
      // keep each group off-screen at its spawn time (push back along its own motion if the player moved toward it)
      if (!g.fixed) {
        pathAt(F.warn + g.t0, tmp);
        let minD = 1e9;
        for (const f of g.fish) minD = Math.min(minD, Math.hypot(f.x - tmp.x, f.y - tmp.y));
        const need = F.offscreen * vr - minD;
        if (need > 0) for (const f of g.fish) { f.x -= Math.cos(f.h) * need; f.y -= Math.sin(f.h) * need; }
      } else {
        // burst point: push it out (away from the player's predicted position) until it is off-screen
        pathAt(F.warn + g.t0, tmp);
        const f0 = g.fish[0];
        if (f0) {
          const ex = f0.x - tmp.x, ey = f0.y - tmp.y, el = Math.hypot(ex, ey) || 1;
          const need = F.offscreen * vr - el;
          if (need > 0) for (const f of g.fish) { f.x += (ex / el) * need; f.y += (ey / el) * need; }
        }
      }
      for (const f of g.fish) spawns.push({ t0: g.t0 + (f.dt || 0), x: f.x, y: f.y, h: f.h, size: fishSize, edible: false, carved: false, dmin: 1e9 });
    }
    // carve gaps along the reference path
    const T = F.pathTime - F.warn;
    for (const s of spawns) {
      const cx = Math.cos(s.h) * V, cy = Math.sin(s.h) * V;
      for (let tt = s.t0; tt < T; tt += F.pathDt) {
        pathAt(F.warn + tt, tmp);
        const fx = s.x + cx * (tt - s.t0), fy = s.y + cy * (tt - s.t0);
        const dd = Math.hypot(fx - tmp.x, fy - tmp.y);
        if (dd < s.dmin) s.dmin = dd;
        if (dd > D * 3) break;
      }
      if (s.dmin < clr) s.carved = true;
    }
    let kept = spawns.filter((s) => !s.carved);
    if (!kept.length) return false;
    // edible riders: the carved fish closest to the path (they sit right in the gaps), plus one at the tail
    const carved = spawns.filter((s) => s.carved).sort((a, b) => a.dmin - b.dmin);
    const nR = Math.min(carved.length, (rand(F.riders[0], F.riders[1] + 1) | 0));
    const edibleKey = pickEdible(tier);
    for (let i = 0; i < nR; i++) {
      const c = carved[i];
      kept.push({ t0: c.t0, x: c.x, y: c.y, h: c.h, size: P * rand(F.edible[0], F.edible[1]), edible: true, species: edibleKey, dmin: c.dmin });
    }
    kept.sort((a, b) => a.t0 - b.t0);
    // min clearance from the reference path to any remaining hazard (surface gap, for tests)
    let minClear = 1e9;
    for (const s of kept) if (!s.edible) minClear = Math.min(minClear, s.dmin - s.size - P);

    // warning directions: player → entry side of each group (deduped)
    const dirs = [];
    for (const g of groups) {
      if (!g.fish.length) continue;
      let gx = 0, gy = 0; for (const f of g.fish) { gx += f.x; gy += f.y; }
      gx = gx / g.fish.length - player.pos.x; gy = gy / g.fish.length - player.pos.y;
      const l = Math.hypot(gx, gy) || 1, ux = gx / l, uy = gy / l;
      if (!dirs.some((q) => q.x * ux + q.y * uy > 0.9)) dirs.push({ x: ux, y: uy });
    }
    const id = nextId++;
    wave = {
      id, pattern, name: `${cap(species)} ${F.names[pattern]}`, species, V, fishSize, gapW, clr,
      spawns: kept, next: 0, fish: [], t: -F.warn, started: false, age: 0, path, ox: O.x, oy: O.y, minClear, tier,
    };
    playerEaten = false;
    api.active = true; api.wave = wave;
    stats.lastMinClear = minClear;
    eco.pauseCrossers && eco.pauseCrossers(true);
    eco.clearStatics && eco.clearStatics(player.pos.x, player.pos.y, vr * 1.05, vr * 2.8);   // off-screen only
    bus.emit('waveWarn', { id, name: wave.name, dirs, time: F.warn });
    return true;
  }

  // Pattern layouts → groups [{t0, fixed?, fish:[{x,y,h,dt?}]}], relative to anchor O and the player's heading.
  function layout(pattern, O, heading, vr, fs, d, tr) {
    const s = fs * 2 * F.spacing, W = F.halfWidth * vr, D = F.enterDist * vr;
    const groups = [];
    // entry direction: any side except straight ahead-on (no head-on rush) → angle relative to heading
    const side = Math.random() < 0.5 ? 1 : -1;
    const rel = side * rand(0.5, 2.2);                        // fish come FROM heading+rel… (0 = from ahead)
    const a = heading + rel + Math.PI;                         // motion direction u (fish travel along u)
    const wall = (ang, t0, cxo = 0, cyo = 0, halfW = W, gapAt = null) => {
      const ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;
      const fish = [];
      const K = Math.ceil(halfW / s);
      for (let k = -K; k <= K; k++) fish.push({ x: O.x + cxo - ux * D + vx * k * s, y: O.y + cyo - uy * D + vy * k * s, h: ang });
      return { t0, fish };
    };
    if (pattern === 'wall') groups.push(wall(a, 0));
    else if (pattern === 'lanes') {
      const n = 3 + Math.round(2 * d), dt = 1.7 - 0.6 * d;
      for (let j = 0; j < n; j++) groups.push(wall(a, j * dt));
    } else if (pattern === 'chevron') {
      const ux = Math.cos(a), uy = Math.sin(a), vx = -uy, vy = ux;
      const K = Math.ceil(W / s), fish = [];
      for (let k = -K; k <= K; k++) {
        const back = Math.abs(k) * s * 0.85;
        fish.push({ x: O.x - ux * (D + back) + vx * k * s, y: O.y - uy * (D + back) + vy * k * s, h: a });
      }
      groups.push({ t0: 0, fish });
    } else if (pattern === 'rain') {
      const ang = a + side * 0.35;                              // diagonal relative to the base direction
      const ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;
      const L = Math.max(s * 2.5, fs * 6), rows = 4 + Math.round(2 * d), dt = 1.1 - 0.35 * d;
      const K = Math.ceil(W / L);
      for (let j = 0; j < rows; j++) {
        const fish = [];
        for (let k = -K; k <= K; k++) {
          const off = (k + (j % 2) * 0.5) * L;
          fish.push({ x: O.x - ux * D + vx * off, y: O.y - uy * D + vy * off, h: ang });
        }
        groups.push({ t0: j * dt, fish });
      }
    } else if (pattern === 'crossfire') {
      groups.push(wall(a, 0));
      const g2 = wall(a + Math.PI, 0.6 + 0.6 * (1 - d));
      groups.push(g2);
    } else if (pattern === 'pincer') {
      const spread = 0.55;
      groups.push(wall(a + spread, 0, 0, 0, W * 0.9));
      groups.push(wall(a - spread, 0.15, 0, 0, W * 0.9));
    } else if (pattern === 'ring') {
      // burst point off to the side (perpendicular to heading), rays fanning toward the player's area
      const R0 = 1.6 * vr, sideA = heading + side * Math.PI / 2;
      const cx = O.x + Math.cos(sideA) * R0, cy = O.y + Math.sin(sideA) * R0;
      const toO = Math.atan2(O.y - cy, O.x - cx);
      const nRays = 9 + Math.round(4 * d), fan = 1.0, pulses = 3 + Math.round(d), dt = 0.9 - 0.25 * d;
      for (let j = 0; j < pulses; j++) {
        const fish = [];
        const jitter = (j % 2) * (fan * 2 / (nRays - 1)) * 0.5;
        for (let r = 0; r < nRays; r++) {
          const ang = toO - fan + (2 * fan * r) / (nRays - 1) + jitter;
          fish.push({ x: cx, y: cy, h: ang });
        }
        groups.push({ t0: j * dt, fish, fixed: true });
      }
    }
    return groups;
  }

  function pickEdible(tier) {
    let best = 'sardine', bw = 0;
    for (const k of EDIBLE_SPECIES) {
      const w = ((SPECIES[k] && SPECIES[k].tiers) || {})[tier] || 0;
      const r = w * Math.random();
      if (r > bw) { bw = r; best = k; }
    }
    return best;
  }

  // ---------- running a wave ----------
  function stepWave(dt, player, vr) {
    const w = wave;
    w.t += dt; w.age += dt;
    while (w.next < w.spawns.length && w.spawns[w.next].t0 <= w.t) {
      const s = w.spawns[w.next++];
      if (!w.started) { w.started = true; bus.emit('waveStart', { id: w.id }); }
      const f = eco.spawnLiner(s.edible ? s.species : w.species, s.size, s.x, s.y, s.h, s.edible ? w.V : w.V, { waveId: w.id, edible: s.edible, despawnMul: 2.2 });
      if (f) { f.ai.entered = false; w.fish.push(f); }
    }
    // done when everything spawned and every wave fish is gone or has left endRadius·vr (moving away)
    if (w.next >= w.spawns.length) {
      const R2 = (F.endRadius * vr) ** 2, maxAge = (3.4 * vr) / Math.max(1, w.V);
      let remaining = 0;
      for (const f of w.fish) {
        if (!f.alive) continue;
        const dx = f.pos.x - player.pos.x, dy = f.pos.y - player.pos.y, d2 = dx * dx + dy * dy;
        if (d2 < R2) { f.ai.entered = true; remaining++; continue; }
        if (!f.ai.entered && f.age < maxAge) remaining++;           // still on its way in
      }
      if (remaining === 0) { endWave(!playerEaten); return; }
    }
    if (w.age > F.timeout + F.warn) endWave(!playerEaten);
  }

  function endWave(cleared, silent = false) {
    const w = wave;
    if (!w) return;
    wave = null; api.active = false; api.wave = null;
    eco.pauseCrossers && eco.pauseCrossers(false);
    if (silent) return;
    stats.waves++; if (cleared) stats.cleared++;
    eco.breather && eco.breather(F.breatherAfter);
    nextAt = runClock + rand(F.interval[0], F.interval[1]);
    bus.emit('waveEnd', { id: w.id, cleared: !!cleared });
  }

  return api;
}
