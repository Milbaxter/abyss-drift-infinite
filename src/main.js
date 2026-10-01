// Abyss Drift — orchestrator. Owns renderer, scene, camera, game state and the frame loop.
import * as THREE from 'three';
import { CONFIG, TIERS, BOSSES, WORLD, playerMealValue, playerGrowthAt, tierIndexFor, biomeIndexAt, metersFrom } from './config.js';
import { createBus } from './bus.js';
import { feed, sizeFromMass } from './entities.js';
import { createTerrain } from './terrain.js';
import { createWorld } from './world.js';
import { createFishRenderer } from './fishRenderer.js';
import { createPlayer } from './player.js';
import { createCameraRig } from './camera.js';
import { createEcosystem } from './ecosystem.js';
import { createEffects } from './effects.js';
import { createUI } from './ui.js';
import { createAudio } from './audio.js';
import { createBosses } from './bosses.js';
import { createFormations } from './formations.js';

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, window.innerWidth / window.innerHeight, 0.5, 3000);
scene.add(camera);

const bus = createBus();
const _mv = {};

// Shared, mutable game state. UI/audio read it; only main mutates mode/score.
const state = {
  mode: 'title',          // 'title' | 'playing' | 'dead' | 'victory'
  paused: false,
  time: 0,                // total elapsed seconds
  runTime: 0,             // seconds in current run
  score: 0,
  eaten: 0,
  tier: 0,
  biome: 0,
  biomesSeen: [0],        // region (biome) indices visited this run
  distance: 0,            // meters swum this run (path length)
  wavesCleared: 0,        // formation waves dodged this run
  maxSize: 1,             // biggest size reached this run
  bossesDefeated: [],     // boss keys defeated this run
  boss: null,             // boss entity currently engaged (UI shows HP bar), or null
  mealValue: 1,           // smoothed 0..1 worth of recent meals (low = food here is too small for you)
  victoryShown: false,
  killer: null,           // species key of the fish that ate you
  best: Number(safeGet('abyss-best') || 0),
};

const terrain = createTerrain();   // 2D SDF of the cave/ocean map; shared by everything that moves
const world = createWorld({ scene, renderer, camera, terrain, bus });
const fishRenderer = createFishRenderer({ scene });
const player = createPlayer({ scene, camera, dom: canvas, bus, terrain });
const camRig = createCameraRig({ camera, bus, terrain });
const eco = createEcosystem({ scene, bus, terrain });
const bosses = createBosses({ scene, bus, terrain });
const formations = createFormations({ bus, eco, terrain });
const fx = createEffects({ renderer, scene, camera, bus });
const ui = createUI({ bus, camera, state, terrain });
const audio = createAudio({ bus });

// ---------- game flow ----------
function startRun() {
  player.reset();
  player.entity.form = TIERS[0].form;
  eco.reset();
  bosses.reset();
  formations.reset();
  Object.assign(state, { mode: 'playing', paused: false, runTime: 0, score: 0, eaten: 0, tier: 0, biome: biomeIndexAt(player.entity.pos.x, player.entity.pos.y), biomesSeen: [biomeIndexAt(player.entity.pos.x, player.entity.pos.y)], distance: 0, maxSize: 1, mealValue: 1, wavesCleared: 0, bossesDefeated: [], boss: null, victoryShown: false, killer: null });
  player.entity.invuln = CONFIG.player.invulnTime;
}
bus.on('start', () => { if (state.mode !== 'playing') startRun(); });
bus.on('restart', startRun);
bus.on('continue', () => { if (state.mode === 'victory') state.mode = 'playing'; });
bus.on('pause', (v) => { if (state.mode === 'playing') state.paused = v === undefined ? !state.paused : !!v; });

bus.on('eat', ({ eater, eaten }) => {
  if (state.mode !== 'playing') return;
  if (eater.isPlayer) {
    // Player growth: tiny prey (relative to you) is worth ~nothing; growth per meal slows as you get bigger.
    const mv = playerMealValue(eater, eaten, _mv);
    const gain = eaten.mass * playerGrowthAt(eater.size) * mv.value;
    eater.mass += gain; eater.size = sizeFromMass(eater.mass); eater.gulp = 1;
    state.mealValue += (mv.value - state.mealValue) * 0.35;   // smoothed recent meal worth, UI shows "rise" hint
    state.eaten++;
    const points = Math.round(10 * eaten.mass * (0.4 + 0.6 * mv.value));
    state.score += points;
    bus.emit('playerAte', { eaten, gain, points, pos: eaten.pos.clone(), value: mv.value, rel: mv.rel });
    checkTier(eater);
  } else if (eaten.isPlayer) {
    eaten.alive = false;
    state.mode = 'dead'; state.killer = eater.species; finishRun();
    bus.emit('playerDeath', { killer: eater });
    bus.emit('shake', { amount: 1.2 });
  }
});
function checkTier(p) {
  const t = tierIndexFor(p.size);
  if (t > state.tier) {
    state.tier = t;
    p.form = TIERS[t].form;
    bus.emit('grow', { tier: t, name: TIERS[t].name });
    bus.emit('evolve', { tier: t, form: TIERS[t].form, name: TIERS[t].name, pos: p.pos.clone() });
    if (t === TIERS.length - 1) winRun();   // Apex reached: victory card, then the run continues endlessly
  }
}
// Shift the whole simulation by (-dx, -dy). Entities are shifted here; modules with their own stored world
// positions (camera rig, effects particles, world chunks, UI) listen to bus 'rebase' {dx, dy}.
function rebase(dx, dy) {
  WORLD.origin.x += dx; WORLD.origin.y += dy;
  const shift = (e) => { e.pos.x -= dx; e.pos.y -= dy; };
  shift(player.entity);
  for (const f of eco.fish) shift(f);
  for (const b of bosses.list) shift(b);
  camera.position.x -= dx; camera.position.y -= dy;
  bus.emit('rebase', { dx, dy });
}
function winRun() {
  if (state.victoryShown) return;
  state.victoryShown = true; state.mode = 'victory'; finishRun();
  bus.emit('victory', {});
}

