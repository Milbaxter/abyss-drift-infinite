// Abyss Drift — procedural WebAudio, SFX ONLY (v4, infinite sea). No music, no ambient bed, nothing pitched/musical.
// Silence underneath; every sound is a short one-shot (filtered noise / low thumps) that stops and disconnects itself.
// createAudio({bus}) -> { update(dt, state, player, eco) }
import { BIOMES, WORLD, biomeWeightsAt } from './config.js';

const MUTE_KEY = 'abyss-muted';
const MAX_VOICES = 40;
const NB = BIOMES.length;
const DARK = [0, 0.1, 0.3, 0.6, 0.2, 0.7, 1]; // per region: muffles the bite a little in dark regions

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const fin = (v, fb) => (Number.isFinite(v) ? v : fb);
const hz = (v, fb = 440) => clamp(fin(v, fb), 1, 22000);

export function createAudio({ bus }) {
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch {}

  let muteGain, master, pauseFilter, comp, sfxBus, duckGain, revIn;
  const echoIn = null; // no echo bus in the SFX-only mix
  let noiseBuf;
  let voices = 0;

  let player = null, lastState = null;
  const wRaw = new Array(NB).fill(0);
  const ws = new Array(NB).fill(0); ws[0] = 1;
  let combo = 0, lastEatT = -10;
  const lastPlayed = {};
  let wasPaused = false;

  // ---------------- setup ----------------
  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch { return; }

    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 4;
    comp.attack.value = 0.004; comp.release.value = 0.2;
    muteGain = ctx.createGain(); muteGain.gain.value = muted ? 0 : 1;
    pauseFilter = ctx.createBiquadFilter(); pauseFilter.type = 'lowpass'; pauseFilter.frequency.value = 18000; pauseFilter.Q.value = 0.5;
    master = ctx.createGain(); master.gain.value = 0.75;
    master.connect(pauseFilter); pauseFilter.connect(comp); comp.connect(muteGain); muteGain.connect(ctx.destination);
    duckGain = ctx.createGain(); duckGain.connect(master);
    sfxBus = ctx.createGain(); sfxBus.connect(duckGain);

    // short dark room for SFX tails (procedural IR); idle = silent
    const conv = ctx.createConvolver();
    conv.buffer = makeIR(1.8, 3);
    revIn = ctx.createGain(); revIn.gain.value = 0.8;
    const revOut = ctx.createGain(); revOut.gain.value = 0.6;
    revIn.connect(conv); conv.connect(revOut); revOut.connect(duckGain);

    const len = ctx.sampleRate * 4;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const w = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) w[i] = Math.random() * 2 - 1;
  }

  function makeIR(dur, decay) {
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        lp += (Math.random() * 2 - 1 - lp) * (0.5 - 0.35 * t);
        d[i] = lp * Math.pow(1 - t, decay);
      }
    }
    return buf;
  }

  // ---------------- voice helpers ----------------
  function canPlay(prio = 0) { return ctx && ctx.state === 'running' && voices < MAX_VOICES + prio * 16; }
  function now0(t) { return Math.max(fin(t, ctx.currentTime), ctx.currentTime); }
  function setT(param, v, t, tc) { if (Number.isFinite(v)) param.setTargetAtTime(v, t, tc); }
  function wsum(tab) { let s = 0; for (let i = 0; i < NB; i++) s += tab[i] * ws[i]; return s; }

  function finish(sources, nodes, stopAt) {
    voices++;
    let left = sources.length;
    for (const s of sources) {
      s.stop(stopAt);
      s.onended = () => {
        if (--left > 0) return;
        voices--;
        for (const n of sources) n.disconnect();
        for (const n of nodes) n.disconnect();
      };
    }
  }
  function outChain(vol, pan, dest, rev, echo) {
    const g = ctx.createGain(); g.gain.value = 0;
    const p = ctx.createStereoPanner(); p.pan.value = clamp(fin(pan, 0), -1, 1);
    g.connect(p); p.connect(dest || sfxBus);
    const nodes = [g, p];
    if (rev) { const s = ctx.createGain(); s.gain.value = fin(rev, 0); p.connect(s); s.connect(revIn); nodes.push(s); }
    if (echo && echoIn) { const s = ctx.createGain(); s.gain.value = fin(echo, 0); p.connect(s); s.connect(echoIn); nodes.push(s); }
    return { g, nodes };
  }
  function envAD(param, t, a, peak, d) {
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(clamp(fin(peak, 0.0002), 0.0002, 2), t + Math.max(0.001, a));
    param.exponentialRampToValueAtTime(0.0001, t + Math.max(0.001, a) + Math.max(0.005, d));
  }
  function tone({ t, type = 'sine', f, f2, glide = 0.1, a = 0.004, d = 0.3, vol = 0.1, pan = 0, rev = 0, echo = 0, dest, lp, prio = 0 }) {
    if (!canPlay(prio)) return;
    vol = fin(vol, 0); if (vol <= 0) return;
    t = now0(t); a = fin(a, 0.004); d = fin(d, 0.3); glide = Math.max(0.005, fin(glide, 0.1));
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(hz(f), t);
    if (f2) o.frequency.exponentialRampToValueAtTime(hz(f2, f), t + glide);
    const { g, nodes } = outChain(vol, pan, dest, rev, echo);
    if (lp) { const fl = ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = hz(lp, 1000); o.connect(fl); fl.connect(g); nodes.push(fl); }
    else o.connect(g);
    envAD(g.gain, t, a, vol, d);
    o.start(t);
    finish([o], nodes, t + a + d + 0.05);
  }
  function noise({ t, dur = 0.3, a = 0.01, vol = 0.1, type = 'bandpass', f = 1000, f2, f3, q = 1, pan = 0, rev = 0, dest, prio = 0, curve }) {
    if (!canPlay(prio)) return;
    vol = fin(vol, 0); if (vol <= 0) return;
    t = now0(t); dur = Math.max(0.02, fin(dur, 0.3)); a = clamp(fin(a, 0.01), 0.001, dur * 0.9);
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const fl = ctx.createBiquadFilter(); fl.type = type; fl.Q.value = fin(q, 1);
    fl.frequency.setValueAtTime(hz(f, 1000), t);
    if (f2 && f3) { fl.frequency.exponentialRampToValueAtTime(hz(f2, f), t + dur * 0.45); fl.frequency.exponentialRampToValueAtTime(hz(f3, f), t + dur); }
    else if (f2) fl.frequency.exponentialRampToValueAtTime(hz(f2, f), t + dur);
    const { g, nodes } = outChain(vol, pan, dest, rev);
    s.connect(fl); fl.connect(g); nodes.push(fl);
    if (curve) g.gain.setValueCurveAtTime(curve.map((x) => x * vol), t, dur);
    else envAD(g.gain, t, a, vol, Math.max(0.01, dur - a));
    s.start(t, rand(0, 3.4));
    finish([s], nodes, t + dur + 0.05);
  }
  function panFor(pos) {
    if (!pos || !player) return 0;
    return clamp(fin((pos.x - player.pos.x) / (28 + player.size * 7), 0), -0.85, 0.85);
  }
  function limit(name, gap) {
    const n = ctx.currentTime;
    if (lastPlayed[name] && n - lastPlayed[name] < gap) return false;
    lastPlayed[name] = n; return true;
  }
  function crackle(t, dur, n, vol, f, pan, dest, rev, prio) {
    if (!canPlay(prio) || n <= 0 || !(vol > 0)) return;
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = hz(f, 2500); bp.Q.value = 2.2;
    const sh = ctx.createWaveShaper(); sh.curve = distCurve(6);
    const { g, nodes } = outChain(vol, pan, dest, rev);
    s.connect(bp); bp.connect(sh); sh.connect(g); nodes.push(bp, sh);
    const times = [];
    for (let i = 0; i < n; i++) times.push(t + Math.random() * dur);
    times.sort((x, y) => x - y);
    let last = t;
    g.gain.setValueAtTime(0, t);
    for (const ti of times) {
      const st = Math.max(ti, last + 0.004);
      g.gain.setValueAtTime(0, st);
      g.gain.linearRampToValueAtTime(vol * rand(0.35, 1), st + 0.0015);
      last = st + rand(0.005, 0.016);
      g.gain.linearRampToValueAtTime(0, last);
    }
    s.start(t, rand(0, 3.3));
    finish([s], nodes, last + 0.05);
  }
  function squelch(t, dur, vol, df, pan, dest, mf, rev, prio) {
    if (!canPlay(prio) || !(vol > 0)) return;
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = rand(4, 7);
    bp.frequency.setValueAtTime(hz(1100 * df * rand(0.85, 1.2), 1000), t);
    bp.frequency.exponentialRampToValueAtTime(hz(230 * df * rand(0.85, 1.15), 230), t + dur);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = hz(mf, 2000);
    const { g, nodes } = outChain(vol, pan, dest, rev);
    s.connect(bp); bp.connect(lp); lp.connect(g); nodes.push(bp, lp);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(vol * 0.5, t + dur * 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    // gurgle: fast wobble on the level
    const gur = ctx.createOscillator(); gur.type = 'triangle'; gur.frequency.setValueAtTime(rand(16, 28), t);
    gur.frequency.linearRampToValueAtTime(rand(8, 14), t + dur);
    const gg = ctx.createGain(); gg.gain.value = vol * 0.4; gur.connect(gg); gg.connect(g.gain); nodes.push(gg);
    s.start(t, rand(0, 3.3)); gur.start(t);
    finish([s, gur], nodes, t + dur + 0.03);
  }
  function bite({ t, heft = 0.3, df = 1, vol = 0.3, pan = 0, dest = sfxBus, mf = 2600, rev = 0.15, prio = 1 }) {
    if (!ctx) return;
    t = now0(t); heft = clamp(fin(heft, 0.3), 0, 1); df = clamp(fin(df, 1), 0.25, 1.4); vol = fin(vol, 0);
    if (vol <= 0) return;
    const r = () => rand(0.88, 1.12);
    // click + jaw snap
    noise({ t, dur: 0.012, a: 0.0008, vol: vol * 0.55, type: 'highpass', f: Math.min(mf * 1.4, 3200 * df * r()), q: 0.7, pan, dest, prio });
    noise({ t: t + 0.002, dur: 0.035 + 0.045 * heft, a: 0.001, vol: vol * (0.75 + 0.45 * heft), type: 'bandpass',
      f: Math.min(mf, 1700 * df * r()), f2: 520 * df * r(), q: 1.3, pan, dest, rev, prio });
    // bone crackle for bigger meals
    if (heft > 0.28) crackle(t + 0.012, 0.05 + 0.24 * heft, Math.round(3 + 11 * heft * r()), vol * 0.42 * heft,
      Math.min(mf * 1.2, 2700 * df * r()), pan, dest, rev, prio);
    // fleshy body + wet gulp
    tone({ t: t + 0.015, f: 165 * df * r(), f2: 48 * df, glide: 0.08 + 0.25 * heft, a: 0.004, d: 0.09 + 0.3 * heft,
      vol: vol * (0.45 + 0.45 * heft), lp: Math.min(mf, 380), pan, dest, prio });
    squelch(t + 0.03 + 0.03 * heft * r(), 0.11 + 0.42 * heft * r(), vol * (0.4 + 0.35 * heft), df, pan, dest, mf * 0.8, rev + 0.1, prio);
    // big meals: a second chew
    if (heft > 0.6) {
      const t2 = t + rand(0.17, 0.24);
      noise({ t: t2, dur: 0.05, a: 0.001, vol: vol * 0.5, type: 'bandpass', f: Math.min(mf, 1300 * df * r()), f2: 450 * df, q: 1.4, pan, dest, rev, prio });
      crackle(t2 + 0.008, 0.12, Math.round(4 + 5 * heft), vol * 0.32, Math.min(mf, 2300 * df * r()), pan, dest, rev, prio);
    }
  }
  function onPlayerAte({ eaten, pos } = {}) {
    if (!ctx) return;
    const t = ctx.currentTime + 0.004;
    const size = clamp(fin(player && player.size, 1), 0.2, 100);
    const ratio = clamp(fin(eaten && eaten.size / size, 0.4), 0.05, 1);
    const heft = clamp((ratio - 0.12) / 0.7, 0, 1);
    const df = rand(0.92, 1.08) / Math.pow(size, 0.28);
    const pan = panFor(pos || (eaten && eaten.pos)) * 0.6;
    combo = (t - lastEatT < 2) ? Math.min(combo + 1, 14) : 0;
    lastEatT = t;
    bite({ t, heft, df, vol: 0.42 + 0.16 * heft, pan, mf: 2400 + 800 * (1 - wsum(DARK)), rev: 0.15, prio: 2 });
    // just the bite: no musical reward note / bubble blips (playtest feedback)
  }
  function onEat({ eater, eaten } = {}) {
    if (!ctx || !player || !eater || !eaten || eater.isPlayer || eaten.isPlayer || !eaten.pos) return;
    if (!lastState || lastState.mode === 'title') return;
    const d = Math.hypot(eaten.pos.x - player.pos.x, eaten.pos.y - player.pos.y);
    const range = 45 + fin(player.size, 1) * 9;
    if (!Number.isFinite(d) || d > range || !limit('npcEat', 0.22)) return;
    const k = 1 - d / range;
    const es = Math.max(fin(eater.size, 1), 0.2);
    const heft = clamp((fin(eaten.size / es, 0.4) - 0.12) / 0.7, 0, 1);
    bite({ t: ctx.currentTime, heft, df: rand(0.9, 1.1) / Math.pow(es, 0.28), vol: 0.03 + 0.11 * k * k, pan: panFor(eaten.pos),
      mf: 700 + 900 * k, rev: 0.55, prio: 0 });
  }
  function crunch(t, vol) {
    if (!canPlay(3)) return;
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const fl = ctx.createBiquadFilter(); fl.type = 'bandpass'; fl.frequency.setValueAtTime(1400, t); fl.frequency.exponentialRampToValueAtTime(200, t + 0.35); fl.Q.value = 1.2;
    const ws_ = ctx.createWaveShaper(); ws_.curve = distCurve(30);
    const { g, nodes } = outChain(vol, 0, sfxBus, 0.5);
    s.connect(fl); fl.connect(ws_); ws_.connect(g); nodes.push(fl, ws_);
    envAD(g.gain, t, 0.004, vol, 0.4);
    s.start(t, rand(0, 3)); finish([s], nodes, t + 0.5);
  }
  function distCurve(k) {
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; c[i] = ((1 + k) * x) / (1 + k * Math.abs(x)); }
    return c;
  }
  function setMuted(m) {
    muted = !!m;
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch {}
    if (ctx) muteGain.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.05);
    bus.emit('muteChanged', { muted });
  }
  // ---------------- non-musical building blocks ----------------
  // Low pitch-drop thump (sub-ish body, no sustained pitch).
  function thump(t, vol, f = 62, d = 0.26, prio = 1) {
    tone({ t, f, f2: f * 0.5, glide: d * 0.5, a: 0.004, d, vol, lp: 220, prio });
  }
  // Whoosh: band-passed noise sweep.
  function whoosh(t, dur, vol, f1, f2, f3, q = 1.4, pan = 0, rev = 0.25, prio = 1) {
    noise({ t, dur, a: Math.min(0.06, dur * 0.25), vol, f: f1, f2, f3, q, pan, rev, prio });
  }
  // Whoomph: deep thump + low-passed noise bloom.
  function whoomph(t, vol, size = 1) {
    thump(t, vol, 70 / Math.sqrt(size), 0.5 + 0.4 * size, 2);
    noise({ t, dur: 0.5 + 0.5 * size, a: 0.01, vol: vol * 0.5, type: 'lowpass', f: 900, f2: 90, q: 0.8, rev: 0.5, prio: 2 });
  }
  // Bubbly swell: a burst of short, rising high-Q noise grains (watery, not tonal) under a rising noise bed.
  function bubbleSwell(t, dur, vol, n = 10) {
    noise({ t, dur, vol: vol * 0.6, type: 'bandpass', f: 300, f2: 1600, q: 0.9, rev: 0.4, prio: 1,
      curve: new Float32Array([0.0001, 0.3, 0.7, 1, 0.6, 0.0001]) });
    for (let i = 0; i < n; i++) {
      const tt = t + Math.random() * dur * 0.8, f = rand(500, 1400);
      noise({ t: tt, dur: rand(0.03, 0.06), a: 0.003, vol: vol * rand(0.4, 0.9), type: 'bandpass', f, f2: f * rand(1.6, 2.4), q: 9, pan: rand(-0.6, 0.6), rev: 0.2 });
    }
  }

  // ---------------- SFX ----------------
  function onDash() {
    if (!ctx) return;
    const t = ctx.currentTime;
    const pan = player ? clamp(fin(Math.cos(player.heading) * 0.4, 0), -0.5, 0.5) : 0;
    whoosh(t, 0.42, 0.6, 280, 2600, 500, 1.0, pan, 0.3, 1);
    noise({ t, dur: 0.3, a: 0.015, vol: 0.25, type: 'lowpass', f: 500, f2: 120, q: 0.7, prio: 1 });
  }

  function onClick() {
    if (!ctx || !limit('click', 0.12)) return;
    noise({ t: ctx.currentTime, dur: 0.018, a: 0.001, vol: 0.02, type: 'highpass', f: 3000, q: 0.7 });
  }

  // grow + evolve fire together: one soft whoomph + bubbly swell (grow alone falls back to the same).
  let pendingGrow = null;
  function onGrow({ tier = 1 } = {}) {
    pendingGrow = fin(tier, 1);
    setTimeout(() => { if (pendingGrow !== null) { const tr = pendingGrow; pendingGrow = null; evolveSound(tr); } }, 0);
  }
  function onEvolve({ tier = 1 } = {}) { pendingGrow = null; evolveSound(tier); }
  function evolveSound(tier) {
    if (!ctx || !limit('evolve', 0.5)) return;
    const g = clamp(fin(tier, 1), 1, 6) / 6;
    const t = ctx.currentTime + 0.02;
    bubbleSwell(t, 0.7 + 0.3 * g, 0.07 + 0.03 * g, 8 + Math.round(6 * g));
    whoomph(t + 0.45 + 0.2 * g, 0.38 + 0.12 * g, 1 + g);
  }

  function onNearMiss({ fish } = {}) {
    if (!ctx || !limit('nearMiss', 0.4)) return;
    const t = ctx.currentTime;
    whoosh(t, 0.24, 0.24, 500, 3800, 900, 3, fish ? panFor(fish.pos) : 0, 0.2, 2);
    thump(t + 0.1, 0.4, 66);
  }

  // Eaten: the attacker's bite from inside its mouth — huge jaw clamp, crunch, muffled dark thud.
  function onDeath({ killer } = {}) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const ks = clamp(fin(killer && killer.size, fin(player && player.size, 1) * 2), 0.3, 100);
    const df = rand(0.9, 1.05) / Math.pow(ks, 0.28);
    noise({ t, dur: 0.09, a: 0.001, vol: 0.4, type: 'lowpass', f: 1600, f2: 250, q: 1.1, prio: 3 });
    noise({ t, dur: 0.015, a: 0.0008, vol: 0.25, type: 'highpass', f: 2200, q: 0.7, prio: 3 });
    bite({ t: t + 0.01, heft: 1, df, vol: 0.42, mf: 1500, rev: 0.35, prio: 3 });
    crunch(t + 0.03, 0.2);
    crackle(t + 0.05, 0.3, 14, 0.14, 1900 * df, 0, sfxBus, 0.3, 3);
    thump(t + 0.02, 0.55, 85, 1.1, 3);
    duckGain.gain.cancelScheduledValues(t);
    duckGain.gain.setTargetAtTime(0.5, t + 0.5, 0.2);
    duckGain.gain.setTargetAtTime(1, t + 1.6, 0.6);
  }

  // Apex reached mid-sea: big whoomph + rising noise swell. No notes.
  function onVictory() {
    if (!ctx) return;
    const t = ctx.currentTime + 0.03;
    noise({ t, dur: 1.4, vol: 0.12, type: 'bandpass', f: 200, f2: 3000, f3: 800, q: 0.8, rev: 0.6, prio: 3,
      curve: new Float32Array([0.0001, 0.2, 0.5, 0.85, 1, 0.5, 0.0001]) });
    bubbleSwell(t + 0.2, 1.0, 0.08, 14);
    whoomph(t + 1.0, 0.55, 2.2);
    whoosh(t + 1.0, 0.6, 0.12, 2500, 900, 300, 0.8, 0, 0.5, 3);
  }

  // ---- formation waves ----
  function onWaveWarn({ time } = {}) {
    init();
    if (!ctx || !limit('waveWarn', 0.8)) return;
    const t = ctx.currentTime + 0.02;
    const lead = clamp(fin(time, 1.8), 0.8, 4);
    // three accelerating low thump+whoosh hits
    [0, 0.5, 0.82].forEach((x, i) => {
      const tt = t + x * lead / 1.8;
      thump(tt, 0.3 + 0.08 * i, 60, 0.22, 2);
      noise({ t: tt, dur: 0.16, a: 0.005, vol: 0.09 + 0.03 * i, type: 'bandpass', f: 250, f2: 900, q: 1.2, prio: 2 });
    });
    // short rising noise swell into the arrival
    noise({ t: t + lead * 0.45, dur: lead * 0.6, vol: 0.1, type: 'bandpass', f: 200, f2: 2400, q: 1.0, rev: 0.3, prio: 2,
      curve: new Float32Array([0.0001, 0.25, 0.55, 0.85, 1, 0.0001]) });
  }
  function onWaveEnd({ cleared } = {}) {
    if (!ctx || !cleared || !limit('waveClear', 0.5)) return;
    const t = ctx.currentTime + 0.02;
    whoosh(t, 0.35, 0.16, 400, 4200, 1800, 1.3, 0, 0.3, 2);
    // the "pop": a tight low-mid noise burst + small thump at the end of the whoosh
    noise({ t: t + 0.3, dur: 0.06, a: 0.001, vol: 0.2, type: 'bandpass', f: 900, f2: 300, q: 1.5, prio: 2 });
    thump(t + 0.3, 0.25, 90, 0.16, 2);
  }

  // ---- bosses ----
  function onBossEngage() {
    init();
    if (!ctx || !limit('bossEngage', 1)) return;
    const t = ctx.currentTime + 0.02;
    thump(t, 0.6, 58, 0.9, 3);
    noise({ t, dur: 1.2, a: 0.004, vol: 0.18, type: 'lowpass', f: 700, f2: 60, q: 1.2, rev: 0.6, prio: 3 });
    crunch(t, 0.08);
  }
  function onBossHit({ pos } = {}) {
    if (!ctx || !limit('bossHit', 0.08)) return;
    const t = ctx.currentTime, pan = panFor(pos);
    tone({ t, f: 110, f2: 40, glide: 0.2, a: 0.003, d: 0.35, vol: 0.5, lp: 350, pan, prio: 3 });
    crunch(t, 0.14);
    noise({ t, dur: 0.12, a: 0.002, vol: 0.16, type: 'lowpass', f: 1800, f2: 300, pan, prio: 3 });
  }
  function onBossDefeated() {
    if (!ctx) return;
    const t = ctx.currentTime + 0.02;
    bite({ t, heft: 1, df: 0.55, vol: 0.45, mf: 2000, rev: 0.4, prio: 3 });
    crunch(t + 0.04, 0.22);
    crackle(t + 0.06, 0.35, 16, 0.15, 1700, 0, sfxBus, 0.3, 3);
    whoomph(t + 0.25, 0.55, 2);
    bubbleSwell(t + 0.3, 0.9, 0.06, 12);
  }
  function onInk({ pos } = {}) {
    if (!ctx || !limit('ink', 0.3)) return;
    const t = ctx.currentTime, pan = panFor(pos);
    noise({ t, dur: 0.8, a: 0.04, vol: 0.18, type: 'lowpass', f: 900, f2: 150, q: 5, pan, rev: 0.5, prio: 2 });
    thump(t, 0.25, 120, 0.4, 2);
    for (let i = 0; i < 4; i++) {
      const f = rand(200, 380);
      noise({ t: t + 0.08 + i * rand(0.07, 0.14), dur: 0.08, a: 0.004, vol: 0.06, type: 'bandpass', f, f2: f * 1.8, q: 7, pan: pan + rand(-0.2, 0.2) });
    }
  }

  // ---------------- wiring ----------------
  const gesture = () => init();
  window.addEventListener('pointerdown', gesture, true);
  window.addEventListener('touchstart', gesture, true);
  window.addEventListener('keydown', (e) => {
    init();
    if (e.code === 'KeyM' && !e.repeat && !(e.target && /INPUT|TEXTAREA/.test(e.target.tagName))) setMuted(!muted);
  }, true);
  bus.on('start', init);
  bus.on('restart', init);
  bus.on('toggleMute', () => setMuted(!muted));
  bus.on('playerAte', onPlayerAte);
  bus.on('eat', onEat);
  bus.on('dash', onDash);
  bus.on('click', onClick);
  bus.on('grow', onGrow);
  bus.on('evolve', onEvolve);
  bus.on('nearMiss', onNearMiss);
  bus.on('playerDeath', onDeath);
  bus.on('victory', onVictory);
  bus.on('bossEngage', onBossEngage);
  bus.on('bossHit', onBossHit);
  bus.on('bossDefeated', onBossDefeated);
  bus.on('ink', onInk);
  bus.on('waveWarn', onWaveWarn);
  bus.on('waveEnd', onWaveEnd);

  bus.emit('muteChanged', { muted });
  setTimeout(() => bus.emit('muteChanged', { muted }), 0);

  // ---------------- per-frame (no continuous sound; just bookkeeping) ----------------
  function update(dt, state, p) {
    player = p; lastState = state;
    if (!ctx || ctx.state !== 'running') return;
    dt = clamp(fin(dt, 0.016), 0, 0.1);
    const now = ctx.currentTime;

    // region weights (absolute coords) only to darken the bite slightly in dark regions
    if (p && p.pos) {
      const ox = fin(WORLD.origin && WORLD.origin.x, 0), oy = fin(WORLD.origin && WORLD.origin.y, 0);
      biomeWeightsAt(fin(p.pos.x, 0) + ox, fin(p.pos.y, 0) + oy, wRaw);
      const k = 1 - Math.exp(-dt / 1.8);
      for (let i = 0; i < NB; i++) ws[i] += (fin(wRaw[i], 0) - ws[i]) * k;
    }

    if (state.paused !== wasPaused) {
      wasPaused = state.paused;
      setT(pauseFilter.frequency, wasPaused ? 650 : 18000, now, 0.12);
      setT(master.gain, wasPaused ? 0.4 : 0.75, now, 0.15);
    }
    if (state.paused || state.mode !== 'playing') { if (now - lastEatT > 2) combo = 0; return; }

    // wall bump: soft rock thump
    if (p && p.alive && fin(p.wallHit, 0) > 0.5 && limit('wall', 0.35)) {
      const s = clamp(p.wallHit, 0, 1);
      const sf = 1 / Math.pow(clamp(fin(p.size, 1), 0.2, 100), 0.25);
      tone({ t: now, f: 110 * sf, f2: 50 * sf, glide: 0.08, a: 0.003, d: 0.18, vol: 0.18 * s, lp: 400, prio: 1 });
      noise({ t: now, dur: 0.09, a: 0.002, vol: 0.08 * s, type: 'lowpass', f: 700, f2: 200, q: 1, rev: 0.3 });
    }
  }

  return { update };
}
