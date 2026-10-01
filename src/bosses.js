// Bosses for the INFINITE sea: Angler King (t2), Giant Octopus (t3), Moray Eel (t4), Great White (t6, final).
//
// There are no fixed places: the first time the player reaches BOSSES[k].tier, that boss spawns off-screen AHEAD
// of the player (~spawnDist × viewRadius, open water) at ≥ minBossRatio × the player's size and engages at once.
// One boss at a time. Its territory ("home") is an anchor that starts at the spawn point and slowly follows the
// player, so the fight stays local. Flee past despawnMul × viewRadius → it disengages and despawns; an undefeated
// boss comes back later (after returnCalm seconds without a boss). Defeated bosses are gone for the run.
//
// Same physics as every fish: forward = (cos h, sin h, 0), heading turns toward a desired heading at a capped
// rate (slow, scaled by size), terrain.collide() each frame (sparse landmark rocks only).
//
// Fight loop (every boss): telegraph → straight attack → vulnerable window. While `vulnerable`, a bite from the
// player's mouth on the weak spot (`weakSpot`: 'rear' = behind its center, 'any' = anywhere) costs 1 hp
// (max hitsPerWindow per window). Outside the window the boss's mouth eats the player (normal `eat` event).
//
// Fields on boss entities (renderer / UI):
//   isBoss, hp, maxHp, vulnerable, phase, hitFlash (0..1), name, home {x,y}, engaged (bool),
//   telegraph (0..1 progress of the current wind-up), attacking (bool during lunge/charge/sweep/strike),
//   vulnT / vulnMax (seconds left / total of the vulnerable window), weakSpot ('rear'|'any'|''),
//   rage (0..1, rises below ~60% hp), lureDim (0..1, Angler King: lures go dark = telegraph),
//   coil (0..1, Moray: coiled wind-up pose).
// Phases: anglerking lurk/telegraph/strike/dazed · octopus drift/telegraph/sweep/ink/dart/exhausted ·
//         moray swim/telegraph/lunge/recover · greatwhite circle/telegraph/charge/stunned/tired.
import { CONFIG, BOSSES, turnToward, wrapAngle, playerSpeed, tierIndexFor } from './config.js';
import { makeFish } from './entities.js';

