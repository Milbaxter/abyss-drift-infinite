// Player: input + WC3 "ice escape" steering on the SIDE-VIEW XY plane. The fish always swims forward; input only
// sets a desired heading, and the heading rotates toward it at a capped rate (playerTurn). Velocity lags a bit.
// Infinite open sea (no surface/gravity). Rare landmark rocks: ice-escape wall sliding via terrain.collide.
// Floating origin: on bus 'rebase' {dx,dy} the click target and marker meshes shift by (-dx,-dy).
import * as THREE from 'three';
import { makeFish } from './entities.js';
import { CONFIG, WORLD, playerSpeed, playerTurn, turnToward, wrapAngle } from './config.js';

const P = CONFIG.player;
const TAU = Math.PI * 2;
const ARC_PTS = 40;
const RIPPLES = 5;

export function createPlayer({ scene, camera, dom, bus, terrain }) {
  const api = { entity: null, dashCooldown01: 1, reset, update };

  // ---------- state ----------
  let flow = 'title';              // mirrors main's mode via bus events
  let lastDt = 1;                  // 0 while paused
  let startGuard = 0;              // ignore dash right after starting
  const keys = { up: false, down: false, left: false, right: false };
  let pointerDown = false, pointerId = -1;
  let sx = 0, sy = 0;              // last pointer screen position
  let lastTouchDown = -1;
  let hasTarget = false;
  const target = new THREE.Vector3();
  let targetTurned = 0;            // accumulated |turn| while chasing a released target (orbit guard)
  let desired = 0;
  let dashT = 99, dashCd = 0, wantDash = false;
  let turnRateSm = 0;
  let clock = 0;
  let impactCd = 0;

  // ---------- picking (z = 0 plane) ----------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const hit = new THREE.Vector3();
  function pick(x, y, out) {
    const w = dom.clientWidth || window.innerWidth, h = dom.clientHeight || window.innerHeight;
    ndc.set((x / w) * 2 - 1, -(y / h) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray.intersectPlane(plane, out) !== null;
  }

  // ---------- visuals: target reticle, click ripples, steering arc (XY plane, facing the camera) ----------
  const markGroup = new THREE.Group();
  scene.add(markGroup);
  const ringGeo = new THREE.RingGeometry(0.82, 1, 48, 1);
  const dotGeo = new THREE.CircleGeometry(0.22, 24);
  const markColor = 0x8ffff0;
  const mkMat = () => new THREE.MeshBasicMaterial({ color: markColor, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false });

  const ripples = [];
  for (let i = 0; i < RIPPLES; i++) {
    const m = new THREE.Mesh(ringGeo, mkMat());
    m.visible = false; m.renderOrder = 6; m.frustumCulled = false;
    markGroup.add(m);
    ripples.push({ mesh: m, life: 1, dur: 0.75, base: 1 });
  }
  let rippleIdx = 0;
  function spawnRipple(p, base, delay, dur) {
    const r = ripples[rippleIdx]; rippleIdx = (rippleIdx + 1) % RIPPLES;
    r.mesh.position.set(p.x, p.y, -0.05);
    r.life = -delay; r.base = base; r.dur = dur; r.mesh.visible = false;
  }

  const reticle = new THREE.Group();
  const retRing = new THREE.Mesh(ringGeo, mkMat());
  const retDot = new THREE.Mesh(dotGeo, mkMat());
  retRing.renderOrder = 6; retDot.renderOrder = 6;
  retRing.frustumCulled = false; retDot.frustumCulled = false;
  reticle.add(retRing, retDot);
  reticle.visible = false;
  markGroup.add(reticle);
  let retAlpha = 0;

  const arcPos = new Float32Array(ARC_PTS * 3);
  const arcCol = new Float32Array(ARC_PTS * 3);
  const arcGeo = new THREE.BufferGeometry();
  arcGeo.setAttribute('position', new THREE.BufferAttribute(arcPos, 3).setUsage(THREE.DynamicDrawUsage));
  arcGeo.setAttribute('color', new THREE.BufferAttribute(arcCol, 3).setUsage(THREE.DynamicDrawUsage));
  const arcMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const arc = new THREE.Line(arcGeo, arcMat);
  arc.frustumCulled = false; arc.renderOrder = 5; arc.visible = false;
  markGroup.add(arc);
  let arcAlpha = 0;
  const arcRGB = new THREE.Color(markColor);

  // ---------- input ----------
  function setTargetFromScreen() {
    if (pick(sx, sy, hit)) { target.copy(hit); target.z = 0; hasTarget = true; return true; }
    return false;
  }
  function steeringAllowed() { return flow === 'playing' && lastDt > 0 && api.entity && api.entity.alive; }

  dom.addEventListener('contextmenu', (e) => e.preventDefault());
  dom.addEventListener('pointerdown', (e) => {
    if (flow === 'title') {
      if (e.button === 0) { e.preventDefault(); bus.emit('start'); }
      return;
    }
    if (!steeringAllowed()) return;
    if (e.button === 2) { wantDash = true; e.preventDefault(); return; }
    if (e.button !== 0) return;
    e.preventDefault();
    if (e.pointerType === 'touch') {           // touch: double-tap dashes
      if (clock - lastTouchDown < 0.28) wantDash = true;
      lastTouchDown = clock;
    }
    pointerDown = true; pointerId = e.pointerId;
    try { dom.setPointerCapture(e.pointerId); } catch {}
    sx = e.clientX; sy = e.clientY;
    if (setTargetFromScreen()) {
      targetTurned = 0;
      const s = api.entity.size;
      spawnRipple(target, s * 1.1, 0, 0.7);
      spawnRipple(target, s * 0.7, 0.09, 0.6);
      retAlpha = Math.max(retAlpha, 0.4);
      bus.emit('click', { point: target });
    }
  });
  dom.addEventListener('pointermove', (e) => {
    if (!pointerDown || e.pointerId !== pointerId) return;
    sx = e.clientX; sy = e.clientY;
  });
  const endPointer = (e) => {
    if (e.pointerId !== pointerId) return;
    pointerDown = false; pointerId = -1; targetTurned = 0;
    try { dom.releasePointerCapture(e.pointerId); } catch {}
  };
  dom.addEventListener('pointerup', endPointer);
  dom.addEventListener('pointercancel', endPointer);

  const KEYMAP = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
    KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right' };
  window.addEventListener('keydown', (e) => {
    if (flow === 'title') {
      if (e.code === 'Enter' || e.code === 'Space' || e.code === 'NumpadEnter') { e.preventDefault(); bus.emit('start'); }
      return;
    }
    const k = KEYMAP[e.code];
    if (k) { keys[k] = true; hasTarget = false; e.preventDefault(); return; }
    if ((e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') && !e.repeat) {
      e.preventDefault();
      if (steeringAllowed()) wantDash = true;
    }
  });
  window.addEventListener('keyup', (e) => { const k = KEYMAP[e.code]; if (k) keys[k] = false; });
  window.addEventListener('blur', () => { keys.up = keys.down = keys.left = keys.right = false; pointerDown = false; });

  bus.on('start', () => { flow = 'playing'; startGuard = 0.25; });
  bus.on('restart', () => { flow = 'playing'; startGuard = 0.25; });
  bus.on('continue', () => { flow = 'playing'; });
  bus.on('playerDeath', () => { flow = 'dead'; pointerDown = false; hasTarget = false; });
  bus.on('victory', () => { flow = 'victory'; pointerDown = false; });
  bus.on('rebase', ({ dx = 0, dy = 0 } = {}) => {
    target.x -= dx; target.y -= dy;
    for (let i = 0; i < RIPPLES; i++) { const m = ripples[i].mesh; m.position.x -= dx; m.position.y -= dy; }
    reticle.position.x -= dx; reticle.position.y -= dy;
    for (let i = 0; i < ARC_PTS; i++) { arcPos[i * 3] -= dx; arcPos[i * 3 + 1] -= dy; }
    arcGeo.attributes.position.needsUpdate = true;
  });

  // ---------- lifecycle ----------
  function reset() {
    const e = makeFish('hero', 1, WORLD.spawn.x, WORLD.spawn.y, 0);
    e.isPlayer = true;
    e.mass = P.startMass;
    e.size = Math.sqrt(e.mass);
    api.entity = e;
    desired = e.heading;
    hasTarget = false; pointerDown = false; targetTurned = 0;
    dashT = 99; dashCd = 0; wantDash = false; api.dashCooldown01 = 1;
    turnRateSm = 0; retAlpha = 0; arcAlpha = 0; impactCd = 0;
    e.vel.set(Math.cos(e.heading), Math.sin(e.heading), 0).multiplyScalar(playerSpeed(e.size) * 0.6);
  }

  // Simulate the turn the fish will take toward the target and write it into the arc line.
  function buildArc(e, turn, speed) {
    let x = e.pos.x, y = e.pos.y, h = e.heading;
    const diff0 = Math.abs(wrapAngle(Math.atan2(target.y - y, target.x - x) - h));
    const horizon = Math.min(2.2, diff0 / turn + 0.35);
    const step = horizon / (ARC_PTS - 1);
    const arrive = e.size * 1.5;
    let n = 0;
    for (let i = 0; i < ARC_PTS; i++) {
      arcPos[i * 3] = x; arcPos[i * 3 + 1] = y; arcPos[i * 3 + 2] = -0.05;
      const fade = 1 - i / (ARC_PTS - 1);
      const f = fade * fade;
      arcCol[i * 3] = arcRGB.r * f; arcCol[i * 3 + 1] = arcRGB.g * f; arcCol[i * 3 + 2] = arcRGB.b * f;
      n = i + 1;
      const dx = target.x - x, dy = target.y - y;
      if (dx * dx + dy * dy < arrive * arrive) break;
      h = turnToward(h, Math.atan2(dy, dx), turn * step);
      x += Math.cos(h) * speed * step; y += Math.sin(h) * speed * step;
    }
    arcGeo.setDrawRange(0, n);
    arcGeo.attributes.position.needsUpdate = true;
    arcGeo.attributes.color.needsUpdate = true;
    return diff0;
  }

  // Ice-escape wall response: deflect heading toward the wall tangent closest to the current heading.
  function wallSlide(e, dt, turn, baseSpeed) {
    const nx = e.lastWallNx, ny = e.lastWallNy;
    if (nx === undefined) return;
    const fx = Math.cos(e.heading), fy = Math.sin(e.heading);
    const into = -(fx * nx + fy * ny);
    if (into <= 0.02) return;
    // tangent candidates: (-ny, nx) and (ny, -nx); pick the one closer to current heading (or desired if head-on)
    let tx = -ny, ty = nx;
    let side = fx * tx + fy * ty;
    if (Math.abs(side) < 0.15) side = Math.cos(desired) * tx + Math.sin(desired) * ty || 1;
    if (side < 0) { tx = -tx; ty = -ty; }
    const tang = Math.atan2(ty, tx);
    const hard = e.wallHit > 0.4 && impactCd <= 0;
    // Steer along the wall faster than the normal cap so contact never feels sticky.
    const rate = turn * 1.6 + into * 6;
    e.heading = wrapAngle(turnToward(e.heading, tang, (hard ? 0.6 * into * Math.PI : 0) + rate * dt));
    // Keep some momentum along the tangent (slide, don't stop).
    const vt = e.vel.x * tx + e.vel.y * ty;
    const minSlide = baseSpeed * 0.35;
    if (vt < minSlide) { e.vel.x += tx * (minSlide - vt); e.vel.y += ty * (minSlide - vt); }
    if (hard) {
      impactCd = 0.35;
      e.vel.multiplyScalar(0.8);
      bus.emit('shake', { amount: Math.min(0.6, 0.15 + e.wallHit * 0.35) });
    }
  }

  function update(dt, t, { active }) {
    lastDt = dt;
    clock += dt;
    const e = api.entity;
    if (!e) return;
    if (startGuard > 0) startGuard -= dt;
    if (impactCd > 0) impactCd -= dt;
    e.age += dt;
    e.invuln = Math.max(0, e.invuln - dt);
    e.gulp = Math.max(0, e.gulp - dt * 2.5);
    e.wallHit = Math.max(0, (e.wallHit || 0) - dt * 4);

    const size = e.size;
    const turn = playerTurn(size);
    const baseSpeed = playerSpeed(size);
    let turnRate = 0;

    if (active && e.alive && dt > 0) {
      // --- desired heading ---
      const kx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
      const ky = (keys.up ? 1 : 0) - (keys.down ? 1 : 0);
      if (kx || ky) {
        desired = Math.atan2(ky, kx);
        hasTarget = false;
      } else {
        if (pointerDown) setTargetFromScreen();   // camera moves → re-pick under the held pointer
        if (hasTarget) {
          const dx = target.x - e.pos.x, dy = target.y - e.pos.y;
          const d2 = dx * dx + dy * dy;
          const arrive = size * 1.5;
          if (pointerDown) {
            if (d2 > size * size * 0.5) desired = Math.atan2(dy, dx);
          } else if (d2 < arrive * arrive || targetTurned > TAU * 0.95) {
            hasTarget = false;              // arrived (or orbiting a point inside the turn circle): glide on
            desired = e.heading;
          } else {
            desired = Math.atan2(dy, dx);
          }
        } else {
          desired = e.heading;
        }
      }

      dashCd = Math.max(0, dashCd - dt);
      const prevH = e.heading;

      {
        // --- rotate (capped; dash does not help turning) ---
        e.heading = wrapAngle(turnToward(e.heading, desired, turn * dt));
        // --- dash ---
        if (wantDash && dashCd <= 0 && startGuard <= 0) {
          dashT = 0; dashCd = P.dashCooldown;
          const fx = Math.cos(e.heading), fy = Math.sin(e.heading);
          e.vel.x += fx * baseSpeed * (P.dashSpeedMul - 1) * 0.55;   // immediate pop
          e.vel.y += fy * baseSpeed * (P.dashSpeedMul - 1) * 0.55;
          bus.emit('dash', { pos: e.pos, heading: e.heading });
        }
        wantDash = false;
        let mul = 1;
        if (dashT < P.dashTime) {
          dashT += dt;
          const p = Math.min(1, dashT / P.dashTime);
          mul = 1 + (P.dashSpeedMul - 1) * (1 - p) * (1 - p);   // ease-out burst
        }
        // --- velocity slides toward forward*speed ---
        const sp = baseSpeed * mul;
        const k = 1 - Math.exp(-P.drift * dt);
        e.vel.x += (Math.cos(e.heading) * sp - e.vel.x) * k;
        e.vel.y += (Math.sin(e.heading) * sp - e.vel.y) * k;
      }
      e.vel.z = 0;
      e.pos.x += e.vel.x * dt;
      e.pos.y += e.vel.y * dt;

      // --- terrain ---
      if (terrain && terrain.collide(e, size * 0.85)) wallSlide(e, dt, turn, baseSpeed);

      const dh = wrapAngle(e.heading - prevH);
      turnRate = dh / dt;
      if (hasTarget && !pointerDown) targetTurned += Math.abs(dh);
    } else {
      wantDash = false;
      if (flow === 'victory' && e.alive && dt > 0) {
        // Cosmetic glide while the victory screen is up.
        const k = 1 - Math.exp(-1.5 * dt), sp = baseSpeed * 0.45;
        e.vel.x += (Math.cos(e.heading) * sp - e.vel.x) * k;
        e.vel.y += (Math.sin(e.heading) * sp - e.vel.y) * k;
        e.pos.x += e.vel.x * dt; e.pos.y += e.vel.y * dt;
        if (terrain && terrain.collide(e, size * 0.85)) wallSlide(e, dt, turn, baseSpeed);
      }
      if (flow === 'title') e.vel.set(0, 0, 0);
    }
    e.pos.z = 0;

    api.dashCooldown01 = 1 - dashCd / P.dashCooldown;

    // ---------- cosmetics ----------
    if (dt > 0) {
      const ks = 1 - Math.exp(-8 * dt);
      turnRateSm += (turnRate - turnRateSm) * ks;
      const turn01 = Math.max(-1, Math.min(1, turnRateSm / turn));
      // Small roll into the turn (renderer handles the left/right 180° flip itself).
      e.bank += (turn01 * 0.25 - e.bank) * ks;
      const dashing = dashT < P.dashTime ? 1 - dashT / P.dashTime : 0;
      const targetRate = 1 + Math.abs(turn01) * 0.8 + dashing * 2.2;
      e.swimRate += (targetRate - e.swimRate) * (1 - Math.exp(-6 * dt));
    }

    updateMarkers(dt, e, turn, baseSpeed);
  }

  function updateMarkers(dt, e, turn, speed) {
    const s = e.size;
    for (let i = 0; i < RIPPLES; i++) {
      const r = ripples[i];
      if (r.life >= 1) { r.mesh.visible = false; continue; }
      r.life += dt / r.dur;
      if (r.life < 0) continue;
      const p = Math.min(1, r.life);
      const pop = 1 - Math.pow(1 - p, 3);
      const sc = r.base * (0.25 + 1.35 * pop);
      r.mesh.scale.set(sc, sc, sc);
      r.mesh.material.opacity = 0.85 * (1 - p) * (1 - p) * Math.min(1, p * 8);
      r.mesh.visible = p < 1;
    }
    const show = hasTarget && flow === 'playing' && e.alive;
    retAlpha += ((show ? 1 : 0) - retAlpha) * (1 - Math.exp(-(show ? 10 : 6) * dt));
    reticle.visible = retAlpha > 0.01;
    if (reticle.visible) {
      if (show) reticle.position.set(target.x, target.y, -0.05);
      const pulse = 1 + Math.sin(clock * 6) * 0.08;
      const sc = s * 0.55 * pulse * (0.7 + 0.3 * retAlpha);
      reticle.scale.set(sc, sc, sc);
      retRing.material.opacity = 0.55 * retAlpha;
      retDot.material.opacity = 0.7 * retAlpha;
    }
    let want = 0;
    if (show && dt > 0) {
      const diff = buildArc(e, turn, speed);
      want = Math.min(1, Math.max(0, (diff - 0.12) / 0.6)) * 0.55;
    }
    arcAlpha += (want - arcAlpha) * (1 - Math.exp(-8 * dt));
    arc.visible = arcAlpha > 0.01;
    arcMat.opacity = arcAlpha;
  }

  reset();
  return api;
}
