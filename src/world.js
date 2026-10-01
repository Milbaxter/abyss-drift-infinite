// World (INFINITE SEA, side view): mood-driven fog/background/light (biomeWeightsAt at the camera, smoothed),
// infinitely tiling parallax silhouette layers chosen per region (kelp columns, coral towers, rock spires),
// drifting whale shapes, god rays in bright moods, sparse unlit marine snow, and the terrain's landmark rocks.
// Floating origin: everything stored in local coords is shifted on bus 'rebase' {dx, dy}; scenery is seeded from
// ABSOLUTE coords (local + WORLD.origin) so it never changes on a rebase.
import * as THREE from 'three';
import { BIOMES, B, WORLD, biomeIndexAt, biomeWeightsAt } from './config.js';

const NB = BIOMES.length;
const lc = (hex) => new THREE.Color(hex);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const FOG_C = BIOMES.map((b) => lc(b.fog));
const TOP_C = BIOMES.map((b) => lc(b.top));
const ACC_C = BIOMES.map((b) => lc(b.accent));
const ROCK_C = BIOMES.map((b) => lc(b.rock));
const SUN_C = [0xfff1d6, 0xeafff6, 0xd6ffc8, 0x8fa8ff, 0xe8f6ff, 0x9cc4ff, 0x6c78ff].map(lc);
const BRIGHT = (w) => w[B.SHALLOWS] + w[B.REEF] + 0.6 * w[B.OCEAN] + 0.35 * w[B.KELP];
const DARK = (w) => w[B.CAVERNS] + w[B.ABYSS] + 0.6 * w[B.TWILIGHT];

