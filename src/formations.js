// FORMATION WAVES — shmup-style geometric herds that come AT the player in straight lines.
//
// createFormations({ bus, eco, terrain }) → { update(dt, t, player, state, viewRadius), reset(), active, wave, stats,
//                                             debugStart(pattern, player, viewRadius, state) }
//
// Every pattern starts fully OFF-SCREEN (outside the real screen rectangle, ≥ ~1.3·viewRadius) and travels toward the
// player's position at warning time (the aim point Q). Nothing pops in on-screen: each group is re-checked against the
// player's actual position when it spawns and pushed back along its own line if needed.
// Patterns (all straight lines):
//   wall      — one wall aimed at Q with a gap        lanes  — 3–5 staggered walls, gaps drift lane to lane
//   chevron   — V whose point aims at Q, gap in an arm rain  — rhythmic rows of columns (every column gap ≥ gap rule)
//   crossfire — two walls from opposite sides, both through Q, gaps at different spots
//   pincer    — two walls from ±35° converging on Q, each with a gap
//   ring      — 'close': a ring converging on Q with an angular gap;  'fan': rays fanning from an off-screen point
// Gaps: width ≥ (3·P + margin) × turn-scale (wider for slow turners); centre at a random offset within ±0.5·vr of the
//   aim line, shifted into the lateral range the player can actually reach (their speed + turn rate, reaction delay)
//   before impact. Impact can't happen before ~2.5 s after the warning (groups are spaced to guarantee it).
// Edible riders (0.5–0.8·P) travel inside the gaps and at the tail: risk/reward.
// Scheduling: level-up wave ~8 s after 'evolve'; otherwise every 35–55 s. Never during boss fights (state.boss),
//   the first 25 s of a run, or eco breathers. Director crossers/darters pause during a wave; a 4 s breather after.
// Bus: waveWarn {id, name, dirs:[{x,y}], time} (dirs = unit vectors player → where fish come from),
//      waveStart {id}, waveEnd {id, cleared}. Rebase: aim point + pending group positions shift by (-dx,-dy).
import { CONFIG, SPECIES, tierIndexFor, playerSpeed, playerTurn, wrapAngle } from './config.js';
import { screenEdgeDist, viewAspect } from './ecosystem.js';