// ---------- tuning knobs ----------
// Speeds/distances are in units of S, the "fight scale": S = playerSpeed(player) × min(1, viewRadius / (viewFit ×
// playerSpeed)) — multiples of the player's own cruise speed, shrunk when the camera is close so attacks start
// on-screen. Times are seconds. Body sizes (mouth, back) are multiples of boss.size.
const T = {
  minBossRatio: 1.6,        // boss.size = max(def.size, player.size * this) at spawn and during the fight
  spawnDist: 1.3,           // spawn this × viewRadius ahead of the player
  despawnMul: 2.5,          // player farther than this × viewRadius (+ boss.size) → disengage + despawn
  returnCalm: 60,           // seconds without any boss before an undefeated, fled-from boss may return
  firstDelay: 2,            // seconds after reaching a tier before its boss spawns
  gap: 8,                   // min seconds between one boss leaving and the next appearing
  anchorFollow: 0.6,        // territory anchor follows the player at this × S (when farther than anchorSlack × S)
  anchorSlack: 3,
  viewFit: 5.5,
  turnBase: 3.4, turnExp: 0.35,   // turn = turnBase * turnMul / size^turnExp (rad/s)
  bossHitCd: 0.6,           // boss invulnerability after taking a hit
  hitsPerWindow: 2,         // max damage per vulnerable window (fight ≈ hp / this windows)
  biteGrace: 0.5,           // boss can't bite for this long after a vulnerable window ends
  knock: 1.6,               // knockback on the player after a successful bite (× player cruise speed)
  bodyPush: 0.8,            // player center kept ≥ boss.size*bodyPush + player.size*0.6 from boss center
  brake: 5,                 // min deceleration rate (1/s)
  mouthFwd: 0.75,           // boss mouth = pos + fwd * size * mouthFwd
  rageFrom: 0.6, rageSpan: 0.45,  // rage = clamp((rageFrom - hp/maxHp) / rageSpan, 0, 1)
  rageSpeed: 0.3, rageTele: 0.25, // at full rage: +30% speed, -25% telegraph time
  anglerking: {               // FIRST boss: lures in the dark, strike from range
    turnMul: 0.75, mouth: 0.5, back: 1.0, arena: 6,
    approach: 0.8, reposition: 0.21, lurkTime: [3, 4.5], standoff: 4.0,
    telegraph: 1.0, teleTurnMul: 2, pullBack: 0.1, lead: 0.1,
    strikeSpeed: 3.6, strikeDist: 7.3, strikeTurn: 0.15, strikeTrack: 0.25, overshoot: 1.05,
    dazed: 3.5, dazedRage: 0.2, dazedSpeed: 0.07,
  },
  octopus: {
    turnMul: 1.0, mouth: 0.75, back: 0.9, arena: 7,
    chaseSpeed: 0.9, inkAnyway: 9,     // inks even without a sweep after this long drifting
    sweepRange: 3.5, sweepTele: 0.75, sweepSpeed: 2.3, sweepTime: 0.6, sweepMouth: 1.1, sweepCd: 3.2, sweepTurn: 0.3,
    inkEvery: 7, inkRange: 6.5, inkRadius: 4.5, inkTime: 0.3,   // inkRadius × boss.size; ink needs ≥1 sweep first
    dartSpeed: 2.1, dartTime: 0.45, dartTurn: 1.5,
    exhausted: 3.5, exhaustedSpeed: 0.14, sag: 0.1,
  },
  moray: {                    // free-swimming eel: coils, then long straight lunges
    turnMul: 1.2, mouth: 0.6, back: 2.6,
    swimSpeed: 0.75, swimR: 4.5, swimTime: [2.2, 3.5],  // slithers around the player at ~swimR × S
    telegraph: 0.85, coilBack: 0.3, teleTurnMul: 1.5, lead: 0.1,  // coiled wind-up (backs off a little)
    lungeSpeed: 4.0, lungeDist: 8, overshoot: 2.0,     // long, straight; ends overshoot × S past the player
    recover: 3.0, recoverSpeed: 0.12,                  // slow recovery: vulnerable, bite anywhere
  },
  greatwhite: {               // FINAL boss: open water
    turnMul: 0.6, mouth: 0.5, back: 1.3,
    circleR: 3.6, circleSpeed: 0.93, circleTime: [3, 5], circleShrink: 0.35,
    telegraph: 1.1, teleTurnMul: 3, lead: 0,
    chargeSpeed: 3.0, chargeTurn: 0.1, chargeTrack: 0.35, chargeDist: 10.5, overshoot: 1.2,
    stunned: 3.2, tired: 4.0, tiredSpeed: 0.16, wallStun: 0.5,
  },
};
const KEYS = Object.keys(BOSSES).sort((a, b) => BOSSES[a].tier - BOSSES[b].tier);
const DISENGAGE = {};
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);

