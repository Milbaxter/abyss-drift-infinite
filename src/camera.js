// Side-view follow camera: sits at +z looking -z. Springy distance by size, velocity lookahead, trauma shake,
// infinite sea (no clamps), floating-origin aware, title drift around the origin, death push-in.
import * as THREE from 'three';
import { CONFIG, WORLD, cameraDistFor } from './config.js';

const TAN_HALF = Math.tan(CONFIG.camera.fov * Math.PI / 360);

export function createCameraRig({ camera, bus, terrain }) {
  const rig = { viewRadius: 40, update };

  let clock = 0;
  let mode = null, blend = 1;           // blend 0→1 eases from snapshot pose to the mode's pose
  const snapPos = new THREE.Vector3(), snapLook = new THREE.Vector3();
  const curPos = new THREE.Vector3(WORLD.spawn.x, WORLD.spawn.y, 80), curLook = new THREE.Vector3(WORLD.spawn.x, WORLD.spawn.y, 0);
  const wantPos = new THREE.Vector3(), wantLook = new THREE.Vector3();

  let dist = cameraDistFor(1), dv = 0;  // distance spring (slightly underdamped)
  let lax = 0, lay = 0;                 // smoothed lookahead
  let trauma = 0;
  const deathSpot = new THREE.Vector3();
  let deathT = 0, deathDist = 40;

  bus.on('shake', (p) => { trauma = Math.min(1, trauma + (p && p.amount != null ? p.amount : 0.4) * 0.7); });
  bus.on('dash', () => { trauma = Math.min(1, trauma + 0.16); dv += dist * 0.2; });
  bus.on('grow', () => { dv += dist * 0.6; trauma = Math.min(1, trauma + 0.25); });

  const n1 = (x, s) => (Math.sin(x + s) * 0.5 + Math.sin(x * 2.31 + s * 1.7) * 0.3 + Math.sin(x * 4.13 + s * 2.9) * 0.2);

  // Floating origin: main shifts camera.position itself; we overwrite it from curPos each frame, so shifting our
  // stored state (and not camera.position) avoids a double shift.
  bus.on('rebase', ({ dx = 0, dy = 0 } = {}) => {
    for (const v of [curPos, curLook, wantPos, wantLook, snapPos, snapLook, deathSpot]) { v.x -= dx; v.y -= dy; }
  });

  function update(dt, p, state) {
    clock += dt;
    const m = state.mode === 'victory' ? 'playing' : state.mode;
    if (m !== mode) {
      if (mode !== null) { snapPos.copy(curPos); snapLook.copy(curLook); blend = 0; }
      if (m === 'dead') { deathSpot.set(p.pos.x, p.pos.y, 0); deathT = 0; deathDist = dist; }
      if (m === 'playing' && mode === 'title') { dist = cameraDistFor(p.size); dv = 0; lax = lay = 0; }
      mode = m;
    }

    if (m === 'title') {
      // Slow cinematic drift around the origin (the player waits at spawn, so the ecosystem fills this view).
      const d = 70 + Math.sin(clock * 0.09) * 6;
      wantLook.set(WORLD.spawn.x + Math.sin(clock * 0.035) * 60, WORLD.spawn.y + Math.sin(clock * 0.05) * 25, 0);
      wantPos.set(wantLook.x + Math.sin(clock * 0.06) * 10, wantLook.y + 3 + Math.sin(clock * 0.04) * 2, d);
    } else if (m === 'dead') {
      deathT += dt;
      const d = deathDist * (1 - 0.3 * (1 - Math.exp(-deathT * 0.35)));
      wantLook.copy(deathSpot);
      const a = deathT * 0.1;
      wantPos.set(wantLook.x + Math.sin(a) * d * 0.15, wantLook.y + Math.sin(a * 0.7) * d * 0.05, d);
    } else {
      const target = cameraDistFor(p.size);
      if (dt > 0) {
        const k = 7, c = 2 * Math.sqrt(k) * 0.72;
        const steps = Math.ceil(dt / 0.016), sdt = dt / steps;
        for (let i = 0; i < steps; i++) { dv += (k * (target - dist) - c * dv) * sdt; dist += dv * sdt; }
      }
      if (dist < target * 0.6) dist = target * 0.6;
      const hh = dist * TAN_HALF, hw = hh * camera.aspect;
      const vlen = Math.hypot(p.vel.x, p.vel.y);
      const sp = 13 * Math.pow(p.size, 0.28);
      const amt = Math.min(1.4, vlen / sp);
      const tx = vlen > 1e-3 ? p.vel.x / vlen * 0.22 * hw * amt : 0;
      const ty = vlen > 1e-3 ? p.vel.y / vlen * 0.22 * hh * amt : 0;
      const kl = 1 - Math.exp(-2.2 * dt);
      lax += (tx - lax) * kl; lay += (ty - lay) * kl;
      wantLook.set(p.pos.x + lax, p.pos.y + lay, 0);   // neutral lookahead in the velocity direction
      wantPos.set(wantLook.x, wantLook.y, dist);
    }

    if (blend < 1) {
      blend = Math.min(1, blend + dt / (m === 'playing' ? 1.1 : 1.6));
      const e = blend * blend * (3 - 2 * blend);
      curPos.lerpVectors(snapPos, wantPos, e);
      curLook.lerpVectors(snapLook, wantLook, e);
    } else { curPos.copy(wantPos); curLook.copy(wantLook); }

    camera.position.copy(curPos);
    camera.up.set(0, 1, 0);
    camera.lookAt(curLook);
    rig.viewRadius = curPos.z * TAN_HALF * camera.aspect;   // half the visible width at z = 0

    if (trauma > 0.001) {
      const s = trauma * trauma;
      const amp = curPos.z * 0.03 * s;
      const f = clock * 22;
      camera.position.x += n1(f, 1.3) * amp;
      camera.position.y += n1(f, 7.1) * amp;
      camera.rotateZ(n1(f * 0.8, 9.7) * 0.035 * s);
      trauma = Math.max(0, trauma - dt * 1.4);
    }
    camera.updateMatrixWorld();
  }

  return rig;
}
