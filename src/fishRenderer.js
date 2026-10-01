// Fish renderer — SIDE VIEW. Every fish is procedurally modelled here (no assets), one InstancedMesh per
// species (bosses included). Swimming (body wave + tail sweep, fin flutter, jelly pulse, octopus arms,
// eel undulation, puffer inflate, gulp) runs in the vertex shader; countershading / patterns are vertex
// colours tinted by the per-instance entity colour; bioluminescence, hero iridescence, the edible/danger
// fresnel rim, boss "bite me" glow and hit flash run in the fragment shader.
//
// Models are side profiles: nose +X, back +Y, tall body, vertical tail, eyes on both flanks (camera sees +Z).
// Orientation: rotation.z = heading; fish roll 180° about the nose (smoothly) when facing left.
// Scale = entity.size, so the model's half-length ≈ collision radius.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SPECIES, BOSSES, CONFIG } from './config.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const fract = (x) => x - Math.floor(x);
const ZERO = () => 0;

function hash3(x, y, z) { return fract(Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453); }
function noise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  let r = 0;
  for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) for (let dz = 0; dz < 2; dz++) {
    const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
    r += w * hash3(ix + dx, iy + dy, iz + dz);
  }
  return r;
}

// ---------------------------------------------------------------- geometry helpers
// Paint record per vertex: rgb, tint (0 = absolute colour, 1 = × instance colour), emis (always-on emissive),
// flut (fin flutter weight), bio (bioluminescence × species glow), spec (spike/lure/tentacle param), part (arm id).
const P = { r: 1, g: 1, b: 1, tint: 1, emis: 0, flut: 0, bio: 0, spec: 0, part: 0 };
function set(o, r, g, b, tint = o.tint) { o.r = r; o.g = g; o.b = b; o.tint = tint; }
function mixc(o, r, g, b, tint, k) {
  o.r = lerp(o.r, r, k); o.g = lerp(o.g, g, k); o.b = lerp(o.b, b, k); o.tint = lerp(o.tint, tint, k);
}