export function createBosses({ scene, bus, terrain }) {
  const list = [];          // 0 or 1 live boss
  let engaged = null;
  let viewR = 80;
  let maxTier = 0;
  let calmT = 0;            // seconds with no boss present
  let tierT = 0;            // seconds since maxTier last rose
  const status = {};        // key → 'pending' | 'away' | 'defeated'
  const api = { list, reset, update };

  bus.on('rebase', ({ dx, dy }) => {
    for (const b of list) { b.home.x -= dx; b.home.y -= dy; }
  });

  // ---------- scale ----------
  function scaleOf(p) {
    const v = playerSpeed(p.size);
    return v * Math.min(1, viewR / (T.viewFit * v));
  }

  // ---------- lifecycle ----------
  function reset() {
    if (engaged) { engaged.engaged = false; engaged = null; bus.emit('bossDisengage', DISENGAGE); }
    for (const b of list) b.alive = false;
    list.length = 0;
    for (const k of KEYS) status[k] = 'pending';
    maxTier = 0; calmT = T.gap; tierT = 0;
  }
  reset();

  const isOpen = (x, y, r) => (terrain && terrain.isOpen ? terrain.isOpen(x, y, r) : true);

  function trySpawn(key, p) {
    const def = BOSSES[key];
    const size = Math.max(def.size, p.size * T.minBossRatio);
    const dist = T.spawnDist * viewR + size;
    // "ahead" = where the player is going
    const vx = p.vel.x, vy = p.vel.y;
    const base = vx * vx + vy * vy > 1 ? Math.atan2(vy, vx) : p.heading;
    for (let i = 0; i < 9; i++) {
      const a = base + (i === 0 ? 0 : ((i + 1) >> 1) * 0.35 * (i & 1 ? 1 : -1));
      const x = p.pos.x + Math.cos(a) * dist, y = p.pos.y + Math.sin(a) * dist;
      if (!isOpen(x, y, size * 1.5)) continue;
      const b = makeFish(key, size, x, y, Math.atan2(p.pos.y - y, p.pos.x - x));
      b.mass = size * size;
      Object.assign(b, {
        isBoss: true, hp: def.hp, maxHp: def.hp, vulnerable: false, phase: 'idle', hitFlash: 0, alive: true,
        name: def.name, home: { x, y }, engaged: true, telegraph: 0, attacking: false, vulnT: 0, vulnMax: 0,
        weakSpot: '', rage: 0, lureDim: 0, coil: 0, lastWallNx: 0, lastWallNy: 0,
      });
      b.pos.z = 0;
      const ai = b.ai;
      ai.t = 0; ai.dur = 0; ai.speed = 0; ai.hitCd = 0; ai.grace = 0; ai.travel = 0; ai.reach = 0;
      ai.collided = false; ai.S = 10; ai.winHits = 0; ai.swept = false; ai.turn = 1;
      ai.inkT = T[key].inkEvery || 0; ai.sweepCd = 0; ai.circleDir = 1;
      list.push(b);
      engaged = b;
      bus.emit('bossEngage', { boss: b });
      return true;
    }
    return false;
  }

  function despawn(b, why) {
    if (engaged === b) { engaged = null; bus.emit('bossDisengage', DISENGAGE); }
    b.engaged = false; b.alive = false;
    const i = list.indexOf(b); if (i >= 0) list.splice(i, 1);
    if (why === 'defeated') status[b.species] = 'defeated';
    else if (status[b.species] !== 'defeated') status[b.species] = 'away';
    calmT = 0;
  }

  function pickNext() {
    for (const k of KEYS) {
      if (BOSSES[k].tier > maxTier) continue;
      if (status[k] === 'pending' && tierT >= T.firstDelay && calmT >= T.gap) return k;
      if (status[k] === 'away' && calmT >= T.returnCalm) return k;
    }
    return null;
  }

  function setPhase(b, phase, dur = 0, vuln = 0, weak = '') {
    const ai = b.ai;
    if (b.vulnerable && vuln <= 0) ai.grace = T.biteGrace;
    b.phase = phase; ai.t = 0; ai.dur = dur; ai.travel = 0;
    b.vulnerable = vuln > 0; b.vulnT = b.vulnMax = vuln; b.weakSpot = weak;
    if (vuln > 0) ai.winHits = 0;
    b.attacking = false; b.telegraph = 0;
  }

  // ---------- movement ----------
  function move(b, dt, desH, desSpd, turn, accel) {
    const ai = b.ai, prevH = b.heading;
    if (turn > 0) b.heading = wrapAngle(turnToward(b.heading, desH, turn * dt));
    // speed up at `accel`, but always brake quickly so attacks end crisply (no hidden follow-through)
    const k = desSpd < ai.speed ? Math.max(accel, T.brake) : accel;
    ai.speed += (desSpd - ai.speed) * Math.min(1, k * dt);
    const c = Math.cos(b.heading), s = Math.sin(b.heading);
    b.vel.set(c * ai.speed, s * ai.speed, 0);
    b.pos.x += b.vel.x * dt; b.pos.y += b.vel.y * dt;
    ai.collided = false;
    if (terrain && terrain.collide && terrain.collide(b, b.size)) {
      ai.collided = true;
      ai.speed = b.vel.x * c + b.vel.y * s;
    }
    b.pos.z = 0;
    const turn01 = dt > 0 ? clamp(wrapAngle(b.heading - prevH) / dt / ai.turn, -1, 1) : 0;
    b.bank += (turn01 * 0.5 - b.bank) * (1 - Math.exp(-6 * dt));
  }
  // attack ended against rock: a hard hit, or pinned against a rock well below attack speed
  function rammed(b, speed, hard = 0.5) {
    const ai = b.ai;
    return b.wallHit > hard || (ai.collided && ai.t > 0.35 && ai.speed < speed * 0.4);
  }
  function headTo(b, x, y) { return Math.atan2(y - b.pos.y, x - b.pos.x); }
  function swim(b, dt, rate) { b.swimRate += (rate - b.swimRate) * (1 - Math.exp(-6 * dt)); }
  const distP = (b, p) => Math.hypot(p.pos.x - b.pos.x, p.pos.y - b.pos.y);

  // ---------- species brains (always engaged while alive) ----------
  function anglerking(b, dt, p) {
    const K = T.anglerking, ai = b.ai, S = ai.S, sp = S * (1 + T.rageSpeed * b.rage), arena = K.arena * S + b.size;
    const hx = b.home.x, hy = b.home.y;
    if (b.phase === 'idle') setPhase(b, 'lurk', rand(K.lurkTime[0], K.lurkTime[1]));
    let dimTarget = 0;
    if (b.phase === 'lurk') {
      const dx = b.pos.x - p.pos.x, dy = b.pos.y - p.pos.y, d = Math.hypot(dx, dy) || 1;
      const R = K.standoff * S + b.size + p.size;
      let tx = p.pos.x + (dx / d) * R, ty = p.pos.y + (dy / d) * R;
      const thx = tx - hx, thy = ty - hy, th = Math.hypot(thx, thy);
      if (th > arena) { tx = hx + (thx / th) * arena; ty = hy + (thy / th) * arena; }
      const dtg = Math.hypot(tx - b.pos.x, ty - b.pos.y);
      let h, s;
      if (dtg < 0.5 * S + b.size * 0.5) { h = headTo(b, p.pos.x, p.pos.y); s = 0.05 * S; }
      else { h = headTo(b, tx, ty); s = (d > R * 1.6 ? K.approach : K.reposition) * sp; }
      if (ai.t >= ai.dur && d < K.strikeDist * S * 0.9 + b.size) setPhase(b, 'telegraph', K.telegraph * (1 - T.rageTele * b.rage));
      move(b, dt, h, s, ai.turn, 1.5);
      swim(b, dt, s > 0.3 * S ? 0.8 : 0.35);
    } else if (b.phase === 'telegraph') {
      b.telegraph = ai.t / ai.dur;
      dimTarget = 1;
      move(b, dt, headTo(b, p.pos.x + p.vel.x * K.lead, p.pos.y + p.vel.y * K.lead), -K.pullBack * S, ai.turn * K.teleTurnMul, 4);
      swim(b, dt, 0.2);
      if (ai.t >= ai.dur) {
        setPhase(b, 'strike'); bus.emit('shake', { amount: 0.35 });
        ai.reach = Math.min(K.strikeDist * S, distP(b, p) + K.overshoot * S);
      }
    } else if (b.phase === 'strike') {
      b.attacking = true;
      dimTarget = 0.6;
      move(b, dt, headTo(b, p.pos.x, p.pos.y), K.strikeSpeed * sp, ai.t < K.strikeTrack ? K.strikeTurn : 0, 10);
      ai.travel += Math.max(0, ai.speed) * dt;
      swim(b, dt, 3);
      const wall = rammed(b, K.strikeSpeed * S);
      if (wall || ai.travel > ai.reach || ai.t > 4) {
        const v = K.dazed * (1 - K.dazedRage * b.rage);
        setPhase(b, 'dazed', v, v, wall ? 'any' : 'rear');
        if (wall) bus.emit('shake', { amount: 0.7 });
      }
    } else if (b.phase === 'dazed') {
      move(b, dt, b.heading, K.dazedSpeed * S, 0, 5);
      b.bank = Math.sin(ai.t * 6) * 0.2;
      swim(b, dt, 0.15);
      if (ai.t >= ai.dur) setPhase(b, 'lurk', rand(K.lurkTime[0], K.lurkTime[1]) * (1 - 0.35 * b.rage));
    }
    b.lureDim += (dimTarget - b.lureDim) * Math.min(1, dt * (dimTarget > b.lureDim ? 5 : 2));
  }

  function octopus(b, dt, p) {
    const K = T.octopus, ai = b.ai, S = ai.S, sp = S * (1 + T.rageSpeed * b.rage), arena = K.arena * S + b.size;
    const hx = b.home.x, hy = b.home.y;
    const fromHome = Math.hypot(b.pos.x - hx, b.pos.y - hy);
    if (b.phase === 'idle') setPhase(b, 'drift');
    if (b.phase === 'drift') {
      ai.sweepCd -= dt; ai.inkT -= dt;
      const d = distP(b, p);
      let h = headTo(b, p.pos.x, p.pos.y);
      const s = K.chaseSpeed * sp * (d > (K.inkRange + 2) * S ? 1.6 : 1);   // closes in faster from afar
      if (ai.inkT <= 0 && (ai.swept || ai.t > K.inkAnyway) && d < K.inkRange * S + b.size) {
        ai.swept = false;
        setPhase(b, 'ink', K.inkTime);
        bus.emit('ink', { pos: b.pos.clone(), radius: K.inkRadius * b.size });
        bus.emit('shake', { amount: 0.25 });
      } else if (ai.sweepCd <= 0 && d < K.sweepRange * S + b.size + p.size) {
        setPhase(b, 'telegraph', K.sweepTele * (1 - T.rageTele * b.rage));
      }
      if (fromHome > arena) h = headTo(b, hx, hy);
      move(b, dt, h, s, ai.turn, 2);
      swim(b, dt, 0.8);
    } else if (b.phase === 'telegraph') {
      b.telegraph = ai.t / ai.dur;
      move(b, dt, headTo(b, p.pos.x, p.pos.y), 0.1 * S, ai.turn * 2, 6);
      swim(b, dt, 0.3); // bunches up
      if (ai.t >= ai.dur) setPhase(b, 'sweep', K.sweepTime);
    } else if (b.phase === 'sweep') {
      b.attacking = true;
      move(b, dt, headTo(b, p.pos.x, p.pos.y), K.sweepSpeed * sp, K.sweepTurn, 12);
      swim(b, dt, 3);
      if (ai.t >= ai.dur) { setPhase(b, 'drift'); ai.sweepCd = K.sweepCd; ai.swept = true; }
    } else if (b.phase === 'ink') {
      // squeeze + spin away from the player before jetting
      move(b, dt, headTo(b, 2 * b.pos.x - p.pos.x, 2 * b.pos.y - p.pos.y), 0, 7, 10);
      swim(b, dt, 0.2);
      if (ai.t >= ai.dur) setPhase(b, 'dart', K.dartTime);
    } else if (b.phase === 'dart') {
      let h = headTo(b, 2 * b.pos.x - p.pos.x, 2 * b.pos.y - p.pos.y);
      if (fromHome > arena) h = headTo(b, hx, hy);
      move(b, dt, h, K.dartSpeed * sp, K.dartTurn, 10);
      swim(b, dt, 3.5);
      if (ai.t >= ai.dur) setPhase(b, 'exhausted', K.exhausted, K.exhausted, 'any');
    } else if (b.phase === 'exhausted') {
      move(b, dt, b.heading, K.exhaustedSpeed * S, ai.turn * 0.3, 2);
      b.pos.y -= dt * K.sag * S; // sags
      swim(b, dt, 0.25);
      if (ai.t >= ai.dur) { setPhase(b, 'drift'); ai.inkT = K.inkEvery * (1 - 0.3 * b.rage); ai.sweepCd = 1.5; }
    }
  }

  function moray(b, dt, p) {
    const K = T.moray, ai = b.ai, S = ai.S, sp = S * (1 + T.rageSpeed * b.rage);
    if (b.phase === 'idle') { setPhase(b, 'swim', rand(K.swimTime[0], K.swimTime[1])); ai.circleDir = Math.random() < 0.5 ? -1 : 1; }
    let coil = 0;
    if (b.phase === 'swim') {
      // slither around the player at mid range, sinuous heading wobble
      const dx = b.pos.x - p.pos.x, dy = b.pos.y - p.pos.y, d = Math.hypot(dx, dy) || 1;
      const a = Math.atan2(dy, dx) + ai.circleDir * 0.5;
      const R = K.swimR * S + b.size + p.size;
      const h = headTo(b, p.pos.x + Math.cos(a) * R, p.pos.y + Math.sin(a) * R) + Math.sin(ai.t * 4) * 0.25;
      move(b, dt, h, K.swimSpeed * sp * (d > R * 1.8 ? 1.8 : 1), ai.turn, 2);
      swim(b, dt, 1.2);
      if (ai.t >= ai.dur && d < K.lungeDist * S * 0.85 + b.size) setPhase(b, 'telegraph', K.telegraph * (1 - T.rageTele * b.rage));
    } else if (b.phase === 'telegraph') {
      b.telegraph = ai.t / ai.dur;
      coil = b.telegraph;
      move(b, dt, headTo(b, p.pos.x + p.vel.x * K.lead, p.pos.y + p.vel.y * K.lead), -K.coilBack * S, ai.turn * K.teleTurnMul, 6);
      swim(b, dt, 0.3);
      if (ai.t >= ai.dur) {
        setPhase(b, 'lunge'); b.attacking = true; bus.emit('shake', { amount: 0.3 });
        ai.reach = Math.min(K.lungeDist * S, distP(b, p) + K.overshoot * S);
      }
    } else if (b.phase === 'lunge') {
      b.attacking = true;
      move(b, dt, b.heading, K.lungeSpeed * sp, 0, 14);   // dead straight
      ai.travel += Math.max(0, ai.speed) * dt;
      swim(b, dt, 3.2);
      const wall = rammed(b, K.lungeSpeed * S);
      if (wall || ai.travel > ai.reach || ai.t > 3) {
        setPhase(b, 'recover', K.recover, K.recover, 'any');
        if (wall) bus.emit('shake', { amount: 0.6 });
      }
    } else if (b.phase === 'recover') {
      move(b, dt, b.heading, K.recoverSpeed * S, ai.turn * 0.25, 5);
      swim(b, dt, 0.3);
      if (ai.t >= ai.dur) { setPhase(b, 'swim', rand(K.swimTime[0], K.swimTime[1]) * (1 - 0.35 * b.rage)); ai.circleDir = -ai.circleDir; }
    }
    b.coil += (coil - b.coil) * Math.min(1, dt * 8);
  }

  function greatwhite(b, dt, p) {
    const K = T.greatwhite, ai = b.ai, S = ai.S, sp = S * (1 + T.rageSpeed * b.rage);
    if (b.phase === 'idle') { setPhase(b, 'circle', rand(K.circleTime[0], K.circleTime[1])); ai.circleDir = Math.random() < 0.5 ? -1 : 1; }
    if (b.phase === 'circle') {
      const dx = b.pos.x - p.pos.x, dy = b.pos.y - p.pos.y, d = Math.hypot(dx, dy) || 1;
      const a = Math.atan2(dy, dx) + ai.circleDir * 0.55;
      const R = (K.circleR * S + b.size + p.size) * (1 - K.circleShrink * Math.min(1, ai.t / ai.dur));
      move(b, dt, headTo(b, p.pos.x + Math.cos(a) * R, p.pos.y + Math.sin(a) * R), K.circleSpeed * sp * (d > R * 2 ? 1.6 : 1), ai.turn, 2);
      swim(b, dt, 1.3);
      if (ai.t >= ai.dur && d < K.chargeDist * S * 0.7) setPhase(b, 'telegraph', K.telegraph * (1 - T.rageTele * b.rage));
    } else if (b.phase === 'telegraph') {
      b.telegraph = ai.t / ai.dur;
      move(b, dt, headTo(b, p.pos.x + p.vel.x * K.lead, p.pos.y + p.vel.y * K.lead), 0.25 * S, ai.turn * K.teleTurnMul, 3);
      swim(b, dt, 0.5);
      if (ai.t >= ai.dur) {
        setPhase(b, 'charge'); bus.emit('shake', { amount: 0.3 });
        ai.reach = Math.min(K.chargeDist * S, distP(b, p) + K.overshoot * S);
      }
    } else if (b.phase === 'charge') {
      b.attacking = true;
      move(b, dt, headTo(b, p.pos.x, p.pos.y), K.chargeSpeed * sp, ai.t < K.chargeTrack ? K.chargeTurn : 0, 4);
      ai.travel += Math.max(0, ai.speed) * dt;
      swim(b, dt, 3.2);
      if (rammed(b, K.chargeSpeed * S, K.wallStun)) {
        setPhase(b, 'stunned', K.stunned, K.stunned, 'any');
        ai.speed = 0;
        bus.emit('shake', { amount: 0.8 });
      } else if (ai.travel > ai.reach || ai.t > 5) setPhase(b, 'tired', K.tired, K.tired, 'rear');
    } else if (b.phase === 'stunned') {
      move(b, dt, b.heading, 0, 0, 5);
      b.bank = Math.sin(ai.t * 9) * 0.25 * (1 - ai.t / ai.dur);
      swim(b, dt, 0.15);
      if (ai.t >= ai.dur) setPhase(b, 'circle', rand(K.circleTime[0], K.circleTime[1]));
    } else if (b.phase === 'tired') {
      move(b, dt, b.heading, K.tiredSpeed * S, ai.turn * 0.4, 5);
      swim(b, dt, 0.5);
      if (ai.t >= ai.dur) setPhase(b, 'circle', rand(K.circleTime[0], K.circleTime[1]));
    }
  }

  const BRAIN = { anglerking, octopus, moray, greatwhite };

  // ---------- combat ----------
  function segDist2(px, py, ax, ay, bx, by) {
    const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
    let u = l2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / l2 : 0;
    u = clamp(u, 0, 1);
    const dx = px - (ax + vx * u), dy = py - (ay + vy * u);
    return dx * dx + dy * dy;
  }

  function defeat(b) {
    b.vulnerable = false; b.attacking = false; b.phase = 'defeated'; b.hp = Math.max(0, b.hp);
    const was = engaged === b;
    if (was) engaged = null;
    b.engaged = false; b.alive = false;
    bus.emit('bossDefeated', { boss: b });
    if (was) bus.emit('bossDisengage', DISENGAGE);
    despawn(b, 'defeated');
  }

  function combat(b, p) {
    const ai = b.ai, m = CONFIG.eat.margin;
    const c = Math.cos(b.heading), s = Math.sin(b.heading);
    const pc = Math.cos(p.heading), ps = Math.sin(p.heading);
    const pmx = p.pos.x + pc * p.size, pmy = p.pos.y + ps * p.size;   // player mouth
    let dx = p.pos.x - b.pos.x, dy = p.pos.y - b.pos.y;
    let d = Math.hypot(dx, dy) || 1e-3;

    // a boss always towers over you (no "outgrew it, swallow it" shortcut)
    if (b.size < p.size * T.minBossRatio) { b.size = p.size * T.minBossRatio; b.mass = b.size * b.size; }

    if (b.vulnerable) {
      if (ai.hitCd <= 0 && ai.winHits < T.hitsPerWindow) {
        const back = T[b.species].back * b.size;
        let hit = false;
        if (b.weakSpot === 'any') {
          const r = b.size * 0.95 + p.size * 0.5;
          hit = segDist2(pmx, pmy, b.pos.x + c * b.size * 0.8, b.pos.y + s * b.size * 0.8, b.pos.x - c * back, b.pos.y - s * back) < r * r;
        } else {
          const r = b.size * 0.85 + p.size * 0.5;
          const along = (pmx - b.pos.x) * c + (pmy - b.pos.y) * s;
          hit = along < b.size * 0.15 && segDist2(pmx, pmy, b.pos.x + c * b.size * 0.15, b.pos.y + s * b.size * 0.15, b.pos.x - c * back, b.pos.y - s * back) < r * r;
        }
        if (hit) {
          b.hp--; ai.winHits++; b.hitFlash = 1; ai.hitCd = T.bossHitCd; p.gulp = 1;
          const k = T.knock * playerSpeed(p.size);
          p.vel.x += (dx / d) * k; p.vel.y += (dy / d) * k;
          p.pos.x += (dx / d) * p.size * 0.5; p.pos.y += (dy / d) * p.size * 0.5;
          bus.emit('bossHit', { boss: b, pos: b.pos.clone().set(pmx, pmy, 0) });
          bus.emit('shake', { amount: 0.5 });
          if (b.hp <= 0) { defeat(b); return; }
          dx = p.pos.x - b.pos.x; dy = p.pos.y - b.pos.y; d = Math.hypot(dx, dy) || 1e-3;
        }
      }
    } else if (ai.grace <= 0 && p.invuln <= 0 && b.size > p.size * m) {
      const mx = b.pos.x + c * b.size * T.mouthFwd, my = b.pos.y + s * b.size * T.mouthFwd;
      const mr = (b.phase === 'sweep' ? T.octopus.sweepMouth : T[b.species].mouth) * b.size + p.size * CONFIG.eat.reach;
      const ex = p.pos.x - mx, ey = p.pos.y - my;
      if (ex * ex + ey * ey < mr * mr) {
        b.gulp = 1;
        bus.emit('eat', { eater: b, eaten: p });
        return;
      }
    }

    // solid body: keep the player out of the boss's center
    const minD = b.size * T.bodyPush + p.size * 0.6;
    if (d < minD) {
      const nx = dx / d, ny = dy / d, push = minD - d;
      p.pos.x += nx * push; p.pos.y += ny * push;
      const vn = p.vel.x * nx + p.vel.y * ny;
      if (vn < 0) { p.vel.x -= vn * nx; p.vel.y -= vn * ny; }
    }
  }

  // ---------- frame ----------
  function update(dt, t, player, { active = false, viewRadius = 80 } = {}) {
    if (dt <= 0) return;
    viewR = Math.max(viewRadius || 0, 40);
    const live = active && player && player.alive;

    // player died / title: drop the engagement (the boss lingers, idle, until reset)
    if (!live && engaged) { engaged.engaged = false; engaged = null; bus.emit('bossDisengage', DISENGAGE); }

    if (live) {
      const tier = tierIndexFor(player.size);
      if (tier > maxTier) { maxTier = tier; tierT = 0; } else tierT += dt;
      if (!list.length) {
        calmT += dt;
        const k = pickNext();
        if (k) trySpawn(k, player);
      }
    }

    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      const ai = b.ai, tk = T[b.species];
      ai.t += dt; b.age += dt;
      ai.hitCd = Math.max(0, ai.hitCd - dt);
      ai.grace = Math.max(0, ai.grace - dt);
      b.hitFlash = Math.max(0, b.hitFlash - dt * 3);
      b.gulp = Math.max(0, b.gulp - dt * 2.5);
      b.wallHit = Math.max(0, b.wallHit - dt * 4);
      if (b.vulnerable) b.vulnT = Math.max(0, b.vulnT - dt);
      b.rage = clamp((T.rageFrom - b.hp / b.maxHp) / T.rageSpan, 0, 1);
      ai.turn = (T.turnBase * tk.turnMul) / Math.pow(b.size, T.turnExp);
      ai.S = scaleOf(player);

      if (engaged !== b) {
        // not fighting (player dead / title): drift on slowly
        move(b, dt, b.heading, 0.2 * ai.S, 0, 2);
        swim(b, dt, 0.5);
        continue;
      }
      // fled too far → disengage + despawn (may return later)
      if (distP(b, player) > T.despawnMul * viewR + b.size) { despawn(b, 'fled'); continue; }
      // territory anchor slowly follows the player so the fight stays local
      const hx = player.pos.x - b.home.x, hy = player.pos.y - b.home.y, hd = Math.hypot(hx, hy);
      if (hd > T.anchorSlack * ai.S) {
        const step = Math.min(hd - T.anchorSlack * ai.S, T.anchorFollow * ai.S * dt);
        b.home.x += (hx / hd) * step; b.home.y += (hy / hd) * step;
      }
      BRAIN[b.species](b, dt, player);
      if (b.alive && player.alive) combat(b, player);
    }
  }

  return api;
}
