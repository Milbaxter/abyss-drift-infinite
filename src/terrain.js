// Terrain (INFINITE): open water everywhere except sparse, big, rounded floating landmark rocks.
// Rocks are chunk-seeded from ABSOLUTE coords (local + WORLD.origin), so a rebase never moves them.
// At most one rock per LM×LM cell, jittered to the cell middle → rocks are always ≥ ~600u apart (no gaps/traps).
// API (fixed): sdf, normal, collide, raycast, isOpen, features, mapCanvas:null, bounds:null.
import { WORLD } from './config.js';

const LM = 1500;          // landmark cell size
const CHANCE = 0.55;      // chance a cell has a rock
const FAR = 1e4;          // "open water" distance cap
const SPAWN_CLEAR = 450;  // no rock within this of the absolute spawn

function hh(ix, iy, k) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(k, 1442695041) + 0x5bd1e995) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296;
}

// rock description for cell (cx, cy) in ABSOLUTE cell coords, written into `out`; returns false if empty
function cellRock(cx, cy, out) {
  if (hh(cx, cy, 11) > CHANCE) return false;
  const ax = (cx + 0.3 + 0.4 * hh(cx, cy, 12)) * LM, ay = (cy + 0.3 + 0.4 * hh(cx, cy, 13)) * LM;
  if (Math.hypot(ax - WORLD.spawn.x, ay - WORLD.spawn.y) < SPAWN_CLEAR) return false;
  const r = 70 + 80 * hh(cx, cy, 14);
  out.ax = ax; out.ay = ay; out.r = r;
  out.sx = 1.0 + 0.6 * hh(cx, cy, 15);          // horizontal stretch (rounded, wider than tall)
  out.sy = 0.75 + 0.35 * hh(cx, cy, 16);
  out.p1 = hh(cx, cy, 17) * 6.283; out.p2 = hh(cx, cy, 18) * 6.283;
  out.seed = (hh(cx, cy, 19) * 1e6) | 0;
  return true;
}
const _r = { ax: 0, ay: 0, r: 0, sx: 1, sy: 1, p1: 0, p2: 0, seed: 0 };
// signed distance to one rock (approximate but conservative: scaled by 0.85)
function rockDist(R, ax, ay) {
  const dx = (ax - R.ax) / R.sx, dy = (ay - R.ay) / R.sy;
  const d = Math.hypot(dx, dy), th = Math.atan2(dy, dx);
  const rr = R.r * (1 + 0.1 * Math.sin(3 * th + R.p1) + 0.06 * Math.sin(5 * th + R.p2));
  return (d - rr) * Math.min(R.sx, R.sy) * 0.85;
}

export function createTerrain() {
  function sdf(x, y) {
    const ax = x + WORLD.origin.x, ay = y + WORLD.origin.y;
    const cx = Math.floor(ax / LM), cy = Math.floor(ay / LM);
    let best = FAR;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      if (!cellRock(cx + i, cy + j, _r)) continue;
      const d = rockDist(_r, ax, ay);
      if (d < best) best = d;
    }
    return best;
  }
  const _n = { x: 0, y: 0 };
  function normal(x, y, out = _n) {
    const e = 2;
    const gx = sdf(x + e, y) - sdf(x - e, y), gy = sdf(x, y + e) - sdf(x, y - e);
    const l = Math.hypot(gx, gy) || 1; out.x = gx / l; out.y = gy / l; return out;
  }
  const _cn = { x: 0, y: 0 };
  const terrain = {
    bounds: null,
    mapCanvas: null,
    sdf, normal,
    collide(e, radius = e.size) {
      const d = sdf(e.pos.x, e.pos.y);
      if (d >= radius) return false;
      const n = normal(e.pos.x, e.pos.y, _cn);
      const push = radius - d;
      e.pos.x += n.x * push; e.pos.y += n.y * push;
      if (e.vel) {
        const vn = e.vel.x * n.x + e.vel.y * n.y;
        if (vn < 0) { e.vel.x -= vn * n.x; e.vel.y -= vn * n.y; }
        e.wallHit = Math.max(e.wallHit || 0, Math.min(1, Math.max(0, -vn) / 10));
      }
      e.lastWallNx = n.x; e.lastWallNy = n.y;
      return true;
    },
    raycast(x, y, dx, dy, maxDist) {
      const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      let t = 0;
      for (let i = 0; i < 64 && t < maxDist; i++) {
        const d = sdf(x + dx * t, y + dy * t);
        if (d < 0.5) return t;
        t += Math.max(d, 1);
      }
      return Infinity;
    },
    isOpen(x, y, r = 0) { return sdf(x, y) > r; },
    randomOpenPoint(region, r = 2, rng = Math.random) {
      for (let k = 0; k < 50; k++) { const x = (rng() - 0.5) * 4000, y = (rng() - 0.5) * 4000; if (sdf(x, y) > r) return { x, y }; }
      return null;
    },
    features: {
      cell: LM,
      // landmark rocks overlapping the rect around (x, y) ± (hw, hh), in LOCAL coords. Fills `out` (array of objects
      // reused by the caller) and returns the count. Each: {x, y, r, sx, sy, p1, p2, seed, key}.
      rocksNear(x, y, hw, hh2, out) {
        const ax = x + WORLD.origin.x, ay = y + WORLD.origin.y;
        const c0 = Math.floor((ax - hw - 400) / LM), c1 = Math.floor((ax + hw + 400) / LM);
        const r0 = Math.floor((ay - hh2 - 400) / LM), r1 = Math.floor((ay + hh2 + 400) / LM);
        let n = 0;
        for (let cx = c0; cx <= c1; cx++) for (let cy = r0; cy <= r1; cy++) {
          if (!cellRock(cx, cy, _r)) continue;
          const o = out[n] || (out[n] = {});
          o.x = _r.ax - WORLD.origin.x; o.y = _r.ay - WORLD.origin.y; o.r = _r.r; o.sx = _r.sx; o.sy = _r.sy;
          o.p1 = _r.p1; o.p2 = _r.p2; o.seed = _r.seed; o.key = cx * 73856093 ^ cy * 19349663;
          n++;
        }
        return n;
      },
    },
    stats: { ms: 0 },
  };
  return terrain;
}