// Bosses: bosses.js emits bossEngage/bossHit/bossDefeated. Main applies the reward.
// Formation waves: a cleared wave (dodged without being eaten) pays out points + a small growth boost.
bus.on('waveEnd', ({ cleared } = {}) => {
  if (!cleared || state.mode !== 'playing') return;
  const p = player.entity;
  const gain = p.mass * 0.08;
  p.mass += gain; p.size = sizeFromMass(p.mass); p.gulp = 1;
  const points = Math.round(150 * (1 + state.tier) * (1 + state.wavesCleared * 0.15));
  state.score += points; state.wavesCleared++;
  bus.emit('waveBonus', { points, gain });
  checkTier(p);
});
bus.on('bossEngage', ({ boss }) => { state.boss = boss; });
bus.on('bossDisengage', () => { state.boss = null; });
bus.on('bossDefeated', ({ boss }) => {
  if (state.mode !== 'playing') return;
  const p = player.entity, def = BOSSES[boss.species];
  const gain = p.mass * (def.mini ? 0.3 : 0.45);   // a boss is a big meal, but never a skip-ahead
  p.mass += gain; p.size = sizeFromMass(p.mass); p.gulp = 1;
  const points = Math.round(500 * def.reward);
  state.score += points; state.boss = null;
  if (!state.bossesDefeated.includes(boss.species)) state.bossesDefeated.push(boss.species);
  bus.emit('playerAte', { eaten: boss, gain, points, pos: boss.pos.clone() });
  bus.emit('shake', { amount: 1.0 });
  checkTier(p);
});

function finishRun() {
  if (state.score > state.best) { state.best = state.score; safeSet('abyss-best', state.best); }
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' || e.code === 'KeyP') bus.emit('pause');
});
document.addEventListener('visibilitychange', () => { if (document.hidden) bus.emit('pause', true); });

window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setSize(w, h); fx.setSize(w, h);
});

// ---------- loop ----------
const clock = new THREE.Clock();
const drawList = [];
function frame() {
  requestAnimationFrame(frame);
  const rawDt = Math.min(clock.getDelta(), 0.05);
  const dt = state.paused ? 0 : rawDt;
  state.time += dt;
  const t = state.time;
  const active = state.mode === 'playing';
  if (active) state.runTime += dt;

  const p = player.entity;
  player.update(dt, t, { active });
  eco.update(dt, t, p, { active: active && p.alive, viewRadius: camRig.viewRadius, bosses: bosses.list });
  bosses.update(dt, t, p, { active: active && p.alive, viewRadius: camRig.viewRadius });
  formations.update(dt, t, p, state, camRig.viewRadius);

  if (active) {
    const b = biomeIndexAt(p.pos.x, p.pos.y);
    if (b !== state.biome) {
      state.biome = b;
      const first = !state.biomesSeen.includes(b);
      if (first) state.biomesSeen.push(b);
      bus.emit('biome', { index: b, first });
    }
    state.distance += Math.hypot(p.vel.x, p.vel.y) * dt * 0.6;
    // Metabolism: you slowly burn mass, so idling shrinks you (never below the start size).
    if (p.mass > CONFIG.player.startMass) {
      p.mass = Math.max(CONFIG.player.startMass, p.mass * (1 - CONFIG.eat.metabolism * dt));
      p.size = sizeFromMass(p.mass);
    }
    if (p.size > state.maxSize) state.maxSize = p.size;
    // Floating origin: keep coordinates small however far you swim.
    if (Math.abs(p.pos.x) > WORLD.rebaseDist || Math.abs(p.pos.y) > WORLD.rebaseDist) rebase(p.pos.x, p.pos.y);
  }

  camRig.update(rawDt, p, state);
  world.update(dt, t, p.pos, camera);

  drawList.length = 0;
  if (p.alive && state.mode !== 'title') drawList.push(p);
  for (const f of eco.fish) drawList.push(f);
  for (const f of bosses.list) if (f.alive) drawList.push(f);
  fishRenderer.sync(drawList, t, p, { showRelation: state.mode === 'playing' });

  fx.update(dt, t, p, state, eco);
  ui.update(rawDt, state, p, eco, camRig.viewRadius, bosses);
  audio.update(rawDt, state, p, eco);
  fx.render();
}
frame();

// Debug handle for console / playtesting.
window.__abyss = { formations, THREE, scene, camera, renderer, state, player, eco, bosses, terrain, bus, world, fx, fishRenderer, camRig, ui, audio };

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, String(v)); } catch {} }