function hh(ix, iy, k) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(k, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function vh(ix, iy) { return hh(ix, iy, 77) * 2 - 1; }
function vn2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y); let fx = x - ix, fy = y - iy; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = vh(ix, iy), b = vh(ix + 1, iy), c = vh(ix, iy + 1), d = vh(ix + 1, iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

// ---------- silhouette shapes (flat, unit-sized; scaled per instance) ----------
function shapeGeo(pts) {
  const s = new THREE.Shape();
  pts.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  return new THREE.ShapeGeometry(s, 1);
}
function kelpSil() { // a few wavy strands spanning y -0.5..0.5 (overlaps the next cell → continuous columns)
  const shapes = [];
  const r = mulberry32(5);
  for (let k = 0; k < 3; k++) {
    const ox = (k - 1) * 0.22 + (r() - 0.5) * 0.08, ph = r() * 6, w = 0.018 + r() * 0.012;
    const L = [], R = [];
    for (let i = 0; i <= 40; i++) {
      const t = i / 40, y = -0.75 + t * 1.5, x = ox + Math.sin(y * 7 + ph) * 0.05;
      const ww = w * Math.min(1, Math.min(t, 1 - t) * 8);
      const leaf = (i % 5 === 2) ? 0.06 * Math.min(1, Math.min(t, 1 - t) * 6) : 0;
      L.push([x - ww - (i % 10 === 2 ? leaf : 0), y]); R.push([x + ww + (i % 10 === 7 ? leaf : 0), y]);
    }
    const s = new THREE.Shape();
    [...L, ...R.reverse()].forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
    shapes.push(s);
  }
  return new THREE.ShapeGeometry(shapes, 1);
}
function coralSil() { // a branching coral tower rising from a rounded base
  const shapes = [];
  const r = mulberry32(9);
  const base = []; for (let i = 0; i <= 24; i++) { const a = Math.PI * i / 24; base.push([Math.cos(a) * 0.32, -0.5 + Math.sin(a) * 0.12]); }
  shapes.push((() => { const s = new THREE.Shape(); base.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y))); return s; })());
  const branch = (x, y, a, len, w, d) => {
    const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len, nx = -Math.sin(a) * w, ny = Math.cos(a) * w;
    const s = new THREE.Shape(); s.moveTo(x - nx, y - ny); s.lineTo(x2 - nx * 0.6, y2 - ny * 0.6); s.lineTo(x2 + nx * 0.6, y2 + ny * 0.6); s.lineTo(x + nx, y + ny);
    shapes.push(s);
    if (d > 0) { branch(x2, y2, a + 0.35 + r() * 0.3, len * 0.72, w * 0.65, d - 1); branch(x2, y2, a - 0.35 - r() * 0.3, len * 0.72, w * 0.65, d - 1); }
    else { const c = new THREE.Shape(); for (let i = 0; i <= 10; i++) { const t = i / 10 * Math.PI * 2; (i ? c.lineTo : c.moveTo).call(c, x2 + Math.cos(t) * w * 1.6, y2 + Math.sin(t) * w * 1.6); } shapes.push(c); }
  };
  branch(-0.08, -0.42, Math.PI / 2 + 0.15, 0.32, 0.06, 3);
  branch(0.12, -0.42, Math.PI / 2 - 0.25, 0.26, 0.05, 2);
  return new THREE.ShapeGeometry(shapes, 1);
}
function spireSil() { // a floating rock spire: tall rounded spindle
  const pts = [];
  for (let i = 0; i <= 32; i++) {
    const t = i / 32, y = -0.5 + t, w = 0.16 * Math.pow(Math.sin(Math.PI * t), 0.7) * (1 - 0.35 * t) + 0.01;
    pts.push([w * (1 + 0.15 * Math.sin(t * 17)), y]);
  }
  for (let i = 32; i >= 0; i--) { const t = i / 32, y = -0.5 + t, w = 0.16 * Math.pow(Math.sin(Math.PI * t), 0.7) * (1 - 0.35 * t) + 0.01; pts.push([-w * (1 + 0.12 * Math.sin(t * 13 + 1)), y]); }
  return shapeGeo(pts);
}
function whaleSil(len) {
  const pts = [];
  const h = (t) => 0.15 * Math.pow(Math.sin(Math.PI * Math.min(1, Math.pow(t, 0.55))), 0.9) * (1 - 0.55 * t) + 0.012;
  for (let i = 0; i <= 30; i++) { const t = i / 30; pts.push([t, h(t) * 1.05]); }
  pts.push([1.06, 0.13], [1.16, 0.16], [1.1, 0.0], [1.16, -0.13], [1.06, -0.1]);
  for (let i = 30; i >= 0; i--) { const t = i / 30; pts.push([t, -h(t) * 0.95 - (t > 0.25 && t < 0.38 ? 0.06 * Math.sin((t - 0.25) / 0.13 * Math.PI) : 0)]); }
  return shapeGeo(pts.map(([x, y]) => [(x - 0.55) * len, y * len]));
}
function rockGeo(R) { // landmark rock matching terrain's rockDist() outline in XY
  const g = new THREE.IcosahedronGeometry(1, 4), p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const th = Math.atan2(v.y, v.x);
    const m = 1 + 0.1 * Math.sin(3 * th + R.p1) + 0.06 * Math.sin(5 * th + R.p2);
    const n = 1 + 0.05 * vn2(v.x * 3 + R.seed % 97, v.y * 3 + v.z * 2);
    v.x *= m * n; v.y *= m * n; v.z *= 0.8 * n;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

// =====================================================================================================
export function createWorld({ scene, renderer, camera, terrain, bus }) {
  const T = terrain, F = (T && T.features) || {};
  const W = new Array(NB).fill(0);

  // ---------- smoothed mood ----------
  const mood = {
    fog: new THREE.Color(0x1f6fb0), top: new THREE.Color(0x4fb3e8), acc: new THREE.Color(0x9fd8ff),
    sun: new THREE.Color(1, 1, 1), rock: new THREE.Color(0x4a5a6a), light: 1, bright: 0.5, dark: 0, whales: 0, ready: false,
  };
  const tgt = { fog: new THREE.Color(), top: new THREE.Color(), acc: new THREE.Color(), sun: new THREE.Color(), rock: new THREE.Color() };

  // ---------- lights / fog ----------
  const fogColor = new THREE.Color(0x1f6fb0);
  scene.background = fogColor;
  scene.fog = new THREE.FogExp2(0x1f6fb0, 0.0035);
  scene.fog.color = fogColor;
  const hemi = new THREE.HemisphereLight(0xffffff, 0x223344, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(30, 100, 55);
  const plight = new THREE.PointLight(0x8fe0ff, 0, 170, 1.3);
  scene.add(hemi, sun, plight);

  // ---------- parallax silhouette layers ----------
  const GEOS = { kelp: kelpSil(), coral: coralSil(), spire: spireSil() };
  const TYPES = ['kelp', 'coral', 'spire'];
  const LAYERS = [
    { z: -150, cell: 240, k: 0.68, cap: 70 },
    { z: -320, cell: 420, k: 0.72, cap: 60 },
    { z: -580, cell: 720, k: 0.84, cap: 50 },
  ];
  for (const L of LAYERS) {
    L.mat = new THREE.MeshBasicMaterial({ color: 0x000000, fog: false, toneMapped: false, depthWrite: false });
    L.meshes = TYPES.map((t) => {
      const m = new THREE.InstancedMesh(GEOS[t], L.mat, L.cap);
      m.count = 0; m.frustumCulled = false; m.renderOrder = -10 + LAYERS.indexOf(L);
      scene.add(m);
      return m;
    });
    L.valid = false;
  }
  // farthest layer first so nearer silhouettes overlap it
  LAYERS.forEach((L, i) => L.meshes.forEach((m) => { m.renderOrder = -20 - i; }));
  const _m4 = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _e = new THREE.Euler();
  const tanH = () => Math.tan((camera.fov * Math.PI) / 360);
  function fillLayer(L, li, camX, camY, camD, aspect, force) {
    const hy = (camD - L.z) * tanH() + L.cell, hx = hy * aspect + L.cell;
    const ox = WORLD.origin.x, oy = WORLD.origin.y;
    const c0 = Math.floor((camX + ox - hx) / L.cell), c1 = Math.floor((camX + ox + hx) / L.cell);
    const r0 = Math.floor((camY + oy - hy) / L.cell), r1 = Math.floor((camY + oy + hy) / L.cell);
    if (!force && L.valid && c0 === L.c0 && c1 === L.c1 && r0 === L.r0 && r1 === L.r1) return;
    L.valid = true; L.c0 = c0; L.c1 = c1; L.r0 = r0; L.r1 = r1;
    const counts = [0, 0, 0];
    for (let cx = c0; cx <= c1; cx++) for (let cy = r0; cy <= r1; cy++) {
      const ax = (cx + 0.5) * L.cell, ay = (cy + 0.5) * L.cell;
      const bi = biomeIndexAt(ax - ox, ay - oy);
      let t = -1, chance = 0;
      if (bi === B.KELP) { t = 0; chance = 0.8; }
      else if (bi === B.REEF || bi === B.SHALLOWS) { t = 1; chance = 0.45; }
      else if (bi === B.OCEAN || bi === B.TWILIGHT || bi === B.CAVERNS || bi === B.ABYSS) { t = 2; chance = bi === B.OCEAN ? 0.18 : 0.3; }
      if (t < 0 || hh(cx, cy, 31 + li) > chance) continue;
      const mesh = L.meshes[t]; if (counts[t] >= L.cap) continue;
      let x, y, sx, sy, rot = 0;
      if (t === 0) { // kelp: strand x depends on column only → continuous vertical columns
        x = (cx + 0.2 + 0.6 * hh(cx, 0, 41 + li)) * L.cell; y = ay;
        sx = L.cell * (0.9 + 0.4 * hh(cx, 0, 42)); sy = L.cell;
      } else {
        x = (cx + 0.2 + 0.6 * hh(cx, cy, 43)) * L.cell; y = (cy + 0.2 + 0.6 * hh(cx, cy, 44)) * L.cell;
        const s = L.cell * (t === 1 ? 0.5 + 0.35 * hh(cx, cy, 45) : 0.55 + 0.6 * hh(cx, cy, 45));
        sx = s * (hh(cx, cy, 46) < 0.5 ? -1 : 1); sy = s; rot = (hh(cx, cy, 47) - 0.5) * (t === 2 ? 0.5 : 0.15);
      }
      _q.setFromEuler(_e.set(0, 0, rot));
      _m4.compose(_p.set(x - ox, y - oy, L.z + (hh(cx, cy, 48) - 0.5) * 30), _q, _s.set(sx, sy, 1));
      mesh.setMatrixAt(counts[t]++, _m4);
    }
    L.meshes.forEach((m, i) => { m.count = counts[i]; m.instanceMatrix.needsUpdate = true; });
  }

  // ---------- whales ----------
  const whaleGeo = whaleSil(170);
  const whales = [];
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(whaleGeo, new THREE.MeshBasicMaterial({ color: 0x000000, fog: false, toneMapped: false, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    m.renderOrder = -15; m.frustumCulled = false; m.visible = false;
    scene.add(m);
    whales.push({ m, x: 0, y: 0, z: -470 - i * 45, dir: 1, speed: 6 + i * 2, ph: i * 2.1, live: false });
  }
  const wrng = mulberry32(99);
  function respawnWhale(w, camX, camY, camD, aspect) {
    const hy = (camD - w.z) * tanH(), hx = hy * aspect;
    w.dir = wrng() < 0.5 ? -1 : 1;
    w.x = camX - w.dir * (hx + 160); w.y = camY + (wrng() - 0.5) * hy * 1.4;
    w.live = true;
  }

  // ---------- landmark rocks (from terrain) ----------
  const rockMat = new THREE.MeshLambertMaterial({ color: 0x6a7480 });
  const rocks = new Map();  // key → {mesh, seen}
  const rockBuf = [];
  const rockKey = [NaN, NaN, NaN];
  let rockForce = true;
  function updateRocks(camX, camY, camD, aspect) {
    if (!F.rocksNear) return;
    const hy = (camD + 60) * tanH() + 500, hx = hy * aspect + 500;
    const kx = Math.floor((camX + WORLD.origin.x) / 600), ky = Math.floor((camY + WORLD.origin.y) / 600), kz = Math.round(hx / 200);
    if (!rockForce && kx === rockKey[0] && ky === rockKey[1] && kz === rockKey[2]) return;
    rockKey[0] = kx; rockKey[1] = ky; rockKey[2] = kz; rockForce = false;
    const n = F.rocksNear(camX, camY, hx, hy, rockBuf);
    for (const r of rocks.values()) r.seen = false;
    for (let i = 0; i < n; i++) {
      const R = rockBuf[i];
      let e = rocks.get(R.key);
      if (!e) {
        const mesh = new THREE.Mesh(rockGeo(R), rockMat);
        mesh.matrixAutoUpdate = false;
        scene.add(mesh);
        e = { mesh }; rocks.set(R.key, e);
      }
      e.seen = true;
      e.mesh.position.set(R.x, R.y, -6);
      e.mesh.scale.set(R.r * R.sx, R.r * R.sy, R.r * 0.9);
      e.mesh.updateMatrix();
    }
    for (const [key, r] of rocks) if (!r.seen) { scene.remove(r.mesh); r.mesh.geometry.dispose(); rocks.delete(key); }
  }

  // ---------- god rays (bright moods only) ----------
  const RAYS = 20;
  const RAY_DIR = new THREE.Vector3(0.3, -1, 0).normalize();
  const rayGeo = new THREE.InstancedBufferGeometry();
  {
    const pl = new THREE.PlaneGeometry(1, 1, 1, 8);
    rayGeo.index = pl.index; rayGeo.setAttribute('position', pl.attributes.position); rayGeo.setAttribute('uv', pl.attributes.uv);
    const r = mulberry32(4242), a = new Float32Array(RAYS * 4);
    for (let i = 0; i < RAYS; i++) { a[i * 4] = r() * 2000; a[i * 4 + 1] = -40 - r() * 380; a[i * 4 + 2] = 14 + r() * 50; a[i * 4 + 3] = r(); }
    rayGeo.setAttribute('aRay', new THREE.InstancedBufferAttribute(a, 4));
    rayGeo.instanceCount = RAYS;
  }
  const rayU = {
    uTime: { value: 0 }, uCX: { value: 0 }, uShift: { value: 0 }, uTop: { value: 300 }, uBox: { value: 1200 },
    uDir: { value: RAY_DIR }, uCol: { value: new THREE.Color() }, uInt: { value: 0 }, uLen: { value: 1000 },
  };
  const rays = new THREE.Mesh(rayGeo, new THREE.ShaderMaterial({
    uniforms: rayU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    vertexShader: /* glsl */`
      attribute vec4 aRay;
      uniform float uTime, uCX, uShift, uTop, uBox, uInt, uLen; uniform vec3 uDir;
      varying vec2 vUv; varying float vA;
      void main(){
        float ax = aRay.x + uShift + uTime * 3.0;
        float f = fract((ax - uCX) / uBox + 0.5);
        float x = uCX + (f - 0.5) * uBox;
        float t = 1.0 - uv.y;
        vec3 P = vec3(x, uTop, aRay.y) + uDir * (t * uLen);
        vec3 side = cross(uDir, normalize(cameraPosition - P)); side /= max(length(side), 1e-3);
        P += side * (uv.x - 0.5) * aRay.z * (0.6 + t * 1.3);
        vUv = vec2(uv.x, t);
        float edge = smoothstep(0.0, 0.15, f) * smoothstep(1.0, 0.85, f);
        float flick = 0.6 + 0.4 * sin(uTime * 0.45 + aRay.w * 6.283) * sin(uTime * 0.29 + aRay.w * 17.0);
        vA = edge * flick * uInt;
        gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uCol; varying vec2 vUv; varying float vA;
      void main(){
        float s = sin(3.14159 * clamp(vUv.x, 0.0, 1.0)); s *= s;
        float t = clamp(vUv.y, 0.0, 1.0);
        float g = smoothstep(0.0, 0.25, t) * pow(1.0 - t, 1.2);
        gl_FragColor = vec4(uCol, clamp(s * g * vA, 0.0, 1.0));
      }`,
  }));
  rays.frustumCulled = false; rays.renderOrder = -1;
  scene.add(rays);

  // ---------- marine snow: sparse, tiny, faint, unlit, behind the playfield ----------
  const SNOW = 420;
  const snowGeo = new THREE.BufferGeometry();
  {
    const r = mulberry32(777), pos = new Float32Array(SNOW * 3), rnd = new Float32Array(SNOW * 2);
    for (let i = 0; i < SNOW; i++) { pos[i * 3] = r() * 1000; pos[i * 3 + 1] = r() * 1000; pos[i * 3 + 2] = -170 + r() * 145; rnd[i * 2] = r(); rnd[i * 2 + 1] = r(); }
    snowGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    snowGeo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 2));
  }
  const snowU = {
    uTime: rayU.uTime, uCenter: { value: new THREE.Vector2() }, uShift: { value: new THREE.Vector2() }, uBox: { value: new THREE.Vector2(400, 300) },
    uSize: { value: 0.16 }, uPx: { value: 800 }, uFogD: { value: 0.003 }, uCol: { value: new THREE.Color(0.6, 0.65, 0.7) },
  };
  const snow = new THREE.Points(snowGeo, new THREE.ShaderMaterial({
    uniforms: snowU, transparent: true, depthWrite: false, fog: false,
    vertexShader: /* glsl */`
      attribute vec2 aRnd;
      uniform float uTime, uSize, uPx, uFogD; uniform vec2 uCenter, uShift, uBox;
      varying float vA;
      void main(){
        vec2 A = position.xy + uShift + vec2(sin(uTime * 0.2 + aRnd.x * 6.283) * 1.5 + uTime * 0.5, -uTime * (0.4 + aRnd.y * 0.6));
        vec2 f = fract((A - uCenter) / uBox + 0.5);
        vec3 w = vec3(uCenter + (f - 0.5) * uBox, position.z);
        vec4 mv = viewMatrix * vec4(w, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(uSize * (0.6 + aRnd.x * 0.8) * uPx / max(-mv.z, 1.0), 0.0, 6.0);
        float edge = smoothstep(0.0, 0.1, f.x) * smoothstep(1.0, 0.9, f.x) * smoothstep(0.0, 0.1, f.y) * smoothstep(1.0, 0.9, f.y);
        float fd = uFogD * -mv.z;
        vA = edge * exp(-fd * fd) * 0.2;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uCol; varying float vA;
      void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; gl_FragColor = vec4(uCol, clamp(1.0 - r, 0.0, 1.0) * vA); }`,
  }));
  snow.frustumCulled = false; snow.renderOrder = -2;
  scene.add(snow);

  // ---------- floating-origin rebase ----------
  function onRebase(e) {
    const dx = (e && e.dx) || 0, dy = (e && e.dy) || 0;
    for (const w of whales) { w.x -= dx; w.y -= dy; }
    snowU.uShift.value.x -= dx; snowU.uShift.value.y -= dy;
    snowU.uShift.value.x %= 1e5; snowU.uShift.value.y %= 1e5;
    rayU.uShift.value = (rayU.uShift.value - dx) % 1e5;
    for (const L of LAYERS) L.valid = false;
    for (const r of rocks.values()) { r.mesh.position.x -= dx; r.mesh.position.y -= dy; r.mesh.updateMatrix(); }
    rockForce = true;
  }
  let busBound = false;
  function bindBus(b) { if (b && !busBound && b.on) { b.on('rebase', onRebase); busBound = true; } }
  bindBus(bus);

  // ---------- per-frame ----------
  const _c = new THREE.Color(), _l = new THREE.Color();
  function update(dt, t, pp, cam) {
    cam = cam || camera;
    if (!busBound && typeof window !== 'undefined' && window.__abyss) bindBus(window.__abyss.bus);
    rayU.uTime.value = t;
    const camX = cam.position.x, camY = cam.position.y, camD = Math.max(10, cam.position.z), aspect = cam.aspect || 1.6;

    // mood targets from region weights at the camera
    biomeWeightsAt(camX, camY, W);
    let light = 0;
    tgt.fog.setRGB(0, 0, 0); tgt.top.setRGB(0, 0, 0); tgt.acc.setRGB(0, 0, 0); tgt.sun.setRGB(0, 0, 0); tgt.rock.setRGB(0, 0, 0);
    for (let k = 0; k < NB; k++) {
      const w = W[k]; if (!w) continue;
      light += BIOMES[k].light * w;
      tgt.fog.r += FOG_C[k].r * w; tgt.fog.g += FOG_C[k].g * w; tgt.fog.b += FOG_C[k].b * w;
      tgt.top.r += TOP_C[k].r * w; tgt.top.g += TOP_C[k].g * w; tgt.top.b += TOP_C[k].b * w;
      tgt.acc.r += ACC_C[k].r * w; tgt.acc.g += ACC_C[k].g * w; tgt.acc.b += ACC_C[k].b * w;
      tgt.sun.r += SUN_C[k].r * w; tgt.sun.g += SUN_C[k].g * w; tgt.sun.b += SUN_C[k].b * w;
      tgt.rock.r += ROCK_C[k].r * w; tgt.rock.g += ROCK_C[k].g * w; tgt.rock.b += ROCK_C[k].b * w;
    }
    const bright = clamp(BRIGHT(W), 0, 1), dark = clamp(DARK(W), 0, 1);
    const whaleW = clamp(W[B.OCEAN] + W[B.TWILIGHT] + W[B.ABYSS], 0, 1);
    // smooth blend over time so region borders never pop (also while paused, use a small fixed step)
    const k = mood.ready ? 1 - Math.exp(-Math.max(dt, 0.004) * 0.9) : 1;
    mood.ready = true;
    mood.fog.lerp(tgt.fog, k); mood.top.lerp(tgt.top, k); mood.acc.lerp(tgt.acc, k); mood.sun.lerp(tgt.sun, k); mood.rock.lerp(tgt.rock, k);
    mood.light += (light - mood.light) * k; mood.bright += (bright - mood.bright) * k; mood.dark += (dark - mood.dark) * k;
    mood.whales += (whaleW - mood.whales) * k;

    // fog / background: the mood colour, a touch brighter toward the top colour in bright moods
    fogColor.copy(mood.fog).lerp(mood.top, 0.25 * mood.bright);
    scene.fog.density = 0.0034 * Math.sqrt(60 / camD) * (1 + 0.6 * mood.dark);
    // lights
    hemi.color.copy(mood.top).lerp(_c.setRGB(1, 1, 1), 0.2);
    hemi.groundColor.copy(fogColor).multiplyScalar(0.5);
    hemi.intensity = 0.45 + 0.9 * mood.light;
    sun.color.copy(mood.sun);
    sun.intensity = 0.4 + 1.6 * mood.light;
    plight.color.copy(mood.acc).lerp(_c.setRGB(0.6, 0.9, 1), 0.5);
    plight.intensity = mood.dark * 90;
    plight.position.set(pp.x, pp.y + 4, 26);

    // parallax silhouettes: darker, desaturated versions of the fog colour (non-glowing, low contrast)
    const lum = fogColor.r * 0.3 + fogColor.g * 0.55 + fogColor.b * 0.15;
    for (let li = 0; li < LAYERS.length; li++) {
      const L = LAYERS[li];
      fillLayer(L, li, camX, camY, camD, aspect, false);
      L.mat.color.copy(fogColor).lerp(_l.setRGB(lum, lum, lum), 0.3).multiplyScalar(L.k);
    }
    // whales drift across in open/deep moods
    for (const w of whales) {
      if (!w.live) { if (mood.whales > 0.3) respawnWhale(w, camX, camY, camD, aspect); else continue; }
      w.x += w.dir * w.speed * dt;
      const hy = (camD - w.z) * tanH(), hx = hy * aspect;
      if (Math.abs(w.x - camX) > hx + 400 || Math.abs(w.y - camY) > hy + 400) { w.live = false; w.m.visible = false; continue; }
      w.m.position.set(w.x, w.y + Math.sin(t * 0.06 + w.ph) * 30, w.z);
      w.m.scale.x = w.dir > 0 ? -1 : 1;
      w.m.visible = true;
      w.m.material.color.copy(fogColor).lerp(_l.setRGB(lum, lum, lum), 0.3).multiplyScalar(0.7);
      w.m.material.opacity = 0.75 * clamp((mood.whales - 0.15) / 0.5, 0, 1);
    }
    // landmark rocks
    updateRocks(camX, camY, camD, aspect);
    rockMat.color.copy(mood.rock).lerp(_l.setRGB(lum, lum, lum), 0.35).multiplyScalar(0.8);

    // god rays: only in bright moods, falling from above the view
    const hy0 = camD * tanH();
    rayU.uCX.value = camX;
    rayU.uTop.value = camY + hy0 + 260;
    rayU.uBox.value = hy0 * aspect * 2 + 900;
    rayU.uInt.value = 0.12 * clamp((mood.bright - 0.25) / 0.6, 0, 1);
    rayU.uCol.value.copy(mood.sun).lerp(mood.top, 0.3);
    rays.visible = rayU.uInt.value > 0.002;

    // snow
    snowU.uCenter.value.set(camX, camY);
    snowU.uBox.value.set((camD + 170) * tanH() * aspect * 2 + 60, (camD + 170) * tanH() * 2 + 60);
    snowU.uPx.value = renderer.domElement.height / (2 * tanH());
    snowU.uSize.value = 0.18 * Math.pow(camD / 43, 0.6);
    snowU.uFogD.value = scene.fog.density;
    snowU.uCol.value.setRGB(lum, lum, lum).lerp(_c.setRGB(0.75, 0.8, 0.85), 0.5);
  }

  return { update, terrain, onRebase };
}