function paintGeo(geo, fn) {
  if (!geo.index) {
    const n = geo.attributes.position.count, idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const pos = geo.attributes.position, uv = geo.attributes.uv, n = pos.count;
  const col = new Float32Array(n * 3), fx = new Float32Array(n * 4), sp = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    P.r = P.g = P.b = 1; P.tint = 1; P.emis = 0; P.flut = 0; P.bio = 0; P.spec = 0; P.part = 0;
    fn(pos.getX(i), pos.getY(i), pos.getZ(i), uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0, P);
    col[i * 3] = P.r; col[i * 3 + 1] = P.g; col[i * 3 + 2] = P.b;
    fx[i * 4] = P.tint; fx[i * 4 + 1] = P.emis; fx[i * 4 + 2] = P.flut; fx[i * 4 + 3] = P.bio;
    sp[i * 2] = P.spec; sp[i * 2 + 1] = P.part;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aFx', new THREE.BufferAttribute(fx, 4));
  geo.setAttribute('aSpec', new THREE.BufferAttribute(sp, 2));
  for (const k of Object.keys(geo.attributes)) {
    if (!['position', 'normal', 'color', 'aFx', 'aSpec'].includes(k)) geo.deleteAttribute(k);
  }
  return geo;
}

// Body: ellipse cross-sections along X (nose x0 → tail x1). h(u)=half-height (Y), w(u)=half-width (Z).
// uv = (u along body 0..1, v around 0..1 with v=0 on top, v=0.25 on the +Z flank).
function tube({ x0, x1, n, m, w, h, yc = ZERO }) {
  const v = [], uv = [], idx = [];
  v.push(x0, yc(0), 0); uv.push(0, 0);
  for (let i = 1; i < n; i++) {
    const u = i / n, x = lerp(x0, x1, u), W = w(u), H = h(u), Y = yc(u);
    for (let j = 0; j < m; j++) {
      const a = (j / m) * TAU;
      v.push(x, Y + H * Math.cos(a), W * Math.sin(a)); uv.push(u, j / m);
    }
  }
  v.push(x1, yc(1), 0); uv.push(1, 0.5);
  const tip = 1 + (n - 1) * m;
  for (let j = 0; j < m; j++) idx.push(1 + j, 1 + ((j + 1) % m), 0);
  for (let i = 0; i < n - 2; i++) for (let j = 0; j < m; j++) {
    const a = 1 + i * m + j, b = 1 + i * m + ((j + 1) % m), c = a + m, d = b + m;
    idx.push(a, c, b, c, d, b);
  }
  const base = 1 + (n - 2) * m;
  for (let j = 0; j < m; j++) idx.push(base + j, tip, base + ((j + 1) % m));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Fin membrane: grid between a root curve R(s) and an edge curve E(s). uv = (s across, t root→edge).
const _ra = new THREE.Vector3(), _rb = new THREE.Vector3(), _rp = new THREE.Vector3();
function fin(R, E, nu = 10, nv = 5, bend) {
  const v = [], uv = [], idx = [];
  for (let i = 0; i <= nu; i++) {
    const s = i / nu; R(s, _ra); E(s, _rb);
    for (let j = 0; j <= nv; j++) {
      const t = j / nv; _rp.lerpVectors(_ra, _rb, t);
      if (bend) bend(s, t, _rp);
      v.push(_rp.x, _rp.y, _rp.z); uv.push(s, t);
    }
  }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = i * (nv + 1) + j, b = a + 1, c = a + nv + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Thin ribbon along a centreline c(s); its width is offset along `axis` ('x' | 'y' | 'z').
function ribbon(center, halfW, nu = 12, axis = 'y') {
  const c = new THREE.Vector3();
  return fin(
    (s, out) => { center(s, c); out.copy(c); out[axis] -= halfW(s); },
    (s, out) => { center(s, c); out.copy(c); out[axis] += halfW(s); },
    nu, 1);
}

// Tapered tube along a Catmull-Rom curve (stalks, tentacles). uv.x = 0..1 along the curve.
function sweep(points, radius, tubular = 24, radial = 6) {
  const curve = new THREE.CatmullRomCurve3(points);
  const g = new THREE.TubeGeometry(curve, tubular, 1, radial, false);
  const pos = g.attributes.position, c = new THREE.Vector3();
  for (let i = 0; i <= tubular; i++) {
    curve.getPointAt(i / tubular, c);
    const r = radius(i / tubular);
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      pos.setXYZ(k, c.x + (pos.getX(k) - c.x) * r, c.y + (pos.getY(k) - c.y) * r, c.z + (pos.getZ(k) - c.z) * r);
    }
  }
  g.computeVertexNormals();
  return g;
}

// Body profile: smooth spindle with a peduncle that keeps the tail base from collapsing.
const prof = (W, a, b, ped, pedStart = 0.6) => (u) =>
  Math.max(W * Math.pow(Math.max(0, Math.sin(Math.PI * Math.pow(u, a))), b), ped * sstep(pedStart, 0.985, u));

// Countershading: darker back, pale belly that keeps only a hint of the instance colour.
function baseShade(o, v, back = 0.78, belly = 0.75) {
  const ca = Math.cos(v * TAU);
  const kb = sstep(0.1, 1, ca), kp = sstep(-0.1, -0.85, ca);
  const k = 1 - (1 - back) * kb + 0.06 * (1 - Math.abs(ca));
  set(o, k, k, k, 1);
  mixc(o, 1.0, 0.98, 0.93, 0.15, kp * belly);
}

function finPaint({ c = [1, 1, 1], tint = 1, edge = null, edgeAt = 0.86, edgeTint = 0, flut = 0.7, rays = 0.18, nr = 9,
  grad = null, emisEdge = 0, bio = 0 } = {}) {
  return (x, y, z, s, t, o) => {
    const k = 1 - rays * Math.pow(0.5 + 0.5 * Math.cos(s * TAU * nr), 3) * t;
    if (grad) { const g = grad(s, t); set(o, g[0] * k, g[1] * k, g[2] * k, g[3] ?? tint); }
    else set(o, c[0] * k, c[1] * k, c[2] * k, tint);
    if (edge && t > edgeAt) mixc(o, edge[0], edge[1], edge[2], edgeTint, sstep(edgeAt, Math.min(1, edgeAt + 0.08), t));
    o.flut = flut * Math.pow(t, 1.25);
    o.emis = emisEdge * sstep(0.55, 1, t);
    o.bio = bio * t;
  };
}

// Eye: white ball + iris/pupil cap + emissive catch-lights, looking out of the flank (side = ±1 → ±Z).
function addEye(add, cx, cy, cz, r, side, e) {
  const d = new THREE.Vector3(e.fwd ?? 0.35, e.up ?? 0.1, side).normalize();
  const iris = e.iris;
  add(new THREE.SphereGeometry(r, 16, 12).translate(cx, cy, cz),
    (x, y, z, u, v, o) => { if (e.white) set(o, e.white[0], e.white[1], e.white[2], 0); else set(o, 0.97, 0.97, 1.0, 0); o.emis = 0.07; });
  const pr = r * (e.pupil ?? 0.72);
  const pc = new THREE.Vector3(cx, cy, cz).addScaledVector(d, r * 0.36);
  const q = new THREE.Vector3();
  add(new THREE.SphereGeometry(pr, 16, 12).translate(pc.x, pc.y, pc.z), (x, y, z, u, v, o) => {
    q.set(x - pc.x, y - pc.y, z - pc.z).normalize();
    const k = q.dot(d);
    const slitPupil = e.slit && k > 0.45 && Math.abs(q.y) < 0.2;
    const roundPupil = !e.slit && k > 0.8;
    if (!iris || slitPupil || roundPupil) set(o, 0.015, 0.015, 0.03, 0);
    else if (k > 0.3) {
      const g = 0.55 + 0.75 * clamp((k - 0.3) / 0.5, 0, 1);
      set(o, iris[0] * g, iris[1] * g, iris[2] * g, 0); o.emis = e.irisGlow ?? 0.05;
    } else set(o, 0.04, 0.04, 0.06, 0);
  });
  const hl = (dx, dy, rad) => {
    const hd = new THREE.Vector3(dx, dy, 0).add(d).normalize();
    const hp = pc.clone().addScaledVector(hd, pr * 0.93);
    add(new THREE.SphereGeometry(r * rad, 6, 4).translate(hp.x, hp.y, hp.z),
      (x, y, z, u, v, o) => { set(o, 1, 1, 1, 0); o.emis = 1.6; });
  };
  hl(-0.1, 0.55, 0.2);
  if (e.sparkle) hl(0.45, -0.35, 0.1);
}

// Rows of glowing photophores on the body surface at angle `ang` (from top) for u in us.
function addDots(ctx, us, angs, r, col, bio, emis = 0) {
  const { xAt, w, h, yc, add } = ctx;
  for (const u of us) for (const a of angs) {
    const x = xAt(u), y = yc(u) + h(u) * Math.cos(a), z = w(u) * Math.sin(a);
    add(new THREE.SphereGeometry(r, 6, 4).translate(x, y, z), (px, py, pz, uu, vv, o) => { set(o, col[0], col[1], col[2], 0); o.bio = bio; o.emis = emis; });
  }
}
const range = (a, b, st) => { const r = []; for (let x = a; x <= b + 1e-6; x += st) r.push(x); return r; };
const cone = (r, len, seg = 4) => new THREE.ConeGeometry(r, len, seg, 1).translate(0, len / 2, 0);
const _up = new THREE.Vector3(0, 1, 0), _q = new THREE.Quaternion();
// cone (base at origin, tip along +Y) → oriented along dir, base at p
function aim(g, dir, p) { _q.setFromUnitVectors(_up, dir.clone().normalize()); return g.applyQuaternion(_q).translate(p.x, p.y, p.z); }
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ---------------------------------------------------------------- generic fish assembly
function fishModel(o) {
  const parts = [];
  const bounds = new THREE.Box3();
  const add = (geo, fn, inBounds = false) => {
    parts.push(paintGeo(geo, fn));
    if (inBounds) { geo.computeBoundingBox(); bounds.union(geo.boundingBox); }
  };
  const x0 = o.x0 ?? 1, x1 = o.x1 ?? -0.7, w = o.w, h = o.h, yc = o.yc || ZERO;
  const n = o.n || 40, m = o.m || 20;
  const xAt = (u) => lerp(x0, x1, u), uAt = (x) => clamp((x0 - x) / (x0 - x1), 0, 1);
  const ctx = { x0, x1, w, h, yc, xAt, uAt, add, n, m, pivot: null };
  add(tube({ x0, x1, n, m, w, h, yc }), o.bodyPaint || ((x, y, z, u, v, p) => baseShade(p, v)), true);

  if (o.eye) {
    const e = o.eye, u = e.u, ang = e.ang ?? 1.15;
    for (const side of [-1, 1]) {
      const x = xAt(u), y = yc(u) + h(u) * Math.cos(ang), z = side * w(u) * Math.sin(ang);
      const nrm = V(0.1, Math.cos(ang) / h(u), side * Math.sin(ang) / w(u)).normalize();
      addEye(add, x - nrm.x * e.r * 0.35, y - nrm.y * e.r * 0.35, z - nrm.z * e.r * 0.35, e.r, side, e);
    }
  }
  if (o.tail) {
    const t = o.tail, xr = x1 + (t.overlap ?? 0.06), y = yc(1), rw = t.root ?? h(0.97) * 1.1;
    const L = t.L, sp = t.spread;
    ctx.pivot = xr;
    const back = (q) => {
      const aq = Math.abs(q);
      switch (t.type) {
        case 'fork': return 1 - t.fork * (1 - Math.pow(aq, 0.85));
        case 'round': return 0.55 + 0.45 * Math.sqrt(Math.max(0, 1 - q * q));
        case 'crescent': return 0.18 + 0.82 * Math.pow(aq, 1.5);
        case 'fluke': return 0.3 + 0.7 * Math.pow(aq, 0.75) - 0.12 * Math.exp(-q * q * 60);
        case 'veil': return 0.62 + 0.38 * Math.pow(Math.sin(Math.PI * (q * 0.5 + 0.5) * 2.5 + 0.3), 2) * (1 - 0.3 * aq);
        default: return 1;
      }
    };
    if (t.type === 'fluke') {
      // whale flukes: horizontal, tilted toward the camera so they read from the side
      const tilt = t.tilt ?? 0.55;
      add(fin((s, out) => out.set(xr, y, (2 * s - 1) * rw),
        (s, out) => { const q = 2 * s - 1; out.set(xr - L * back(q), y, q * sp); }, t.nu || 18, t.nv || 6,
        (s, tt, p) => { const z = p.z; p.y = y + z * Math.sin(tilt) + 0.04 * tt; p.z = z * Math.cos(tilt); }),
      t.paint || finPaint({ flut: 0.5 }), true);
    } else {
      const up = t.upper ?? 1;
      add(fin((s, out) => out.set(xr, y + (2 * s - 1) * rw, 0),
        (s, out) => {
          const q = 2 * s - 1, k = q > 0 ? up : 1;
          out.set(xr - L * back(q) * (q > 0 ? Math.sqrt(up) : 1), y + q * sp * k * (t.type === 'veil' ? 1 + 0.25 * (1 - Math.abs(q)) : 1), 0);
        }, t.nu || 16, t.nv || 6,
        (s, tt, p) => { p.z += (t.cup ?? 0.03) * tt * tt * Math.cos((2 * s - 1) * Math.PI * 0.5); }),
      t.paint || finPaint({ flut: 0.7 }), true);
    }
  }
  const list = (x) => (x ? (Array.isArray(x) ? x : [x]) : []);
  for (const p of list(o.pecs)) {
    for (const side of [-1, 1]) {
      const dir = V(-p.back, -p.droop, side * (p.splay ?? 0.3)).normalize();
      const leaf = p.leaf || ((s) => 0.3 + 0.7 * Math.pow(Math.sin(Math.PI * (0.1 + 0.85 * s)), 0.7));
      const R = (s, out) => {
        const u = p.u + p.span * s;
        out.set(xAt(u), yc(u) + h(u) * (p.yOff ?? -0.2) + (p.vert ?? 0.12) * s, side * w(u) * (p.zf ?? 0.95));
      };
      add(fin(R, (s, out) => { R(s, out); out.addScaledVector(dir, p.len * leaf(s)); }, p.nu || 8, p.nv || 5),
        p.paint || finPaint({ flut: 1 }));
    }
  }
  const vfin = (d, sign) => {
    const pf = d.prof || ((s) => Math.pow(Math.sin(Math.PI * s), 0.7));
    const R = (s, out) => { const u = lerp(d.u0, d.u1, s); out.set(xAt(u), yc(u) + sign * h(u) * 0.9, 0); };
    add(fin(R, (s, out) => { R(s, out); const k = pf(s); out.x -= (d.sweep ?? 0.4) * d.hgt * k; out.y += sign * d.hgt * k; },
      d.nu || 12, d.nv || 4), d.paint || finPaint({ flut: 0.3 }));
  };
  for (const d of list(o.dorsal)) vfin(d, 1);
  for (const d of list(o.anal)) vfin(d, -1);
  if (o.extra) o.extra(ctx);
  if (o.bodyLast) parts.push(parts.shift());
  const geo = mergeGeometries(parts);
  return { geo, minX: bounds.min.x, maxX: bounds.max.x, pivot: ctx.pivot };
}

// ---------------------------------------------------------------- species models
const ORANGE_FIN = (edge = [0.03, 0.03, 0.03]) => finPaint({ c: [1, 0.95, 0.9], edge, edgeAt: 0.78, flut: 0.9, rays: 0.12 });

function buildSardine() {
  const h = prof(0.2, 0.75, 0.6, 0.045), w = prof(0.11, 0.75, 0.6, 0.03);
  return fishModel({
    x0: 1, x1: -0.72, n: 36, m: 16, w, h,
    bodyPaint: (x, y, z, u, v, o) => {
      baseShade(o, v, 0.9, 0.85);
      const ca = Math.cos(v * TAU);
      mixc(o, 0.25, 0.48, 0.68, 0.45, sstep(0.25, 0.75, ca));
      if (u > 0.14 && u < 0.55 && ca > 0.05 && ca < 0.5 && fract(u * 24) < 0.4) mixc(o, 0.1, 0.14, 0.2, 0, 0.8);
      if (Math.abs(ca) < 0.2) { o.r *= 1.12; o.g *= 1.12; o.b *= 1.15; }
    },
    eye: { u: 0.1, r: 0.07, iris: [0.95, 0.85, 0.45], pupil: 0.74 },
    tail: { type: 'fork', L: 0.42, spread: 0.3, fork: 0.62, root: 0.04, paint: finPaint({ c: [0.75, 0.82, 0.9], rays: 0.3, flut: 0.6 }) },
    pecs: { u: 0.2, span: 0.07, len: 0.17, back: 1.0, droop: 0.3, paint: finPaint({ c: [0.9, 0.95, 1], flut: 1.1 }) },
    dorsal: { u0: 0.36, u1: 0.55, hgt: 0.12, sweep: 0.6, paint: finPaint({ c: [0.55, 0.65, 0.78], flut: 0.3 }) },
    anal: { u0: 0.62, u1: 0.74, hgt: 0.07, sweep: 0.6, paint: finPaint({ c: [0.85, 0.9, 0.95], flut: 0.3 }) },
  });
}

function buildClown() {
  const h = prof(0.42, 0.72, 0.68, 0.09), w = prof(0.24, 0.72, 0.6, 0.05);
  const bands = [[0.19, 0.07], [0.5, 0.075], [0.83, 0.045]];
  return fishModel({
    x0: 1, x1: -0.68, n: 52, m: 22, w, h,
    bodyPaint: (x, y, z, u, v, o) => {
      baseShade(o, v, 0.88, 0.3);
      const ca = Math.cos(v * TAU);
      for (const [c, wd] of bands) {
        const d = Math.abs(u - (c - 0.04 * ca));
        if (d < wd) { set(o, 1.02, 1.0, 0.98, 0); o.emis = 0.03; }
        else if (d < wd + 0.028) set(o, 0.03, 0.025, 0.03, 0);
      }
    },
    eye: { u: 0.11, r: 0.115, ang: 1.0, iris: [1.0, 0.55, 0.12], sparkle: true },
    tail: { type: 'round', L: 0.42, spread: 0.36, root: 0.08, paint: ORANGE_FIN() },
    pecs: { u: 0.26, span: 0.1, len: 0.28, back: 0.8, droop: 0.45, paint: ORANGE_FIN() },
    dorsal: [{ u0: 0.25, u1: 0.5, hgt: 0.13, sweep: 0.3, paint: ORANGE_FIN(), prof: (s) => 0.6 + 0.4 * Math.sin(Math.PI * s) },
      { u0: 0.52, u1: 0.78, hgt: 0.17, sweep: 0.5, paint: ORANGE_FIN() }],
    anal: [{ u0: 0.56, u1: 0.78, hgt: 0.15, sweep: 0.5, paint: ORANGE_FIN() },
      { u0: 0.28, u1: 0.36, hgt: 0.13, sweep: 0.9, paint: ORANGE_FIN() }],
  });
}

function buildTang() {
  const h = prof(0.55, 0.85, 0.55, 0.07), w = prof(0.15, 0.8, 0.6, 0.035);
  return fishModel({
    x0: 1, x1: -0.6, n: 44, m: 22, w, h,
    bodyPaint: (x, y, z, u, v, o) => {
      baseShade(o, v, 0.88, 0.4);
      const ca = Math.cos(v * TAU);
      // the "palette" swoosh: dark band from above the eye sweeping down to the tail
      if (u > 0.1 && u < 0.92) {
        const cc = 0.72 - 0.75 * sstep(0.12, 0.92, u);
        const wd = 0.1 + 0.16 * Math.sin(Math.PI * clamp((u - 0.1) / 0.6, 0, 1));
        const d = Math.abs(ca - cc);
        if (d < wd) mixc(o, 0.03, 0.05, 0.13, 0, 0.92);
        else if (d < wd + 0.08) mixc(o, 0.03, 0.05, 0.13, 0, 0.4);
      }
      if (u > 0.86 && u < 0.93 && Math.abs(ca) < 0.3) set(o, 1, 0.95, 0.4, 0); // scalpel
    },
    eye: { u: 0.14, r: 0.085, ang: 1.0, iris: [0.15, 0.2, 0.35] },
    tail: { type: 'crescent', L: 0.34, spread: 0.36, root: 0.06,
      paint: finPaint({ c: [1.0, 0.82, 0.08], tint: 0.15, edge: [0.05, 0.08, 0.2], edgeAt: 0.82, flut: 0.6 }) },
    pecs: { u: 0.25, span: 0.08, len: 0.2, back: 1.0, droop: 0.3, paint: finPaint({ c: [1.0, 0.85, 0.2], tint: 0.4, flut: 1.2 }) },
    dorsal: { u0: 0.12, u1: 0.88, hgt: 0.15, sweep: 0.3, nu: 18, prof: (s) => Math.pow(Math.sin(Math.PI * s), 0.5) * (0.7 + 0.3 * s),
      paint: finPaint({ c: [0.55, 0.6, 0.78], edge: [0.35, 0.85, 1.0], edgeAt: 0.72, edgeTint: 0.2, flut: 0.5, rays: 0.3, nr: 14 }) },
    anal: { u0: 0.38, u1: 0.88, hgt: 0.13, sweep: 0.3, nu: 14, prof: (s) => Math.pow(Math.sin(Math.PI * s), 0.5) * (0.7 + 0.3 * s),
      paint: finPaint({ c: [0.55, 0.6, 0.78], edge: [0.35, 0.85, 1.0], edgeAt: 0.72, edgeTint: 0.2, flut: 0.5, rays: 0.3, nr: 10 }) },
  });
}

function buildPuffer() {
  const h = prof(0.6, 0.6, 0.45, 0.08), w = prof(0.52, 0.6, 0.45, 0.07);
  return fishModel({
    x0: 0.9, x1: -0.62, n: 36, m: 24, w, h,
    bodyPaint: (x, y, z, u, v, o) => {
      baseShade(o, v, 0.85, 0.9);
      const ca = Math.cos(v * TAU);
      if (ca > -0.2) mixc(o, 0.22, 0.15, 0.08, 0.25, 0.85 * sstep(0.5, 0.68, noise3(x * 9 + 3, y * 9, z * 9)));
    },
    eye: { u: 0.2, r: 0.14, ang: 0.95, iris: [0.95, 0.75, 0.25], sparkle: true },
    tail: { type: 'round', L: 0.24, spread: 0.2, root: 0.08, paint: finPaint({ c: [1, 0.95, 0.8], flut: 0.9 }) },
    pecs: { u: 0.3, span: 0.08, len: 0.17, back: 0.7, droop: 0.1, paint: finPaint({ c: [1, 0.97, 0.85], flut: 2.2 }) },
    dorsal: { u0: 0.68, u1: 0.84, hgt: 0.12, sweep: 0.5 },
    anal: { u0: 0.68, u1: 0.84, hgt: 0.1, sweep: 0.5 },
    extra: ({ xAt, w: W, h: H, add }) => {
      const nrm = new THREE.Vector3();
      for (let i = 0; i < 8; i++) {
        const u = 0.16 + i * 0.09;
        for (let j = 0; j < 11; j++) {
          const a = ((j + (i % 2) * 0.5) / 11) * TAU;
          if (u < 0.32 && Math.abs(Math.sin(a)) > 0.5 && Math.abs(Math.cos(a)) < 0.6) continue; // keep eyes clear
          const px = xAt(u), py = H(u) * Math.cos(a), pz = W(u) * Math.sin(a);
          nrm.set((0.45 - u) * 0.8, Math.cos(a), Math.sin(a)).normalize();
          const len = 0.11;
          const g = aim(cone(0.022, len), nrm, V(px - nrm.x * 0.02, py - nrm.y * 0.02, pz - nrm.z * 0.02));
          add(g, (x, y, z, uu, vv, o) => {
            set(o, 0.95, 0.9, 0.75, 0.4); o.spec = clamp(Math.hypot(x - px, y - py, z - pz) / len, 0, 1);
          });
        }
      }
    },
  });
}

function buildBarracuda() {
  const h = prof(0.15, 0.95, 0.5, 0.04), w = prof(0.11, 0.95, 0.5, 0.03);
  return fishModel({
    x0: 1, x1: -0.78, n: 48, m: 16, w, h,
    bodyPaint: (x, y, z, u, v, o) => {
      baseShade(o, v, 0.75, 0.85);
      const ca = Math.cos(v * TAU);
      if (u > 0.2 && u < 0.86 && ca > -0.3 && fract(u * 10 - ca * 0.18) < 0.28) mixc(o, 0.12, 0.15, 0.2, 0.15, 0.75);
      if (u > 0.6 && ca < 0.4 && ca > -0.3 && noise3(x * 18, y * 18, z * 18) > 0.72) set(o, 0.03, 0.03, 0.04, 0);
      if (u < 0.1 && Math.abs(ca + 0.15) < 0.12) set(o, 0.12, 0.05, 0.06, 0); // jaw line
    },
    eye: { u: 0.13, r: 0.058, ang: 1.0, iris: [0.95, 0.8, 0.25], pupil: 0.66 },
    tail: { type: 'fork', L: 0.4, spread: 0.32, fork: 0.55, root: 0.04, paint: finPaint({ c: [0.45, 0.5, 0.56], edge: [0.08, 0.08, 0.1], edgeAt: 0.8, flut: 0.6 }) },
    pecs: { u: 0.2, span: 0.05, len: 0.16, back: 1.2, droop: 0.3, paint: finPaint({ c: [0.85, 0.85, 0.75], flut: 0.9 }) },
    dorsal: [{ u0: 0.3, u1: 0.42, hgt: 0.12, sweep: 0.5 }, { u0: 0.66, u1: 0.74, hgt: 0.09, sweep: 0.6 }],
    anal: { u0: 0.66, u1: 0.74, hgt: 0.08, sweep: 0.6 },
    extra: ({ xAt, w: W, h: H, add }) => {
      for (const side of [-1, 1]) for (let i = 0; i < 6; i++) {
        const u = 0.02 + i * 0.016, px = xAt(u), pz = side * W(u) * 0.8, py = -H(u) * 0.2;
        add(aim(cone(0.009, 0.05, 3), V(0.35, 1, 0), V(px, py, pz)), (x, y, z, uu, vv, o) => { set(o, 1, 1, 0.95, 0); o.emis = 0.15; });
      }
    },
  });
}

function buildGrouper() {
  const h = prof(0.5, 0.55, 0.55, 0.1), w = prof(0.36, 0.55, 0.55, 0.07);
  return fishModel({
    x0: 1, x1: -0.62, n: 44, m: 24, w, h,
    bodyPaint: (x, y, z, u, v, o) => {
      baseShade(o, v, 0.85, 0.55);
      const ca = Math.cos(v * TAU);
      const k = 0.55 + 0.6 * sstep(0.25, 0.7, noise3(x * 5 + 7, y * 5, z * 5));
      o.r *= k; o.g *= k; o.b *= k;
      if (ca > -0.4) mixc(o, 1.0, 0.92, 0.75, 0.35, 0.7 * sstep(0.62, 0.78, noise3(x * 15, y * 15 + 2, z * 15)));
      if (u < 0.05) set(o, 0.18, 0.04, 0.05, 0);
    },
    eye: { u: 0.15, r: 0.078, ang: 0.85, iris: [0.85, 0.55, 0.15] },
    tail: { type: 'round', L: 0.38, spread: 0.34, root: 0.1, paint: finPaint({ c: [0.85, 0.8, 0.75], edge: [1.0, 0.85, 0.55], edgeAt: 0.88, edgeTint: 0.4, flut: 0.6 }) },
    pecs: { u: 0.26, span: 0.12, len: 0.32, back: 0.8, droop: 0.4, paint: finPaint({ c: [0.9, 0.85, 0.8], flut: 0.9, rays: 0.3 }) },
    dorsal: { u0: 0.22, u1: 0.72, hgt: 0.17, sweep: 0.25, nu: 28,
      prof: (s) => Math.pow(Math.sin(Math.PI * s), 0.5) * (0.75 + 0.25 * Math.abs(Math.sin(s * Math.PI * 9))),
      paint: finPaint({ c: [0.75, 0.7, 0.65], rays: 0.4, nr: 12, flut: 0.25 }) },
    anal: { u0: 0.58, u1: 0.76, hgt: 0.14, sweep: 0.4, paint: finPaint({ c: [0.8, 0.75, 0.7], flut: 0.3 }) },
    extra: ({ add }) => {
      const lips = new THREE.TorusGeometry(0.15, 0.055, 8, 22).rotateY(Math.PI / 2).scale(1, 1.4, 1.1).translate(0.97, -0.04, 0);
      add(lips, (x, y, z, u, v, o) => set(o, 0.82, 0.74, 0.7, 1));
    },
  });
}

// ENEMY: every dangerous (non-boss) fish is drawn with this one model so threats read instantly. Deep, round,
// piranha-like body that fills its hitbox circle (radius = entity.size; see the hitbox ring below): dark back,
// pale belly, underbite with white fangs, glaring eye. Colour is fixed (not species-tinted).
function buildEnemy() {
  const h = prof(0.74, 0.5, 0.6, 0.12), w = prof(0.42, 0.5, 0.6, 0.08);
  return fishModel({
    x0: 0.82, x1: -0.55, n: 40, m: 24, w, h,
    bodyPaint: (x, y, z, u, v, o) => {
      baseShade(o, v, 0.55, 1.1);
      const ca = Math.cos(v * TAU);
      if (ca < -0.15) mixc(o, 0.95, 0.88, 0.8, 0, 0.75 * sstep(-0.15, -0.6, ca));   // pale belly
      const k = 0.85 + 0.3 * noise3(x * 7, y * 7 + 3, z * 7); o.r *= k; o.g *= k; o.b *= k;
      if (u < 0.04) set(o, 0.12, 0.03, 0.04, 0);
    },
    eye: { u: 0.17, r: 0.1, ang: 0.75, iris: [1.0, 0.82, 0.1], irisGlow: 0.35, slit: true, fwd: 0.6, up: -0.15 },
    tail: { type: 'fork', fork: 0.45, L: 0.34, spread: 0.36, root: 0.1, paint: finPaint({ c: [0.55, 0.55, 0.6], flut: 0.6 }) },
    pecs: { u: 0.3, span: 0.1, len: 0.22, back: 0.8, droop: 0.35, paint: finPaint({ c: [0.6, 0.6, 0.65], flut: 1.0 }) },
    dorsal: { u0: 0.3, u1: 0.62, hgt: 0.2, sweep: 0.55, paint: finPaint({ c: [0.45, 0.45, 0.5], flut: 0.3 }) },
    anal: { u0: 0.55, u1: 0.72, hgt: 0.16, sweep: 0.5, paint: finPaint({ c: [0.5, 0.5, 0.55], flut: 0.3 }) },
    extra: ({ xAt, w: W, h: H, add }) => {
      // underbite jaw + fangs
      const jaw = new THREE.SphereGeometry(0.2, 14, 10).scale(1.15, 0.55, 0.9).translate(0.72, -0.2, 0);
      add(jaw, (x, y, z, uu, vv, o) => set(o, 0.85, 0.8, 0.75, 0.3));
      for (let k = 0; k < 7; k++) {
        const a = lerp(-1.1, 1.1, k / 6), px = 0.72 + 0.17 * Math.cos(a) * 0.9, pz = 0.17 * Math.sin(a);
        const len = k % 2 ? 0.1 : 0.14;
        add(aim(cone(0.028, len), V(0.25, 1, 0), V(px, -0.13, pz)), (x, y, z, uu, vv, o) => { set(o, 1, 1, 0.95, 0); o.emis = 0.3; });
      }
      for (let k = 0; k < 5; k++) {
        const a = lerp(-0.9, 0.9, k / 4), px = 0.66 + 0.15 * Math.cos(a), pz = 0.15 * Math.sin(a);
        add(aim(cone(0.024, 0.08), V(0.25, -1, 0), V(px, -0.05, pz)), (x, y, z, uu, vv, o) => { set(o, 1, 1, 0.95, 0); o.emis = 0.3; });
      }
    },
  });
}

// Shared angler head kit (teeth + lures), used by angler and anglerking.
function anglerTeeth({ xAt, w: W, h: H, add }, scale = 1) {
  const tooth = (u, a, upward, len) => {
    const px = xAt(u), py = H(u) * Math.cos(a), pz = W(u) * Math.sin(a);
    add(aim(cone(0.03 * scale, len), V(0.6, upward ? 1 : -1, 0), V(px + 0.02, py, pz)),
      (x, y, z, uu, vv, o) => { set(o, 0.95, 0.95, 0.85, 0); o.emis = 0.25; });
  };
  for (let k = 0; k < 11; k++) tooth(0.05, lerp(1.75, TAU - 1.75, k / 10), true, (0.1 + 0.05 * ((k * 7) % 3)) * scale);
  for (let k = 0; k < 9; k++) tooth(0.06, lerp(-1.35, 1.35, k / 8), false, (0.09 + 0.04 * ((k * 5) % 3)) * scale);
}
function anglerLure(add, p0, p1, p2, bulbR, col, emis, lureId) {
  const stalk = sweep([p0, p1, p2], (s) => 0.022 * (1 - 0.4 * s), 18, 5);
  add(stalk, (x, y, z, uu, vv, o) => { set(o, 0.8, 0.75, 0.9, 0.8); o.spec = uu; o.part = lureId; o.bio = uu * 0.3; });
  add(new THREE.SphereGeometry(bulbR, 14, 10).translate(p2.x, p2.y, p2.z),
    (x, y, z, uu, vv, o) => { set(o, col[0], col[1], col[2], 0); o.emis = emis; o.spec = 1; o.part = lureId; });
}

function buildAngler() {
  const h = prof(0.62, 0.42, 0.75, 0.08), w = prof(0.5, 0.42, 0.8, 0.07);
  return fishModel({
    x0: 1, x1: -0.55, n: 40, m: 24, w, h,
    bodyPaint: (x, y, z, u, v, o) => {
      baseShade(o, v, 0.85, 0.3);
      const k = 0.8 + 0.4 * noise3(x * 9, y * 9, z * 9);
      o.r *= k; o.g *= k; o.b *= k;
      if (u < 0.07) set(o, 0.06, 0.01, 0.03, 0);
    },
    eye: { u: 0.2, r: 0.055, ang: 0.75, iris: [0.75, 0.95, 1.0], irisGlow: 0.9 },
    tail: { type: 'round', L: 0.3, spread: 0.28, root: 0.08, paint: finPaint({ c: [0.7, 0.65, 0.8], rays: 0.45, flut: 0.8, edge: [0.4, 0.9, 1], edgeAt: 0.92, bio: 0.4 }) },
    pecs: { u: 0.3, span: 0.1, len: 0.26, back: 0.6, droop: 0.4, paint: finPaint({ c: [0.75, 0.7, 0.85], rays: 0.45, flut: 1 }) },
    dorsal: { u0: 0.55, u1: 0.8, hgt: 0.1, sweep: 0.4 },
    anal: { u0: 0.6, u1: 0.8, hgt: 0.09, sweep: 0.4 },
    extra: (ctx) => {
      addDots(ctx, range(0.26, 0.8, 0.065), [1.35, -1.35], 0.024, [0.45, 0.72, 1.0], 1.4);
      addDots(ctx, range(0.3, 0.75, 0.09), [1.9, -1.9], 0.018, [0.6, 0.7, 1.0], 1.2);
      anglerTeeth(ctx);
      anglerLure(ctx.add, V(0.6, ctx.h(0.23) * 0.95, 0), V(1.0, 1.0, 0), V(1.32, 0.7, 0), 0.06, [0.55, 0.85, 1.0], 2.2, 1);
    },
  });
}

function buildShark() {
  const h = prof(0.21, 0.82, 0.55, 0.045), w = prof(0.17, 0.82, 0.55, 0.035);
  return fishModel(sharkSpec(h, w));
}
function sharkSpec(h, w, extra = {}) {
  const finC = finPaint({ c: [0.85, 0.85, 0.88], edge: [0.25, 0.27, 0.3], edgeAt: 0.85, edgeTint: 0.6, flut: 0.3, rays: 0.04 });
  return {
    x0: 1, x1: -0.75, n: extra.n || 56, m: extra.m || 22, w, h,
    bodyPaint: (x, y, z, u, v, o) => {
      const ca = Math.cos(v * TAU);
      const k = 0.85 + 0.1 * noise3(x * 6, y * 6, z * 6);
      set(o, k, k, k, 1);
      mixc(o, 0.96, 0.96, 0.94, 0.05, sstep(-0.05, -0.3, ca + 0.08 * Math.sin(u * 30)));
      if (u > 0.19 && u < 0.29 && Math.abs(ca) < 0.45 && fract((u - 0.19) * 55) < 0.3) mixc(o, 0.08, 0.09, 0.11, 0.2, 0.85); // gills
      if (extra.paint) extra.paint(x, y, z, u, v, o);
    },
    eye: extra.eye || { u: 0.1, r: 0.042, ang: 1.1, iris: null },
    tail: { type: 'crescent', L: 0.46, spread: 0.36, upper: 1.35, root: 0.045, paint: finC },
    pecs: { u: 0.24, span: 0.11, len: 0.5, back: 1.0, droop: 0.65, splay: 0.35, leaf: (s) => 1 - 0.85 * Math.pow(s, 0.7), paint: finC },
    dorsal: [{ u0: 0.32, u1: 0.5, hgt: 0.33, sweep: 0.55, prof: (s) => (s < 0.3 ? Math.pow(s / 0.3, 0.8) : Math.pow(1 - (s - 0.3) / 0.7, 1.6)), paint: finC },
      { u0: 0.74, u1: 0.8, hgt: 0.07, sweep: 0.5 }],
    anal: [{ u0: 0.74, u1: 0.8, hgt: 0.06, sweep: 0.5 }, { u0: 0.55, u1: 0.62, hgt: 0.08, sweep: 0.7, paint: finC }],
    extra: extra.extra,
  };
}

function buildWhale() {
  const h = prof(0.28, 0.5, 0.6, 0.05), w = prof(0.25, 0.5, 0.6, 0.04);
  return fishModel({
    x0: 1, x1: -0.78, n: 56, m: 24, w, h,
    bodyPaint: (x, y, z, u, v, o) => {
      baseShade(o, v, 0.85, 0.0);
      const ca = Math.cos(v * TAU);
      if (ca < -0.25 && u < 0.6) {
        const pleat = Math.cos(u * 140) > 0.3 ? 0.65 : 1.0; // ventral grooves run along the body
        mixc(o, 0.85 * pleat, 0.86 * pleat, 0.88 * pleat, 0.1, sstep(-0.25, -0.55, ca));
      }
      if (u < 0.3 && ca > 0.3 && noise3(x * 26, y * 26, z * 26) > 0.76) mixc(o, 0.8, 0.8, 0.76, 0.2, 0.35);
      if (u > 0.12 && u < 0.16 && ca > 0.97) set(o, 0.05, 0.05, 0.08, 0);
    },
    eye: { u: 0.21, r: 0.036, ang: 1.75, iris: [0.4, 0.25, 0.15] },
    tail: { type: 'fluke', L: 0.38, spread: 0.6, root: 0.05, nu: 20, tilt: 0.6, paint: finPaint({ c: [0.85, 0.85, 0.9], flut: 0.4, rays: 0.0, edge: [0.95, 0.95, 1], edgeAt: 0.9, edgeTint: 0.3 }) },
    pecs: { u: 0.25, span: 0.11, len: 0.6, back: 0.8, droop: 0.7, splay: 0.35, nu: 6, nv: 10,
      leaf: (s) => (1 - 0.75 * s) * (0.85 + 0.15 * Math.sin(s * 3.1)),
      paint: (x, y, z, s, t, o) => { set(o, 0.88, 0.9, 0.93, 0.35); if (s < 0.2 && fract(t * 6) < 0.3) set(o, 1, 1, 1, 0.2); o.flut = 0.35 * t; } },
    dorsal: { u0: 0.68, u1: 0.76, hgt: 0.05, sweep: 0.8 },
    extra: (ctx) => {
      addDots(ctx, range(0.24, 0.84, 0.05), [1.5, -1.5], 0.009, [0.45, 0.75, 1.0], 1.6);
      addDots(ctx, range(0.27, 0.8, 0.07), [1.2, -1.2], 0.007, [0.6, 0.85, 1.0], 1.4);
    },
  });
}

function buildKrill() {
  const h = prof(0.16, 0.6, 0.5, 0.05), w = prof(0.12, 0.6, 0.5, 0.04);
  return fishModel({
    x0: 1, x1: -0.55, n: 30, m: 12, w, h, yc: (u) => 0.08 * Math.sin(Math.PI * u),
    bodyPaint: (x, y, z, u, v, o) => {
      const ca = Math.cos(v * TAU);
      const k = 0.85 + 0.2 * Math.cos(u * TAU * 7);
      set(o, k, k, k, 1);
      mixc(o, 1.0, 0.9, 0.85, 0.5, sstep(0, -0.8, ca));
    },
    eye: { u: 0.08, r: 0.06, ang: 0.9, iris: null },
    tail: { type: 'round', L: 0.3, spread: 0.2, root: 0.05, paint: finPaint({ c: [1.0, 0.9, 0.88], rays: 0.4, nr: 5, flut: 0.9 }) },
    pecs: [0.32, 0.4, 0.48, 0.56, 0.64].map((u) => ({ u, span: 0.03, len: 0.16, back: 0.25, droop: 1.0, yOff: -0.7, vert: 0, splay: 0.2, nu: 2, nv: 3,
      paint: finPaint({ c: [1, 0.85, 0.85], flut: 2.0, rays: 0 }) })),
    extra: (ctx) => {
      addDots(ctx, range(0.3, 0.8, 0.1), [1.9, -1.9], 0.03, [0.5, 0.75, 1.0], 1.6);
      for (const side of [-1, 1]) {
        ctx.add(ribbon((s, c) => c.set(1.0 - 1.7 * s, 0.08 + 0.35 * Math.sin(s * 2.0) - 0.1 * s, side * 0.06), (s) => 0.01 * (1 - s) + 0.003, 14, 'y'),
          (x, y, z, s, t, o) => { set(o, 1.0, 0.8, 0.75, 0.6); o.flut = s * 1.2; });
      }
    },
  });
}

// ---------------------------------------------------------------- hero evolution forms
const HTEAL = [0.3, 0.85, 1.0], HVIOLET = [0.72, 0.45, 1.0];
const hgrad = (k) => (s, t) => {
  const m = clamp(t * 0.9 + k, 0, 1);
  return [lerp(HTEAL[0], HVIOLET[0], m) * (1 + 0.25 * t), lerp(HTEAL[1], HVIOLET[1], m) * (1 + 0.25 * t), lerp(HTEAL[2], HVIOLET[2], m) * (1 + 0.2 * t), 0.15];
};
const HERO_EYE = { iris: [0.15, 0.85, 0.95], irisGlow: 0.25, sparkle: true, pupil: 0.8, fwd: 0.45, up: 0.15 };

// Parametric hero fish: fry / fish / hunter / apex.
function buildHeroFish(o = {}) {
  const H0 = o.h ?? 0.3, W0 = o.w ?? 0.22;
  const h = prof(H0, 0.68, 0.6, 0.07 * H0 / 0.3), w = prof(W0, 0.68, 0.6, 0.05 * W0 / 0.22);
  const extraFns = [];
  const spec = {
    x0: 1, x1: o.x1 ?? -0.6, n: o.n || 48, m: o.m || 24, w, h,
    bodyPaint: (x, y, z, u, v, p) => {
      const ca = Math.cos(v * TAU);
      const sc = 0.86 + 0.08 * Math.cos(u * 70) * Math.cos(v * TAU * 14) - 0.12 * sstep(0.3, 1, ca);
      set(p, sc, sc, sc, 1);
      mixc(p, 1.0, 1.0, 1.0, 0.45, sstep(-0.1, -0.8, ca));
      if (Math.abs(ca) < 0.08 && u > 0.25 && u < 0.9) { p.r *= 1.25; p.g *= 1.25; p.b *= 1.25; }
      p.emis = 0.02;
      if (o.armor && u > 0.12 && u < 0.85) {
        const pl = fract(u * 9 - Math.abs(ca) * 0.35);
        if (pl < 0.09 && ca > -0.6) { set(p, 0.7, 0.85, 1.0, 0.2); p.emis = 0.5; }
        else if (ca > -0.3) { p.r *= 0.82; p.g *= 0.82; p.b *= 0.86; }
      }
    },
    eye: { ...HERO_EYE, u: o.eyeU ?? 0.15, r: o.eyeR ?? 0.13, ang: 1.0, ...(o.eye || {}) },
    tail: o.tail || { type: 'veil', L: 1.05, spread: 0.55, root: 0.06, nu: 22, nv: 10, cup: 0.02,
      paint: finPaint({ grad: hgrad(0.1), flut: 1.7, rays: 0.22, nr: 11, emisEdge: 0.45 }) },
    pecs: { u: 0.25, span: 0.15, len: o.pecLen ?? 0.48, back: 0.95, droop: 0.4, splay: 0.3, nv: 8, nu: 10,
      leaf: (s) => (1 - 0.5 * s) * (0.55 + 0.45 * Math.sin(Math.PI * (0.15 + 0.85 * s))),
      paint: finPaint({ grad: hgrad(0.25), flut: 1.5, rays: 0.2, nr: 6, emisEdge: o.edge ?? 0.4 }) },
    dorsal: o.dorsal || { u0: 0.22, u1: 0.78, hgt: 0.22, sweep: 1.3, nu: 18, prof: (s) => Math.pow(Math.sin(Math.PI * Math.pow(s, 0.6)), 0.8),
      paint: finPaint({ grad: hgrad(0.3), flut: 0.9, rays: 0.25, nr: 14, emisEdge: o.edge ?? 0.35 }) },
    anal: o.anal || { u0: 0.6, u1: 0.85, hgt: 0.16, sweep: 1.4, prof: (s) => Math.pow(Math.sin(Math.PI * Math.pow(s, 0.6)), 0.8),
      paint: finPaint({ grad: hgrad(0.35), flut: 1.0, rays: 0.25, nr: 8, emisEdge: o.edge ?? 0.35 }) },
    extra: (ctx) => {
      const { xAt, h: H, add } = ctx;
      const sl = o.streamer ?? 0.95;
      if (sl > 0) for (const side of [-1, 1]) {
        const u0 = 0.4, x0 = xAt(u0), y0 = -H(u0) * 0.85, z0 = side * 0.06;
        add(ribbon((s, c) => c.set(x0 - sl * s, y0 - 0.3 * Math.sin(s * 1.6) + 0.12 * s, z0), (s) => 0.035 * (1 - s) + 0.008, 14, 'y'),
          (x, y, z, s, t, p) => { const g = hgrad(0.4)(s, 1); set(p, g[0], g[1], g[2], 0.15); p.flut = 1.8 * s; p.emis = 0.4 * s; });
      }
      for (const fn of extraFns) fn(ctx);
    },
  };
  if (o.spines) extraFns.push(({ xAt, h: H, add }) => {
    // short glowing spines along the back
    for (let i = 0; i < o.spines; i++) {
      const u = 0.2 + i * (0.55 / o.spines), x = xAt(u), y = H(u) * 0.95, len = 0.07 + 0.03 * Math.sin(i);
      add(aim(cone(0.018, len, 4), V(-0.6, 1, 0), V(x, y - 0.01, 0)), (px, py, pz, uu, vv, p) => {
        const t = clamp((py - y) / len, 0, 1); const g = hgrad(0.3 + 0.5 * t)(0, 1); set(p, g[0], g[1], g[2], 0.1); p.emis = 0.5 * t;
      });
    }
  });
  if (o.crown) extraFns.push(({ xAt, h: H, add }) => {
    // the crown: tall spiked crest fin over the head, tipped with glowing spikes
    const R = (s, out) => { const u = lerp(0.06, 0.34, s); out.set(xAt(u), H(u) * 0.9, 0); };
    const pf = (s) => Math.pow(Math.sin(Math.PI * s), 0.6) * (0.65 + 0.35 * Math.abs(Math.cos(s * Math.PI * 4)));
    add(fin(R, (s, out) => { R(s, out); const k = pf(s); out.x -= 0.55 * 0.45 * k; out.y += 0.45 * k; }, 24, 6),
      finPaint({ grad: hgrad(0.45), flut: 0.4, rays: 0.4, nr: 8, emisEdge: 0.9 }));
    for (let i = 0; i < 5; i++) {
      const s = 0.12 + i * 0.19, u = lerp(0.06, 0.34, s), k = pf(s);
      const base = V(xAt(u) - 0.55 * 0.45 * k * 0.92, H(u) * 0.9 + 0.45 * k * 0.92, 0), len = 0.12;
      add(aim(cone(0.02, len, 5), V(-0.5, 1, 0), base), (px, py, pz, uu, vv, p) => {
        const t = clamp((py - base.y) / len, 0, 1); set(p, 0.8, 0.95, 1.0, 0); p.emis = 0.4 + 1.6 * t;
      });
    }
  });
  return fishModel(spec);
}
const buildHero = () => buildHeroFish();
const buildHeroFry = () => buildHeroFish({
  h: 0.34, w: 0.24, x1: -0.45, eyeU: 0.17, eyeR: 0.19, pecLen: 0.26, streamer: 0,
  tail: { type: 'round', L: 0.5, spread: 0.36, root: 0.07, paint: finPaint({ grad: hgrad(0.15), flut: 1.4, rays: 0.2, nr: 9, emisEdge: 0.4 }) },
  dorsal: { u0: 0.4, u1: 0.75, hgt: 0.14, sweep: 0.5, paint: finPaint({ grad: hgrad(0.3), flut: 0.7, emisEdge: 0.35 }) },
  anal: { u0: 0.6, u1: 0.8, hgt: 0.1, sweep: 0.5, paint: finPaint({ grad: hgrad(0.35), flut: 0.7, emisEdge: 0.35 }) },
});
const buildHeroHunter = () => buildHeroFish({
  h: 0.24, w: 0.17, x1: -0.72, eyeR: 0.1, eyeU: 0.13, pecLen: 0.62, spines: 7, streamer: 1.1, n: 52,
  eye: { pupil: 0.72 },
  tail: { type: 'fork', L: 0.85, spread: 0.6, fork: 0.5, root: 0.05, nu: 22, nv: 8,
    paint: finPaint({ grad: hgrad(0.1), flut: 1.3, rays: 0.25, nr: 13, emisEdge: 0.5 }) },
  dorsal: { u0: 0.3, u1: 0.62, hgt: 0.3, sweep: 1.0, prof: (s) => (s < 0.25 ? s / 0.25 : Math.pow(1 - (s - 0.25) / 0.75, 1.2)),
    paint: finPaint({ grad: hgrad(0.3), flut: 0.6, rays: 0.3, nr: 10, emisEdge: 0.45 }) },
  anal: { u0: 0.6, u1: 0.8, hgt: 0.2, sweep: 1.2, paint: finPaint({ grad: hgrad(0.35), flut: 0.8, emisEdge: 0.4 }) },
});
const buildHeroApex = () => buildHeroFish({
  h: 0.31, w: 0.23, x1: -0.7, eyeR: 0.1, eyeU: 0.13, pecLen: 0.78, armor: true, crown: true, streamer: 1.5, edge: 0.7, n: 56, m: 28,
  eye: { irisGlow: 0.8, pupil: 0.7 },
  tail: { type: 'veil', L: 1.4, spread: 0.72, root: 0.06, nu: 26, nv: 12, cup: 0.02,
    paint: finPaint({ grad: hgrad(0.1), flut: 1.8, rays: 0.25, nr: 13, emisEdge: 0.8 }) },
  dorsal: { u0: 0.36, u1: 0.82, hgt: 0.26, sweep: 1.5, nu: 18, prof: (s) => Math.pow(Math.sin(Math.PI * Math.pow(s, 0.6)), 0.8),
    paint: finPaint({ grad: hgrad(0.35), flut: 1.0, rays: 0.25, nr: 14, emisEdge: 0.7 }) },
  anal: { u0: 0.58, u1: 0.86, hgt: 0.22, sweep: 1.6, prof: (s) => Math.pow(Math.sin(Math.PI * Math.pow(s, 0.6)), 0.8),
    paint: finPaint({ grad: hgrad(0.4), flut: 1.2, rays: 0.25, nr: 8, emisEdge: 0.7 }) },
});

function buildHeroLarva() {
  const h = prof(0.17, 0.6, 0.5, 0.05), w = prof(0.1, 0.6, 0.5, 0.03);
  const finP = finPaint({ grad: hgrad(0.2), flut: 1.0, rays: 0.15, nr: 18, emisEdge: 0.3 });
  return fishModel({
    x0: 1, x1: -0.78, n: 40, m: 16, w, h, bodyLast: true,
    bodyPaint: (x, y, z, u, v, o) => { const k = 1.05 + 0.1 * Math.cos(u * 60); set(o, k, k, k, 1); o.bio = 0.15; },
    eye: { ...HERO_EYE, u: 0.1, r: 0.17, ang: 1.05 },
    tail: { type: 'round', L: 0.32, spread: 0.2, root: 0.05, paint: finP },
    pecs: { u: 0.22, span: 0.06, len: 0.16, back: 0.8, droop: 0.3, paint: finPaint({ grad: hgrad(0.2), flut: 2.0 }) },
    dorsal: { u0: 0.28, u1: 1.0, hgt: 0.12, sweep: 0.15, nu: 24, prof: (s) => Math.pow(Math.min(1, s * 3), 0.6) * (1 - 0.3 * s), paint: finP },
    anal: { u0: 0.5, u1: 1.0, hgt: 0.1, sweep: 0.15, nu: 18, prof: (s) => Math.pow(Math.min(1, s * 3), 0.6) * (1 - 0.3 * s), paint: finP },
    extra: ({ add }) => {
      // glowing yolk sac + notochord + gut seen through the body
      add(new THREE.SphereGeometry(0.2, 18, 12).scale(1.35, 1, 0.85).translate(0.45, -0.17, 0),
        (x, y, z, u, v, o) => { set(o, 1.0, 0.72, 0.28, 0); o.emis = 0.4; });
      add(sweep([V(0.7, 0.02, 0), V(0.1, 0.0, 0), V(-0.75, 0.0, 0)], (s) => 0.022 * (1 - 0.6 * s), 24, 5),
        (x, y, z, u, v, o) => { set(o, 0.75, 0.88, 1.0, 0.3); o.emis = 0.35; });
      add(sweep([V(0.3, -0.08, 0), V(-0.1, -0.1, 0), V(-0.35, -0.06, 0)], (s) => 0.03, 12, 5),
        (x, y, z, u, v, o) => { set(o, 0.9, 0.5, 0.9, 0); o.emis = 0.3; });
    },
  });
}

// Single cell: translucent membrane, nucleus, organelles, cilia ring, flagellum (all animated in mode 7).
function buildCell({ eyes = false, flagella = 1 } = {}) {
  const parts = [];
  const add = (g, fn) => parts.push(paintGeo(g, fn));
  add(new THREE.SphereGeometry(1, 40, 28).scale(1.15, 0.92, 0.7), (x, y, z, u, v, o) => {
    const k = 0.9 + 0.25 * noise3(x * 6, y * 6, z * 6);
    set(o, k, k, k, 1); o.bio = 0.12;
  });
  add(new THREE.SphereGeometry(0.36, 20, 14).translate(-0.15, 0.06, 0),
    (x, y, z, u, v, o) => { set(o, 0.85, 0.55, 1.0, 0.25); o.bio = 1.0; o.part = 3; });
  add(new THREE.SphereGeometry(0.13, 12, 8).translate(-0.1, 0.12, 0.2),
    (x, y, z, u, v, o) => { set(o, 1.0, 0.75, 1.0, 0.2); o.emis = 0.5; o.part = 3; });
  const oc = [[0.55, 0.7, 1], [1, 0.8, 0.4], [0.9, 0.6, 1], [0.55, 0.9, 1]];
  for (let i = 0; i < 8; i++) {
    const a = hash3(i, 1, 9) * TAU, r = 0.35 + 0.35 * hash3(i, 3, 3), c = oc[i % 4];
    const g = new THREE.SphereGeometry(0.07 + 0.06 * hash3(i, 5, 5), 10, 8).scale(1.6, 1, 1)
      .rotateZ(a).translate(Math.cos(a) * r, Math.sin(a) * r * 0.8, (hash3(i, 7, 1) - 0.5) * 0.5);
    add(g, (x, y, z, u, v, o) => { set(o, c[0], c[1], c[2], 0.3); o.bio = 0.7; o.part = 3; });
  }
  if (eyes) for (const side of [-1, 1]) addEye(add, 0.58, 0.2, side * 0.47, 0.21, side, { ...HERO_EYE, fwd: 0.5, up: 0.2 });
  // cilia: three rings of hair around the rim
  for (const zr of [0, 0.38, -0.38]) {
    const sc = Math.sqrt(1 - (zr / 0.7) ** 2), cnt = zr === 0 ? 34 : 26;
    for (let i = 0; i < cnt; i++) {
      const a = (i + (zr ? 0.5 : 0)) / cnt * TAU;
      if (Math.cos(a) < -0.93) continue;
      const p = V(1.15 * sc * Math.cos(a), 0.92 * sc * Math.sin(a), zr), len = 0.16;
      const d = V(Math.cos(a) / 1.15, Math.sin(a) / 0.92, zr * 0.6).normalize();
      add(aim(cone(0.022, len, 3), d, p.clone().addScaledVector(d, -0.02)), (x, y, z, u, v, o) => {
        set(o, 1.0, 1.0, 1.0, 0.7); o.spec = clamp(Math.hypot(x - p.x, y - p.y, z - p.z) / len, 0, 1); o.part = 2; o.bio = 0.1;
      });
    }
  }
  for (let k = 0; k < flagella; k++) {
    const yo = (k - (flagella - 1) / 2) * 0.35;
    add(sweep([V(-1.08, yo, 0), V(-1.6, yo + 0.1, 0), V(-2.2, yo - 0.08, 0), V(-2.85, yo + 0.04, 0)], (s) => 0.06 * (1 - s) + 0.012, 40, 5),
      (x, y, z, u, v, o) => { set(o, 1.0, 1.0, 1.0, 0.8); o.spec = u; o.part = 1; o.bio = 0.5 * u; });
  }
  parts.push(parts.shift()); // membrane last (translucent, depth-writing)
  return { geo: mergeGeometries(parts), minX: -1.15, maxX: 1.15, pivot: null };
}
// Rod-shaped bacteria colony.
function buildRods() {
  const parts = [];
  const add = (g, fn) => parts.push(paintGeo(g, fn));
  const rods = [[0.45, 0.1, 0.25], [-0.35, -0.15, -0.3], [0.05, 0.42, 1.1], [-0.15, -0.55, 0.9]];
  rods.forEach(([x, y, a], i) => {
    const g = new THREE.CapsuleGeometry(0.2, 0.7, 6, 14).rotateZ(Math.PI / 2 + a).translate(x, y, (i % 2 ? 0.1 : -0.1));
    add(g, (px, py, pz, u, v, o) => { const k = 0.9 + 0.3 * Math.abs(Math.sin((px - x) * 8)); set(o, k, k, k, 1); o.bio = 0.2; });
    add(new THREE.SphereGeometry(0.08, 10, 8).translate(x, y, 0), (px, py, pz, u, v, o) => { set(o, 1, 1, 1, 0.5); o.bio = 1.0; o.part = 3; });
    const ca = Math.cos(a), sa = Math.sin(a), ex = x - ca * 0.55, ey = y - sa * 0.55;
    add(sweep([V(ex, ey, 0), V(ex - ca * 0.3, ey - sa * 0.3 + 0.06, 0), V(ex - ca * 0.6, ey - sa * 0.6 - 0.04, 0)], (s) => 0.025 * (1 - s) + 0.008, 16, 4),
      (px, py, pz, u, v, o) => { set(o, 1, 1, 1, 0.8); o.spec = u; o.part = 1; o.bio = 0.3; });
  });
  const inner = parts.filter((_, i) => i % 3 === 1), rest = parts.filter((_, i) => i % 3 !== 1);
  return { geo: mergeGeometries([...inner, ...rest]), byX: true };
}
// Spiky centric diatom / radiolarian.
function buildDiatom() {
  const parts = [];
  const add = (g, fn) => parts.push(paintGeo(g, fn));
  add(new THREE.CylinderGeometry(1, 1, 0.28, 48, 1).rotateX(Math.PI / 2), (x, y, z, u, v, o) => {
    const r = Math.hypot(x, y), a = Math.atan2(y, x);
    const k = 0.75 + 0.3 * Math.pow(0.5 + 0.5 * Math.cos(a * 24), 2) * sstep(0.2, 0.9, r) + 0.2 * Math.cos(r * 18);
    set(o, k, k, k, 1); o.bio = 0.1 + 0.6 * sstep(0.35, 0.0, r);
  });
  add(new THREE.SphereGeometry(0.3, 16, 12).scale(1, 1, 0.8), (x, y, z, u, v, o) => { set(o, 1.1, 1.0, 0.7, 0.4); o.bio = 1.0; o.part = 3; });
  for (let i = 0; i < 14; i++) {
    const a = i / 14 * TAU, d = V(Math.cos(a), Math.sin(a), 0), p = d.clone().multiplyScalar(0.95), len = 0.35 + 0.25 * (i % 2);
    add(aim(cone(0.035, len, 4), d, p), (x, y, z, u, v, o) => {
      set(o, 1, 1, 1, 0.6); o.spec = clamp(Math.hypot(x - p.x, y - p.y) / len, 0, 1); o.part = 2; o.bio = 0.8 * o.spec;
    });
  }
  parts.push(parts.shift());
  return { geo: mergeGeometries(parts), byX: true };
}

function buildLantern() {
  const h = prof(0.26, 0.65, 0.6, 0.05), w = prof(0.15, 0.65, 0.6, 0.035);
  return fishModel({
    x0: 1, x1: -0.66, n: 40, m: 18, w, h,
    bodyPaint: (x, y, z, u, v, o) => {
      baseShade(o, v, 0.7, 0.0);
      const ca = Math.cos(v * TAU);
      mixc(o, 0.7, 0.8, 0.95, 0.3, sstep(-0.1, -0.7, ca));      // silvery-blue belly
      if (Math.abs(ca) < 0.25) { o.r *= 1.15; o.g *= 1.15; o.b *= 1.25; }
    },
    eye: { u: 0.12, r: 0.14, ang: 1.0, iris: [0.4, 0.8, 1.0], irisGlow: 0.4, sparkle: true, pupil: 0.82 },
    tail: { type: 'fork', L: 0.4, spread: 0.3, fork: 0.5, root: 0.05, paint: finPaint({ c: [0.6, 0.7, 0.85], flut: 0.7, rays: 0.3 }) },
    pecs: { u: 0.24, span: 0.06, len: 0.2, back: 1.0, droop: 0.3, paint: finPaint({ c: [0.7, 0.8, 0.95], flut: 1.2 }) },
    dorsal: [{ u0: 0.3, u1: 0.5, hgt: 0.14, sweep: 0.5, paint: finPaint({ c: [0.6, 0.7, 0.85], flut: 0.4 }) }, { u0: 0.78, u1: 0.83, hgt: 0.05, sweep: 0.4 }],
    anal: { u0: 0.55, u1: 0.75, hgt: 0.1, sweep: 0.5 },
    extra: (ctx) => {
      addDots(ctx, range(0.18, 0.86, 0.052), [2.15, -2.15], 0.022, [0.45, 0.72, 1.0], 1.8);
      addDots(ctx, range(0.22, 0.8, 0.07), [2.6, -2.6], 0.018, [0.45, 0.72, 1.0], 1.6);
      addDots(ctx, range(0.3, 0.7, 0.13), [1.6, -1.6], 0.016, [0.55, 0.85, 1.0], 1.4);
      addDots(ctx, [0.05], [1.35, -1.35], 0.03, [0.7, 1.0, 0.9], 2.2);
    },
  });
}

// Squid: mantle tip forward (+X), fins at the tip, head + 8 arms + 2 club tentacles trailing behind.
function buildSquid() {
  const parts = [];
  const bounds = new THREE.Box3();
  const add = (g, fn, inB = false) => { parts.push(paintGeo(g, fn)); if (inB) { g.computeBoundingBox(); bounds.union(g.boundingBox); } };
  const h = (u) => 0.2 * Math.pow(sstep(0, 0.6, u), 0.65) * (1 - 0.12 * u) + 0.004, w = (u) => h(u) * 0.9;
  const skin = (x, y, z, u, v, o) => {
    const ca = Math.cos(v * TAU);
    baseShade(o, v, 0.85, 0.5);
    const k = 0.75 + 0.45 * sstep(0.45, 0.75, noise3(x * 16, y * 16, z * 16));
    o.r *= k; o.g *= k; o.b *= k;
    if (ca > 0.2 && noise3(x * 30 + 4, y * 30, z * 30) > 0.72) mixc(o, 0.35, 0.08, 0.15, 0.5, 0.6);
  };
  add(tube({ x0: 1, x1: -0.15, n: 40, m: 18, w, h }), skin, true);
  for (const sgn of [1, -1]) {
    const R = (s, out) => { const x = lerp(0.97, 0.5, s); const u = (1 - x) / 1.15; out.set(x, sgn * h(u) * 0.85, 0); };
    add(fin(R, (s, out) => { R(s, out); out.y += sgn * 0.24 * Math.pow(Math.sin(Math.PI * Math.pow(s, 0.7)), 0.9); out.x -= 0.06 * s; }, 12, 4),
      finPaint({ c: [0.95, 0.85, 0.9], flut: 0.8, rays: 0.1 }));
  }
  add(new THREE.SphereGeometry(0.19, 20, 14).scale(1.15, 1, 0.95).translate(-0.25, 0, 0), skin, true);
  for (const side of [-1, 1]) addEye(add, -0.22, 0.04, side * 0.13, 0.1, side, { iris: [1.0, 0.8, 0.3], irisGlow: 0.2, sparkle: true, pupil: 0.78, fwd: -0.2 });
  for (let k = 0; k < 8; k++) {
    const y0 = lerp(-0.1, 0.1, (k % 4) / 3), z0 = (k < 4 ? 1 : -1) * 0.07, sp = 1 + 0.4 * ((k % 4) - 1.5) / 1.5;
    const pts = [V(-0.36, y0, z0), V(-0.65, y0 * 1.6 * sp, z0 * 1.3), V(-0.92, y0 * 2.2 * sp + 0.03 * Math.sin(k), z0 * 1.6), V(-1.08, y0 * 2.4 * sp, z0 * 1.7)];
    add(sweep(pts, (s) => 0.045 * (1 - s) + 0.006, 20, 6), (x, y, z, u, v, o) => {
      skin(x, y, z, u, v, o); if (Math.cos(v * TAU) < -0.6 && fract(u * 20) < 0.4) mixc(o, 1, 0.9, 0.85, 0.3, 0.7); o.spec = u; o.part = k + 1;
    }, true);
  }
  for (const s2 of [1, -1]) {
    const pts = [V(-0.36, 0.02 * s2, 0.04 * s2), V(-0.8, 0.06 * s2, 0.05 * s2), V(-1.3, -0.02 * s2, 0.06 * s2), V(-1.75, 0.05 * s2, 0.07 * s2)];
    add(sweep(pts, (s) => 0.02 * (1 - 0.5 * s), 28, 5), (x, y, z, u, v, o) => { skin(x, y, z, u, v, o); o.spec = u; o.part = s2 > 0 ? 9 : 10; });
    add(new THREE.SphereGeometry(0.05, 10, 8).scale(2.2, 1, 0.8).translate(-1.75, 0.05 * s2, 0.07 * s2),
      (x, y, z, u, v, o) => { skin(x, y, z, u, 0.5, o); o.spec = 1; o.part = s2 > 0 ? 9 : 10; });
  }
  return { geo: mergeGeometries(parts), minX: bounds.min.x, maxX: bounds.max.x, pivot: null };
}

function buildJelly() {
  const parts = [];
  const add = (g, fn) => parts.push(paintGeo(g, fn));
  const pts = [];
  for (let i = 0; i <= 16; i++) {
    const a = (i / 16) * Math.PI * 0.5;
    pts.push(new THREE.Vector2(Math.max(Math.sin(a), 0.001), Math.cos(a) * 0.75 - 0.04 + 0.04 * Math.sin(a * 2)));
  }
  pts.push(new THREE.Vector2(0.98, -0.1), new THREE.Vector2(0.9, -0.16));
  const bellGeo = new THREE.LatheGeometry(pts, 36);
  {
    // make sure bell normals point outward (outline hull expands along them)
    const pn = bellGeo.attributes.normal, pp = bellGeo.attributes.position;
    let dot = 0;
    for (let i = 0; i < pp.count; i++) dot += pn.getX(i) * pp.getX(i) + pn.getY(i) * (pp.getY(i) + 0.2) + pn.getZ(i) * pp.getZ(i);
    if (dot < 0) for (let i = 0; i < pn.count; i++) pn.setXYZ(i, -pn.getX(i), -pn.getY(i), -pn.getZ(i));
  }
  add(bellGeo, (x, y, z, u, v, o) => {
    const r = Math.hypot(x, z), ang = Math.atan2(z, x);
    const k = 0.85 + 0.3 * (1 - r);
    set(o, k, k, k, 1);
    const petal = Math.pow(0.5 + 0.5 * Math.cos(4 * ang), 1.5) * sstep(0.16, 0.0, Math.abs(r - 0.36));
    if (petal > 0.05) { mixc(o, 1.1, 0.75, 1.0, 0.35, petal); o.bio = petal * 0.9; }
    if (0.5 + 0.5 * Math.cos(16 * ang) > 0.93 && r > 0.4) { o.r *= 1.2; o.g *= 1.2; o.b *= 1.2; }
    if (r > 0.86) { o.bio = Math.pow(0.5 + 0.5 * Math.cos(16 * ang), 4) * 1.4; mixc(o, 1.1, 1.1, 1.2, 0.5, 0.5); }
  });
  // oral arms: frilly ribbons hanging from the centre
  for (let k = 0; k < 4; k++) {
    const a0 = k * Math.PI / 2 + Math.PI / 4, ca = Math.cos(a0), sa = Math.sin(a0);
    add(ribbon((s, c) => c.set(0.12 * ca + 0.07 * Math.sin(s * 9 + k) - 0.15 * s, lerp(-0.05, -1.2, s), 0.12 * sa),
      (s) => 0.1 * (1 - 0.6 * s) * (0.75 + 0.25 * Math.sin(s * 30)), 18, 'x'),
    (x, y, z, s, t, o) => { set(o, 1.1, 0.95, 1.1, 0.6); o.flut = 0.4 + 0.8 * s; o.bio = 0.5; });
  }
  // tentacles from the rim, hanging down
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * TAU, rx = 0.92 * Math.cos(a), rz = 0.92 * Math.sin(a), len = 1.8 + 0.6 * hash3(k, 1, 2);
    add(ribbon((s, c) => c.set(rx * (1 - 0.3 * s) - 0.2 * s, -0.12 - len * s, rz * (1 - 0.35 * s)), (s) => 0.018 * (1 - 0.7 * s), 14, 'x'),
      (x, y, z, s, t, o) => { set(o, 1.0, 1.0, 1.1, 0.8); o.flut = 0.15 + 1.1 * s; o.bio = 0.6 * s; });
  }
  parts.push(parts.shift()); // bell last
  return { geo: mergeGeometries(parts), byZ: true };
}

// ---------------------------------------------------------------- bosses
function buildMoray() {
  const N = 110, M = 18;
  const h = (u) => 0.15 * Math.pow(sstep(0, 0.1, u), 0.6) * (1 - 0.72 * Math.pow(u, 1.5)) + 0.01;
  const w = (u) => h(u) * 0.72;
  const hingeX = 0.8, hingeY = -0.06, jawA = -0.5, jawL = 0.22;
  const jawPt = (d, off) => V(hingeX + Math.cos(jawA) * d - Math.sin(jawA) * off, hingeY + Math.sin(jawA) * d + Math.cos(jawA) * off, 0);
  const tooth = (add, p, dir, r, len) => add(aim(cone(r, len, 4), dir, p), (x, y, z, u, v, o) => { set(o, 1, 1, 0.92, 0); o.emis = 0.35; });
  return fishModel({
    x0: 1, x1: -1, n: N, m: M, w, h,
    bodyPaint: (x, y, z, u, v, o) => {
      baseShade(o, v, 0.8, 0.45);
      const ret = noise3(x * 12, y * 12 + 5, z * 12);
      mixc(o, 0.85, 0.85, 0.35, 0.35, 0.75 * sstep(0.55, 0.68, ret));
      const k = 0.7 + 0.45 * noise3(x * 5, y * 5, z * 5);
      o.r *= k; o.g *= k; o.b *= k;
      if (u < 0.1 && Math.cos(v * TAU) < -0.2) set(o, 0.3, 0.03, 0.05, 0); // upper palate seen through the gape
    },
    eye: { u: 0.075, r: 0.034, ang: 0.85, iris: [1.0, 0.85, 0.2], irisGlow: 0.35, pupil: 0.7, fwd: 0.5 },
    dorsal: { u0: 0.1, u1: 1.0, hgt: 0.055, sweep: 0.1, nu: 60, nv: 2, prof: (s) => Math.pow(Math.min(1, s * 6), 0.5) * (1 - 0.35 * s),
      paint: finPaint({ c: [0.7, 0.75, 0.55], edge: [0.95, 0.9, 0.4], edgeAt: 0.7, edgeTint: 0.4, flut: 0.2, rays: 0.3, nr: 40 }) },
    anal: { u0: 0.5, u1: 1.0, hgt: 0.045, sweep: 0.1, nu: 30, nv: 2, prof: (s) => Math.pow(Math.min(1, s * 4), 0.5) * (1 - 0.3 * s),
      paint: finPaint({ c: [0.7, 0.75, 0.55], flut: 0.2, rays: 0.3, nr: 20 }) },
    extra: ({ xAt, h: H, add }) => {
      // gaping lower jaw hinged under the eye
      const jaw = tube({ x0: jawL, x1: 0, n: 12, m: 12, w: (u) => 0.075 * (0.55 + 0.45 * u), h: (u) => 0.045 * (0.5 + 0.5 * u) });
      jaw.rotateZ(jawA).translate(hingeX, hingeY, 0);
      add(jaw, (x, y, z, u, v, o) => { baseShade(o, v, 0.85, 0.6); if (Math.cos(v * TAU) > 0.55) set(o, 0.35, 0.04, 0.06, 0); });
      // throat
      add(new THREE.SphereGeometry(0.07, 14, 10).scale(1.5, 1.0, 0.9).translate(0.86, -0.09, 0), (x, y, z, u, v, o) => set(o, 0.22, 0.02, 0.04, 0));
      for (const side of [-1, 1]) for (let i = 0; i < 7; i++) {
        const ux = 0.99 - i * 0.028, uu = (1 - ux) / 2;
        tooth(add, V(ux, -H(uu) * 0.45, side * 0.04), V(0.2, -1, side * 0.1), 0.011, 0.05 + 0.015 * (i % 2));
        const d = 0.03 + i * 0.027;
        tooth(add, jawPt(d, 0.035), V(0.3, 1, side * 0.1), 0.01, 0.045 + 0.015 * ((i + 1) % 2));
      }
      add(aim(cone(0.01, 0.04, 4), V(1, 0.7, 0), V(0.99, 0.03, 0.02)), (x, y, z, u, v, o) => set(o, 0.6, 0.6, 0.4, 0.6));
    },
  });
}

function buildOctopus() {
  const parts = [];
  const add = (g, fn) => parts.push(paintGeo(g, fn));
  const skin = (x, y, z, u, v, o) => {
    const k = 0.75 + 0.45 * noise3(x * 7, y * 7, z * 7);
    set(o, k, k, k, 1);
    if (noise3(x * 18 + 3, y * 18, z * 18) > 0.7) mixc(o, 1.1, 0.75, 0.65, 0.5, 0.6); // papillae
    if (y < -0.15) mixc(o, 1.0, 0.82, 0.75, 0.5, 0.35);
  };
  // head + mantle
  add(new THREE.SphereGeometry(0.42, 28, 20).scale(1.0, 0.85, 0.8).translate(0.25, 0, 0), skin);
  add(new THREE.SphereGeometry(0.55, 28, 20).scale(1.3, 0.92, 0.85).rotateZ(-0.55).translate(-0.4, 0.38, 0),
    (x, y, z, u, v, o) => { skin(x, y, z, u, v, o); const ridge = Math.abs(z) < 0.06 ? 0.75 : 1; o.r *= ridge; o.g *= ridge; o.b *= ridge; });
  // eyes with horizontal slit pupils + brow ridges
  for (const side of [-1, 1]) {
    addEye(add, 0.42, 0.18, side * 0.3, 0.12, side, { iris: [1.0, 0.75, 0.15], irisGlow: 0.3, slit: true, pupil: 0.8, fwd: 0.4, up: 0.1, white: [0.95, 0.85, 0.6] });
    add(new THREE.SphereGeometry(0.1, 12, 8).scale(1.4, 0.45, 0.8).translate(0.42, 0.3, side * 0.3), skin);
  }
  // siphon
  add(sweep([V(0.0, -0.15, 0.3), V(-0.1, -0.25, 0.4), V(-0.2, -0.28, 0.42)], (s) => 0.07 * (1 - 0.3 * s), 8, 8), skin);
  // eight curling arms
  for (let k = 0; k < 8; k++) {
    const phi = lerp(-2.55, -0.35, k / 7) + 0.1 * Math.sin(k * 2.1);
    const z0 = (k % 2 ? 1 : -1) * (0.12 + 0.06 * (k % 3));
    const pts = [];
    const curl = (k % 2 ? 1 : -1) * (1.6 + 0.6 * hash3(k, 4, 1));
    for (let i = 0; i <= 7; i++) {
      const s = i / 7, d = 0.15 + s * 1.5, a = phi + curl * s * s * 0.9;
      pts.push(V(0.2 + Math.cos(a) * d, -0.2 + Math.sin(a) * d, z0 * (1 + s)));
    }
    add(sweep(pts, (s) => 0.12 * Math.pow(1 - s, 0.9) + 0.008, 40, 8), (x, y, z, u, v, o) => {
      skin(x, y, z, u, v, o);
      const under = 0.5 + 0.5 * Math.cos(v * TAU);
      if (under > 0.9 && fract(u * 34) < 0.3 && u < 0.9) mixc(o, 1.0, 0.88, 0.8, 0.25, 0.8); // suckers
      o.spec = u; o.part = k + 1;
    });
  }
  return { geo: mergeGeometries(parts), byX: true };
}

function buildGreatWhite() {
  const h = prof(0.26, 0.75, 0.55, 0.05), w = prof(0.21, 0.75, 0.55, 0.04);
  const scars = [];
  for (let i = 0; i < 6; i++) scars.push([0.25 + 0.55 * hash3(i, 2, 3), 0.6 * hash3(i, 5, 1) - 0.1, (hash3(i, 7, 7) - 0.5) * 4, 0.04 + 0.07 * hash3(i, 9, 2)]);
  return fishModel(sharkSpec(h, w, {
    n: 64, m: 32, eye: { u: 0.1, r: 0.04, ang: 1.05, iris: null, white: [0.03, 0.03, 0.04] },
    paint: (x, y, z, u, v, o) => {
      const ca = Math.cos(v * TAU);
      for (const [su, sc, sl, len] of scars) {
        if (Math.abs(u - su) < len && Math.abs(ca - (sc + sl * (u - su))) < 0.03) mixc(o, 0.9, 0.84, 0.84, 0.2, 0.55);
      }
      // gape: dark gums + throat on the lower snout
      if (u < 0.17 && ca < -0.1 && ca > -0.8) mixc(o, 0.32, 0.04, 0.07, 0, sstep(0.18, 0.08, u));
    },
    extra: ({ xAt, w: W, h: H, add }) => {
      // rows of serrated triangular teeth on the upper and lower gape edges, both flanks
      for (const side of [-1, 1]) for (let i = 0; i < 9; i++) {
        const u = 0.03 + i * 0.013;
        const a1 = Math.acos(-0.15), a2 = Math.acos(-0.7);
        const up = V(xAt(u), H(u) * Math.cos(a1), side * W(u) * Math.sin(a1) * 0.95);
        const lo = V(xAt(u), H(u) * Math.cos(a2), side * W(u) * Math.sin(a2) * 0.95);
        const sz = 0.03 + 0.012 * Math.sin(i);
        add(aim(cone(sz * 0.55, sz * 1.6, 3), V(0.15, -1, side * 0.2), up), (x, y, z, uu, vv, o) => { set(o, 1, 0.98, 0.92, 0); o.emis = 0.2; });
        add(aim(cone(sz * 0.5, sz * 1.4, 3), V(0.15, 1, side * 0.2), lo), (x, y, z, uu, vv, o) => { set(o, 1, 0.98, 0.92, 0); o.emis = 0.2; });
      }
    },
  }));
}

function buildAnglerKing() {
  const h = prof(0.66, 0.4, 0.75, 0.08), w = prof(0.52, 0.4, 0.8, 0.07);
  return fishModel({
    x0: 1, x1: -0.55, n: 48, m: 28, w, h,
    bodyPaint: (x, y, z, u, v, o) => {
      baseShade(o, v, 0.8, 0.25);
      const k = 0.7 + 0.5 * noise3(x * 9, y * 9, z * 9);
      o.r *= k; o.g *= k; o.b *= k;
      const vein = Math.abs(noise3(x * 6 + 9, y * 6, z * 6) - 0.5);
      if (vein < 0.014 && u > 0.15) { mixc(o, 0.55, 0.3, 1.0, 0, 0.6); o.bio = 0.5; } // glowing veins
      if (u < 0.07) set(o, 0.08, 0.0, 0.04, 0);
    },
    eye: { u: 0.2, r: 0.06, ang: 0.75, iris: [1.0, 0.7, 0.2], irisGlow: 0.4, white: [0.15, 0.1, 0.12] },
    tail: { type: 'round', L: 0.32, spread: 0.32, root: 0.08, paint: finPaint({ c: [0.6, 0.5, 0.8], rays: 0.5, flut: 0.8, edge: [0.7, 0.4, 1], edgeAt: 0.88, bio: 0.8 }) },
    pecs: { u: 0.3, span: 0.12, len: 0.3, back: 0.6, droop: 0.4, paint: finPaint({ c: [0.6, 0.55, 0.8], rays: 0.5, flut: 1, edge: [0.7, 0.4, 1], edgeAt: 0.9, bio: 0.5 }) },
    dorsal: { u0: 0.5, u1: 0.82, hgt: 0.14, sweep: 0.4, paint: finPaint({ c: [0.6, 0.55, 0.8], rays: 0.5, nr: 12, bio: 0.6 }) },
    anal: { u0: 0.6, u1: 0.82, hgt: 0.1, sweep: 0.4 },
    extra: (ctx) => {
      const { h: H, add } = ctx;
      addDots(ctx, range(0.22, 0.82, 0.05), [1.3, -1.3], 0.022, [0.45, 0.72, 1.0], 1.5);
      addDots(ctx, range(0.25, 0.8, 0.07), [1.75, -1.75], 0.02, [0.75, 0.5, 1.0], 1.5);
      addDots(ctx, range(0.3, 0.7, 0.1), [2.2, -2.2], 0.016, [0.45, 0.72, 1.0], 1.3);
      anglerTeeth(ctx, 1.35);
      // three lures: the true one (cyan) and two decoys
      anglerLure(add, V(0.55, H(0.25) * 0.95, 0), V(1.05, 1.2, 0), V(1.4, 0.8, 0), 0.065, [0.55, 0.85, 1.0], 2.4, 1);
      anglerLure(add, V(0.42, H(0.33) * 0.95, 0.05), V(0.75, 1.35, 0.15), V(1.05, 1.15, 0.2), 0.05, [0.75, 0.45, 1.0], 2.0, 2);
      anglerLure(add, V(0.66, H(0.19) * 0.95, -0.05), V(1.15, 0.7, -0.15), V(1.3, 0.35, -0.2), 0.05, [1.0, 0.75, 0.3], 2.0, 3);
      // bioluminescent crown: spines along the head ridge with glowing tips
      for (let i = 0; i < 9; i++) {
        const u = 0.14 + i * 0.045, x = ctx.xAt(u), y = H(u) * 0.97, len = 0.18 + 0.12 * Math.sin(Math.PI * i / 8);
        const g = aim(cone(0.028, len, 5), V(-0.35, 1, 0), V(x, y - 0.02, 0));
        add(g, (px, py, pz, uu, vv, o) => {
          const t = clamp((py - y) / len, 0, 1);
          set(o, lerp(0.35, 0.8, t), lerp(0.25, 0.55, t), lerp(0.5, 1.0, t), 0); o.bio = t * t * 2.0; o.emis = t > 0.8 ? 0.6 : 0;
        });
      }
    },
  });
}

const BUILDERS = {
  krill: buildKrill, sardine: buildSardine, clownfish: buildClown, tang: buildTang, jelly: buildJelly,
  puffer: buildPuffer, barracuda: buildBarracuda, grouper: buildGrouper, angler: buildAngler,
  shark: buildShark, whale: buildWhale, hero: buildHero,
  moray: buildMoray, octopus: buildOctopus, greatwhite: buildGreatWhite, anglerking: buildAnglerKing,
  lanternfish: buildLantern, squid: buildSquid,
};
// Species drawn with several model variants (picked per entity id).
const VARIANTS = { cell: [['cell', () => buildCell({ flagella: 1 })], ['rod', buildRods], ['diatom', buildDiatom], ['cell2', () => buildCell({ flagella: 2 })]] };
const HERO_FORMS = { cell: () => buildCell({ eyes: true, flagella: 1 }), larva: buildHeroLarva, shrimp: buildKrill, fry: buildHeroFry,
  fish: buildHero, hunter: buildHeroHunter, apex: buildHeroApex };
const HERO_TUNE = {
  cell:   { half: 1.05, hz: 2.6, amp: 0.14, mode: 7, transl: true },
  larva:  { half: 1.3,  hz: 3.0, amp: 0.15, transl: true },
  shrimp: { half: 1.2,  hz: 3.2, amp: 0.08 },
  fry:    { half: 1.25, hz: 2.8, amp: 0.14 },
  fish:   { half: 1.45, hz: 2.3, amp: 0.13 },
  hunter: { half: 1.5,  hz: 2.0, amp: 0.12, rough: 0.28 },
  apex:   { half: 1.6,  hz: 1.6, amp: 0.11, rough: 0.25, metal: 0.2 },
};
const SHAPE_BUILDERS = {
  shrimp: buildKrill, slim: buildSardine, standard: buildGrouper, disc: buildTang, round: buildPuffer, jelly: buildJelly,
  long: buildBarracuda, angler: buildAngler, shark: buildShark, whale: buildWhale, hero: buildHero,
  eel: buildMoray, octopus: buildOctopus, lantern: buildLantern, squid: buildSquid,
};
// Per-species tuning. half = target half-length; hz = tail beats/s at size 1; amp = wave amplitude;
// mode: 0 fish, 1 jelly, 2 puffer, 4 angler (lure sway), 5 octopus, 6 eel, 7 cell, 8 squid. irid/transl = extra defines.
// zA/yA = lateral / vertical share of the body wave; k = wave number; envP = envelope exponent; tr = tail sweep.
const TUNE = {
  krill:     { half: 1.15, hz: 3.4, amp: 0.07, cap: 256, rough: 0.4 },
  sardine:   { half: 1.15, hz: 3.0, amp: 0.13, cap: 256, rough: 0.3, metal: 0.25 },
  clownfish: { half: 1.12, hz: 2.4, amp: 0.12, cap: 192, rough: 0.45 },
  tang:      { half: 1.1,  hz: 2.0, amp: 0.09, cap: 192, rough: 0.45 },
  jelly:     { half: 1.0,  hz: 0.55, amp: 0,   cap: 128, rough: 0.25, mode: 1, upright: true },
  puffer:    { half: 1.0,  hz: 2.6, amp: 0.06, cap: 128, rough: 0.55, mode: 2 },
  barracuda: { half: 1.25, hz: 1.7, amp: 0.12, cap: 128, rough: 0.3, metal: 0.3 },
  grouper:   { half: 1.12, hz: 1.6, amp: 0.1,  cap: 128, rough: 0.65 },
  angler:    { half: 1.1,  hz: 1.4, amp: 0.08, cap: 64,  rough: 0.6, mode: 4 },
  shark:     { half: 1.3,  hz: 1.15, amp: 0.11, cap: 64, rough: 0.5 },
  whale:     { half: 1.35, hz: 0.45, amp: 0.08, cap: 24, rough: 0.6, zA: 0.25, yA: 1.0, tr: 0 },
  hero:      { half: 1.45, hz: 2.3, amp: 0.13, cap: 1,  rough: 0.3 },
  enemy:     { half: 0.92, hz: 2.2, amp: 0.1,  cap: 384, rough: 0.45 },
  microbe:   { half: 1.0,  hz: 2.8, amp: 0.12, cap: 160, rough: 0.2, mode: 7, transl: true },
  lanternfish:{ half: 1.1, hz: 2.8, amp: 0.12, cap: 192, rough: 0.35 },
  squid:     { half: 1.15, hz: 1.2, amp: 0.1,  cap: 64,  rough: 0.35, mode: 8 },
  moray:     { half: 1.9,  hz: 0.9, amp: 0.13, cap: 2,  rough: 0.35, mode: 6, zA: 0.5, yA: 1.0, k: 7.5, envP: 0.6, env0: 0.3, tr: 0, boss: true },
  octopus:   { half: 1.3,  hz: 0.8, amp: 0.3,  cap: 2,  rough: 0.45, mode: 5, upright: true, glow: 0.2, boss: true },
  greatwhite:{ half: 1.35, hz: 0.95, amp: 0.1, cap: 2,  rough: 0.5, boss: true },
  anglerking:{ half: 1.2,  hz: 1.0, amp: 0.07, cap: 2,  rough: 0.55, mode: 4, glow: 1.0, boss: true },
};
const SHAPE_TUNE = { shrimp: 'krill', slim: 'sardine', standard: 'grouper', disc: 'tang', round: 'puffer', jelly: 'jelly',
  long: 'barracuda', angler: 'angler', shark: 'shark', whale: 'whale', hero: 'hero', eel: 'moray', octopus: 'octopus',
  cell: 'microbe', lantern: 'lanternfish', squid: 'squid' };

function normalize(model, half) {
  const geo = model.geo;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  let s, cx = 0;
  if (model.byZ) s = half / ((bb.max.z - bb.min.z) / 2);
  else if (model.byX) { s = half / ((bb.max.x - bb.min.x) / 2); cx = (bb.max.x + bb.min.x) / 2; }
  else { s = half / ((model.maxX - model.minX) / 2); cx = (model.maxX + model.minX) / 2; }
  geo.translate(-cx, 0, 0); geo.scale(s, s, s);
  // Degenerate (zero-length) normals at lathe tips make normalize() return NaN in the shader, which bloom smears
  // across the whole screen. Replace them with a sane outward normal.
  const nAttr = geo.attributes.normal, pAttr = geo.attributes.position;
  if (nAttr) for (let i = 0; i < nAttr.count; i++) {
    const nx = nAttr.getX(i), ny = nAttr.getY(i), nz = nAttr.getZ(i);
    if (!(nx * nx + ny * ny + nz * nz > 1e-8)) {
      const py = pAttr.getY(i), pz = pAttr.getZ(i), l = Math.hypot(py, pz);
      if (l > 1e-6) nAttr.setXYZ(i, 0, py / l, pz / l); else nAttr.setXYZ(i, Math.sign(pAttr.getX(i)) || 1, 0, 0);
    }
  }
  geo.computeBoundingBox(); geo.computeBoundingSphere();
  const b2 = geo.boundingBox;
  const pivot = model.pivot != null ? (model.pivot - cx) * s : -1e4;
  if (model.byZ || model.byX) return { nose: b2.max.x, len: b2.max.x - b2.min.x, pivot };
  return { nose: half, len: half * 2, pivot };
}

// ---------------------------------------------------------------- shaders
const VERT_HEAD = /* glsl */`
attribute vec4 aFx;
attribute vec2 aSpec;
attribute vec3 iColor;
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iC;
uniform float uTime, uNose, uLen, uPivot, uK, uZA, uYA, uEnv0, uEnvP, uTR;
varying vec4 vFx;
varying vec4 vIA;
varying vec4 vIB;
varying vec4 vIC;
varying vec3 vIColor;
varying vec3 vRaw;
varying float vS;
varying vec2 vSpec;
varying vec3 vPos;
`;
const VERT_DEFORM = /* glsl */`
vec3 objectNormal = vec3( normal );
#ifdef USE_TANGENT
  vec3 objectTangent = vec3( tangent.xyz );
#endif
vec3 swimPos = position;
float sAx = clamp((uNose - position.x) / uLen, 0.0, 1.0);
vS = sAx; vFx = aFx; vIA = iA; vIB = iB; vIC = iC; vIColor = iColor; vSpec = aSpec; vPos = position;
float ph = iA.x;
float amp = iA.y;
#if FISH_MODE == 1
  // jelly: bell pulse, tentacles sway (hang along -Y)
  float pulse = sin(ph);
  float bellW = 1.0 - min(aFx.z, 1.0);
  swimPos.xz *= 1.0 + 0.13 * pulse * bellW;
  swimPos.y *= 1.0 - 0.09 * pulse * bellW;
  float tw = aFx.z;
  swimPos.x += tw * 0.22 * sin(ph + position.y * 2.2 + iB.w * 6.283);
  swimPos.z += tw * 0.12 * cos(ph + position.y * 1.7 + iB.w * 3.0);
  swimPos.y += tw * 0.08 * cos(ph);
#elif FISH_MODE == 5
  // octopus: arms writhe & curl, mantle breathes
  float ti = aSpec.x, arm = aSpec.y;
  if (arm > 0.5) {
    float e = pow(max(ti, 0.0), 1.3);
    swimPos.x += e * amp * sin(ph + ti * 4.0 + arm * 0.9);
    swimPos.y += e * amp * 0.9 * cos(ph * 1.0 + ti * 3.3 + arm * 1.7);
    swimPos.z += ti * amp * 0.4 * sin(ph + arm * 2.3);
  } else {
    float br = 1.0 + 0.05 * sin(ph) * smoothstep(0.1, -0.6, position.x);
    swimPos.yz *= br;
  }
  float g = iB.x;
  swimPos *= 1.0 + 0.08 * g;
#elif FISH_MODE == 7
  // cell: membrane wobble, flagellum whip, cilia ripple, drifting organelles
  float part = aSpec.y, ti = aSpec.x;
  float ang = atan(position.y, position.x);
  float wob = 1.0 + 0.045 * sin(ang * 5.0 + uTime * 3.1 + iB.w * 6.283) + 0.03 * sin(ang * 3.0 - uTime * 2.2);
  if (part < 0.5) swimPos.xy *= wob;
  else if (part < 1.5) {
    float e = ti * ti;
    swimPos.y += e * 0.55 * sin(ph - ti * 7.0);
    swimPos.z += e * 0.2 * cos(ph - ti * 6.0);
  } else if (part < 2.5) {
    swimPos.xy *= wob;
    float wv = sin(ang * 9.0 - ph * 2.0);
    swimPos.xy += vec2(-sin(ang), cos(ang)) * ti * 0.13 * wv;
    swimPos.z += ti * 0.05 * cos(ang * 9.0 - ph * 2.0);
  } else {
    swimPos.xy += 0.035 * vec2(sin(uTime * 1.3 + position.x * 9.0 + iB.w * 5.0), cos(uTime * 1.1 + position.y * 7.0));
  }
  float g = iB.x;
  swimPos *= 1.0 + 0.18 * g * (1.0 - step(0.5, part) * step(part, 1.5));
#elif FISH_MODE == 8
  // squid: jet pulse (mantle squeeze + arms snap together), arms ripple, fins undulate
  float pulse = pow(max(sin(ph), 0.0), 3.0);
  float arm = aSpec.y, ti = aSpec.x;
  if (arm < 0.5) {
    float mm = smoothstep(-0.25, 0.1, position.x);
    swimPos.yz *= 1.0 - 0.16 * pulse * mm;
    swimPos.z += aFx.z * 0.07 * sin(2.0 * ph - position.x * 9.0);
    swimPos.y += aFx.z * 0.03 * sin(2.0 * ph - position.x * 9.0 + 1.0);
  } else {
    swimPos.yz *= 1.0 - 0.45 * pulse * ti;
    swimPos.x -= 0.12 * pulse * ti;
    float relax = 1.0 - pulse;
    swimPos.y += ti * amp * relax * sin(2.0 * ph - ti * 6.0 + arm * 1.3);
    swimPos.z += ti * amp * 0.6 * cos(2.0 * ph - ti * 5.0 + arm);
  }
  float g = iB.x;
  swimPos.yz *= 1.0 + 0.1 * g;
#else
  #if FISH_MODE == 2
    float pf = iB.y;
    swimPos *= 1.0 + 0.5 * pf;
    swimPos.x *= 1.0 - 0.2 * pf;
    swimPos += normalize(position + vec3(1e-4)) * aSpec.x * pf * 0.3;
  #endif
  float g = iB.x;
  float headW = 1.0 - smoothstep(0.0, 0.32, sAx);
  swimPos.yz *= 1.0 + g * 0.35 * headW;
  swimPos.y -= g * 0.12 * headW * step(position.y, 0.0);   // jaw drops on gulp
  float env = uEnv0 + (1.0 - uEnv0) * pow(max(sAx, 0.0), uEnvP);
  float arg = ph - sAx * uK;
  float wv = sin(arg);
  float dEnv = (1.0 - uEnv0) * uEnvP * pow(max(sAx, 1e-3), uEnvP - 1.0);
  float slope = -amp * (dEnv * wv - env * uK * cos(arg)) / uLen;
  swimPos.z += amp * uZA * env * wv;
  swimPos.y += amp * uYA * env * wv;
  objectNormal.x -= slope * (uZA * objectNormal.z + uYA * objectNormal.y);
  // tail fin sweep about local Y (reads from the side as the fin narrowing/flapping)
  if (position.x < uPivot) {
    float th = uTR * amp * sin(ph - uK * 0.95);
    float dx = position.x - uPivot;
    swimPos.x = uPivot + dx * cos(th) - (swimPos.z) * sin(th) * 0.0;
    swimPos.z += -dx * sin(th);
    objectNormal.xz = mat2(cos(th), -sin(th), sin(th), cos(th)) * objectNormal.xz;
  }
  float fl = aFx.z;
  swimPos.z += fl * amp * 0.75 * sin(2.0 * ph - sAx * 6.0 + position.y * 1.5);
  swimPos.y += fl * amp * 0.6 * sin(2.0 * ph - sAx * 5.0 + 1.7);
  swimPos.x += fl * amp * 0.25 * sin(2.0 * ph - sAx * 4.0 + 0.6);
  #if FISH_MODE == 4
    float lw = aSpec.x;
    swimPos.z += lw * 0.1 * sin(uTime * 1.7 + iB.w * 6.283 + aSpec.y * 2.1);
    swimPos.y += lw * 0.07 * sin(uTime * 2.6 + iB.w * 3.0 + aSpec.y * 1.3);
    swimPos.x += lw * 0.05 * sin(uTime * 1.9 + aSpec.y * 2.7);
  #endif
#endif
`;
const FRAG_HEAD = /* glsl */`
uniform float uTime;
varying vec4 vFx;
varying vec4 vIA;
varying vec4 vIB;
varying vec4 vIC;
varying vec3 vIColor;
varying vec3 vRaw;
varying float vS;
varying vec2 vSpec;
varying vec3 vPos;
`;
const FRAG_EMISSIVE = /* glsl */`
#include <emissivemap_fragment>
{
  vec3 Vd = normalize(vViewPosition);
  float ndv = clamp(abs(dot(normal, Vd)), 0.0, 1.0);
  float edge = 1.0 - ndv;
  float fres = pow(edge, 2.4);
  #if IRID == 1
    // hero: iridescent teal→violet body, soft white/ice-blue edge (never green)
    float hk = clamp(vS * 1.35 - 0.12 + fres * 0.45 + 0.12 * sin(uTime * 1.3 + vS * 7.0), 0.0, 1.0);
    vec3 irid = mix(vIColor, vec3(0.62, 0.38, 1.0), hk);
    irid = mix(irid, vec3(0.75, 0.95, 1.0), pow(fres, 3.0) * 0.5);
    diffuseColor.rgb = mix(diffuseColor.rgb, vRaw * irid, vFx.x);
    vec3 heroEdge = mix(vec3(0.7, 0.88, 1.0), vec3(0.8, 0.65, 1.0), hk);
    totalEmissiveRadiance += (irid * 0.12 + heroEdge * smoothstep(0.42, 0.88, edge) * 1.3) * vFx.x;
  #endif
  #if TRANSL == 1
    #if FISH_MODE == 7
      diffuseColor.a *= 0.8 + 0.2 * fres;                        // microbes read as solid-ish bodies
      diffuseColor.rgb *= 1.0 - 0.55 * smoothstep(0.55, 0.9, edge) * vFx.x; // dark membrane outline
    #elif FISH_MODE == 1
      diffuseColor.a *= 0.6 + 0.4 * fres + 0.2 * vFx.w;
    #else
      diffuseColor.a *= 0.45 + 0.55 * fres + 0.3 * vFx.w;
    #endif
    diffuseColor.a = max(diffuseColor.a, 1.0 - vFx.x);
  #endif
  #if FISH_MODE == 8
    float cs = 0.5 + 0.5 * sin(vPos.x * 28.0 + uTime * 5.0 + 3.0 * sin(vPos.y * 22.0 - uTime * 3.0 + vPos.z * 15.0));
    diffuseColor.rgb *= 0.75 + 0.45 * cs * vFx.x;
  #endif
  #if FISH_MODE == 1
    totalEmissiveRadiance += vColor * 0.05 * fres;
  #endif
  // species bioluminescence: small, quiet accents (never competes with the relation outline)
  float tw = 0.75 + 0.25 * sin(uTime * 2.3 + vIB.w * 40.0 + vS * 9.0);
  float lureP = 1.0;
  if (vFx.y > 1.9) lureP = 0.3 * (0.8 + 0.2 * sin(uTime * 3.0 + vIB.w * 6.0 + vSpec.y * 2.0)) * (1.0 - 0.9 * vIC.z);
  float bioK = vFx.w * vIA.w * 0.45 * tw * (1.0 - 0.6 * vIC.z) * (1.0 + 0.5 * vIC.w);
  totalEmissiveRadiance += vColor * (min(vFx.y, 0.6) * (vFx.y > 1.9 ? 0.0 : 1.0) + vFx.y * lureP * step(1.9, vFx.y) + bioK);
  // boss rage: violet smoulder (red is reserved for "danger")
  totalEmissiveRadiance += vec3(0.6, 0.2, 1.0) * vIC.w * (0.05 + 0.35 * fres) * (0.7 + 0.3 * sin(uTime * 5.0));
  // ---- relation code (outline drawn by the outline pass): danger "tell" flare + desaturated similar
  float rel = vIA.z;
  if (rel > 0.75) {
    float notice = vIB.z;
    totalEmissiveRadiance += vec3(1.0, 0.1, 0.06) * notice * (0.1 + 0.1 * sin(uTime * 22.0)) * vFx.x;
  } else if (rel > 0.25) {
    float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(lum), 0.4);
  }
  // boss vulnerable: pulsing golden "bite me" glow on the tail half
  if (vIC.y > 0.001) {
    float tailK = smoothstep(0.35, 0.7, vS);
    float pg = 0.6 + 0.4 * sin(uTime * 7.0);
    totalEmissiveRadiance += vec3(1.0, 0.72, 0.18) * vIC.y * tailK * pg * (0.35 + 1.2 * fres);
  }
  // hit / gulp / evolve flash
  if (vIC.x > 0.001) {
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), vIC.x * 0.6);
    totalEmissiveRadiance += vec3(1.0, 0.97, 0.92) * vIC.x * 0.7;
  }
}
`;

function makeMaterial(mode, geoInfo, uTime, tune) {
  const transparent = mode === 1 || !!tune.transl;
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: tune.rough ?? 0.5, metalness: tune.metal ?? 0.05, side: THREE.DoubleSide,
    transparent, opacity: transparent ? (mode === 1 ? 0.85 : 0.92) : 1, depthWrite: true,
  });
  mat.defines = { FISH_MODE: mode, IRID: tune.irid ? 1 : 0, TRANSL: transparent ? 1 : 0 };
  const U = {
    uNose: { value: geoInfo.nose }, uLen: { value: geoInfo.len }, uPivot: { value: geoInfo.pivot },
    uK: { value: tune.k ?? 3.2 }, uZA: { value: tune.zA ?? 1.0 }, uYA: { value: tune.yA ?? 0.3 },
    uEnv0: { value: tune.env0 ?? 0.06 }, uEnvP: { value: tune.envP ?? 2.0 }, uTR: { value: tune.tr ?? 3.2 },
  };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_HEAD)
      .replace('#include <beginnormal_vertex>', VERT_DEFORM)
      .replace('#include <begin_vertex>', 'vec3 transformed = swimPos;')
      .replace('#include <color_vertex>', 'vRaw = color.rgb;\nvColor = mix(color.rgb, color.rgb * iColor, aFx.x);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_HEAD)
      .replace('#include <emissivemap_fragment>', FRAG_EMISSIVE);
  };
  mat.customProgramCacheKey = () => 'abyss-fish-v3-' + mode + (tune.irid ? 'i' : '') + (transparent ? 't' : '');
  mat.userData.U = U;
  return mat;
}

