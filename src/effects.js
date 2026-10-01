// Effects: pooled GPU particles + underwater post-processing. render() draws the frame.
// INFINITE SIDE VIEW: gameplay plane is XY (z = 0), open water everywhere, camera at +z looking -z.
// Floating origin: on bus 'rebase' {dx,dy} every stored world position here is shifted by (-dx,-dy).
// Particles are simulated entirely in the vertex shader from (spawn pos, velocity, birth time), so the CPU only
// writes a particle once when it is emitted (ring buffer, partial buffer uploads, zero per-frame allocations).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CONFIG, BIOMES, biomeWeightsAt, biomeIndexAt, playerSpeed } from './config.js';

const K_BUBBLE = 0, K_GLOW = 1, K_STREAK = 2, K_SPARK = 3, K_MURK = 4, K_DROP = 5, K_ORBIT = 6, K_FLAKE = 7;

// Per-biome display-space grading (index = BIOMES index). tint = multiply, lift = shadow tint, sat/contrast,
// vignette, bloom threshold/strength, exposure gain, player lamp.
const GRADES = [
  /* Shallows */ { tint: [1.02, 1.03, 1.00], lift: [0.000, 0.030, 0.040], sat: 1.10, con: 1.04, vig: 0.28, bTh: 1.35, bSt: 0.22, gain: 1.00, lamp: 0.00 },
  /* Reef     */ { tint: [1.05, 1.00, 1.00], lift: [0.020, 0.010, 0.040], sat: 1.16, con: 1.05, vig: 0.30, bTh: 1.30, bSt: 0.24, gain: 1.00, lamp: 0.00 },
  /* Kelp     */ { tint: [0.97, 1.04, 0.94], lift: [0.010, 0.035, 0.025], sat: 1.02, con: 1.05, vig: 0.34, bTh: 1.20, bSt: 0.26, gain: 1.04, lamp: 0.10 },
  /* Midnight */ { tint: [0.95, 0.94, 1.10], lift: [0.035, 0.022, 0.065], sat: 1.06, con: 1.04, vig: 0.36, bTh: 1.05, bSt: 0.34, gain: 1.12, lamp: 0.35 },
  /* Ocean    */ { tint: [0.98, 1.01, 1.05], lift: [0.000, 0.020, 0.050], sat: 1.08, con: 1.03, vig: 0.28, bTh: 1.30, bSt: 0.22, gain: 1.00, lamp: 0.00 },
  /* Twilight */ { tint: [0.95, 0.96, 1.08], lift: [0.030, 0.025, 0.065], sat: 0.98, con: 1.04, vig: 0.36, bTh: 1.10, bSt: 0.30, gain: 1.08, lamp: 0.25 },
  /* Abyss    */ { tint: [0.98, 0.94, 1.08], lift: [0.050, 0.030, 0.060], sat: 0.96, con: 1.03, vig: 0.34, bTh: 1.05, bSt: 0.34, gain: 1.16, lamp: 0.42 },
];
// (dark moods keep the old vents-readability lift: raised, tinted blacks + exposure + a soft lamp around the player)

// ---------------------------------------------------------------- shaders
const PARTICLE_VS = /* glsl */`
attribute vec3 aVel;
attribute vec3 aColor;
attribute vec4 aData;   // birth, life, size, kind
attribute vec4 aExtra;  // drag, buoyancy (velocity; for droplets: gravity accel), seed, grow
uniform float uTime, uScale, uMaxSize, uAspect;
uniform vec3 uOrbit;
varying vec3 vColor;
varying float vAlpha, vKind;
varying vec2 vDir;
varying float vRot;
void hide() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; }
void main() {
  float age = uTime - aData.x;
  float life = aData.y;
  if (age < 0.0 || age > life) { hide(); return; }
  float t = age / life;
  float kind = aData.w;
  float drag = aExtra.x;
  float seed = aExtra.z;
  float damp = exp(-drag * age);
  vec3 p = position + aVel * (1.0 - damp) / drag;
  bool drop = kind > 4.5 && kind < 5.5;
  if (drop) p.y += 0.5 * aExtra.y * age * age;     // ballistic
  else p.y += aExtra.y * age;                      // buoyant drift
  float wob = (kind < 0.5) ? aData.z * 0.7 * min(age * 2.0, 1.0) : ((kind > 3.5 && kind < 4.5) ? aData.z * 0.25 : 0.0);
  p.x += sin(age * 4.7 + seed * 6.283) * wob;
  p.z += cos(age * 3.9 + seed * 9.17) * wob * 0.5;
  if (kind > 5.5 && kind < 6.5) {                            // cocoon spiral: orbits (and follows) the player
    float oa = seed * 6.283 + aVel.y * age;
    float orr = aVel.x * max(1.0 - t * aVel.z, 0.0);
    p = position + uOrbit + vec3(cos(oa) * orr, sin(oa) * orr, sin(oa * 0.7 + seed * 3.0) * orr * 0.4);
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = aData.z * (1.0 + aExtra.w * t);
  gl_PointSize = clamp(size * uScale / max(-mv.z, 0.1), 1.5, uMaxSize);
  vDir = vec2(1.0, 0.0);
  if (kind > 1.5 && kind < 2.5) {
    vec4 p2 = projectionMatrix * modelViewMatrix * vec4(p + aVel * damp * 0.05 + vec3(0.0001), 1.0);
    vec2 d = p2.xy / p2.w - gl_Position.xy / gl_Position.w;
    d.x *= uAspect; d.y = -d.y;            // gl_PointCoord has y down
    vDir = normalize(d + vec2(1e-6, 0.0));
  }
  float fin = min(age * ((kind > 1.5 && kind < 2.5) ? 18.0 : 7.0), 1.0);   // slower fade-in: bursts start stacked at one point
  float fout = 1.0 - smoothstep(kind < 0.5 ? 0.75 : ((kind > 5.5 && kind < 6.5) ? 0.85 : 0.45), 1.0, t);
  vAlpha = fin * fout;
  if (kind > 2.5 && kind < 3.5) vAlpha *= 0.55 + 0.45 * sin(age * 26.0 + seed * 40.0);
  vColor = aColor;
  vKind = kind;
  vRot = seed * 6.283 + age * (seed - 0.5) * 16.0;
}`;