const F = {
  warn: 1.8,                // warning before the first fish spawns
  levelUpDelay: 8, interval: [35, 55], firstAfter: 25, breatherAfter: 4,
  endRadius: 1.5, timeout: 30,
  sizeMul: [1.3, 1.8],      // fish size × P
  speed: [0.6, 0.85], fairSpeedCap: 0.9,   // × playerSpeed
  gapBase: 3, gapMargin: 3, turnScaleK: 0.3,   // gap ≥ (gapBase·P + gapMargin) × (1 + K·(baseTurn/playerTurn(P) − 1))
  gapOffset: 0.5,           // gap centre within ±this × vr of the aim line
  spacing: 1.08,            // × fish diameter along a wall (no squeezing between fish)
  enterDist: 1.35,          // groups start ≥ this × vr from the aim point (and outside the screen rect)
  screenMargin: 1.2,        // … and ≥ screen-edge distance × this
  halfWidth: 1.25,          // wall half-length × vr
  minImpact: 2.5,           // s after the warning before anything can reach the player (worst case closing)
  reaction: 0.4,            // reach model: seconds before the player starts steering
  reactTime: 2.0,           // ≥ this from appearing on screen to impact even if the player swims straight at it
  minSpeed: 0.4,            // group speed floor × playerSpeed (the reactTime cap may lower speeds to this)
  edible: [0.5, 0.8],
  pools: [
    ['wall', 'chevron'], ['wall', 'chevron'],
    ['wall', 'chevron', 'lanes', 'rain'], ['lanes', 'rain', 'chevron', 'wall'],
    ['lanes', 'rain', 'crossfire', 'pincer', 'ring'], ['crossfire', 'pincer', 'ring', 'lanes', 'rain'],
    ['crossfire', 'pincer', 'ring', 'lanes', 'rain'],
  ],
  names: { wall: 'Wall', lanes: 'Lanes', chevron: 'Chevron', rain: 'Rain', crossfire: 'Crossfire', ring: 'Ring', pincer: 'Pincer' },
};
const EDIBLE_SPECIES = ['krill', 'sardine', 'lanternfish', 'clownfish', 'tang', 'microbe'];
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function createFormations({ bus, eco, terrain }) {
  let runClock = 0, nextAt = 0, levelUpAt = -1, nextId = 1;
  let wave = null, playerEaten = false;
  const stats = { waves: 0, cleared: 0 };
  const api = {
    active: false, wave: null, stats, update, reset,
    debugStart: (pattern, player, viewRadius, state) => startWave(player, viewRadius, state || {}, pattern),
  };

  bus.on('evolve', () => { levelUpAt = runClock + F.levelUpDelay; });
  bus.on('eat', (p) => { if (wave && p && p.eaten && p.eaten.isPlayer) playerEaten = true; });
  bus.on('playerDeath', () => { if (wave) playerEaten = true; });
  bus.on('rebase', (r) => {
    if (!wave || !r) return;
    const dx = r.dx || 0, dy = r.dy || 0;
    wave.qx -= dx; wave.qy -= dy;
    for (const g of wave.groups) for (const f of g.fish) { f.x -= dx; f.y -= dy; }
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
      const lvl = levelUpAt > 0 && runClock >= levelUpAt;
      const due = lvl || runClock >= nextAt;
      const allowed = runClock >= F.firstAfter && !(state && state.boss) && eco.phase !== 'breather' && player.alive;
      if (due && allowed) {
        if (startWave(player, vr, state, null)) { if (lvl) levelUpAt = -1; }
        else nextAt = runClock + 3;
      }
      return;
    }
    stepWave(dt, player, vr);
  }

  // ---------- building ----------
  function startWave(player, vr, state, forcePattern) {
    const P = player.size;
    const tier = Math.min(F.pools.length - 1, state && state.tier != null ? state.tier : tierIndexFor(P));
    const d = clamp(tier / 6, 0, 1);
    const pool = F.pools[tier];
    const pattern = forcePattern || pool[(Math.random() * pool.length) | 0];
    const sp = playerSpeed(P), tr = playerTurn(P);
    const V = Math.min(F.fairSpeedCap, rand(F.speed[0], F.speed[1]) + 0.05 * d) * sp;
    const fs = P * rand(F.sizeMul[0], F.sizeMul[1]);
    const species = eco.pickSpecies ? eco.pickSpecies(tier, fs) : 'sardine';
    const turnScale = 1 + F.turnScaleK * (CONFIG.player.baseTurn / tr - 1);
    const gapW = (F.gapBase * P + F.gapMargin) * turnScale;
    const aspect = viewAspect();
    const qx = player.pos.x, qy = player.pos.y;
    const h = Math.hypot(player.vel.x, player.vel.y) > 0.5 ? Math.atan2(player.vel.y, player.vel.x) : player.heading;
    // entry side (direction FROM the player TO where fish come from): facing side or random, mostly horizontal
    let e = Math.random() < 0.5 ? h + rand(-0.5, 0.5) : Math.random() * Math.PI * 2;
    if (Math.abs(Math.sin(e)) > 0.8) e = Math.atan2(Math.sin(e) * 0.5, Math.cos(e));
    const ctx = { P, sp, tr, V, fs, gapW, vr, aspect, qx, qy, h, d };
    const groups = layout(pattern, e, ctx);
    if (!groups.length) return false;

    // riders: edible fish in each wall's gap + one at the tail
    const edibleKey = pickEdible(tier);
    for (const g of groups) if (g.gap) g.fish.push({ x: g.gap.x, y: g.gap.y, h: g.gap.h, edible: true });
    const last = groups[groups.length - 1];
    if (last.fish.length && last.uniform) {
      const f0 = last.fish[(last.fish.length / 2) | 0];
      last.fish.push({ x: f0.x - Math.cos(f0.h) * fs * 4, y: f0.y - Math.sin(f0.h) * fs * 4, h: f0.h, edible: true });
    }
    // warning directions
    const dirs = [];
    for (const g of groups) {
      if (!g.fish.length) continue;
      let gx = 0, gy = 0; for (const f of g.fish) { gx += f.x; gy += f.y; }
      gx = gx / g.fish.length - qx; gy = gy / g.fish.length - qy;
      if (g.ring) { gx = Math.cos(g.gapDir); gy = Math.sin(g.gapDir); }   // closing ring: from everywhere; point at the gap
      const l = Math.hypot(gx, gy) || 1, ux = gx / l, uy = gy / l;
      if (!dirs.some((q) => q.x * ux + q.y * uy > 0.9)) dirs.push({ x: ux, y: uy });
    }
    const id = nextId++;
    wave = {
      id, pattern, name: `${cap(species)} ${F.names[pattern]}`, species, edibleKey, V, fs, gapW, P,
      groups, next: 0, fish: [], t: -F.warn, started: false, age: 0, qx, qy, tier,
    };
    playerEaten = false;
    api.active = true; api.wave = wave;
    eco.pauseCrossers && eco.pauseCrossers(true);
    bus.emit('waveWarn', { id, name: wave.name, dirs, time: F.warn });
    return true;
  }

  // Lateral range [lo, hi] (along v) the player can reach before `T` seconds, given heading/speed/turn rate.
  function lateralReach(ctx, vx, vy, T) {
    const { sp, tr, h } = ctx;
    const res = [0, 0];
    for (let s = 0; s < 2; s++) {
      const target = Math.atan2(s ? -vy : vy, s ? -vx : vx);
      let x = 0, y = 0, a = h;
      for (let t = 0; t < T; t += 0.05) {
        if (t > F.reaction) a += clamp(wrapAngle(target - a), -tr * 0.05, tr * 0.05);
        x += Math.cos(a) * sp * 0.05; y += Math.sin(a) * sp * 0.05;
      }
      res[s] = x * vx + y * vy;
    }
    return [Math.min(res[0], res[1]), Math.max(res[0], res[1])];
  }
  // Pick a gap offset within ±gapOffset·vr, shifted into the reachable lateral range.
  function chooseGap(ctx, vx, vy, T, avoid = null) {
    const [lo, hi] = lateralReach(ctx, vx, vy, T);
    const half = ctx.gapW / 2 - ctx.P * 1.1;
    let g = rand(-F.gapOffset, F.gapOffset) * ctx.vr;
    if (avoid !== null && Math.abs(g - avoid) < ctx.gapW * 1.5) g = avoid + (g >= avoid ? 1 : -1) * ctx.gapW * 1.5;
    return clamp(g, lo - half, hi + half);
  }
  // Start distance for a group moving along u (toward Q) so it is off-screen and impact ≥ minImpact after warning.
  function startDist(ctx, ux, uy, extra = 0) {
    const { vr, aspect, fs, sp, V, P } = ctx;
    const edge = screenEdgeDist(-ux, -uy, vr, aspect);
    const impact = (F.minImpact - F.warn) * (V + sp) + fs + P;   // worst case: player swims straight at it
    return Math.max(F.enterDist * vr, edge * F.screenMargin + fs, impact) + extra;
  }

  // Group speed: wave speed, capped so a fish entering from direction (-ux,-uy) needs ≥ reactTime from the screen
  // edge to the player even if the player swims straight at it.
  function groupSpeed(ctx, ux, uy) {
    const { vr, aspect, fs, P, sp, V, h } = ctx;
    const edge = screenEdgeDist(-ux, -uy, vr, aspect);
    const toward = Math.max(0, Math.cos(h) * -ux + Math.sin(h) * -uy) * sp;
    return clamp((edge - fs - P) / F.reactTime - toward, F.minSpeed * sp, V);
  }
  // A straight wall moving along `ang`, centred on the aim line through Q, with one gap (offset g along v).
  function wall(ctx, ang, t0, halfW, avoid = null) {
    const { vr, fs, gapW, qx, qy, sp, V } = ctx;
    const ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;
    const D = startDist(ctx, ux, uy);
    const Vg = groupSpeed(ctx, ux, uy);
    const Tarr = F.warn + t0 + D / (Vg + sp * 0.5);
    const g = chooseGap(ctx, vx, vy, Tarr, avoid);
    const s = fs * 2 * F.spacing, K = Math.ceil(halfW / s);
    const fish = [];
    for (let k = -K; k <= K; k++) {
      const off = k * s;
      if (Math.abs(off - g) < gapW / 2 + fs) continue;           // the gap
      fish.push({ x: qx - ux * D + vx * off, y: qy - uy * D + vy * off, h: ang });
    }
    return { t0, fish, uniform: true, ux, uy, g, V: Vg, gap: { x: qx - ux * D + vx * g, y: qy - uy * D + vy * g, h: ang } };
  }

  function layout(pattern, e, ctx) {
    const { vr, fs, gapW, qx, qy, d, sp, V, tr, h } = ctx;
    const a = e + Math.PI;                                       // travel direction: from entry side toward Q
    const W = F.halfWidth * vr;
    const groups = [];
    if (pattern === 'wall') groups.push(wall(ctx, a, 0, W));
    else if (pattern === 'lanes') {
      const n = 3 + Math.round(2 * d), dt = 1.6 - 0.5 * d;
      let prev = null;
      for (let j = 0; j < n; j++) {
        const gw = wall(ctx, a, j * dt, W, null);
        if (prev !== null) {   // keep consecutive gaps within lateral reach of each other
          const maxShift = sp * dt * 0.6;
          const g = clamp(gw.g, prev - maxShift, prev + maxShift);
          if (g !== gw.g) { const w2 = wallAt(ctx, a, j * dt, W, g); groups.push(w2); prev = g; continue; }
        }
        groups.push(gw); prev = gw.g;
      }
    } else if (pattern === 'chevron') {
      const ux = Math.cos(a), uy = Math.sin(a), vx = -uy, vy = ux;
      const s = fs * 2 * F.spacing, K = Math.ceil(W / s);
      const D = startDist(ctx, ux, uy);
      const Tarr = F.warn + D / (V + sp * 0.5);
      let g = chooseGap(ctx, vx, vy, Tarr);
      if (Math.abs(g) < s * 1.5) g = (g >= 0 ? 1 : -1) * s * 1.5;  // gap in an arm, not the point
      const fish = [];
      for (let k = -K; k <= K; k++) {
        const off = k * s, back = Math.abs(off) * 0.85;
        if (Math.abs(off - g) < gapW / 2 + fs) continue;
        fish.push({ x: qx - ux * (D + back) + vx * off, y: qy - uy * (D + back) + vy * off, h: a });
      }
      const gb = Math.abs(g) * 0.85;
      groups.push({ t0: 0, fish, uniform: true, V: groupSpeed(ctx, ux, uy), gap: { x: qx - ux * (D + gb) + vx * g, y: qy - uy * (D + gb) + vy * g, h: a } });
    } else if (pattern === 'rain') {
      // rows of columns aimed at Q; every column gap is a legal gap, rows alternate by half a spacing
      const ux = Math.cos(a), uy = Math.sin(a), vx = -uy, vy = ux;
      const L = gapW + fs * 2 * 1.1, rows = 4 + Math.round(2 * d), dt = 1.1 - 0.35 * d;
      const D = startDist(ctx, ux, uy), K = Math.ceil(W / L), off0 = rand(-0.5, 0.5) * L;
      for (let j = 0; j < rows; j++) {
        const fish = [];
        for (let k = -K; k <= K; k++) {
          const off = off0 + (k + (j % 2) * 0.5) * L;
          fish.push({ x: qx - ux * D + vx * off, y: qy - uy * D + vy * off, h: a });
        }
        const go = off0 + ((j % 2) * 0.5 + 0.5) * L;
        groups.push({ t0: j * dt, fish, uniform: true, V: groupSpeed(ctx, ux, uy), gap: j === 1 ? { x: qx - ux * D + vx * go, y: qy - uy * D + vy * go, h: a } : null });
      }
    } else if (pattern === 'crossfire') {
      const g1 = wall(ctx, a, 0, W);
      const g2 = wall(ctx, a + Math.PI, 0.5 + 0.4 * (1 - d), W, -g1.g);   // opposite side; gap at a different spot
      groups.push(g1, g2);
    } else if (pattern === 'pincer') {
      const g1 = wall(ctx, a + 0.6, 0, W * 0.85);
      const g2 = wall(ctx, a - 0.6, 0.15, W * 0.85);
      groups.push(g1, g2);
    } else if (pattern === 'ring') {
      if (Math.random() < 0.5) {
        // CLOSE: ring converging on Q with one angular gap the player can turn into
        const Rr = Math.max(F.enterDist * vr, vr * F.screenMargin) + fs;
        const rMeet = Rr * sp / (V + sp);
        const s = fs * 2 * F.spacing;
        const N = Math.max(10, Math.ceil((2 * Math.PI * rMeet) / s));
        const Tm = F.warn + Rr / (V + sp);
        const maxTurn = Math.min(1.75, tr * Math.max(0, Tm - F.reaction) * 0.7);
        const gapDir = h + rand(-maxTurn, maxTurn);
        const gapAng = (gapW + 2 * fs) / Math.max(1, rMeet);
        const fish = [];
        for (let k = 0; k < N; k++) {
          const ang = (k / N) * Math.PI * 2;
          if (Math.abs(wrapAngle(ang - gapDir)) < gapAng / 2) continue;
          fish.push({ x: qx + Math.cos(ang) * Rr, y: qy + Math.sin(ang) * Rr, h: ang + Math.PI });
        }
        groups.push({ t0: 0, fish, uniform: false, ring: true, gapDir, V: groupSpeed(ctx, -Math.cos(h), -Math.sin(h)),
          gap: { x: qx + Math.cos(gapDir) * Rr * 1.08, y: qy + Math.sin(gapDir) * Rr * 1.08, h: gapDir + Math.PI } });
      } else {
        // FAN: rays from an off-screen point toward Q; rays near the gap offset are skipped; 3 pulses
        const Db = startDist(ctx, Math.cos(a), Math.sin(a)) + vr * 0.2;
        const bx = qx + Math.cos(e) * Db, by = qy + Math.sin(e) * Db;
        const toQ = Math.atan2(qy - by, qx - bx);
        const s = fs * 2 * F.spacing, dAng = s / Db, fan = Math.atan(W / Db);
        const vx = -Math.sin(toQ), vy = Math.cos(toQ);
        const g = chooseGap(ctx, vx, vy, F.warn + Db / (V + sp * 0.5));
        const pulses = 3 + Math.round(d), dt = 0.9 - 0.25 * d;
        for (let j = 0; j < pulses; j++) {
          const fish = [];
          for (let ang = -fan; ang <= fan + 1e-6; ang += dAng) {
            const lat = Math.tan(ang) * Db;
            if (Math.abs(lat - g) < gapW / 2 + fs) continue;
            fish.push({ x: bx, y: by, h: toQ + ang });
          }
          const ga = Math.atan(g / Db);
          groups.push({ t0: j * dt, fish, uniform: false, V: groupSpeed(ctx, Math.cos(a), Math.sin(a)), gap: j === 0 ? { x: bx, y: by, h: toQ + ga } : null });
        }
      }
    }
    return groups.filter((gr) => gr.fish.length);
  }
  function wallAt(ctx, ang, t0, halfW, g) {
    const { fs, gapW, qx, qy } = ctx;
    const ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;
    const D = startDist(ctx, ux, uy);
    const s = fs * 2 * F.spacing, K = Math.ceil(halfW / s), fish = [];
    for (let k = -K; k <= K; k++) {
      const off = k * s;
      if (Math.abs(off - g) < gapW / 2 + fs) continue;
      fish.push({ x: qx - ux * D + vx * off, y: qy - uy * D + vy * off, h: ang });
    }
    return { t0, fish, uniform: true, ux, uy, g, V: groupSpeed(ctx, ux, uy), gap: { x: qx - ux * D + vx * g, y: qy - uy * D + vy * g, h: ang } };
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

  // ---------- running ----------
  function stepWave(dt, player, vr) {
    const w = wave;
    w.t += dt; w.age += dt;
    const aspect = viewAspect();
    while (w.next < w.groups.length && w.groups[w.next].t0 <= w.t) {
      const g = w.groups[w.next++];
      if (!w.started) { w.started = true; bus.emit('waveStart', { id: w.id }); }
      // nothing pops in on-screen: push the group back along its line(s) until it's outside the screen rectangle
      const margin = w.fs * 1.5;
      const inside = (x, y) => Math.abs(x - player.pos.x) < vr + margin && Math.abs(y - player.pos.y) < vr / aspect + margin;
      if (g.uniform) {
        let push = 0;
        for (const f of g.fish) {
          let k = 0;
          while (inside(f.x - Math.cos(f.h) * (push + k), f.y - Math.sin(f.h) * (push + k)) && k < vr * 4) k += w.fs;
          push += k;
        }
        if (push > 0) for (const f of g.fish) { f.x -= Math.cos(f.h) * push; f.y -= Math.sin(f.h) * push; }
      } else {
        for (const f of g.fish) { let k = 0; while (inside(f.x, f.y) && k < 200) { f.x -= Math.cos(f.h) * w.fs; f.y -= Math.sin(f.h) * w.fs; k++; } }
      }
      for (const f of g.fish) {
        const size = f.edible ? w.P * rand(F.edible[0], F.edible[1]) : w.fs;
        const fish = eco.spawnLiner(f.edible ? w.edibleKey : w.species, size, f.x, f.y, f.h, g.V || w.V, { waveId: w.id, despawnMul: 2.2 });
        if (fish) w.fish.push(fish);
      }
    }
    if (w.next >= w.groups.length) {
      const R2 = (F.endRadius * vr) ** 2, maxAge = (3.4 * vr) / Math.max(1, w.V * F.minSpeed / F.speed[1]);
      let remaining = 0;
      for (const f of w.fish) {
        if (!f.alive) continue;
        const dx = f.pos.x - player.pos.x, dy = f.pos.y - player.pos.y, d2 = dx * dx + dy * dy;
        if (d2 < R2) { f.ai.entered = true; remaining++; continue; }
        if (!f.ai.entered && f.age < maxAge) remaining++;
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