// Relation outline: inverted hull expanded by a constant number of screen pixels along the projected normal.
// GREEN = edible, RED = dangerous (thicker + pulsing when hunting, brightened by the "notice" tell).
const OUTLINE_VERT = /* glsl */`
{
  float rel = iA.z;
  if (!(rel < -0.5 || rel > 0.75)) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);               // no outline: clip away
  } else {
    float hunt = clamp(rel - 1.0, 0.0, 1.0);
    float notice = iB.z;
    float px = rel < 0.0 ? 2.2 : 2.6 + 2.2 * hunt * (0.75 + 0.25 * sin(uTime * 10.0)) + 1.5 * notice;
    px *= step(0.5, aFx.x) * uDpr;                       // eyes / teeth / lures are not outlined
    vec3 nW = objectNormal;
    #ifdef USE_INSTANCING
      nW = mat3(instanceMatrix) * nW;
    #endif
    vec3 nV = normalize(normalMatrix * nW);
    vec2 nd = (projectionMatrix * vec4(nV, 0.0)).xy;
    float l = length(nd);
    nd = l > 1e-5 ? nd / l : vec2(0.0);
    gl_Position.xy += nd * px * 2.0 / uRes * gl_Position.w;
    gl_Position.z += 0.0003 * gl_Position.w;
    vOutCol = rel < 0.0 ? vec3(0.1, 0.95, 0.25)
      : mix(vec3(0.95, 0.04, 0.03), vec3(1.0, 0.35, 0.25), notice * (0.5 + 0.5 * sin(uTime * 25.0)));
  }
}
`;
function makeOutlineMaterial(mode, U, uTime, uRes, uDpr, afterTransparent) {
  const mat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, toneMapped: false, transparent: afterTransparent, depthWrite: !afterTransparent });
  mat.defines = { FISH_MODE: mode };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime; sh.uniforms.uRes = uRes; sh.uniforms.uDpr = uDpr;
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_HEAD + 'uniform vec2 uRes;\nuniform float uDpr;\nvarying vec3 vOutCol;\n')
      .replace('#include <begin_vertex>', VERT_DEFORM + 'vec3 transformed = swimPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + OUTLINE_VERT);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vOutCol;')
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( vOutCol, 1.0 );');
  };
  mat.customProgramCacheKey = () => 'abyss-fish-outline-' + mode + (afterTransparent ? 't' : '');
  return mat;
}