const PARTICLE_FS = /* glsl */`
varying vec3 vColor;
varying float vAlpha, vKind;
varying vec2 vDir;
varying float vRot;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  if (vKind > 6.5) {                       // flake / bit of flesh: tumbling opaque shard (normal blending)
    float cr = cos(vRot), sr = sin(vRot);
    vec2 rq = vec2(cr * q.x - sr * q.y, sr * q.x + cr * q.y);
    float d = abs(rq.x) * 0.95 + abs(rq.y) * 2.1;
    if (d > 1.0) discard;
    gl_FragColor = vec4(vColor * (0.75 + 0.35 * rq.y), (1.0 - smoothstep(0.8, 1.0, d)) * vAlpha);
    return;
  }
  float r2 = dot(q, q);
  float a;
  if (vKind < 0.5) {                       // bubble: bright rim, faint body, specular dot
    if (r2 > 1.0) discard;
    float r = sqrt(r2);
    float rim = smoothstep(0.55, 0.9, r) * (1.0 - smoothstep(0.9, 1.0, r));
    vec2 s = q - vec2(-0.35, -0.38);
    a = rim * 0.85 + 0.1 + exp(-dot(s, s) * 28.0) * 1.1;
  } else if (vKind < 1.5 || vKind > 4.5) { // soft glow / droplet
    if (r2 > 1.0) discard;
    a = exp(-r2 * 4.5) * (1.0 - r2);
  } else if (vKind < 2.5) {                // streak, stretched along screen velocity
    vec2 rq = vec2(dot(q, vDir), dot(q, vec2(-vDir.y, vDir.x)));
    a = exp(-(rq.x * rq.x * 2.2 + rq.y * rq.y * 70.0));
  } else if (vKind < 3.5) {                // sparkle: core + cross
    vec2 aq = abs(q);
    a = exp(-r2 * 14.0) + 0.6 * (exp(-aq.x * 14.0 - aq.y * 2.2) + exp(-aq.y * 14.0 - aq.x * 2.2));
  } else {                                 // murk / ink / sand puff (normal blending)
    if (r2 > 1.0) discard;
    a = (1.0 - r2); a *= a * 0.8;
  }
  gl_FragColor = vec4(vColor, a * vAlpha);
}`;

const RING_VS = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const RING_FS = /* glsl */`
uniform float uProg, uAlpha;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  float r = length(vUv * 2.0 - 1.0);
  if (r > 1.0) discard;
  float w = mix(0.10, 0.025, uProg);
  float ring = exp(-pow((r - 0.92) / w, 2.0));
  float fill = smoothstep(0.3, 0.92, r) * 0.05 * (1.0 - uProg);
  float f = (1.0 - uProg); f *= f;
  gl_FragColor = vec4(uColor, (ring + fill) * f * uAlpha);
}`;

const UNDERWATER = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 }, uAspect: { value: 1 }, uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
    uDistort: { value: 0.0012 }, uCA: { value: 0.0025 }, uVig: { value: 0.35 }, uGrain: { value: 0.03 },
    uTint: { value: new THREE.Vector3(1, 1, 1) }, uLift: { value: new THREE.Vector3() },
    uSat: { value: 1 }, uContrast: { value: 1 },
    uThreat: { value: 0 }, uBeat: { value: 0 }, uDeath: { value: 0 }, uPause: { value: 0 },
    uFlash: { value: 0 }, uFlashColor: { value: new THREE.Vector3(1, 1, 1) },
    uRipple: { value: new THREE.Vector4(0.5, 0.5, 0, 0) },
    uGlow: { value: new THREE.Vector4(0.5, 0.5, 0.2, 0) }, uGlowColor: { value: new THREE.Vector3(0.3, 1, 0.85) },
    uInk: { value: 0 }, uLetter: { value: new THREE.Vector2(0, 0) },
    uGain: { value: 1 }, uLamp: { value: new THREE.Vector4(0.5, 0.5, 0.2, 0) },
  },
  vertexShader: /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
