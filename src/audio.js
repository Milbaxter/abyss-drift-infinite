// Abyss Drift — procedural WebAudio (v4, infinite sea). No samples: everything is synthesized.
// createAudio({bus}) -> { update(dt, state, player, eco) }
import { BIOMES, B, TIERS, WORLD, biomeWeightsAt } from './config.js';

const MUTE_KEY = 'abyss-muted';
const MAX_VOICES = 48;
const NB = BIOMES.length; // 7

// ---- per-biome tables (index = B.*) ----
//            Shallows       Reef            Kelp            Caverns         Open Ocean      Twilight        Abyss
const CHORDS = [
  [50, 57, 66, 73], [45, 52, 61, 68], [43, 50, 58, 65], [52, 59, 66, 70], [38, 45, 57, 64], [40, 47, 55, 58], [33, 40, 46, 48],
];
const ROOTS = [50, 45, 43, 52, 38, 40, 33];
const SCALES = [
  [0, 2, 4, 7, 9], [0, 2, 4, 7, 9], [0, 3, 5, 7, 10], [0, 2, 6, 7, 11], [0, 2, 5, 7, 9], [0, 3, 5, 7, 10], [0, 1, 5, 7, 8],
];
const DRONE_CUT  = [1700, 1300, 850, 1900, 1100, 480, 300];
const DRONE_VOL  = [0.045, 0.05, 0.055, 0.04, 0.05, 0.06, 0.065];
const RUMBLE_CUT = [560, 480, 400, 330, 470, 330, 250];
const RUMBLE_VOL = [0.3, 0.34, 0.4, 0.34, 0.28, 0.5, 0.58];
const SUB_VOL    = [0, 0, 0.01, 0.02, 0.012, 0.035, 0.06];
const REV_AMT    = [0.9, 0.9, 1.0, 2.0, 1.45, 1.2, 1.3];
const ECHO_FB    = [0.35, 0.35, 0.4, 0.62, 0.5, 0.45, 0.45];
const WHALE_RATE = [0.06, 0.1, 0.15, 0.08, 1, 0.6, 0.75];
const SONAR_RATE = [0, 0, 0, 0.35, 0.15, 1, 1];
const GLASS      = [0, 0, 0, 1, 0, 0, 0];
const AIRY       = [0.1, 0, 0, 0, 1, 0.08, 0];
// ---- mood extras per region + tier grandeur ----
const BMEL       = [1, 0.9, 0.55, 0.65, 0.3, 0.15, 0.05];   // melody density per region
const DARK       = [0, 0.1, 0.3, 0.6, 0.2, 0.7, 1];         // muffles/darkens sfx & mix
const BUBBLING   = [0, 0, 0, 0.35, 0, 0.4, 1];               // primordial bubbling + slow pulse
const UW_CUT     = [7500, 7000, 6000, 5000, 6500, 4200, 3200];
const NT = TIERS.length;
const BOSS_ROOT  = { moray: 40, octopus: 38, greatwhite: 41, anglerking: 33 };

const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const fin = (v, fb) => (Number.isFinite(v) ? v : fb);
const hz = (v, fb = 440) => clamp(fin(v, fb), 1, 22000);