// ---------------------------------------------------------------- renderer
export function createFishRenderer({ scene }) {
  const uTime = { value: 0 }, uRes = { value: new THREE.Vector2(1920, 1080) }, uDpr = { value: 1 };
  const buckets = [];
  const byKey = {};
  const group = new THREE.Group();
  group.name = 'fish';
  scene.add(group);

  // bucket list: [bucketKey, speciesDef, builder, tune]
  const defs = [];
  const tuneFor = (key, shape) => TUNE[key] || TUNE[SHAPE_TUNE[shape]] || TUNE.grouper;
  const variantsOf = {};
  for (const k of Object.keys(SPECIES)) {
    const sp = SPECIES[k];
    if (k === 'hero') {
      for (const form of Object.keys(HERO_FORMS)) {
        const ht = HERO_TUNE[form];
        defs.push(['hero:' + form, sp, HERO_FORMS[form], { cap: 1, rough: 0.3, ...ht, irid: true }]);
      }
      continue;
    }
    const vars = VARIANTS[sp.shape];
    if (vars) {
      variantsOf[k] = vars.map(([vk]) => k + ':' + vk);
      const t = tuneFor(k, sp.shape);
      for (const [vk, fn] of vars) defs.push([k + ':' + vk, sp, fn, { ...t, cap: Math.ceil(t.cap / vars.length) + 24 }]);
      continue;
    }
    defs.push([k, sp, BUILDERS[k] || SHAPE_BUILDERS[sp.shape] || buildGrouper, tuneFor(k, sp.shape)]);
  }
  defs.push(['enemy', { glow: 0 }, buildEnemy, TUNE.enemy]);
  for (const k of Object.keys(BOSSES || {})) if (!SPECIES[k]) {
    const sp = BOSSES[k];
    defs.push([k, sp, BUILDERS[k] || SHAPE_BUILDERS[sp.shape] || buildGrouper, tuneFor(k, sp.shape)]);
  }

  for (const [key, sp, build, tune] of defs) {
    const model = build();
    const info = normalize(model, tune.half);
    const geo = model.geo, cap = tune.cap;
    const mk = (n) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    const iColor = mk(3), iA = mk(4), iB = mk(4), iC = mk(4);
    geo.setAttribute('iColor', iColor); geo.setAttribute('iA', iA); geo.setAttribute('iB', iB); geo.setAttribute('iC', iC);
    const mode = tune.mode || 0;
    const mesh = new THREE.InstancedMesh(geo, makeMaterial(mode, info, uTime, tune), cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.visible = false;
    mesh.name = 'fish-' + key;
    if (mode === 1 || tune.transl) mesh.renderOrder = 2;
    group.add(mesh);
    const outline = new THREE.InstancedMesh(geo, makeOutlineMaterial(mode, mesh.material.userData.U, uTime, uRes, uDpr, mesh.material.transparent), cap);
    if (mesh.material.transparent) outline.renderOrder = 3;
    outline.instanceMatrix = mesh.instanceMatrix;
    outline.frustumCulled = false; outline.count = 0; outline.visible = false; outline.name = 'outline-' + key;
    outline.onBeforeRender = (r) => { r.getDrawingBufferSize(uRes.value); uDpr.value = r.getPixelRatio(); };
    group.add(outline);
    const b = { key, mesh, outline, rels: 0, iColor, iA, iB, iC, cap, n: 0, hz: tune.hz, amp: tune.amp,
      glow: tune.glow ?? sp.glow ?? 0, upright: !!tune.upright, jelly: mode === 1 };
    buckets.push(b); byKey[key] = b;
  }
  // HITBOX RING: every dangerous (non-boss) fish gets a red circle at its exact kill radius (entity.size; the
  // ecosystem eats the player when the player's core touches it, from any direction) + a faint red fill.
  // Constant ~2.5 px line via fwidth; drawn on top of the fish (no depth test).
  const HIT_EXT = 1.15, HIT_CAP = 384;
  const hitMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(2 * HIT_EXT, 2 * HIT_EXT), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: false,
    vertexShader: /* glsl */`
      varying vec2 vP;
      void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      varying vec2 vP;
      void main() {
        float r = length(vP), fw = max(fwidth(r), 1e-4);
        float ring = 1.0 - smoothstep(1.0, 2.2, abs(r - 1.0 + fw) / fw);
        float fill = 0.12 * (1.0 - smoothstep(1.0 - fw, 1.0, r));
        float a = max(ring * 0.95, fill);
        if (a < 0.004) discard;
        gl_FragColor = vec4(1.0, 0.16, 0.14, a);
      }`,
  }), HIT_CAP);
  hitMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  hitMesh.frustumCulled = false; hitMesh.count = 0; hitMesh.renderOrder = 10; hitMesh.name = 'hitbox-rings';
  group.add(hitMesh);
  const ENEMY_COLOR = new THREE.Color(0x46505e);
  const qId = new THREE.Quaternion();

  const FORM_T = 0.5;
  // Pure greens / reds are reserved for the edible / danger code: shift them (cached per entity).
  const hsl = { h: 0, s: 0, l: 0 };
  function safeColor(f) {
    const c = f.color;
    let sc = f._frSafe;
    if (sc && f._frSrcHex === c.getHex()) return sc;
    if (!sc) sc = f._frSafe = new THREE.Color();
    f._frSrcHex = c.getHex();
    c.getHSL(hsl);
    let h = hsl.h, sat = hsl.s;
    if (sat > 0.25) {
      if (h > 0.2 && h < 0.3) { h = 0.14; sat *= 0.8; }          // green-yellow → olive/amber
      else if (h >= 0.3 && h < 0.46) { h = 0.52; sat *= 0.85; }  // green → cyan
      else if (h < 0.045) h = 0.065;                             // red → coral/orange
      else if (h > 0.95) h = 0.9;                                // red → magenta
    }
    sc.setHSL(h, sat, hsl.l);
    return sc;
  }

  const mat4 = new THREE.Matrix4(), quat = new THREE.Quaternion(), euler = new THREE.Euler(), scl = new THREE.Vector3();
  const margin = CONFIG.eat.margin;
  let lastT = null;

  function sync(list, t, player, opts) {
    const dt = lastT === null ? 0 : clamp(t - lastT, 0, 0.1);
    lastT = t;
    uTime.value = t;
    const show = !!(opts && opts.showRelation) && player && player.alive !== false;
    const ps = player ? player.size : 1;
    for (let k = 0; k < buckets.length; k++) { buckets[k].n = 0; buckets[k].rels = 0; }
    let nHit = 0;
    const kRoll = 1 - Math.exp(-dt * 14);   // ≈0.25 s flip

    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (!f || f.alive === false) continue;
      let b, flash = 0, pulseS = 1;
      if (f.isPlayer) {
        // evolution: flash + scale pulse, model swaps at the peak of the flash
        const form = HERO_FORMS[f.form] ? f.form : 'fish';
        if (f._frForm === undefined) { f._frForm = form; f._frShown = form; f._frTr = 0; }
        if (form !== f._frForm) { f._frForm = form; f._frTr = FORM_T; }
        if (f._frTr > 0) {
          f._frTr = Math.max(0, f._frTr - dt);
          const pr = 1 - f._frTr / FORM_T;
          if (pr >= 0.5) f._frShown = f._frForm;
          const k = Math.sin(Math.PI * pr);
          flash = 0.45 * k * k; pulseS = 1 + 0.15 * k;
        }
        b = byKey['hero:' + f._frShown];
      } else if (show && !f.isBoss && f.size > ps * margin) {
        b = byKey.enemy;                       // every threat looks the same: one enemy model + hitbox ring
        if (nHit < HIT_CAP) {
          scl.set(f.size, f.size, f.size);
          mat4.compose(f.pos, qId, scl);
          mat4.toArray(hitMesh.instanceMatrix.array, nHit++ * 16);
        }
      } else {
        const vars = variantsOf[f.species];
        b = vars ? byKey[vars[f.id % vars.length]] : byKey[f.species];
      }
      if (!b || b.n >= b.cap) continue;

      // swim phase integrated per entity so tail-beat rate changes never jump
      let ph = f._frPh;
      const ch = Math.cos(f.heading);
      if (ph === undefined) {
        ph = f.swimPhase || 0;
        f._frFlip = ch < 0 ? 1 : 0; f._frRoll = f._frFlip * Math.PI;
      }
      ph += dt * TAU * b.hz * (f.swimRate ?? 1) / Math.pow(Math.max(f.size, 0.05), 0.3);
      if (ph > TAU) ph -= TAU * Math.floor(ph / TAU);
      f._frPh = ph;
      // belly-down flip with hysteresis
      if (ch < -0.08) f._frFlip = 1; else if (ch > 0.08) f._frFlip = 0;
      f._frRoll += (f._frFlip * Math.PI - f._frRoll) * kRoll;

      if (f.isPlayer && f.invuln > 0 && fract(t * 7) < 0.4) continue; // spawn-protection blink

      const idx = b.n++;
      const gulp = clamp(f.gulp || 0, 0, 1);
      const s = f.size * (1 + 0.13 * Math.sin(gulp * Math.PI)) * pulseS;
      if (b.upright) {
        // jelly / octopus: stay upright, mirror (yaw) to face left, lean with vertical motion
        const lean = clamp(Math.sin(f.heading), -1, 1) * (b.jelly ? 0.15 : 0.35);
        euler.set(0, f._frRoll, lean, 'YZX');
      } else {
        euler.set(f._frRoll + (f.bank || 0) * 0.3, 0, f.heading, 'ZYX');
      }
      quat.setFromEuler(euler);
      scl.set(s, s, s);
      mat4.compose(f.pos, quat, scl);
      mat4.toArray(b.mesh.instanceMatrix.array, idx * 16);

      const ca = b.iColor.array;
      if (b === byKey.enemy) {
        ca[idx * 3] = ENEMY_COLOR.r; ca[idx * 3 + 1] = ENEMY_COLOR.g; ca[idx * 3 + 2] = ENEMY_COLOR.b;
      } else if (f.isPlayer || !f.color) {
        const c = f.color;
        ca[idx * 3] = c ? c.r : 1; ca[idx * 3 + 1] = c ? c.g : 1; ca[idx * 3 + 2] = c ? c.b : 1;
      } else {
        const c = safeColor(f);
        ca[idx * 3] = c.r; ca[idx * 3 + 1] = c.g; ca[idx * 3 + 2] = c.b;
      }

      const boss = !!f.isBoss;
      const vuln = boss && !!f.vulnerable;
      let rel = 0;
      if (show && !f.isPlayer) {
        const hunting = (f.ai && f.ai.hunting) || (boss && (f.rage || 0) > 0.5);
        if (boss) rel = vuln ? 0.5 : (hunting ? 2 : 1);
        else if (ps > f.size * margin) rel = -1;
        else if (f.size > ps * margin) rel = hunting ? 2 : 1;
        else rel = 0.5;
      }
      if (rel < -0.5 || rel > 0.75) b.rels++;
      const o4 = idx * 4;
      const a = b.iA.array;
      a[o4] = ph; a[o4 + 1] = b.amp * (0.7 + 0.3 * Math.min(f.swimRate ?? 1, 2)); a[o4 + 2] = rel; a[o4 + 3] = b.glow;
      const bb = b.iB.array;
      bb[o4] = gulp; bb[o4 + 1] = clamp(f.puff || 0, 0, 1); bb[o4 + 2] = rel > 0.75 && f.ai ? clamp(f.ai.notice || 0, 0, 1) : 0; bb[o4 + 3] = fract(f.id * 0.6180339887);
      const cc = b.iC.array;
      cc[o4] = boss ? clamp(Math.max(f.hitFlash || 0, gulp * 0.8), 0, 1) : flash;
      cc[o4 + 1] = vuln ? 1 : 0;
      cc[o4 + 2] = boss ? clamp(f.lureDim || 0, 0, 1) : 0;
      cc[o4 + 3] = boss ? clamp(f.rage || 0, 0, 1) : 0;
    }

    hitMesh.count = nHit;
    hitMesh.visible = nHit > 0;
    if (nHit > 0) hitMesh.instanceMatrix.needsUpdate = true;
    for (let k = 0; k < buckets.length; k++) {
      const b = buckets[k];
      b.mesh.count = b.n;
      b.mesh.visible = b.n > 0;
      b.outline.count = b.n;
      b.outline.visible = b.n > 0 && b.rels > 0;
      if (b.n > 0) {
        b.mesh.instanceMatrix.needsUpdate = true;
        b.iColor.needsUpdate = true; b.iA.needsUpdate = true; b.iB.needsUpdate = true; b.iC.needsUpdate = true;
      }
    }
  }

  return { sync, group };
}