uniform sampler2D tDiffuse;
uniform float uTime, uAspect, uDistort, uCA, uVig, uGrain, uSat, uContrast, uThreat, uBeat, uDeath, uPause, uFlash, uInk;
uniform float uGain;
uniform vec2 uTexel, uLetter;
uniform vec4 uLamp;
uniform vec3 uTint, uLift, uFlashColor, uGlowColor;
uniform vec4 uRipple, uGlow;
varying vec2 vUv;
void main() {
  vec2 uv = vUv;
  vec2 c = vUv - 0.5;
  float e = length(c) * 1.4142;            // 0 center .. 1 corner
  // gentle wave refraction
  vec2 w = vec2(sin(uv.y * 23.0 + uTime * 1.3) + sin(uv.y * 9.0 + uv.x * 6.0 - uTime * 0.7),
                cos(uv.x * 19.0 + uTime * 1.1) + cos(uv.x * 7.0 - uv.y * 5.0 + uTime * 0.9));
  uv += w * uDistort * (0.6 + 0.4 * e);
  // shock ripple
  if (uRipple.w > 0.001) {
    vec2 d = (uv - uRipple.xy) * vec2(uAspect, 1.0);
    float dist = length(d);
    float band = dist - uRipple.z;
    float k = exp(-band * band * 700.0) * uRipple.w;
    uv -= (d / max(dist, 1e-4)) / vec2(uAspect, 1.0) * k * 0.018;
  }
  // chromatic aberration toward the edges
  vec3 col = texture2D(tDiffuse, uv).rgb;   // (chromatic aberration removed for readability)
  if (uPause > 0.001) {
    vec2 o = uTexel * 3.5 * uPause;
    vec3 b = col;
    b += texture2D(tDiffuse, uv + vec2(o.x, o.y)).rgb + texture2D(tDiffuse, uv + vec2(-o.x, o.y)).rgb;
    b += texture2D(tDiffuse, uv + vec2(o.x, -o.y)).rgb + texture2D(tDiffuse, uv + vec2(-o.x, -o.y)).rgb;
    b += texture2D(tDiffuse, uv + vec2(o.x * 2.0, 0.0)).rgb + texture2D(tDiffuse, uv - vec2(o.x * 2.0, 0.0)).rgb;
    b += texture2D(tDiffuse, uv + vec2(0.0, o.y * 2.0)).rgb + texture2D(tDiffuse, uv - vec2(0.0, o.y * 2.0)).rgb;
    col = mix(col, b / 9.0, min(uPause * 1.5, 1.0));
  }
  // grade (exposure, then tint + lifted shadows so the deep never crushes to black)
  col *= uGain;
  vec2 ldv = (vUv - uLamp.xy) * vec2(uAspect, 1.0);
  float lamp = uLamp.w * exp(-dot(ldv, ldv) / (uLamp.z * uLamp.z));
  col *= 1.0 + lamp;
  col = col * uTint + uLift * (1.0 - col);
  col += vec3(0.020, 0.024, 0.030) * lamp;
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSat);
  col = (col - 0.5) * uContrast + 0.5;
  // light pulse + flash
  vec2 gd = (vUv - uGlow.xy) * vec2(uAspect, 1.0);
  col += uGlowColor * (uGlow.w * exp(-dot(gd, gd) / (uGlow.z * uGlow.z)));
  col += uFlashColor * uFlash;
  // vignette
  col *= 1.0 - uVig * smoothstep(0.3, 1.05, e);
  // ink: the world closes in, purple-black
  if (uInk > 0.001) {
    float ik = uInk * (0.35 + 0.6 * smoothstep(0.05, 0.75, e));
    col = mix(col, vec3(0.02, 0.01, 0.04), clamp(ik, 0.0, 0.92));
  }
  // threat (+ boss engage pulse): red heartbeat edges
  float edge = smoothstep(0.42, 1.05, e);
  float th = uThreat * edge * (0.4 + 0.6 * uBeat) + uLetter.y * edge * 0.55;
  col = mix(col, vec3(0.55, 0.02, 0.05) * (0.55 + 0.6 * uBeat), clamp(th, 0.0, 0.85));
  // boss letterbox
  if (uLetter.x > 0.001) {
    float bar = 0.06 * uLetter.x;
    float yb = min(vUv.y, 1.0 - vUv.y);
    float inBar = 1.0 - smoothstep(bar - 0.002, bar + 0.002, yb);
    col = mix(col, vec3(0.01, 0.0, 0.005), inBar * 0.94);
    float glowB = exp(-pow((yb - bar) * 90.0, 2.0)) * uLetter.x;
    col += vec3(0.6, 0.05, 0.08) * glowB * (0.25 + 0.75 * uLetter.y);
  }
  // death
  l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, vec3(l) * vec3(0.95, 0.82, 0.84), uDeath * 0.85);
  col *= 1.0 - uDeath * (0.35 + 0.35 * edge);
  // pause dim
  col = mix(col, vec3(l) * 0.55, uPause * 0.35);
  col *= 1.0 - uPause * 0.25;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`,
};

// ---------------------------------------------------------------- module
export function createEffects({ renderer, scene, camera, bus }) {
  // ---------- particle pools ----------
  const gl = renderer.getContext();
  const psr = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
  const maxPoint = Math.min(psr ? psr[1] : 64, 256);
  const pUniforms = {
    uTime: { value: 0 }, uScale: { value: 800 }, uMaxSize: { value: maxPoint }, uAspect: { value: 1 },
    uOrbit: { value: new THREE.Vector3() },
  };

  function makePool(max, blending, order) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(max * 3), vel = new Float32Array(max * 3), col = new Float32Array(max * 3);
    const data = new Float32Array(max * 4), extra = new Float32Array(max * 4);
    for (let i = 0; i < max; i++) { data[i * 4] = -1e6; data[i * 4 + 1] = 0.001; extra[i * 4] = 1; }
    const mk = (arr, n) => new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    const attrs = [mk(pos, 3), mk(vel, 3), mk(col, 3), mk(data, 4), mk(extra, 4)];
    geo.setAttribute('position', attrs[0]);
    geo.setAttribute('aVel', attrs[1]);
    geo.setAttribute('aColor', attrs[2]);
    geo.setAttribute('aData', attrs[3]);
    geo.setAttribute('aExtra', attrs[4]);
    const mat = new THREE.ShaderMaterial({
      uniforms: pUniforms, vertexShader: PARTICLE_VS, fragmentShader: PARTICLE_FS,
      transparent: true, depthWrite: false, depthTest: true, blending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = order;
    scene.add(pts);
    return { max, pos, vel, col, data, extra, attrs, head: 0, start: -1, count: 0 };
  }
  const addPool = makePool(5000, THREE.AdditiveBlending, 20);
  const murkPool = makePool(1800, THREE.NormalBlending, 19);

  let now = 0;   // particle clock (= state.time; freezes when paused)

  function emit(pool, x, y, z, vx, vy, vz, r, g, b, life, size, kind, drag, buoy, grow) {
    const i = pool.head;
    pool.head = (i + 1) % pool.max;
    if (pool.count === 0) pool.start = i;
    pool.count++;
    let o = i * 3;
    pool.pos[o] = x; pool.pos[o + 1] = y; pool.pos[o + 2] = z;
    pool.vel[o] = vx; pool.vel[o + 1] = vy; pool.vel[o + 2] = vz;
    pool.col[o] = r; pool.col[o + 1] = g; pool.col[o + 2] = b;
    o = i * 4;
    pool.data[o] = now; pool.data[o + 1] = life; pool.data[o + 2] = size; pool.data[o + 3] = kind;
    pool.extra[o] = Math.max(drag, 0.05); pool.extra[o + 1] = buoy; pool.extra[o + 2] = Math.random(); pool.extra[o + 3] = grow;
  }
  function flush(pool) {
    if (pool.count === 0) return;
    const { start, count, max } = pool;
    for (let a = 0; a < pool.attrs.length; a++) {
      const at = pool.attrs[a], n = at.itemSize;
      at.clearUpdateRanges();
      if (count < max) {
        if (start + count <= max) at.addUpdateRange(start * n, count * n);
        else { at.addUpdateRange(start * n, (max - start) * n); at.addUpdateRange(0, (start + count - max) * n); }
      }
      at.needsUpdate = true;
    }
    pool.count = 0;
  }

  // ---------- shockwave rings (XY plane, facing the +z camera) ----------
  const ringGeo = new THREE.PlaneGeometry(1, 1);
  const rings = [];
  for (let i = 0; i < 10; i++) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uProg: { value: 0 }, uAlpha: { value: 1 }, uColor: { value: new THREE.Color() } },
      vertexShader: RING_VS, fragmentShader: RING_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const m = new THREE.Mesh(ringGeo, mat);
    m.visible = false; m.frustumCulled = false; m.renderOrder = 18;
    scene.add(m);
    rings.push({ mesh: m, t: 1, dur: 0.6, r0: 1, r1: 5, delay: 0, flat: 1 });
  }
  let ringHead = 0;
  function spawnRing(x, y, r0, r1, dur, color, alpha, delay = 0, flat = 1) {
    const r = rings[ringHead]; ringHead = (ringHead + 1) % rings.length;
    r.mesh.position.set(x, y, 0.3);
    r.t = 0; r.dur = dur; r.r0 = r0; r.r1 = r1; r.delay = delay; r.flat = flat;
    r.mesh.material.uniforms.uColor.value.copy(color).multiplyScalar(0.9);
    r.mesh.material.uniforms.uAlpha.value = alpha;
    r.mesh.visible = false;
  }

  // ---------- post-processing ----------
  const composer = new EffectComposer(renderer);
  composer.renderTarget1.samples = 4;
  composer.renderTarget2.samples = 4;
  const renderPass = new RenderPass(scene, camera);
  const size0 = renderer.getSize(new THREE.Vector2());
  const bloom = new UnrealBloomPass(new THREE.Vector2(size0.x, size0.y), 0.4, 0.55, 0.9);
  // Cap bloom input luminance (keeps hue) so stacked additive particles can't explode into a white disc,
  // and soften the threshold knee.
  bloom.materialHighPassFilter.fragmentShader = bloom.materialHighPassFilter.fragmentShader.replace(
    'gl_FragColor = mix( outputColor, texel, alpha );',
    'texel.rgb *= min( 1.0, 1.8 / max( v, 1e-4 ) ); gl_FragColor = mix( outputColor, texel, alpha );');
  bloom.materialHighPassFilter.needsUpdate = true;
  bloom.highPassUniforms.smoothWidth.value = 0.25;
  const outputPass = new OutputPass();
  const water = new ShaderPass(UNDERWATER);
  composer.addPass(renderPass);
  composer.addPass(bloom);
  composer.addPass(outputPass);
  composer.addPass(water);
  const U = water.uniforms;

  function syncSizes() {
    const rt = composer.renderTarget1;
    pUniforms.uScale.value = rt.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5));
    pUniforms.uAspect.value = rt.width / Math.max(1, rt.height);
    U.uAspect.value = pUniforms.uAspect.value;
    U.uTexel.value.set(1 / rt.width, 1 / rt.height);
  }
  syncSizes();

  // ---------- quality fallback ----------
  let quality = 0, warm = 0, avgFt = 16, badMs = 0, lastFrame = 0;
  function setQuality(q) {
    quality = q;
    bloom.enabled = q < 1;
    const samples = q >= 2 ? 0 : 4;
    if (composer.renderTarget1.samples !== samples) {
      composer.renderTarget1.samples = samples; composer.renderTarget2.samples = samples;
      composer.renderTarget1.dispose(); composer.renderTarget2.dispose();
    }
    if (q >= 2) composer.setPixelRatio(1);
    syncSizes();
  }
  try {
    const qp = new URLSearchParams(location.search).get('fx');
    if (qp === 'low') setQuality(2); else if (qp === 'med') setQuality(1);
  } catch {}

  // ---------- juice state ----------
  const grade = { tint: new THREE.Vector3(), lift: new THREE.Vector3(), sat: 1, con: 1, vig: 0.35, grain: 0.03, bTh: 0.9, bSt: 0.4 };
  grade.tint.fromArray(GRADES[0].tint); grade.lift.fromArray(GRADES[0].lift);
  const gTint = new THREE.Vector3(), gLift = new THREE.Vector3();
  const weights = new Array(BIOMES.length).fill(0);
  let threatS = 0, beatPhase = 0, death = 0, pauseS = 0;
  let flash = 0, flashDecay = 0.9, caKick = 0, glowI = 0, rippleT = 1, rippleStr = 0, rippleDur = 0.9;
  let trailAcc = 0, dashT = 9, wallCd = 0;
  let inkS = 0, inkX = 0, inkY = 0, inkR = 0, inkUntil = -1;
  let letterS = 0, engagePulse = 0;
  let bloomKick = 0, lampS = 0, gainS = 1;
  let evoT = -1, evoSize = 1, evoEmitAcc = 0, pendingGrow = false;
  const EVO_DUR = 0.5;
  const evoCenter = new THREE.Vector3();
  const sunGold = new THREE.Color(1.0, 0.85, 0.55);
  let lastReal = performance.now();
  const flashColor = U.uFlashColor.value;
  const proj = new THREE.Vector3();
  const glowAt = new THREE.Vector3();
  let glowFollowPlayer = true;
  const col = new THREE.Color();
  const col2 = new THREE.Color();
  const white = new THREE.Color(1, 1, 1);
  const heroCol = new THREE.Color(0x3ff5d0);
  const redCol = new THREE.Color(0xff2a3a);
  const goldCol = new THREE.Color(0xffd36a);
  let playerRef = null;

  const rnd = (a, b) => a + Math.random() * (b - a);
  const camD = () => Math.max(20, camera.position.z);
  // Minimum world size so particles stay readable as the camera pulls back with growth.
  const minSz = (k) => camD() * k;

  function screenOf(p, out2) {
    proj.copy(p).project(camera);
    out2.x = proj.x * 0.5 + 0.5; out2.y = proj.y * 0.5 + 0.5;
  }
  function visible(p) {
    const halfH = camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) * 1.2;
    const halfW = halfH * camera.aspect;
    return Math.abs(p.x - camera.position.x) < halfW && Math.abs(p.y - camera.position.y) < halfH;
  }

  // Generic radial burst (XY plane): hollow bubbles + tumbling flakes/bits in colour `c` + a murky puff.
  // Nothing here is a free-floating solid glowing dot (those read as food).
  function burst(p, c, sz, count, power = 1) {
    const spread = (sz * 2.2 + minSz(0.02)) * power;
    const nb = Math.ceil(count * 0.35), nf = count - nb, nm = Math.min(10, 3 + Math.round(sz * 2));
    for (let i = 0; i < nb; i++) {
      const a = Math.random() * 6.283, s = rnd(0.3, 1) * spread * 2.2;
      const bs = Math.max(sz * rnd(0.12, 0.28), minSz(rnd(0.004, 0.008)));
      emit(addPool, p.x + rnd(-0.3, 0.3) * sz, p.y + rnd(-0.3, 0.3) * sz, rnd(-0.5, 0.5) * sz, Math.cos(a) * s, Math.sin(a) * s, rnd(-0.3, 0.3) * s,
        0.5, 0.72, 0.82, rnd(0.8, 1.5), bs, K_BUBBLE, 3, rnd(1, 3) * (0.5 + sz * 0.4), 0.3);
    }
    for (let i = 0; i < nf; i++) {
      const a = Math.random() * 6.283, s = rnd(0.4, 1.2) * spread * 2.6;
      const fs = Math.max(sz * rnd(0.18, 0.4), minSz(rnd(0.007, 0.013)));
      const sh = rnd(0.55, 1.05), red = Math.random() < 0.3;     // some darker, reddish bits = flesh
      emit(murkPool, p.x + rnd(-0.3, 0.3) * sz, p.y + rnd(-0.3, 0.3) * sz, rnd(-0.3, 0.3) * sz, Math.cos(a) * s, Math.sin(a) * s, rnd(-0.2, 0.2) * s,
        red ? 0.45 * sh : c.r * sh, red ? 0.07 * sh : c.g * sh, red ? 0.08 * sh : c.b * sh,
        rnd(0.45, 0.9), fs, K_FLAKE, 3.5, -sz * rnd(0.3, 1.0), 0);
    }
    col2.copy(c).multiplyScalar(0.3);
    for (let i = 0; i < nm; i++) {
      const a = Math.random() * 6.283, s = rnd(0.2, 0.7) * spread;
      emit(murkPool, p.x + rnd(-0.4, 0.4) * sz, p.y + rnd(-0.4, 0.4) * sz, -0.3, Math.cos(a) * s, Math.sin(a) * s, 0,
        col2.r + 0.06, col2.g + 0.01, col2.b + 0.02, rnd(0.7, 1.1), Math.max(sz * rnd(0.9, 1.5), minSz(0.02)), K_MURK, 2.5, sz * 0.2, 1.4);
    }
  }
  function radialStreaks(x, y, n, len, speed, c, br) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.283 + rnd(-0.08, 0.08), sp = speed * rnd(0.6, 1.1), r0 = rnd(0.2, 1) * len;
      emit(addPool, x + Math.cos(a) * r0, y + Math.sin(a) * r0, 0.4, Math.cos(a) * sp, Math.sin(a) * sp, 0,
        c.r * br, c.g * br, c.b * br, rnd(0.35, 0.6), len * rnd(0.5, 0.9), K_STREAK, 2.5, 0, 0);
    }
  }
  function pulseAt(p, intensity, colR, colG, colB) {
    glowAt.copy(p); glowFollowPlayer = false;
    glowI = Math.max(glowI, intensity); U.uGlowColor.value.set(colR, colG, colB);
  }

  // ---------- events ----------
  bus.on('eat', ({ eater, eaten }) => {
    if (!eaten || eaten.isPlayer) return;
    if (!(eater && eater.isPlayer) && !visible(eaten.pos)) return;
    const n = Math.min(70, Math.round(12 + eaten.size * 9));
    burst(eaten.pos, eaten.color, eaten.size, n);
    const ps = Math.max(eaten.size * 2.2, minSz(0.025));
    emit(addPool, eaten.pos.x, eaten.pos.y, 0.3, 0, 0, 0,
      eaten.color.r * 0.8, eaten.color.g * 0.8, eaten.color.b * 0.8, 0.18, ps * 0.7, K_GLOW, 1, 0, 0.6);
  });

  bus.on('playerAte', ({ eaten, pos }) => {
    const s = eaten ? Math.min(eaten.size, 10) : 1;
    const c = eaten && eaten.color ? eaten.color : white;
    const ps = playerRef ? playerRef.size : 1;
    col.copy(c).lerp(white, 0.35);
    const r0 = Math.max(s, ps * 0.4);
    spawnRing(pos.x, pos.y, r0, r0 * 2.3 + minSz(0.02), 0.45, col, 0.6);
  });

  // Evolution finale: a ring, a soft glow pulse, a few bubbles. No whiteout (flash capped low).
  function evolveBurst(p, big) {
    const s = p.size;
    for (let i = 0; i < (big ? 22 : 14); i++) {
      const a = Math.random() * 6.283, sp = rnd(0.5, 1) * (s * 6 + minSz(0.12));
      emit(addPool, p.pos.x + Math.cos(a) * s, p.pos.y + Math.sin(a) * s, rnd(-0.5, 0.5) * s,
        Math.cos(a) * sp, Math.sin(a) * sp, 0,
        0.45, 0.7, 0.8, rnd(0.9, 1.5), Math.max(s * rnd(0.15, 0.3), minSz(0.008)), K_BUBBLE, 3, rnd(2, 4) * s, 0.3);
    }
    spawnRing(p.pos.x, p.pos.y, s, s * 5 + minSz(0.08), 0.75, heroCol, big ? 0.9 : 0.6);
    glowFollowPlayer = true; glowI = big ? 0.45 : 0.3; U.uGlowColor.value.set(0.45, 1, 0.9);
    rippleT = 0; rippleStr = big ? 0.5 : 0.3; rippleDur = 0.8;
    flash = Math.max(flash, big ? 0.12 : 0.07); flashDecay = 1.2; flashColor.set(0.6, 1, 0.9);
    bloomKick = big ? 0.3 : 0.15;
    bus.emit('shake', { amount: big ? 0.25 : 0.15 });
  }

  // main emits grow + evolve together; evolve owns the show, grow alone gets a smaller fallback burst.
  bus.on('grow', () => { pendingGrow = true; });

  bus.on('evolve', ({ pos } = {}) => {
    pendingGrow = false;
    const p = playerRef; if (!p) return;
    evoT = 0; evoSize = p.size; evoEmitAcc = 0;
    evoCenter.copy(pos || p.pos);
    pUniforms.uOrbit.value.set(0, 0, 0);
    const s = p.size;
    // the cocoon: a spiral of light that tightens around the player, then the finale fires
    for (let i = 0; i < 26; i++) {
      const r0 = s * rnd(1.6, 2.8) + minSz(0.02);
      const w = (Math.random() < 0.5 ? 1 : -1) * rnd(4, 9);
      const c = Math.random() < 0.2 ? white : heroCol, br = rnd(0.55, 0.9);
      emit(addPool, evoCenter.x, evoCenter.y, 0.4, r0, w, rnd(0.6, 0.85),
        c.r * br, c.g * br, c.b * br, EVO_DUR, Math.max(s * rnd(0.12, 0.24), minSz(0.007)), K_ORBIT, 1, 0, 0);
    }
  });

  bus.on('dash', ({ pos, heading }) => {
    const p = playerRef; const s = p ? p.size : 1;
    const fx = Math.cos(heading), fy = Math.sin(heading);
    const tx = pos.x - fx * s, ty = pos.y - fy * s;
    for (let i = 0; i < 26; i++) {
      const a = heading + Math.PI + rnd(-0.9, 0.9), sp = rnd(0.3, 1) * (s * 8 + minSz(0.1));
      emit(addPool, tx, ty, rnd(-0.5, 0.5) * s, Math.cos(a) * sp, Math.sin(a) * sp, rnd(-1, 1),
        0.6, 0.85, 0.95, rnd(0.6, 1.3), Math.max(s * rnd(0.1, 0.25), minSz(0.006)), K_BUBBLE, 3, rnd(1, 3) * s, 0.3);
    }
    // speed streaks rushing past the fish
    const spd = playerSpeed(s) * 2.6;
    for (let i = 0; i < 16; i++) {
      const side = rnd(-1, 1) * (s * 3 + minSz(0.08)), ahead = rnd(0, 1) * (s * 6 + minSz(0.1));
      emit(addPool, pos.x + fx * ahead - fy * side, pos.y + fy * ahead + fx * side, 0.5,
        -fx * spd, -fy * spd, 0, 1.1, 1.4, 1.5, rnd(0.25, 0.45), Math.max(s * 1.6, minSz(0.04)), K_STREAK, 2, 0, 0);
    }
    dashT = 0; caKick = Math.min(1, caKick + 0.6);
  });

  bus.on('nearMiss', ({ fish }) => {
    const p = playerRef; if (!fish || !p) return;
    const mx = (fish.pos.x + p.pos.x) * 0.5, my = (fish.pos.y + p.pos.y) * 0.5;
    const fx = Math.cos(fish.heading), fy = Math.sin(fish.heading);
    const s = Math.max(p.size, fish.size * 0.5), spd = s * 20 + minSz(0.4);
    for (let i = 0; i < 9; i++) {
      const side = rnd(-1, 1) * s, back = rnd(-1, 1) * s;
      emit(addPool, mx - fy * side + fx * back, my + fx * side + fy * back, 0.5, fx * spd * rnd(0.6, 1), fy * spd * rnd(0.6, 1), 0,
        2, 2, 2, rnd(0.2, 0.35), Math.max(s * 2, minSz(0.05)), K_STREAK, 3, 0, 0);
    }
    flash = Math.max(flash, 0.07); flashDecay = 0.9; flashColor.set(1, 1, 1);
    caKick = Math.min(1, caKick + 0.5);
  });

  bus.on('playerDeath', () => {
    const p = playerRef; if (!p) return;
    const s = p.size;
    for (let i = 0; i < 55; i++) {
      const a = Math.random() * 6.283, sp = rnd(0.2, 1) * (s * 4 + minSz(0.05));
      const red = Math.random() < 0.55;
      emit(murkPool, p.pos.x + rnd(-1, 1) * s, p.pos.y + rnd(-1, 1) * s, rnd(-1, 1) * s,
        Math.cos(a) * sp, Math.sin(a) * sp, 0,
        red ? rnd(0.12, 0.22) : 0.02, red ? 0.01 : 0.03, red ? 0.02 : 0.04,
        rnd(2.2, 4.0), Math.max(s * rnd(1.2, 2.4), minSz(0.03)), K_MURK, 1.2, rnd(0.5, 1.5), 2.2);
    }
    burst(p.pos, redCol, s, 50, 1.3);
    flash = Math.max(flash, 0.12); flashDecay = 0.9; flashColor.set(0.6, 0.05, 0.05);
    rippleT = 0; rippleStr = 0.7; rippleDur = 0.9;
  });

  // Victory: became the Apex (mid-sea; the run continues). Radial golden glow + rings + brief sparkles.
  bus.on('victory', () => {
    const p = playerRef; if (!p) return;
    const s = p.size;
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * 6.283, sp = rnd(0.3, 1) * (s * 12 + minSz(0.25));
      emit(addPool, p.pos.x + Math.cos(a) * s, p.pos.y + Math.sin(a) * s, 0.3, Math.cos(a) * sp, Math.sin(a) * sp, 0,
        sunGold.r * 1.5, sunGold.g * 1.5, sunGold.b * 1.5, rnd(0.3, 0.55), Math.max(s * rnd(0.2, 0.45), minSz(0.012)), K_SPARK, 2, 0, 0);
    }
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * 6.283, sp = rnd(0.4, 1) * (s * 6 + minSz(0.12));
      emit(addPool, p.pos.x + Math.cos(a) * s, p.pos.y + Math.sin(a) * s, rnd(-0.5, 0.5) * s, Math.cos(a) * sp, Math.sin(a) * sp, 0,
        0.5, 0.7, 0.8, rnd(0.8, 1.3), Math.max(s * rnd(0.15, 0.3), minSz(0.008)), K_BUBBLE, 3, rnd(2, 4) * s, 0.3);
    }
    radialStreaks(p.pos.x, p.pos.y, 18, s * 1.6 + minSz(0.04), s * 24 + minSz(0.6), sunGold, 1.6);
    spawnRing(p.pos.x, p.pos.y, s, s * 9 + minSz(0.15), 1.1, goldCol, 1);
    spawnRing(p.pos.x, p.pos.y, s * 0.5, s * 6 + minSz(0.1), 0.9, white, 0.6, 0.15);
    glowFollowPlayer = true; glowI = 1.1; U.uGlowColor.value.set(1, 0.82, 0.42);
    rippleT = 0; rippleStr = 0.9; rippleDur = 1.0;
    flash = Math.max(flash, 0.2); flashDecay = 1.0; flashColor.set(1, 0.88, 0.6);
    bloomKick = 0.5;
  });

  bus.on('spawnBurst', ({ pos, color, count } = {}) => {
    if (!pos) return;
    if (color !== undefined && color !== null) col.set(color); else col.set(0xffffff);
    burst(pos, col, playerRef ? playerRef.size * 0.6 : 1, Math.min(120, count || 20));
  });

  // Octopus ink: dense lingering cloud + screen darkening while the player is inside.
  bus.on('ink', ({ pos, radius } = {}) => {
    if (!pos) return;
    const R = Math.max(4, radius || 20);
    for (let i = 0; i < 150; i++) {
      const a = Math.random() * 6.283, d = Math.sqrt(Math.random()) * R * 0.75;
      const sp = rnd(0.1, 0.6) * R * 0.4;
      const v = rnd(0, 0.03);
      emit(murkPool, pos.x + Math.cos(a) * d * 0.4, pos.y + Math.sin(a) * d * 0.4, rnd(-0.3, 0.3) * R,
        Math.cos(a) * (d + sp), Math.sin(a) * (d + sp), 0,
        0.02 + v, 0.012 + v * 0.5, 0.04 + v * 1.5, rnd(3.4, 4.6), R * rnd(0.25, 0.55), K_MURK, 1.1, rnd(-0.5, 0.5), 1.2);
    }
    inkX = pos.x; inkY = pos.y; inkR = R; inkUntil = now + 4.2;
  });

  bus.on('bossHit', ({ boss, pos } = {}) => {
    const p = pos || (boss && boss.pos); if (!p) return;
    const s = boss ? Math.min(boss.size, 14) * 0.5 : 2;
    burst(p, goldCol, s, 40, 1.1);
    spawnRing(p.x, p.y, s * 0.6, s * 3 + minSz(0.05), 0.5, goldCol, 1);
    radialStreaks(p.x, p.y, 10, s * 1.4 + minSz(0.03), s * 22 + minSz(0.5), goldCol, 1.4);
    flash = Math.max(flash, 0.08); flashDecay = 1.2; flashColor.set(1, 0.85, 0.45);
  });

  bus.on('bossDefeated', ({ boss } = {}) => {
    if (!boss) return;
    const p = boss.pos, s = Math.min(boss.size, 26);
    burst(p, boss.color || goldCol, s * 0.6, 100, 1.8);
    radialStreaks(p.x, p.y, 24, s * 1.2 + minSz(0.04), s * 30 + minSz(0.8), white, 2.2);
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * 6.283, sp = rnd(0.2, 1) * s * 3;
      emit(murkPool, p.x + rnd(-1, 1) * s * 0.5, p.y + rnd(-1, 1) * s * 0.5, rnd(-1, 1) * s * 0.3,
        Math.cos(a) * sp, Math.sin(a) * sp, 0, 0.03, 0.04, 0.06, rnd(1.0, 1.6), s * rnd(0.5, 1), K_MURK, 1.5, rnd(0.5, 2), 1.6);
    }
    spawnRing(p.x, p.y, s * 0.5, s * 6 + minSz(0.1), 1.2, goldCol, 1);
    spawnRing(p.x, p.y, s * 0.3, s * 9 + minSz(0.15), 1.6, white, 0.8, 0.15);
    pulseAt(p, 0.8, 1, 0.9, 0.6);
    rippleT = 0; rippleStr = 1.0; rippleDur = 1.0;
    flash = 0.3; flashDecay = 0.8; flashColor.set(1, 0.95, 0.85);
  });

  bus.on('bossEngage', () => { engagePulse = 1; });

  // Floating origin: shift stored spawn positions of live particles (both pools, full re-upload — rare event),
  // rings, cocoon centre, glow anchor and ink zone.
  function shiftPool(pool, dx, dy) {
    const pos = pool.pos, data = pool.data;
    for (let i = 0; i < pool.max; i++) {
      if (now - data[i * 4] > data[i * 4 + 1]) continue;     // dead slot
      pos[i * 3] -= dx; pos[i * 3 + 1] -= dy;
    }
    const at = pool.attrs[0];
    at.clearUpdateRanges(); at.needsUpdate = true;
  }
  bus.on('rebase', ({ dx = 0, dy = 0 } = {}) => {
    if (!dx && !dy) return;
    flush(addPool); flush(murkPool);                        // pending writes go up with the old coords first
    shiftPool(addPool, dx, dy); shiftPool(murkPool, dx, dy);
    for (let i = 0; i < rings.length; i++) { rings[i].mesh.position.x -= dx; rings[i].mesh.position.y -= dy; }
    evoCenter.x -= dx; evoCenter.y -= dy;
    glowAt.x -= dx; glowAt.y -= dy;
    inkX -= dx; inkY -= dy;
  });

  const resetFx = () => { death = 0; inkUntil = -1; evoT = -1; };
  bus.on('start', resetFx);
  bus.on('restart', resetFx);

  // ---------- per-frame ----------
  function update(dt, t, player, state, eco) {
    playerRef = player;
    now = t;
    const nowReal = performance.now();
    const rdt = Math.min(0.05, (nowReal - lastReal) / 1000);
    lastReal = nowReal;
    const live = player && player.alive && (state.mode === 'playing' || state.mode === 'victory');

    // player bubble trail (underwater only)
    if (live && dt > 0) {
      const s = player.size;
      const spd = Math.hypot(player.vel.x, player.vel.y);
      const base = playerSpeed(s);
      dashT += dt;
      const dashing = dashT < CONFIG.player.dashTime * 1.4 || spd > base * 1.35;
      trailAcc += dashing ? dt * 28 : dt * (1.5 + 2.5 * Math.min(1.5, spd / base));
      const fx = Math.cos(player.heading), fy = Math.sin(player.heading);
      while (trailAcc >= 1) {
        trailAcc -= 1;
        const j = s * 0.2;
        emit(addPool, player.pos.x - fx * s * 0.95 + rnd(-j, j), player.pos.y - fy * s * 0.95 + rnd(-j, j), rnd(-j, j),
          -fx * spd * 0.12 + rnd(-1, 1) * s * 0.5, -fy * spd * 0.12 + rnd(-1, 1) * s * 0.5, rnd(-0.5, 0.5) * s,
          0.45, 0.65, 0.75, rnd(0.5, 0.9), Math.max(s * rnd(0.06, 0.14), minSz(rnd(0.003, 0.005))), K_BUBBLE, 2, rnd(1, 2.5) * (0.6 + s * 0.3), 0.25);
      }
    }

    // wall impact: sand / debris puff at the contact point
    wallCd -= dt;
    if (live && dt > 0 && player.wallHit > 0.5 && wallCd <= 0) {
      wallCd = 0.3;
      const nx = player.lastWallNx || 0, ny = player.lastWallNy || 0, s = player.size;
      const cx = player.pos.x - nx * s, cy = player.pos.y - ny * s;
      col2.set(BIOMES[biomeIndexAt(cx, cy)].rock);
      const str = Math.min(1, player.wallHit);
      for (let i = 0; i < 18; i++) {
        const tg = rnd(-1, 1), sp = rnd(0.3, 1) * (s * 5 + minSz(0.06)) * str;
        const vx = (nx + -ny * tg * 1.3) * sp, vy = (ny + nx * tg * 1.3) * sp;
        const sh = rnd(0.55, 1.0);
        emit(murkPool, cx, cy, rnd(-0.5, 0.5) * s, vx, vy, rnd(-1, 1) * s,
          col2.r * sh, col2.g * sh, col2.b * sh, rnd(0.7, 1.4), Math.max(s * rnd(0.35, 0.7), minSz(0.012)), K_MURK, 3, -s * 0.4, 1.6);
      }
      caKick = Math.min(1, caKick + 0.2 * str);
    }

    flush(addPool); flush(murkPool);
    pUniforms.uTime.value = t;

    // rings
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      if (r.t >= 1) { r.mesh.visible = false; continue; }
      if (r.delay > 0) { r.delay -= dt; continue; }
      r.t = Math.min(1, r.t + dt / r.dur);
      const e = 1 - Math.pow(1 - r.t, 3);
      const sc = (r.r0 + (r.r1 - r.r0) * e) * 2;
      r.mesh.scale.set(sc, sc * r.flat, 1);
      r.mesh.material.uniforms.uProg.value = r.t;
      r.mesh.visible = r.t < 1;
    }

    // grade: biome weights at the player + darkness with depth
    const px = player ? player.pos.x : 0, py = player ? player.pos.y : 0;
    biomeWeightsAt(px, py, weights);
    gTint.set(0, 0, 0); gLift.set(0, 0, 0);
    let sat = 0, con = 0, vig = 0, grain = 0, bTh = 0, bSt = 0;
    for (let i = 0; i < GRADES.length; i++) {
      const w = weights[i]; if (!w) continue;
      const G = GRADES[i];
      gTint.x += G.tint[0] * w; gTint.y += G.tint[1] * w; gTint.z += G.tint[2] * w;
      gLift.x += G.lift[0] * w; gLift.y += G.lift[1] * w; gLift.z += G.lift[2] * w;
      sat += G.sat * w; con += G.con * w; vig += G.vig * w; bTh += G.bTh * w; bSt += G.bSt * w;
    }
    let gainT = 0, lampT = 0;
    for (let i = 0; i < GRADES.length; i++) { const w = weights[i]; if (w) { gainT += GRADES[i].gain * w; lampT += GRADES[i].lamp * w; } }
    const kg = 1 - Math.exp(-1.5 * rdt);
    grade.tint.lerp(gTint, kg); grade.lift.lerp(gLift, kg);
    grade.sat += (sat - grade.sat) * kg;
    grade.con += (con - grade.con) * kg;
    grade.vig += (vig - grade.vig) * kg;
    grade.bTh += (bTh - grade.bTh) * kg;
    grade.bSt += (bSt - grade.bSt) * kg;
    gainS += (gainT - gainS) * kg; lampS += (lampT - lampS) * kg;

    // evolution cocoon → finale
    if (evoT >= 0 && player) {
      evoT += dt;
      const pr = Math.min(1, evoT / EVO_DUR);
      pUniforms.uOrbit.value.set(player.pos.x - evoCenter.x, player.pos.y - evoCenter.y, 0);
      glowFollowPlayer = true; U.uGlowColor.value.set(0.45, 1, 0.9);
      glowI = Math.max(glowI, 0.1 + 0.3 * pr * pr);
      if (evoT >= EVO_DUR) { evoT = -1; evolveBurst(player, true); }
    }
    if (pendingGrow && player) { pendingGrow = false; evolveBurst(player, false); }

    bloomKick = Math.max(0, bloomKick - rdt * 1.1);

    // threat heartbeat
    const threat = state.mode === 'playing' && eco && eco.threat ? eco.threat : 0;
    threatS += (threat - threatS) * (1 - Math.exp(-4 * rdt));
    beatPhase = (beatPhase + dt * (0.9 + threatS * 1.5)) % 1;
    const beat = Math.exp(-beatPhase * 16) + 0.7 * (beatPhase > 0.2 ? Math.exp(-(beatPhase - 0.2) * 16) : 0);

    // ink zone
    let inkT = 0;
    if (live && now < inkUntil) {
      const dx = px - inkX, dy = py - inkY, rr = inkR + player.size * 0.5;
      if (dx * dx + dy * dy < rr * rr) inkT = Math.min(1, (inkUntil - now) / 0.8);
    }
    inkS += (inkT - inkS) * (1 - Math.exp(-(inkT > inkS ? 6 : 2) * rdt));

    // boss letterbox
    const engaged = state.mode === 'playing' && !!state.boss;
    letterS += ((engaged ? 1 : 0) - letterS) * (1 - Math.exp(-3 * rdt));
    engagePulse = Math.max(0, engagePulse - rdt * 0.8);
    const lp = engagePulse > 0 ? engagePulse * (0.5 + 0.5 * Math.sin(engagePulse * 22)) : 0;

    // death / pause
    death += ((state.mode === 'dead' ? 1 : 0) - death) * (1 - Math.exp(-(state.mode === 'dead' ? 1.6 : 4) * rdt));
    pauseS += ((state.paused ? 1 : 0) - pauseS) * (1 - Math.exp(-8 * rdt));

    // decays (real time so pause doesn't freeze a flash mid-screen)
    flash = Math.max(0, flash - rdt * flashDecay);
    caKick = Math.max(0, caKick - rdt * 2.2);
    glowI = Math.max(0, glowI - rdt * 1.4);
    if (rippleT < 1) rippleT = Math.min(1, rippleT + rdt / rippleDur);

    if (glowI > 0 || rippleT < 1) {
      if (glowFollowPlayer && player) screenOf(player.pos, U.uGlow.value);
      else screenOf(glowAt, U.uGlow.value);
      U.uRipple.value.x = U.uGlow.value.x; U.uRipple.value.y = U.uGlow.value.y;
    }
    U.uGlow.value.z = 0.07 + 0.13 * (1 - Math.min(1, glowI));
    U.uGlow.value.w = glowI * glowI * 0.2;
    U.uRipple.value.z = rippleT * 0.75;
    U.uRipple.value.w = rippleT < 1 ? rippleStr * (1 - rippleT) * (1 - rippleT) : 0;

    U.uTime.value = state.time + nowReal * 0.0001;   // keep grain alive while paused
    U.uTint.value.copy(grade.tint); U.uLift.value.copy(grade.lift);
    U.uSat.value = grade.sat * (1 + threatS * 0.08);
    U.uContrast.value = grade.con;
    U.uVig.value = grade.vig + threatS * 0.12 + letterS * 0.08;
    U.uGrain.value = 0;
    U.uDistort.value = 0.0006 + caKick * 0.0004;
    U.uCA.value = 0;
    U.uThreat.value = threatS;
    U.uBeat.value = beat;
    U.uDeath.value = death;
    U.uPause.value = pauseS;
    U.uFlash.value = flash * flash * 2.5;
    U.uInk.value = inkS;
    U.uLetter.value.set(Math.max(letterS, engagePulse), lp + letterS * 0.15 * beat);
    U.uGain.value = gainS;
    if (player) screenOf(player.pos, U.uLamp.value);
    U.uLamp.value.z = 0.2;
    U.uLamp.value.w = player && state.mode !== 'title' ? lampS : lampS * 0.5;

    bloom.threshold = grade.bTh;
    bloom.strength = Math.min(0.6, grade.bSt + glowI * 0.1 + bloomKick * 0.15);
    bloom.threshold = grade.bTh;
  }

  function render() {
    // quality fallback: avg frame > 22ms for 3s → drop bloom; again → drop MSAA + pixel ratio 1
    const n = performance.now();
    const ft = n - lastFrame; lastFrame = n;
    if (!document.hidden && ft < 250) {
      warm += ft;
      avgFt += (ft - avgFt) * 0.05;
      if (warm > 4000 && quality < 2) {
        badMs = avgFt > 22 ? badMs + ft : Math.max(0, badMs - ft);
        if (badMs > 3000) {
          setQuality(quality + 1); badMs = 0; avgFt = 16;
          console.info('[effects] quality fallback →', quality);
        }
      }
    }
    composer.render();
  }

  function setSize(w, h) {
    composer.setSize(w, h);
    syncSizes();
  }

  return {
    update, render, setSize,
    setQuality, get quality() { return quality; },
    composer, bloom,
  };
}