export function createAudio({ bus }) {
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch {}

  let muteGain, master, pauseFilter, uwFilter, comp, sfxBus, ambBus, musicBus, bossBus, duckGain, revIn, echoIn, echoFb;
  let noiseBuf, brownBuf;
  let rumble, drone, fizz, sub, glass, airy;
  let voices = 0;

  let player = null, lastState = null;
  const wRaw = new Array(NB).fill(0);
  const ws = new Array(NB).fill(0); ws[0] = 1;   // smoothed biome weights
  let dom = 0;                                   // dominant biome (hysteresis)
  let gS = 0;                                    // smoothed grandeur from player tier, 0..1
  let nextPulse = 0, pendingGrow = null;
  let vent, halo;
  let intS = 0;
  let tick = 0;
  let combo = 0, lastEatT = -10;
  let nextWhale = 0, nextPing = 0, nextPhrase = 0, nextBeat = 0, nextDrip = 0;
  let melodyIdx = 2;
  const lastPlayed = {};
  let wasPaused = false;
  const boss = { active: false, strings: [], stringNodes: null, nextStep: 0, step: 0, root: 40 };

  // ---------------- setup ----------------
  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch { return; }

    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 14; comp.ratio.value = 3.5;
    comp.attack.value = 0.008; comp.release.value = 0.25;
    muteGain = ctx.createGain(); muteGain.gain.value = muted ? 0 : 1;
    pauseFilter = ctx.createBiquadFilter(); pauseFilter.type = 'lowpass'; pauseFilter.frequency.value = 18000; pauseFilter.Q.value = 0.5;
    uwFilter = ctx.createBiquadFilter(); uwFilter.type = 'lowpass'; uwFilter.frequency.value = 5500; uwFilter.Q.value = 0.6;
    master = ctx.createGain(); master.gain.value = 0;
    master.gain.setTargetAtTime(0.72, ctx.currentTime, 1.2);
    master.connect(uwFilter); uwFilter.connect(pauseFilter); pauseFilter.connect(comp); comp.connect(muteGain); muteGain.connect(ctx.destination);

    duckGain = ctx.createGain(); duckGain.connect(master);
    ambBus = ctx.createGain(); ambBus.connect(duckGain);
    musicBus = ctx.createGain(); musicBus.gain.value = 0; musicBus.connect(duckGain);
    bossBus = ctx.createGain(); bossBus.gain.value = 0; bossBus.connect(duckGain);
    sfxBus = ctx.createGain(); sfxBus.connect(master);

    // reverb: procedural IR. revIn gain = per-biome wetness (caverns very wet)
    const conv = ctx.createConvolver();
    conv.buffer = makeIR(4.6, 2.4);
    revIn = ctx.createGain();
    const revOut = ctx.createGain(); revOut.gain.value = 0.85;
    revIn.connect(conv); conv.connect(revOut); revOut.connect(master);

    // echo: filtered feedback delay -> reverb
    echoIn = ctx.createGain();
    const dl = ctx.createDelay(2); dl.delayTime.value = 0.47;
    echoFb = ctx.createGain(); echoFb.gain.value = 0.42;
    const dlf = ctx.createBiquadFilter(); dlf.type = 'lowpass'; dlf.frequency.value = 2200;
    echoIn.connect(dl); dl.connect(dlf); dlf.connect(echoFb); echoFb.connect(dl);
    const echoOut = ctx.createGain(); echoOut.gain.value = 0.5;
    dlf.connect(echoOut); echoOut.connect(duckGain); dlf.connect(revIn);

    const len = ctx.sampleRate * 4;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    brownBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const w = noiseBuf.getChannelData(0), br = brownBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const r = Math.random() * 2 - 1;
      w[i] = r;
      last = (last + 0.02 * r) / 1.02; br[i] = last * 3.5;
    }
    for (let i = 0; i < 2048; i++) { const k = i / 2048; br[len - 2048 + i] = br[len - 2048 + i] * (1 - k) + br[i] * k; }

    buildAmbient();
    const now = ctx.currentTime;
    nextWhale = now + rand(6, 14);
    nextPing = now + rand(8, 16);
    nextPhrase = now + 2;
    nextBeat = now + 0.5;
    nextDrip = now + 1;
  }

  function makeIR(dur, decay) {
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        lp += (Math.random() * 2 - 1 - lp) * (0.55 - 0.4 * t);
        const pre = i < ctx.sampleRate * 0.02 ? i / (ctx.sampleRate * 0.02) : 1;
        d[i] = lp * Math.pow(1 - t, decay) * pre;
      }
    }
    return buf;
  }

  function lfo(freq, depth, target, type = 'sine') {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = ctx.createGain(); g.gain.value = depth;
    o.connect(g); g.connect(target); o.start();
    return o;
  }
  function loopNoise(buf, offset) {
    const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(0, offset);
    return s;
  }

  function buildAmbient() {
    // 1) Underwater rumble (stereo brown noise, lowpass with slow LFO + swells)
    rumble = { filter: ctx.createBiquadFilter(), gain: ctx.createGain() };
    rumble.filter.type = 'lowpass'; rumble.filter.frequency.value = 500; rumble.filter.Q.value = 0.9;
    rumble.gain.gain.value = 0.35;
    for (const [pan, off] of [[-0.7, 0], [0.7, 1.7]]) {
      const src = loopNoise(brownBuf, off);
      const p = ctx.createStereoPanner(); p.pan.value = pan;
      src.connect(p); p.connect(rumble.filter);
    }
    lfo(0.06, 140, rumble.filter.frequency);
    const swell = ctx.createGain(); swell.gain.value = 1;
    lfo(0.045, 0.3, swell.gain);
    rumble.filter.connect(swell); swell.connect(rumble.gain); rumble.gain.connect(ambBus);

    // 2) Bright fizz (sunlit regions)
    fizz = { gain: ctx.createGain(), bp: ctx.createBiquadFilter() };
    const fsrc = loopNoise(noiseBuf, 0.5);
    fizz.bp.type = 'bandpass'; fizz.bp.frequency.value = 4500; fizz.bp.Q.value = 0.8;
    lfo(0.11, 1500, fizz.bp.frequency);
    const fw = ctx.createGain(); fw.gain.value = 0.6; lfo(0.23, 0.4, fw.gain);
    fizz.gain.gain.value = 0;
    fsrc.connect(fizz.bp); fizz.bp.connect(fw); fw.connect(fizz.gain); fizz.gain.connect(ambBus);

    // 4) Evolving pad/drone: 4 chord voices x 2 detuned oscs -> shared lowpass
    drone = { filter: ctx.createBiquadFilter(), gain: ctx.createGain(), voices: [] };
    drone.filter.type = 'lowpass'; drone.filter.frequency.value = 1400; drone.filter.Q.value = 1.2;
    lfo(0.037, 260, drone.filter.frequency);
    drone.gain.gain.value = 0.05;
    const rates = [0.031, 0.047, 0.071, 0.093];
    for (let v = 0; v < 4; v++) {
      const vg = ctx.createGain(); vg.gain.value = v === 3 ? 0.35 : 0.6;
      lfo(rates[v], v === 3 ? 0.3 : 0.28, vg.gain);
      const f = midi(CHORDS[0][v]);
      const a = ctx.createOscillator(); a.type = 'sawtooth'; a.frequency.value = f; a.detune.value = -8;
      const b = ctx.createOscillator(); b.type = 'triangle'; b.frequency.value = f; b.detune.value = 7;
      const ag = ctx.createGain(); ag.gain.value = 0.55;
      a.connect(ag); ag.connect(vg); b.connect(vg); vg.connect(drone.filter);
      a.start(); b.start();
      drone.voices.push([a, b]);
    }
    const dpan = ctx.createStereoPanner(); lfo(0.02, 0.5, dpan.pan);
    drone.filter.connect(drone.gain); drone.gain.connect(dpan); dpan.connect(ambBus);
    const dsend = ctx.createGain(); dsend.gain.value = 0.55; drone.gain.connect(dsend); dsend.connect(revIn);

    // 5) Glass shimmer (Crystal Caverns): high sines with tremolo, drenched in reverb + echo
    glass = { gain: ctx.createGain(), oscs: [] };
    glass.gain.gain.value = 0;
    const gtrem = ctx.createGain(); gtrem.gain.value = 0.6; lfo(5.3, 0.4, gtrem.gain);
    for (let v = 0; v < 3; v++) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = midi(CHORDS[B.CAVERNS][v + 1] + 24);
      o.detune.value = rand(-6, 6);
      const og = ctx.createGain(); og.gain.value = 0.33; lfo(0.07 + v * 0.05, 0.3, og.gain);
      o.connect(og); og.connect(gtrem); o.start(); glass.oscs.push(o);
    }
    gtrem.connect(glass.gain);
    const gsend = ctx.createGain(); gsend.gain.value = 1.6; glass.gain.connect(gsend); gsend.connect(revIn);
    const gecho = ctx.createGain(); gecho.gain.value = 0.5; glass.gain.connect(gecho); gecho.connect(echoIn);
    glass.gain.connect(ambBus);

    // 6) Airy open-ocean wash: wide band of noise breathing very slowly
    airy = { gain: ctx.createGain() };
    const asrc = loopNoise(noiseBuf, 3.1);
    const abp = ctx.createBiquadFilter(); abp.type = 'bandpass'; abp.frequency.value = 900; abp.Q.value = 0.4;
    lfo(0.03, 400, abp.frequency);
    const ab = ctx.createGain(); ab.gain.value = 0.6; lfo(0.04, 0.4, ab.gain);
    airy.gain.gain.value = 0;
    asrc.connect(abp); abp.connect(ab); ab.connect(airy.gain); airy.gain.connect(ambBus);
    const asend = ctx.createGain(); asend.gain.value = 0.8; airy.gain.connect(asend); asend.connect(revIn);

    // 7) Primordial bubbling (dark regions): warm bubbling low band, irregular amplitude (two detuned LFOs)
    vent = { gain: ctx.createGain() };
    const vsrc = loopNoise(brownBuf, 2.9);
    const vbp = ctx.createBiquadFilter(); vbp.type = 'bandpass'; vbp.frequency.value = 160; vbp.Q.value = 1.4;
    lfo(0.17, 50, vbp.frequency);
    const vb = ctx.createGain(); vb.gain.value = 0.55;
    lfo(3.1, 0.25, vb.gain); lfo(4.7, 0.2, vb.gain); lfo(0.21, 0.2, vb.gain);
    vent.gain.gain.value = 0;
    vsrc.connect(vbp); vbp.connect(vb); vb.connect(vent.gain); vent.gain.connect(ambBus);

    // 8) Halo: high sine chord tones that bloom as you evolve (grandeur)
    halo = { gain: ctx.createGain(), oscs: [] };
    halo.gain.gain.value = 0;
    for (let v = 0; v < 3; v++) {
      const o = ctx.createOscillator(); o.type = v === 0 ? 'triangle' : 'sine';
      o.frequency.value = midi(CHORDS[0][v + 1] + 12); o.detune.value = (v - 1) * 5;
      const og = ctx.createGain(); og.gain.value = 0.33; lfo(0.05 + v * 0.03, 0.25, og.gain);
      o.connect(og); og.connect(halo.gain); o.start(); halo.oscs.push(o);
    }
    const hsend = ctx.createGain(); hsend.gain.value = 1.2; halo.gain.connect(hsend); hsend.connect(revIn);
    halo.gain.connect(ambBus);

    // 9) Sub: ominous beating low pair (depth)
    sub = { gain: ctx.createGain() };
    sub.gain.gain.value = 0;
    for (const dt of [0, 0.6]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = midi(33) + dt;
      o.connect(sub.gain); o.start();
    }
    sub.gain.connect(ambBus);
  }

  // ---------------- voice helpers ----------------
  function canPlay(prio = 0) { return ctx && ctx.state === 'running' && voices < MAX_VOICES + prio * 16; }
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
    if (echo) { const s = ctx.createGain(); s.gain.value = fin(echo, 0); p.connect(s); s.connect(echoIn); nodes.push(s); }
    return { g, nodes };
  }
  function envAD(param, t, a, peak, d) {
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(clamp(fin(peak, 0.0002), 0.0002, 2), t + Math.max(0.001, a));
    param.exponentialRampToValueAtTime(0.0001, t + Math.max(0.001, a) + Math.max(0.005, d));
  }
  function now0(t) { return Math.max(fin(t, ctx.currentTime), ctx.currentTime); }
  function setT(param, v, t, tc) { if (Number.isFinite(v)) param.setTargetAtTime(v, t, tc); }

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

  function bubble(t, f, vol, pan = 0) {
    tone({ t, f, f2: f * rand(1.8, 2.6), glide: rand(0.03, 0.07), a: 0.003, d: rand(0.04, 0.08), vol, pan, rev: 0.25 });
  }

  function pluck(t, f, vol, pan = 0, rev = 0.45, dest) {
    if (!canPlay()) return;
    t = now0(t); f = hz(f); vol = fin(vol, 0); if (vol <= 0) return;
    const o1 = ctx.createOscillator(); o1.frequency.value = f;
    const o2 = ctx.createOscillator(); o2.frequency.value = hz(f * 3.98);
    const g2 = ctx.createGain(); envAD(g2.gain, t, 0.002, 0.35, 0.09);
    const { g, nodes } = outChain(vol, pan, dest, rev, rev * 0.3);
    o1.connect(g); o2.connect(g2); g2.connect(g); nodes.push(g2);
    envAD(g.gain, t, 0.003, vol, 0.9);
    o1.start(t); o2.start(t);
    finish([o1, o2], nodes, t + 1);
  }

  function bell(t, f, vol, pan = 0, rev = 0.6, d = 1.6, prio = 0, dest = sfxBus, echo = 0.15) {
    if (!canPlay(prio)) return;
    t = now0(t); f = hz(f); vol = fin(vol, 0); d = fin(d, 1.6); if (vol <= 0) return;
    const { g, nodes } = outChain(vol, pan, dest, rev, echo);
    const parts = [[1, 1, d], [2.756, 0.35, d * 0.5], [5.404, 0.15, d * 0.25]];
    const srcs = [];
    for (const [m, amp, dd] of parts) {
      const o = ctx.createOscillator(); o.frequency.value = hz(f * m);
      const pg = ctx.createGain(); envAD(pg.gain, t, 0.003, amp, dd);
      o.connect(pg); pg.connect(g); nodes.push(pg); o.start(t); srcs.push(o);
    }
    g.gain.setValueAtTime(vol, t);
    finish(srcs, nodes, t + d + 0.1);
  }

  function thump(t, vol, f = 62) {
    tone({ t, f, f2: f * 0.6, glide: 0.12, a: 0.006, d: 0.26, vol, lp: 220, prio: 1 });
  }
  function tom(t, f, vol) {
    tone({ t, f, f2: f * 0.55, glide: 0.18, a: 0.003, d: 0.32, vol, lp: 600, rev: 0.25, dest: bossBus, prio: 1 });
    noise({ t, dur: 0.06, a: 0.002, vol: vol * 0.35, type: 'lowpass', f: 1400, q: 0.7, dest: bossBus, prio: 1 });
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
  function wsum(tab) { let s = 0; for (let i = 0; i < NB; i++) s += tab[i] * ws[i]; return s; }
  function scaleNote(deg, base) {
    const sc = SCALES[dom];
    const o = Math.floor(deg / sc.length), i = ((deg % sc.length) + sc.length) % sc.length;
    return base + o * 12 + sc[i];
  }
  function keyBase() { const r = ROOTS[dom]; return 60 + (((r - 60) % 12) + 12) % 12; }

  // ---------------- ambient events ----------------
  function whaleCall(t) {
    if (!canPlay()) return;
    t = now0(t);
    const deep = clamp(ws[B.ABYSS] * 0.7 + ws[B.TWILIGHT] * 0.5 + ws[B.OCEAN] * 0.4 + gS * 0.3, 0, 1);
    const f0 = deep > 0.45 ? rand(65, 140) : rand(130, 260);
    const dur = rand(2.6, 5);
    const vol = 0.05 + 0.04 * deep + 0.02 * ws[B.OCEAN];
    const pan = rand(-0.8, 0.8);
    const { g, nodes } = outChain(vol, pan, ambBus, 1.4, 0.35 + 0.3 * ws[B.OCEAN]);
    const fl = ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 700 + 500 * (1 - deep); fl.Q.value = 3;
    fl.connect(g); nodes.push(fl);
    const up = rand(1.25, 1.9), down = rand(0.6, 1.0), mid = rand(0.3, 0.55);
    const srcs = [];
    for (const [type, mult, amp] of [['triangle', 1, 1], ['sine', 2.01, 0.35]]) {
      const o = ctx.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(f0 * mult, t);
      o.frequency.exponentialRampToValueAtTime(f0 * mult * up, t + dur * mid);
      o.frequency.exponentialRampToValueAtTime(f0 * mult * down, t + dur);
      const vib = ctx.createOscillator(); vib.frequency.value = rand(3.5, 6);
      const vg = ctx.createGain(); vg.gain.setValueAtTime(0, t); vg.gain.linearRampToValueAtTime(f0 * mult * 0.025, t + dur * 0.6);
      vib.connect(vg); vg.connect(o.frequency);
      const og = ctx.createGain(); og.gain.value = amp;
      o.connect(og); og.connect(fl);
      nodes.push(vg, og);
      o.start(t); vib.start(t); srcs.push(o, vib);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.3);
    g.gain.setValueAtTime(vol, t + dur * 0.65);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    finish(srcs, nodes, t + dur + 0.05);
  }

  function sonarPing(t) {
    const f = rand(1150, 1500), pan = rand(-0.6, 0.6);
    tone({ t, f, a: 0.003, d: 1.6, vol: 0.035, pan, rev: 1.2, echo: 0.9, dest: ambBus });
    tone({ t, f: f * 1.003, a: 0.003, d: 1.2, vol: 0.02, pan: -pan, rev: 1.0, dest: ambBus });
  }

  function melodyPhrase(t, density) {
    const glassy = ws[B.CAVERNS] > 0.5;
    const n = 2 + ((Math.random() * 4) | 0);
    const step = glassy ? rand(0.3, 0.5) : rand(0.2, 0.34);
    const base = keyBase() + (glassy ? 24 : 12);
    const vol = (glassy ? 0.03 : 0.045) * (0.6 + 0.4 * density);
    for (let i = 0; i < n; i++) {
      melodyIdx = clamp(melodyIdx + ((Math.random() * 5) | 0) - 2, -2, 9);
      if (Math.random() < 0.15) continue;
      const tt = t + i * step + (Math.random() < 0.3 ? step * 0.5 : 0);
      const f = midi(scaleNote(melodyIdx, base));
      if (glassy) bell(tt, f, vol, rand(-0.7, 0.7), 1.4, 2.2, 0, musicBus, 0.7);
      else pluck(tt, f, vol, rand(-0.5, 0.5), 0.55, musicBus);
    }
    if (Math.random() < 0.35) pluck(t + n * step, midi(scaleNote(melodyIdx - 2, base)), vol * 0.6, rand(-0.4, 0.4), 0.7, musicBus);
  }

  // ---------------- boss music layer ----------------
  const PROG = [[12, 15, 19, 24], [8, 12, 15, 20], [5, 8, 12, 17], [7, 11, 14, 19]]; // i bVI iv V
  const BASS = [1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 1, 0, 1];
  const STEP = 0.12; // 16th @ 125bpm

  function bossEngage({ boss: b } = {}) {
    init();
    if (!ctx) return;
    const n = ctx.currentTime;
    boss.root = BOSS_ROOT[b && b.species] || ROOTS[dom] - 12 * (ROOTS[dom] > 45 ? 1 : 0);
    if (!Number.isFinite(boss.root)) boss.root = 40;
    if (!boss.active) { boss.step = 0; boss.nextStep = n + 0.15; }
    boss.active = true;
    if (!boss.strings.length) {
      // tense strings: detuned saws through a lowpass with tremolo
      const fl = ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 900; fl.Q.value = 2.5;
      const flo = lfo(0.09, 350, fl.frequency);
      const trem = ctx.createGain(); trem.gain.value = 0.75;
      const tl = ctx.createOscillator(); tl.frequency.value = 7.5;
      const tg = ctx.createGain(); tg.gain.value = 0.25; tl.connect(tg); tg.connect(trem.gain); tl.start();
      const sg = ctx.createGain(); sg.gain.value = 0.045;
      fl.connect(trem); trem.connect(sg); sg.connect(bossBus);
      const send = ctx.createGain(); send.gain.value = 0.6; sg.connect(send); send.connect(revIn);
      for (let v = 0; v < 4; v++) {
        for (const dt of [-9, 9]) {
          const o = ctx.createOscillator(); o.type = 'sawtooth';
          o.frequency.value = midi(boss.root + PROG[0][v]); o.detune.value = dt;
          o.connect(fl); o.start(); boss.strings.push({ o, v });
        }
      }
      boss.stringNodes = [fl, trem, tl, tg, sg, send, flo];
    }
    bossBus.gain.cancelScheduledValues(n);
    bossBus.gain.setTargetAtTime(1, n, 0.6);
    // hit of dread
    tom(n + 0.02, 70, 0.5);
    noise({ t: n, dur: 1.8, vol: 0.1, type: 'lowpass', f: 80, f2: 700, f3: 100, q: 4, rev: 0.8, prio: 2,
      curve: new Float32Array([0.0001, 0.4, 1, 0.6, 0.2, 0.0001]) });
  }

  function bossFadeOut(time = 0.8) {
    if (!ctx) return;
    const n = ctx.currentTime;
    boss.active = false;
    bossBus.gain.cancelScheduledValues(n);
    bossBus.gain.setTargetAtTime(0, n, time);
    const strings = boss.strings, nodes = boss.stringNodes;
    boss.strings = []; boss.stringNodes = null;
    const stopAt = n + time * 6;
    let left = strings.length;
    for (const { o } of strings) {
      o.stop(stopAt);
      o.onended = () => { o.disconnect(); if (--left === 0 && nodes) for (const x of nodes) { try { if (x.stop) x.stop(); } catch {} x.disconnect(); } };
    }
  }

  function bossSequencer(n) {
    if (!boss.active) return;
    if (boss.nextStep < n) boss.nextStep = n + 0.02;
    while (boss.nextStep < n + 0.15) {
      const t = boss.nextStep, s = boss.step % 16, bar = Math.floor(boss.step / 16);
      const chord = PROG[Math.floor(bar / 2) % 4];
      if (s === 0 && bar % 2 === 0) {
        for (const { o, v } of boss.strings) setT(o.frequency, midi(boss.root + chord[v]), t, 0.08);
      }
      // ostinato bass
      if (BASS[s]) {
        const oct = (s === 7 || s === 13) ? 12 : 0;
        tone({ t, type: 'sawtooth', f: midi(boss.root - 12 + chord[0] - 12 + oct), a: 0.004, d: 0.13, vol: 0.09, lp: 420, dest: bossBus, prio: 1 });
      }
      // war drums
      if (s === 0) { tom(t, 62, 0.42); noise({ t, dur: 0.4, a: 0.003, vol: 0.06, type: 'lowpass', f: 300, f2: 60, dest: bossBus, rev: 0.4, prio: 1 }); }
      if (s === 6 || s === 10) tom(t, 82, 0.3);
      if (s === 8) tom(t, 62, 0.34);
      if (bar % 4 === 3 && s >= 12) tom(t, 95 + (s - 12) * 14, 0.22 + (s - 12) * 0.03);
      boss.step++;
      boss.nextStep += STEP;
    }
  }

  // ---------------- SFX ----------------
  // ---- BITE: jaw snap + click, bone crackle (bigger meals), wet squelch/gulp, low body ----
  // heft 0..1 = meal size relative to eater; df = pitch factor (bigger eater = lower); mf = muffle cutoff.
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

  function onDash() {
    if (!ctx) return;
    const t = ctx.currentTime;
    const pan = player ? clamp(fin(Math.cos(player.heading) * 0.4, 0), -0.5, 0.5) : 0;
    noise({ t, dur: 0.45, a: 0.04, vol: 0.2, f: 280, f2: 2600, f3: 500, q: 1.6, pan, rev: 0.3, prio: 1 });
    noise({ t, dur: 0.3, a: 0.02, vol: 0.08, type: 'lowpass', f: 300, f2: 120, q: 0.7 });
    for (let i = 0; i < 7; i++) bubble(t + 0.05 + i * rand(0.02, 0.05), rand(600, 1600), 0.045, rand(-0.6, 0.6));
  }

  function onClick({ point } = {}) {
    if (!ctx || !limit('click', 0.09)) return;
    tone({ t: ctx.currentTime, f: rand(1500, 1900), f2: 2600, glide: 0.03, a: 0.002, d: 0.04, vol: 0.022, pan: panFor(point), lp: 3000, rev: 0.3 });
  }

  // 'grow' and 'evolve' fire together; evolve gets the big sound, grow is a fallback if no evolve follows.
  function onGrow({ tier = 1 } = {}) {
    pendingGrow = fin(tier, 1);
    setTimeout(() => { if (pendingGrow !== null) { const tt = pendingGrow; pendingGrow = null; growSound({ tier: tt }); } }, 0);
  }

  // Evolution: rising shimmer swell -> choir pad (formant-filtered saws/sines) -> bright resolved chime.
  function onEvolve({ tier = 1, pos } = {}) {
    pendingGrow = null;
    if (!ctx) return;
    const tr = clamp(fin(tier, 1) | 0, 1, 6);
    const g = tr / 6;                                   // grandeur 0..1
    const t = ctx.currentTime + 0.02;
    const root = 48 + [0, 0, 2, 4, 5, 7, 12][tr];       // climbs with each tier
    const rise = 1.0 + 0.4 * g;                         // swell length
    // 1) rising shimmer: noise sweep + gliding triangles
    noise({ t, dur: rise + 0.3, vol: 0.05 + 0.05 * g, type: 'bandpass', f: 500, f2: 3000, f3: 9000, q: 1.2, rev: 1.0, prio: 3,
      curve: new Float32Array([0.0001, 0.15, 0.35, 0.6, 0.9, 1, 0.0001]) });
    [0, 7, 12].forEach((iv, i) => tone({ t, type: 'triangle', f: midi(root + iv), f2: midi(root + iv + 24), glide: rise, a: rise * 0.8, d: 0.5,
      vol: 0.03 + 0.015 * g, pan: (i - 1) * 0.5, rev: 0.9, prio: 3 }));
    tone({ t, f: 50, f2: 80, glide: rise, a: rise, d: 0.6, vol: 0.12 + 0.1 * g, lp: 200, prio: 3 });
    // 2) choir pad
    const tc = t + rise * 0.7;
    const choirNotes = [0, 7, 12, 16, 19, 24, 28].slice(0, 3 + Math.ceil(g * 4)).map((iv) => root + iv);
    choir(tc, choirNotes, 0.05 + 0.04 * g, 2.4 + 2 * g);
    // 3) resolved chime + boom
    const tb = t + rise;
    tone({ t: tb, f: 75, f2: 32, glide: 0.9, a: 0.006, d: 1.6 + g, vol: 0.35 + 0.15 * g, lp: 260, prio: 3 });
    noise({ t: tb, dur: 0.5, a: 0.004, vol: 0.12 + 0.06 * g, type: 'lowpass', f: 700, f2: 90, q: 0.8, rev: 0.6, prio: 3 });
    const chime = [12, 16, 19, 24, 28, 31, 36].slice(0, 4 + Math.ceil(g * 3));
    chime.forEach((iv, i) => bell(tb + i * 0.07, midi(root + iv), 0.055 - i * 0.003, i % 2 ? 0.4 : -0.4, 0.9, 1.6 + g, 3));
    bell(tb + chime.length * 0.07 + 0.05, midi(root + 36), 0.04, 0, 1.2, 2.5, 3);
  }

  function choir(t, notes, vol, dur) {
    if (!canPlay(3)) return;
    const { g, nodes } = outChain(vol, 0, sfxBus, 1.2, 0.15);
    const mix = ctx.createGain(); mix.gain.value = 1; nodes.push(mix);
    // "ah"-ish formants
    for (const [f, q, a] of [[730, 6, 1], [1090, 7, 0.7], [2440, 8, 0.25], [300, 2, 0.5]]) {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
      const bg = ctx.createGain(); bg.gain.value = a * 2.2;
      mix.connect(bp); bp.connect(bg); bg.connect(g); nodes.push(bp, bg);
    }
    const srcs = [];
    notes.forEach((m, i) => {
      for (const [type, dt] of [['sawtooth', -9], ['sawtooth', 8], ['sine', 0]]) {
        const o = ctx.createOscillator(); o.type = type; o.frequency.value = midi(m); o.detune.value = dt + rand(-3, 3);
        const vib = ctx.createOscillator(); vib.frequency.value = rand(4.5, 5.5);
        const vg = ctx.createGain(); vg.gain.value = midi(m) * 0.004; vib.connect(vg); vg.connect(o.frequency);
        const og = ctx.createGain(); og.gain.value = type === 'sine' ? 0.6 : 0.35;
        o.connect(og); og.connect(mix); nodes.push(vg, og);
        o.start(t + i * 0.05); vib.start(t); srcs.push(o, vib);
      }
    });
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.7);
    g.gain.setValueAtTime(vol, t + dur * 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    finish(srcs, nodes, t + dur + 0.1);
  }

  function growSound({ tier = 1 } = {}) {
    if (!ctx) return;
    const t = ctx.currentTime + 0.02;
    tier = fin(tier, 1) | 0;
    tone({ t, f: 72, f2: 30, glide: 0.9, a: 0.008, d: 1.8, vol: 0.45, lp: 260, prio: 2 });
    noise({ t, dur: 0.6, a: 0.005, vol: 0.18, type: 'lowpass', f: 600, f2: 80, q: 0.8, rev: 0.5, prio: 2 });
    const base = 62 + (Math.abs(tier) % 7) * 2;
    [0, 4, 7, 11, 12, 16, 19, 24, 28].forEach((iv, i) => bell(t + 0.08 + i * 0.065, midi(base + iv), 0.06 - i * 0.002, (i % 2 ? 0.35 : -0.35), 0.7, 1.4, 2));
    if (canPlay(2)) {
      const { g, nodes } = outChain(0.05, 0, sfxBus, 1.0);
      const srcs = [];
      for (const iv of [24, 28, 31, 36]) {
        const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = midi(base + iv); o.detune.value = rand(-8, 8);
        o.connect(g); o.start(t + 0.3); srcs.push(o);
      }
      const tr = ctx.createOscillator(); tr.frequency.value = 9;
      const tg = ctx.createGain(); tg.gain.value = 0.02; tr.connect(tg); tg.connect(g.gain); tr.start(t + 0.3); srcs.push(tr); nodes.push(tg);
      g.gain.setValueAtTime(0.0001, t + 0.3);
      g.gain.exponentialRampToValueAtTime(0.035, t + 0.8);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.8);
      finish(srcs, nodes, t + 2.9);
    }
  }

  function gong(t, f, vol, dur = 5) {
    if (!canPlay(2)) return;
    const { g, nodes } = outChain(vol, 0, sfxBus, 1.1, 0.2);
    const srcs = [];
    for (const [m, amp, d] of [[1, 1, dur], [2, 0.4, dur * 0.7], [2.76, 0.25, dur * 0.52], [4.07, 0.12, dur * 0.36], [0.5, 0.5, dur * 0.9]]) {
      const o = ctx.createOscillator(); o.frequency.value = hz(f * m);
      const pg = ctx.createGain(); pg.gain.setValueAtTime(0.0001, t);
      pg.gain.exponentialRampToValueAtTime(amp, t + 0.9); pg.gain.exponentialRampToValueAtTime(0.0001, t + 0.9 + d);
      o.connect(pg); pg.connect(g); nodes.push(pg); o.start(t); srcs.push(o);
    }
    g.gain.setValueAtTime(vol, t);
    finish(srcs, nodes, t + dur + 1);
  }

  // Entering a new region mood: soft swell of filtered noise + the new region's chord blooming in.
  function onBiome({ index = 0, first } = {}) {
    if (!ctx || !limit('biome', 2)) return;
    const t = ctx.currentTime + 0.02;
    const i = clamp(fin(index, 0) | 0, 0, NB - 1);
    const dark = DARK[i];
    noise({ t, dur: 3.4, vol: 0.07, type: 'lowpass', f: 120, f2: lerp(1100, 380, dark), f3: 140, q: 2, rev: 0.9, prio: 1,
      curve: new Float32Array([0.0001, 0.2, 0.55, 0.85, 1, 0.7, 0.35, 0.0001]) });
    CHORDS[i].forEach((m, k) =>
      tone({ t: t + 0.3 + k * 0.18, type: 'triangle', f: midi(m + 12), a: 1.1, d: 2.4, vol: 0.022, pan: k % 2 ? 0.4 : -0.4, rev: 1.1, lp: 1600, prio: 1 }));
    if (first) CHORDS[i].slice(1).forEach((m, k) => bell(t + 1.3 + k * 0.2, midi(m + 24), 0.02, k % 2 ? 0.5 : -0.5, 1.2, 2.2, 1));
  }

  function onNearMiss({ fish } = {}) {
    if (!ctx || !limit('nearMiss', 0.4)) return;
    const t = ctx.currentTime;
    const pan = fish ? panFor(fish.pos) : 0;
    noise({ t, dur: 0.24, a: 0.015, vol: 0.24, f: 500, f2: 3800, f3: 900, q: 3, pan, rev: 0.2, prio: 2 });
    thump(t + 0.1, 0.45, 66);
    thump(t + 0.27, 0.3, 54);
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

  // Eaten: the attacker's bite from inside its mouth — huge jaw clamp, crunch, muffled dark thud.
  function onDeath({ killer } = {}) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const ks = clamp(fin(killer && killer.size, fin(player && player.size, 1) * 2), 0.3, 100);
    const df = rand(0.9, 1.05) / Math.pow(ks, 0.28);
    // jaw clamp: heavy low snap
    noise({ t, dur: 0.09, a: 0.001, vol: 0.4, type: 'lowpass', f: 1600, f2: 250, q: 1.1, prio: 3 });
    noise({ t, dur: 0.015, a: 0.0008, vol: 0.25, type: 'highpass', f: 2200, q: 0.7, prio: 3 });
    bite({ t: t + 0.01, heft: 1, df, vol: 0.42, mf: 1500, rev: 0.35, prio: 3 });
    crunch(t + 0.03, 0.2);
    crackle(t + 0.05, 0.3, 14, 0.14, 1900 * df, 0, sfxBus, 0.3, 3);
    // muffled dark thud + sinking tone
    tone({ t: t + 0.02, f: 85, f2: 26, glide: 0.5, a: 0.004, d: 1.1, vol: 0.55, lp: 170, prio: 3 });
    tone({ t: t + 0.25, type: 'sawtooth', f: 220, f2: 40, glide: 1.8, a: 0.05, d: 2.0, vol: 0.06, lp: 450, rev: 0.8, prio: 3 });
    for (let i = 0; i < 4; i++) bubble(t + 0.35 + i * 0.09, rand(250, 600), 0.03, rand(-0.6, 0.6));
    if (boss.active) bossFadeOut(0.5);
    duckGain.gain.cancelScheduledValues(t);
    duckGain.gain.setTargetAtTime(0.22, t, 0.05);
    duckGain.gain.setTargetAtTime(1, t + 2.2, 1.0);
  }

  function chordSwell(t, notes, vol, dur, dest = sfxBus) {
    if (!canPlay(3)) return;
    const { g, nodes } = outChain(vol, 0, dest, 0.9, 0.1);
    const fl = ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.Q.value = 2;
    fl.frequency.setValueAtTime(250, t); fl.frequency.exponentialRampToValueAtTime(3200, t + dur * 0.3); fl.frequency.exponentialRampToValueAtTime(700, t + dur);
    fl.connect(g); nodes.push(fl);
    const srcs = [];
    for (const m of notes) for (const dt of [-11, 0, 12]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midi(m); o.detune.value = dt + rand(-3, 3);
      o.connect(fl); o.start(t); srcs.push(o);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.25);
    g.gain.setValueAtTime(vol, t + dur * 0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    finish(srcs, nodes, t + dur + 0.1);
  }

  // Becoming Apex mid-sea: triumphant swell + choir + sparkling bells (shorter; the run continues).
  function onVictory() {
    if (!ctx) return;
    const t = ctx.currentTime + 0.05;
    if (boss.active) bossFadeOut(0.5);
    tone({ t, f: 60, f2: 30, glide: 1.0, a: 0.01, d: 2.2, vol: 0.4, lp: 220, prio: 3 });
    chordSwell(t, [43, 55, 62, 67, 71, 74, 81], 0.065, 5);
    choir(t + 0.4, [55, 62, 67, 71, 74], 0.055, 3.8);
    noise({ t, dur: 2, vol: 0.06, type: 'highpass', f: 2000, f2: 7000, q: 0.5, rev: 1.2, curve: new Float32Array([0.0001, 0.2, 0.6, 1, 0.4, 0.0001]) });
    [79, 83, 86, 91, 95, 98, 103, 98].forEach((m, i) => bell(t + 0.9 + i * 0.08 + Math.random() * 0.03, midi(m), 0.045 - i * 0.002, rand(-0.7, 0.7), 1.0, 2, 3));
    [67, 71, 74, 79].forEach((m, i) => bell(t + 1.9 + i * 0.14, midi(m), 0.045, i % 2 ? 0.4 : -0.4, 1.1, 2.6, 3));
  }

  function onBossHit({ pos } = {}) {
    if (!ctx || !limit('bossHit', 0.08)) return;
    const t = ctx.currentTime, pan = panFor(pos);
    tone({ t, f: 110, f2: 40, glide: 0.2, a: 0.003, d: 0.35, vol: 0.5, lp: 350, pan, prio: 3 });
    crunch(t, 0.14);
    noise({ t, dur: 0.12, a: 0.002, vol: 0.16, type: 'lowpass', f: 1800, f2: 300, pan, prio: 3 });
    bell(t + 0.02, midi(keyBase() + 31), 0.07, -pan * 0.5, 0.8, 1.3, 3);
    bell(t + 0.02, midi(keyBase() + 38), 0.03, pan * 0.5, 0.8, 0.9, 3);
  }

  function onBossDefeated() {
    if (!ctx) return;
    bossFadeOut(0.6);
    const t = ctx.currentTime + 0.05;
    const r = 50; // D
    tone({ t, f: 70, f2: 30, glide: 1.0, a: 0.008, d: 2.2, vol: 0.45, lp: 240, prio: 3 });
    // brassy fanfare: I - IV - V - I(held)
    const steps = [[0, 0.22], [5, 0.22], [7, 0.3], [12, 2.6]];
    let tt = t;
    for (const [iv, len] of steps) {
      const notes = [r - 12 + iv, r + iv, r + iv + 4, r + iv + 7];
      chordSwell(tt, notes, len > 1 ? 0.06 : 0.05, Math.max(0.35, len + 0.3));
      tom(tt, 90, 0.3);
      tt += len;
    }
    [74, 78, 81, 86, 90, 93].forEach((m, i) => bell(t + 0.8 + i * 0.08, midi(m), 0.045, i % 2 ? 0.4 : -0.4, 0.8, 1.8, 3));
    noise({ t: t + 0.7, dur: 2.2, vol: 0.05, type: 'highpass', f: 2500, f2: 7000, q: 0.5, rev: 1, curve: new Float32Array([0.0001, 0.4, 1, 0.5, 0.0001]) });
  }

  function onInk({ pos } = {}) {
    if (!ctx || !limit('ink', 0.3)) return;
    const t = ctx.currentTime, pan = panFor(pos);
    noise({ t, dur: 0.9, a: 0.04, vol: 0.18, type: 'lowpass', f: 900, f2: 150, q: 5, pan, rev: 0.6, prio: 2 });
    tone({ t, f: 140, f2: 60, glide: 0.4, a: 0.01, d: 0.5, vol: 0.2, lp: 300, pan, prio: 2 });
    for (let i = 0; i < 5; i++) tone({ t: t + 0.08 + i * rand(0.07, 0.14), f: rand(110, 220), f2: rand(250, 380), glide: 0.12, a: 0.01, d: 0.16, vol: 0.06, lp: 500, pan: pan + rand(-0.2, 0.2), rev: 0.5 });
  }

  function distCurve(k) {
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; c[i] = ((1 + k) * x) / (1 + k * Math.abs(x)); }
    return c;
  }

  // ---------------- mute ----------------
  function setMuted(m) {
    muted = !!m;
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch {}
    if (ctx) muteGain.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.05);
    bus.emit('muteChanged', { muted });
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
  bus.on('restart', () => { init(); if (boss.active) bossFadeOut(0.3); });
  bus.on('toggleMute', () => setMuted(!muted));
  bus.on('playerAte', onPlayerAte);
  bus.on('eat', onEat);
  bus.on('dash', onDash);
  bus.on('click', onClick);
  bus.on('grow', onGrow);
  bus.on('evolve', onEvolve);
  bus.on('biome', onBiome);
  bus.on('nearMiss', onNearMiss);
  bus.on('playerDeath', onDeath);
  bus.on('victory', onVictory);
  bus.on('bossEngage', bossEngage);
  bus.on('bossDisengage', () => bossFadeOut(0.9));
  bus.on('bossHit', onBossHit);
  bus.on('bossDefeated', onBossDefeated);
  bus.on('ink', onInk);

  bus.emit('muteChanged', { muted });
  setTimeout(() => bus.emit('muteChanged', { muted }), 0);

  // ---------------- per-frame ----------------
  function update(dt, state, p, eco) {
    player = p; lastState = state;
    if (!ctx || ctx.state !== 'running') return;
    dt = clamp(fin(dt, 0.016), 0, 0.1);
    const now = ctx.currentTime;
    const playing = state.mode === 'playing' && !state.paused;
    const threat = playing && eco ? clamp(fin(eco.threat, 0), 0, 1) : 0;
    const intensity = playing && eco ? clamp(fin(eco.intensity, 0), 0, 1) : 0;

    // region weights at the player's ABSOLUTE position (floating origin), smoothed
    const ox = fin(WORLD.origin && WORLD.origin.x, 0), oy = fin(WORLD.origin && WORLD.origin.y, 0);
    const px = fin(p && p.pos.x, 0) + ox, py = fin(p && p.pos.y, 0) + oy;
    if (p) biomeWeightsAt(px, py, wRaw); else { wRaw.fill(0); wRaw[0] = 1; }
    const k = 1 - Math.exp(-dt / 1.8);
    for (let i = 0; i < NB; i++) ws[i] += (fin(wRaw[i], 0) - ws[i]) * k;
    let best = dom;
    for (let i = 0; i < NB; i++) if (ws[i] > ws[best] + 0.12) best = i;
    dom = best;
    intS += (intensity - intS) * (1 - Math.exp(-dt / 2));
    // grandeur: grows with evolution tier (smoothed; also eases with size inside a tier)
    const tier = clamp(fin(state.tier, 0), 0, NT - 1);
    gS += (tier / (NT - 1) - gS) * (1 - Math.exp(-dt / 3));
    const bubW = wsum(BUBBLING), dark = wsum(DARK);

    tick -= dt;
    if (tick <= 0) {
      tick = 0.1;
      for (let v = 0; v < 4; v++) {
        // bigger forms get a weightier pad: the root drops an octave as grandeur builds
        const f = midi(CHORDS[dom][v] - (v === 0 && gS > 0.55 ? 12 : 0));
        setT(drone.voices[v][0].frequency, f, now, 1.2);
        setT(drone.voices[v][1].frequency, f, now, 1.2);
      }
      for (let v = 0; v < 3; v++) setT(halo.oscs[v].frequency, midi(CHORDS[dom][v + 1] + 12 + (v === 2 ? 12 : 0)), now, 1.2);
      setT(drone.filter.frequency, wsum(DRONE_CUT) * (1 + 0.5 * gS) * (1 - 0.3 * threat) * (1 + 0.35 * intS), now, 0.4);
      setT(drone.gain.gain, wsum(DRONE_VOL) * (0.8 + 0.5 * gS) * (1 + 0.25 * intS) * (boss.active ? 0.6 : 1), now, 0.5);
      setT(halo.gain.gain, (0.004 + 0.02 * gS) * (1 - dark * 0.5) * (boss.active ? 0.3 : 1) * (1 - 0.5 * threat), now, 0.8);
      setT(vent.gain.gain, 0.2 * bubW, now, 0.6);
      setT(rumble.filter.frequency, wsum(RUMBLE_CUT), now, 0.5);
      setT(rumble.gain.gain, wsum(RUMBLE_VOL) * 0.8 * (1 + 0.3 * threat + 0.15 * intS), now, 0.5);
      setT(sub.gain.gain, wsum(SUB_VOL) * 0.7 + 0.025 * gS + 0.03 * threat + 0.015 * intS, now, 0.6);
      setT(fizz.gain.gain, 0.012 * ws[B.SHALLOWS] + 0.006 * ws[B.REEF], now, 0.5);
      setT(glass.gain.gain, wsum(GLASS) * 0.022, now, 0.8);
      setT(airy.gain.gain, wsum(AIRY) * 0.05, now, 0.8);
      setT(revIn.gain, wsum(REV_AMT) * (1 + 0.3 * gS), now, 0.6);
      setT(echoFb.gain, clamp(wsum(ECHO_FB), 0, 0.7), now, 0.6);
      setT(uwFilter.frequency, wsum(UW_CUT), now, 0.4);
      setT(musicBus.gain, playing ? (1 - 0.85 * threat) * (1 - 0.4 * intS) * (boss.active ? 0.15 : 1) : 0, now, 0.4);

      if (state.paused !== wasPaused) {
        wasPaused = state.paused;
        setT(pauseFilter.frequency, wasPaused ? 650 : 18000, now, 0.12);
        setT(master.gain, wasPaused ? 0.4 : 0.72, now, 0.15);
      }
    }
    if (state.paused) return;

    bossSequencer(now);

    // whale calls: frequent in Open Ocean / dark regions, a bit more as you grow
    if (now >= nextWhale) {
      const rate = clamp(wsum(WHALE_RATE) + 0.2 * gS, 0, 1);
      whaleCall(now + 0.05);
      if (Math.random() < 0.25 + 0.4 * rate) whaleCall(now + rand(3, 6));
      nextWhale = now + rand(lerp(55, 9, rate), lerp(100, 22, rate));
    }
    if (now >= nextPing) {
      if (Math.random() < wsum(SONAR_RATE)) sonarPing(now + 0.02);
      nextPing = now + rand(11, 24);
    }
    if (now >= nextDrip) {
      const sh = ws[B.SHALLOWS] + ws[B.REEF] * 0.5;
      if (sh > 0.1) bubble(now, rand(900, 2200), 0.012 * clamp(sh, 0, 1), rand(-0.9, 0.9));
      if (ws[B.CAVERNS] > 0.4 && Math.random() < 0.25) bell(now, midi(keyBase() + 36 + SCALES[B.CAVERNS][(Math.random() * 5) | 0]), 0.012, rand(-0.9, 0.9), 1.8, 2.5, 0, ambBus, 0.8);
      nextDrip = now + rand(0.6, 2.5);
    }

    // dark regions: slow primordial heartbeat-like pulse + bubbling blips
    const ventW = bubW;
    if (ventW > 0.05) {
      if (now >= nextPulse) {
        const tb = Math.max(nextPulse, now + 0.02);
        tone({ t: tb, f: 58, f2: 42, glide: 0.2, a: 0.03, d: 0.5, vol: 0.09 * ventW, lp: 160, dest: ambBus, rev: 0.3 });
        tone({ t: tb + 0.32, f: 50, f2: 38, glide: 0.2, a: 0.03, d: 0.6, vol: 0.06 * ventW, lp: 140, dest: ambBus, rev: 0.3 });
        nextPulse = tb + rand(1.5, 1.9);
      }
      if (Math.random() < 3.5 * ventW * dt) {
        const f = rand(140, 420);
        tone({ t: now, f, f2: f * rand(1.6, 2.4), glide: rand(0.05, 0.1), a: 0.004, d: rand(0.07, 0.14), vol: 0.035 * ventW, lp: 900, pan: rand(-0.8, 0.8), rev: 0.4, dest: ambBus });
      }
    } else nextPulse = now + 0.5;

    if (!playing) { if (now - lastEatT > 2) combo = 0; return; }

    // generative melody
    if (now >= nextPhrase) {
      const density = clamp(wsum(BMEL) * (0.85 + 0.3 * gS), 0, 1) * (1 - threat) * (1 - 0.5 * intS) * (boss.active ? 0 : 1);
      if (density > 0.05 && Math.random() < 0.4 + 0.6 * density) melodyPhrase(now + 0.05, density);
      nextPhrase = now + rand(3, 6.5) / Math.max(0.5, density || 0.5);
    }

    // heartbeat follows threat
    if (threat > 0.12) {
      if (now >= nextBeat - 0.05) {
        const tb = Math.max(nextBeat, now + 0.02);
        const vol = 0.1 + 0.32 * threat;
        thump(tb, vol, 64);
        thump(tb + 0.17, vol * 0.7, 54);
        nextBeat = tb + lerp(1.15, 0.42, threat);
      }
    } else nextBeat = Math.max(nextBeat, now + 0.15);

    if (p && p.alive) {
      // wall bump
      if (fin(p.wallHit, 0) > 0.5 && limit('wall', 0.35)) {
        const s = clamp(p.wallHit, 0, 1);
        const sf = 1 / Math.pow(clamp(fin(p.size, 1), 0.2, 100), 0.25);
        tone({ t: now, f: 110 * sf, f2: 50 * sf, glide: 0.08, a: 0.003, d: 0.18, vol: 0.18 * s, lp: 400, prio: 1 });
        noise({ t: now, dur: 0.09, a: 0.002, vol: 0.08 * s, type: 'lowpass', f: 700, f2: 200, q: 1, rev: 0.3 });
      }
      // trail bubbles
      {
        const speed = Math.hypot(fin(p.vel.x, 0), fin(p.vel.y, 0));
        const rate = 0.35 + speed * 0.025;
        if (Math.random() < rate * dt) bubble(now, rand(700, 1700) / Math.pow(clamp(fin(p.size, 1), 0.2, 100), 0.3), 0.018, rand(-0.3, 0.3));
      }
    }
  }

  return { update };
}
