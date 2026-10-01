// Abyss Drift INFINITE — all DOM UI: title, HUD, banners, floating score, threat arrows, radar, boss UI, menus.
// Side view on an endless sea: gameplay plane is XY (z = 0), up = +y. No surface, no depth, no map.
import * as THREE from 'three';
import { CONFIG, TIERS, BIOMES, BOSSES } from './config.js';

const SPECIES_NAMES = {
  krill: 'Krill', sardine: 'Sardine', clownfish: 'Clownfish', tang: 'Blue Tang', jelly: 'Jellyfish',
  puffer: 'Pufferfish', barracuda: 'Barracuda', grouper: 'Grouper', angler: 'Anglerfish', shark: 'Shark',
  whale: 'Whale', hero: 'Rival', microbe: 'Microbe', lanternfish: 'Lanternfish', squid: 'Squid',
};
const BOSS_SUB = {
  anglerking: 'The Light That Lies',
  octopus: 'Ink-Mother of the Deep',
  moray: 'Lurker of the Kelp Den',
  greatwhite: 'Terror of the Open Blue',
};
const FORM_LINE = {
  cell: 'A single hungry cell.',
  larva: 'Tiny, but you can finally push against the current.',
  shrimp: 'Armoured, quick — and always hungry.',
  fry: 'A real fish at last. Mind your arcs.',
  fish: 'The reef is your pantry now.',
  hunter: 'Most things flee when you arrive.',
  apex: 'Top of the food chain. The sea is endless \u2014 keep growing.',
};
const REGION_FLAVOR = [
  'Bright, warm water. Easy living \u2014 mostly.',
  'Crowded colour \u2014 and the things that hunt it.',
  'Swaying shadows hide ambushers.',
  'Dark water. The glow you see is usually teeth.',
  'Endless blue. Nowhere to hide.',
  'The light thins. Eyes glow in the gloom.',
  'Crushing dark. Only the bold feed here.',
];
const HINTS_ONBOARD = [
  { id: 'v4click', at: 1.5, text: 'Click where you want to swim' },
  { id: 'v4arcs', at: 9, text: "You can't turn on a dime \u2014 plan your arcs" },
  { id: 'v4glow', at: 18, text: 'Green outline = food, red = danger' },
  { id: 'v4lines', at: 28, text: 'Big fish swim in straight lines \u2014 read their path' },
  { id: 'v4tiny', at: 40, text: "Tiny prey won't grow you \u2014 hunt things closer to your size" },
];
const killerName = (k) => (BOSSES[k] ? BOSSES[k].name : SPECIES_NAMES[k] || (k ? String(k) : 'something'));
const article = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const fmtInt = (n) => (Number.isFinite(n) ? Math.round(n) : 0).toLocaleString('en-US');
const fmtTime = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const bossColor = (k) => (BOSSES[k] && BOSSES[k].mini ? '#ffa45a' : '#ff4d6d');

const CSS = `
#ui{--edge:rgba(150,240,255,.22);--cyan:#5ff6ff;--aqua:#3ff5d0;--ink:#e8fbff;--dim:rgba(210,245,255,.62);--red:#ff4d6d;--gold:#ffd66b;
  --mono:'JetBrains Mono',ui-monospace,monospace;-webkit-font-smoothing:antialiased;overflow:hidden}
#ui *{box-sizing:border-box}
#ui .ad-i{pointer-events:auto}
#ui .glass{background:linear-gradient(160deg,rgba(40,120,150,.30),rgba(6,30,48,.42));border:1px solid var(--edge);
  backdrop-filter:blur(10px) saturate(140%);-webkit-backdrop-filter:blur(10px) saturate(140%);
  box-shadow:0 8px 30px rgba(0,10,20,.35),inset 0 1px 0 rgba(255,255,255,.12),0 0 24px rgba(80,230,255,.08);border-radius:18px}

/* ---------- screens ---------- */
.ad-screen{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
  opacity:0;visibility:hidden;transition:opacity .7s ease,visibility 0s linear .7s,transform .7s cubic-bezier(.2,.8,.2,1);transform:scale(1.04);
  padding:16px;text-align:center}
.ad-screen.show{opacity:1;visibility:visible;transform:none;transition:opacity .7s ease,visibility 0s,transform .7s cubic-bezier(.2,.8,.2,1)}
.ad-screen.dead.show{transition-delay:.85s,.85s,.85s}

.ad-title{background:radial-gradient(ellipse at 50% 35%,rgba(2,20,34,0) 0%,rgba(2,16,28,.35) 60%,rgba(1,8,16,.75) 100%)}
.ad-rays{position:absolute;inset:-20% -10% 30% -10%;pointer-events:none;opacity:.5;mix-blend-mode:screen;
  background:repeating-linear-gradient(100deg,rgba(160,255,255,0) 0 60px,rgba(160,255,255,.07) 80px,rgba(160,255,255,0) 120px);
  -webkit-mask-image:linear-gradient(#000,transparent);mask-image:linear-gradient(#000,transparent);animation:adRays 14s ease-in-out infinite alternate}
@keyframes adRays{from{transform:translateX(-4%) skewX(-4deg)}to{transform:translateX(4%) skewX(4deg)}}
.ad-logo{font-weight:700;font-size:clamp(44px,11vw,124px);line-height:.95;letter-spacing:.04em;margin:0;white-space:nowrap;
  filter:drop-shadow(0 0 18px rgba(80,240,255,.45)) drop-shadow(0 6px 0 rgba(0,40,60,.55))}
.ad-logo .w{display:inline-block;margin:0 .14em}
.ad-logo .l{display:inline-block;background:linear-gradient(100deg,#7ffcff 0%,#e9ffff 22%,#3ff5d0 40%,#2bb8ff 62%,#bdfcff 80%,#7ffcff 100%);
  background-size:400% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;
  animation:adWave 3.2s ease-in-out infinite,adShimmer 6s linear infinite;animation-delay:calc(var(--i)*-.16s),calc(var(--i)*-.12s)}
@keyframes adWave{0%,100%{transform:translateY(0) rotate(0)}25%{transform:translateY(-.07em) rotate(-2deg)}75%{transform:translateY(.05em) rotate(1.5deg)}}
@keyframes adShimmer{from{background-position:0% 50%}to{background-position:400% 50%}}
.ad-tag{margin:14px 0 28px;font-size:clamp(16px,3.6vw,24px);color:var(--dim);letter-spacing:.06em}
.ad-tag b{color:var(--ink);font-weight:600}
.ad-tag b:last-child{color:#ff8fa3}
.ad-tag2{margin:-18px 0 26px;font-size:clamp(13px,2.8vw,17px);color:var(--dim);letter-spacing:.04em;font-style:italic}
.ad-goal{color:var(--ink)!important;font-weight:600}
.ad-goal .ad-key{background:rgba(255,226,138,.15);border-color:rgba(255,226,138,.45)}
.ad-btn{font-family:inherit;font-weight:700;font-size:22px;letter-spacing:.08em;color:#032430;cursor:pointer;border:0;
  padding:16px 48px;border-radius:999px;position:relative;overflow:hidden;
  background:linear-gradient(180deg,#9ffcff,#3ff5d0 55%,#22c7c0);box-shadow:0 0 0 3px rgba(160,255,250,.25),0 10px 30px rgba(40,240,220,.35),inset 0 -4px 0 rgba(0,80,90,.25);
  transition:transform .18s cubic-bezier(.3,1.6,.5,1),box-shadow .2s}
.ad-btn:hover{transform:translateY(-2px) scale(1.04);box-shadow:0 0 0 5px rgba(160,255,250,.3),0 14px 40px rgba(40,240,220,.5),inset 0 -4px 0 rgba(0,80,90,.25)}
.ad-btn:active{transform:scale(.97)}
.ad-btn::after{content:"";position:absolute;inset:0;background:linear-gradient(110deg,transparent 30%,rgba(255,255,255,.65) 50%,transparent 70%);
  transform:translateX(-120%);animation:adGleam 3.4s ease-in-out infinite}
@keyframes adGleam{0%,60%{transform:translateX(-120%)}100%{transform:translateX(120%)}}
.ad-btn.ghost{background:rgba(120,230,255,.08);color:var(--ink);box-shadow:inset 0 0 0 1.5px rgba(150,240,255,.45)}
.ad-btn.ghost::after{display:none}
.ad-btn.ghost:hover{background:rgba(120,230,255,.18)}
.ad-btn .k{font-family:var(--mono);font-size:11px;font-weight:500;opacity:.6;margin-left:10px;letter-spacing:0}
.ad-controls{margin-top:30px;padding:16px 22px;max-width:440px;width:100%;text-align:left;font-size:15px;color:var(--dim)}
.ad-controls .row{display:flex;align-items:center;gap:12px;padding:5px 0}
.ad-controls .row+.row{border-top:1px solid rgba(150,240,255,.08)}
.ad-key{flex:0 0 auto;min-width:74px;text-align:center;font-family:var(--mono);font-size:11px;color:var(--ink);padding:4px 8px;border-radius:8px;
  background:rgba(150,240,255,.1);border:1px solid rgba(150,240,255,.25);box-shadow:inset 0 -2px 0 rgba(0,0,0,.25)}
.ad-best{margin-top:18px;font-size:14px;color:var(--dim);letter-spacing:.12em;text-transform:uppercase}
.ad-best span{font-family:var(--mono);color:var(--gold);font-size:16px;margin-left:6px;letter-spacing:0}
.ad-bubbles{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.ad-bub{position:absolute;bottom:-40px;border-radius:50%;
  background:radial-gradient(circle at 32% 30%,rgba(255,255,255,.85) 0 8%,rgba(190,250,255,.25) 22%,rgba(120,220,255,.06) 60%,rgba(170,250,255,.35) 100%);
  box-shadow:inset 0 0 4px rgba(200,255,255,.4);animation:adRise linear infinite}
@keyframes adRise{0%{transform:translate(0,0);opacity:0}8%{opacity:.9}50%{transform:translate(var(--dx),-55vh)}100%{transform:translate(0,-115vh);opacity:0}}

.ad-card{padding:28px 32px 24px;max-width:540px;width:100%;max-height:100%;overflow:auto;animation:adFloat 6s ease-in-out infinite}
@keyframes adFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
.ad-h1{font-weight:700;font-size:clamp(34px,8vw,60px);margin:0 0 4px;line-height:1.05}
.ad-sub{color:var(--dim);font-size:clamp(15px,3.6vw,19px);margin-bottom:18px}
.ad-sub b{color:var(--ink)}
.ad-stats{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin:6px 0 20px}
.ad-stat{padding:9px 12px;border-radius:14px;background:rgba(150,240,255,.06);border:1px solid rgba(150,240,255,.12);text-align:left;min-width:0}
.ad-stat .lbl{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.ad-stat .val{font-family:var(--mono);font-size:19px;color:var(--ink);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ad-stat .val.txt{font-family:'Fredoka',sans-serif;font-weight:600;font-size:18px}
.ad-stat .val small{font-size:12px;color:var(--dim)}
.ad-stat.wide{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between}
.ad-stat.big .val{font-size:30px;color:var(--cyan);text-shadow:0 0 14px rgba(95,246,255,.5)}
.ad-newbest{display:none;font-size:12px;font-weight:700;letter-spacing:.12em;color:#2b1a00;background:linear-gradient(90deg,#ffe28a,#ffb84d);
  padding:4px 10px;border-radius:999px;box-shadow:0 0 18px rgba(255,200,80,.6);animation:adPulse 1s ease-in-out infinite}
.ad-newbest.on{display:inline-block}
@keyframes adPulse{50%{transform:scale(1.08)}}
.ad-btns{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.ad-dead{background:radial-gradient(ellipse at center,rgba(60,0,15,.15),rgba(40,0,10,.65))}
.ad-dead .ad-h1{color:#ff8fa3;text-shadow:0 0 24px rgba(255,60,90,.55)}
.ad-where{font-size:14px;color:var(--dim);margin:-12px 0 16px}
.ad-where b{color:var(--ink)}.ad-where .small{color:#ff8fa3;font-weight:600}
#ui .ad-dead .ad-card{border-color:rgba(255,140,160,.25)}
.ad-vic{background:radial-gradient(ellipse at 50% -10%,rgba(255,240,190,.75),rgba(255,210,120,.35) 30%,rgba(40,140,190,.25) 60%,rgba(4,30,50,.55))}
.ad-vic::before{content:"";position:absolute;inset:0;pointer-events:none;mix-blend-mode:screen;opacity:.6;
  background:repeating-conic-gradient(from 180deg at 50% -10%,rgba(255,245,200,.0) 0deg 6deg,rgba(255,245,200,.22) 8deg 10deg,rgba(255,245,200,0) 12deg 18deg);
  animation:adSun 18s linear infinite}
@keyframes adSun{from{filter:hue-rotate(0)}50%{opacity:.4}to{filter:hue-rotate(0)}}
#ui .ad-vic .ad-card{border-color:rgba(255,230,160,.45);box-shadow:0 0 60px rgba(255,210,120,.25),inset 0 1px 0 rgba(255,255,255,.3)}
.ad-vic .ad-h1{background:linear-gradient(100deg,#ffe8a3,#fff,#ffcf5a,#b48cff,#ffe8a3);background-size:300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;
  animation:adShimmer 5s linear infinite;filter:drop-shadow(0 2px 0 rgba(90,45,0,.75)) drop-shadow(0 0 18px rgba(255,190,80,.6))}
.ad-screen .eyebrow{font-size:12px;letter-spacing:.3em;text-transform:uppercase;color:var(--dim);margin-bottom:6px}
.ad-pause{background:rgba(2,14,24,.5);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}
.ad-pause .ad-h1{letter-spacing:.2em}
.ad-hint{margin-top:16px;font-size:13px;color:var(--dim)}

/* ---------- HUD ---------- */
.ad-hud{position:absolute;inset:0;opacity:0;visibility:hidden;transition:opacity .6s,visibility 0s linear .6s}
.ad-hud.show{opacity:1;visibility:visible;transition:opacity .6s .2s,visibility 0s}
.ad-tl{position:absolute;left:16px;top:16px;padding:12px 16px 14px;width:min(300px,calc(50vw - 24px))}
.ad-tierrow{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.ad-tier{font-weight:700;font-size:22px;overflow:hidden;text-overflow:ellipsis;color:var(--ink);text-shadow:0 0 12px rgba(95,246,255,.4);white-space:nowrap}
.ad-next{font-size:12px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ad-bar{position:relative;height:10px;margin-top:8px;border-radius:99px;background:rgba(0,20,30,.5);box-shadow:inset 0 1px 3px rgba(0,0,0,.5);overflow:hidden}
.ad-fill{position:absolute;inset:0;transform-origin:0 50%;transform:scaleX(0);border-radius:99px;
  background:linear-gradient(90deg,#1fb6ff,#3ff5d0 70%,#c6fff5);box-shadow:0 0 12px rgba(63,245,208,.7);transition:transform .35s cubic-bezier(.2,.9,.3,1)}
.ad-fill::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);
  background-size:40% 100%;background-repeat:no-repeat;animation:adBarGleam 2.4s linear infinite}
@keyframes adBarGleam{from{background-position:-60% 0}to{background-position:160% 0}}
.ad-pips{display:flex;gap:4px;margin-top:8px}
.ad-tl .ad-fill{transition:transform .35s cubic-bezier(.2,.9,.3,1),filter .6s}
.ad-tl.lowval .ad-fill{filter:saturate(.25) brightness(.65);box-shadow:none}
.ad-tl.lowval .ad-fill::after{animation:none;opacity:0}
.ad-pip{flex:1;height:3px;border-radius:2px;background:rgba(150,240,255,.15);transition:background .4s,box-shadow .4s}
.ad-pip.on{background:var(--aqua);box-shadow:0 0 6px var(--aqua)}
.ad-tr{position:absolute;right:16px;top:16px;display:flex;flex-direction:column;align-items:flex-end;gap:10px}
.ad-btnrow{display:flex;gap:8px;margin-right:50px}
.ad-mute{position:absolute;right:16px;top:16px;z-index:5}
#ui .ad-icon{width:42px;height:42px;border-radius:50%;display:grid;place-items:center;cursor:pointer;color:var(--ink);padding:0;transition:transform .15s,background .2s}
#ui .ad-icon:hover{transform:scale(1.08);background:rgba(60,160,190,.4)}
.ad-icon svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.ad-icon .x{display:none}.ad-icon.muted .x{display:inline}.ad-icon.muted .wv{display:none}
.ad-scorebox{padding:10px 16px;text-align:right;min-width:150px}
.ad-score{font-family:var(--mono);font-size:30px;line-height:1;color:var(--ink);text-shadow:0 0 14px rgba(95,246,255,.5);display:inline-block}
.ad-eaten{font-size:13px;color:var(--dim);margin-top:5px}
.ad-eaten span{font-family:var(--mono);color:var(--ink)}
.ad-bl{position:absolute;left:16px;bottom:16px;padding:10px 14px;display:flex;align-items:center;gap:12px}
.ad-depth{font-family:var(--mono);font-size:24px;color:var(--ink);line-height:1}
.ad-depth small{font-size:13px;color:var(--dim);margin-left:3px}
.ad-mood{font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--dim);margin-bottom:3px}
.ad-biome{font-size:14px;font-weight:600;color:var(--ink);margin-top:4px;white-space:nowrap;transition:color .6s}
.ad-dash{--p:1;width:44px;height:44px;border-radius:50%;position:relative;display:grid;place-items:center;
  background:conic-gradient(var(--aqua) calc(var(--p)*360deg),rgba(150,240,255,.12) 0);transition:box-shadow .3s}
.ad-dash::before{content:"";position:absolute;inset:4px;border-radius:50%;background:rgba(4,28,42,.9)}
.ad-dash svg{position:relative;width:20px;height:20px;fill:var(--aqua);opacity:.45;transition:opacity .2s}
.ad-dash.ready{box-shadow:0 0 14px rgba(63,245,208,.6)}
.ad-dash.ready svg{opacity:1}
.ad-dash.hide{display:none}

/* bottom-right: radar */
.ad-br{position:absolute;right:16px;bottom:16px;display:flex;flex-direction:column;align-items:flex-end;gap:10px}
#ui .ad-radar{position:relative;width:120px;height:120px;border-radius:50%;padding:0;overflow:hidden}
.ad-radar canvas{position:absolute;inset:0;width:100%;height:100%}
.ad-sweep{position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 0deg,rgba(95,246,255,0) 0deg,rgba(95,246,255,0) 300deg,rgba(95,246,255,.28) 358deg,rgba(200,255,255,.6) 360deg);
  animation:adSpin 3s linear infinite;mix-blend-mode:screen}
@keyframes adSpin{to{transform:rotate(360deg)}}
.ad-radar::after{content:"";position:absolute;inset:0;border-radius:50%;box-shadow:inset 0 0 20px rgba(0,0,0,.45),inset 0 0 0 1px rgba(150,240,255,.2)}
/* danger */
.ad-danger{position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .4s;
  box-shadow:inset 0 0 90px rgba(255,40,70,.45);animation:adBeat .9s ease-in-out infinite}
.ad-danger.on{opacity:1}
@keyframes adBeat{0%,100%{filter:brightness(.7)}15%{filter:brightness(1.3)}35%{filter:brightness(.85)}50%{filter:brightness(1.15)}}
.ad-dangertag{position:absolute;left:50%;bottom:150px;transform:translateX(-50%);font-weight:700;letter-spacing:.4em;font-size:13px;color:#ffd0d8;
  padding:5px 12px 5px 17px;border-radius:999px;background:rgba(120,0,25,.45);border:1px solid rgba(255,90,120,.5);
  box-shadow:0 0 20px rgba(255,50,80,.5);opacity:0;transition:opacity .3s}
.ad-dangertag.on{opacity:1;animation:adPulseC .9s ease-in-out infinite}
@keyframes adPulseC{50%{transform:translateX(-50%) scale(1.1)}}

/* threat arrows */
.ad-arrow{position:absolute;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;opacity:0;will-change:transform,opacity}
.ad-arrow i{position:absolute;inset:0;background:linear-gradient(90deg,#ff2d55,#ff8a7a);
  clip-path:polygon(100% 50%,15% 6%,34% 50%,15% 94%);filter:drop-shadow(0 0 6px rgba(255,40,70,.9))}
.ad-arrow.boss i{background:linear-gradient(90deg,#b48cff,#ffd66b);filter:drop-shadow(0 0 8px rgba(255,210,100,.9))}
.ad-arrow.hunt i{animation:adArrowP .45s ease-in-out infinite alternate}
@keyframes adArrowP{from{opacity:.6}to{opacity:1}}

/* banners */
.ad-banner{position:absolute;left:50%;top:13%;transform:translate(-50%,-14px);text-align:center;opacity:0;
  transition:opacity .9s ease,transform 1.2s cubic-bezier(.2,.8,.2,1);white-space:nowrap}
.ad-banner.on{opacity:1;transform:translate(-50%,0)}
.ad-banner .eyebrow{font-size:12px;letter-spacing:.42em;text-transform:uppercase;color:var(--dim)}
.ad-banner .name{font-weight:700;font-size:clamp(30px,7vw,52px);line-height:1.1;color:var(--ink);text-shadow:0 0 22px var(--bc,#5ff6ff),0 2px 0 rgba(0,0,0,.3)}
.ad-banner .line{height:1px;width:0;margin:8px auto;background:linear-gradient(90deg,transparent,var(--bc,#5ff6ff),transparent);transition:width 1.4s cubic-bezier(.2,.8,.2,1) .2s}
.ad-banner.on .line{width:100%}
.ad-banner .meta{font-family:var(--mono);font-size:14px;color:var(--dim)}
.ad-banner .bonus{font-size:15px;color:var(--gold);margin-top:6px;display:none;white-space:normal;max-width:calc(100vw - 32px)}
.ad-banner .bonus.on{display:block}
.ad-tierup{position:absolute;left:50%;top:54%;transform:translate(-50%,-50%) scale(.6);opacity:0;padding:16px 30px 18px;text-align:center;white-space:nowrap;
  transition:opacity .35s,transform .55s cubic-bezier(.25,1.7,.45,1)}
.ad-tierup.on{opacity:1;transform:translate(-50%,-50%) scale(1)}
.ad-tierup .eyebrow{font-size:13px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim)}
.ad-tierup .name{font-weight:700;font-size:clamp(30px,7vw,48px);letter-spacing:.08em;line-height:1.1;
  background:linear-gradient(100deg,#c6fff5,#3ff5d0,#ffffff,#5ff6ff,#c6fff5);background-size:300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;
  animation:adShimmer 2.5s linear infinite;filter:drop-shadow(0 0 12px rgba(63,245,208,.7))}
.ad-tierup .perk{font-size:14px;color:var(--dim);margin-top:4px}
.ad-tierup .eyebrow b{color:#fff;letter-spacing:.3em}
.ad-ring{position:absolute;left:50%;top:50%;width:120px;height:120px;margin:-60px;border-radius:50%;border:2px solid rgba(95,246,255,.8);opacity:0;pointer-events:none}
.ad-tierup.on .ad-ring{animation:adRing 1s ease-out}
@keyframes adRing{from{transform:scale(.4);opacity:1}to{transform:scale(3.4);opacity:0}}

/* boss: letterbox + name card */
.ad-lbox{position:absolute;left:0;right:0;height:11vh;background:#000;transition:transform .7s cubic-bezier(.6,0,.2,1);pointer-events:none;z-index:2}
.ad-lbox.t{top:0;transform:translateY(-101%)}.ad-lbox.b{bottom:0;transform:translateY(101%)}
.ad-cine .ad-lbox{transform:none}
.ad-bosscard{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);text-align:center;opacity:0;pointer-events:none;z-index:3;width:max-content;max-width:calc(100vw - 32px)}
.ad-bosscard .eyebrow{font-size:13px;letter-spacing:.5em;text-transform:uppercase;color:var(--bc);opacity:0;transform:translateY(10px)}
.ad-bosscard .name{font-weight:700;font-size:clamp(40px,10vw,96px);line-height:1;letter-spacing:.06em;color:#fff;white-space:nowrap;
  text-shadow:0 0 30px var(--bc),0 0 60px var(--bc),0 4px 0 rgba(0,0,0,.6);opacity:0;transform:scale(1.6);letter-spacing:.5em;filter:blur(8px)}
.ad-bosscard .sub{font-size:clamp(15px,3vw,22px);color:var(--dim);font-style:italic;margin-top:10px;opacity:0}
.ad-bosscard .slash{height:2px;width:0;margin:14px auto 0;background:linear-gradient(90deg,transparent,var(--bc),transparent)}
.ad-bosscard.on{opacity:1}
.ad-bosscard.on .eyebrow{opacity:1;transform:none;transition:all .6s ease .2s}
.ad-bosscard.on .name{opacity:1;transform:none;letter-spacing:.06em;filter:none;transition:all .9s cubic-bezier(.2,.8,.2,1) .35s}
.ad-bosscard.on .sub{opacity:1;transition:opacity .8s 1s}
.ad-bosscard.on .slash{width:100%;transition:width 1s cubic-bezier(.2,.8,.2,1) .7s}
.ad-bosscard.out{opacity:0;transition:opacity .6s}
.ad-bosscard.mini{top:42%}
.ad-bosscard.mini .name{font-size:clamp(30px,6.5vw,56px)}

/* boss HP bar */
.ad-boss{position:absolute;left:50%;bottom:22px;width:min(560px,calc(100vw - 520px));min-width:260px;transform:translate(-50%,30px);opacity:0;
  transition:opacity .5s,transform .6s cubic-bezier(.2,.8,.2,1);text-align:center;z-index:4}
.ad-boss.on{opacity:1;transform:translate(-50%,0)}
.ad-boss .nm{font-weight:700;font-size:16px;letter-spacing:.24em;text-transform:uppercase;color:#fff;text-shadow:0 0 12px var(--bc);margin-bottom:6px}
.ad-boss .nm small{font-size:11px;letter-spacing:.2em;color:var(--dim);margin-left:8px}
.ad-hp{position:relative;height:16px;border-radius:10px;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.18);overflow:hidden;
  box-shadow:0 0 20px rgba(0,0,0,.5),inset 0 2px 4px rgba(0,0,0,.6)}
.ad-hp .lag,.ad-hp .cur{position:absolute;inset:0;transform-origin:0 50%}
.ad-hp .lag{background:#fff;transition:transform .6s cubic-bezier(.4,0,.2,1) .35s}
.ad-hp .cur{background:linear-gradient(180deg,#ff8a9a,#e8263f 55%,#a0102a);box-shadow:0 0 14px rgba(255,40,70,.7);transition:transform .12s}
.ad-boss.final .ad-hp .cur{background:linear-gradient(180deg,#d9b8ff,#8a4dff 55%,#4b1aa8)}
.ad-boss.mini .ad-hp .cur{background:linear-gradient(180deg,#ffc38a,#ff7b1c 55%,#b84a00)}
.ad-hp .seg{position:absolute;inset:0;background-image:linear-gradient(90deg,rgba(0,0,0,.55) 0 2px,transparent 2px);background-size:calc(100% / var(--n)) 100%;pointer-events:none}
.ad-hp.hit{animation:adHit .35s}
@keyframes adHit{0%{transform:translateX(0)}20%{transform:translateX(-6px)}40%{transform:translateX(5px)}60%{transform:translateX(-3px)}100%{transform:none}}
.ad-bite{position:absolute;left:50%;bottom:100%;margin-bottom:12px;transform:translateX(-50%) scale(.5);opacity:0;font-weight:700;font-size:clamp(28px,5vw,42px);
  letter-spacing:.08em;color:#fff3c4;text-shadow:0 0 16px #ffb84d,0 0 34px #ff7b1c,0 3px 0 #7a3a00;transition:opacity .15s,transform .25s cubic-bezier(.3,1.8,.5,1);white-space:nowrap}
.ad-bite.on{opacity:1;transform:translateX(-50%) scale(1);animation:adBite .5s ease-in-out infinite alternate .25s}
@keyframes adBite{from{transform:translateX(-50%) scale(1)}to{transform:translateX(-50%) scale(1.12)}}
.ad-defeat{position:absolute;left:50%;top:32%;transform:translate(-50%,-50%) scale(.4);opacity:0;text-align:center;pointer-events:none;z-index:3;white-space:nowrap}
.ad-defeat.on{opacity:1;transform:translate(-50%,-50%) scale(1);transition:opacity .25s,transform .7s cubic-bezier(.25,1.7,.45,1)}
.ad-defeat.out{opacity:0;transform:translate(-50%,-60%) scale(1.05);transition:opacity .9s,transform .9s}
.ad-defeat .big{font-weight:700;font-size:clamp(46px,11vw,110px);letter-spacing:.1em;line-height:1;
  background:linear-gradient(100deg,#fff6d0,#ffd66b,#fff,#ffb84d,#fff6d0);background-size:300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;
  animation:adShimmer 2s linear infinite;filter:drop-shadow(0 0 20px rgba(255,190,80,.8))}
.ad-defeat .who{font-size:clamp(16px,3.4vw,24px);color:var(--ink);margin-top:6px;letter-spacing:.1em}
.ad-defeat .rw{font-family:var(--mono);font-size:15px;color:var(--gold);margin-top:6px}
.ad-defeat .burst{position:absolute;left:50%;top:50%;width:200px;height:200px;margin:-100px;border-radius:50%;pointer-events:none;
  background:radial-gradient(circle,rgba(255,220,130,.7),rgba(255,180,60,0) 65%);opacity:0}
.ad-defeat.on .burst{animation:adBurst 1.1s ease-out}
@keyframes adBurst{from{transform:scale(.2);opacity:1}to{transform:scale(5);opacity:0}}

/* formation waves */
.ad-wchev{position:absolute;left:0;top:0;width:46px;height:40px;margin:-20px 0 0 -23px;opacity:0;transition:opacity .35s;will-change:transform,opacity}
.ad-wchev.on{opacity:1}
.ad-wchev .in{position:absolute;inset:0;animation:adWPulse var(--wp,.6s) ease-in-out infinite alternate}
.ad-wchev i{position:absolute;top:0;width:24px;height:40px;background:linear-gradient(90deg,#ff9a3c,#ff2d55);
  clip-path:polygon(0 0,45% 0,100% 50%,45% 100%,0 100%,55% 50%);filter:drop-shadow(0 0 8px rgba(255,90,40,.95))}
.ad-wchev i:first-child{left:0;opacity:.6}.ad-wchev i:last-child{left:20px}
@keyframes adWPulse{from{transform:translateX(-5px) scale(.92);opacity:.65}to{transform:translateX(3px) scale(1.08);opacity:1}}
.ad-wchev .cd{position:absolute;left:50%;top:100%;margin-top:4px;width:40px;height:4px;transform:translateX(-50%);border-radius:2px;background:rgba(0,0,0,.45);overflow:hidden}
.ad-wchev .cd b{position:absolute;inset:0;background:#ffb03c;transform-origin:0 50%;box-shadow:0 0 6px #ff9a3c}
.ad-wwarn{position:absolute;left:50%;top:18px;transform:translate(-50%,-12px);opacity:0;padding:8px 18px 10px;border-radius:14px;text-align:center;white-space:nowrap;
  background:linear-gradient(180deg,rgba(150,30,10,.62),rgba(90,10,20,.55));border:1px solid rgba(255,140,80,.6);box-shadow:0 0 26px rgba(255,90,40,.45);
  font-weight:700;font-size:17px;letter-spacing:.06em;color:#ffe6cf;transition:opacity .3s,transform .4s cubic-bezier(.2,.8,.2,1);z-index:4}
.ad-wwarn.on{opacity:1;transform:translate(-50%,0);animation:adWShake .5s ease-in-out infinite}
@keyframes adWShake{0%,100%{margin-left:0}25%{margin-left:-2px}75%{margin-left:2px}}
.ad-wwarn .bar{height:3px;margin-top:6px;border-radius:2px;background:rgba(0,0,0,.4);overflow:hidden}
.ad-wwarn .bar b{display:block;height:100%;background:linear-gradient(90deg,#ffd66b,#ff7b1c);transform-origin:0 50%}
.ad-dodge{position:absolute;left:50%;top:22px;transform:translate(-50%,0) scale(.7);opacity:0;font-weight:700;font-size:clamp(26px,4.5vw,38px);letter-spacing:.2em;
  color:#fff1d6;text-shadow:0 0 16px #ff7b1c,0 0 30px rgba(255,80,40,.8),0 3px 0 rgba(90,20,0,.7);pointer-events:none;z-index:4}
.ad-dodge.on{animation:adDodge 1.1s ease-out forwards}
@keyframes adDodge{0%{opacity:0;transform:translate(-50%,0) scale(.6)}15%{opacity:1;transform:translate(-50%,0) scale(1.12)}30%{transform:translate(-50%,0) scale(1)}70%{opacity:1}100%{opacity:0;transform:translate(-50%,-10px) scale(1)}}
.ad-wavecard{position:absolute;left:50%;top:34%;transform:translate(-50%,-50%) scale(.5);opacity:0;text-align:center;pointer-events:none;z-index:3;white-space:nowrap}
.ad-wavecard.on{opacity:1;transform:translate(-50%,-50%) scale(1);transition:opacity .25s,transform .6s cubic-bezier(.25,1.7,.45,1)}
.ad-wavecard.out{opacity:0;transform:translate(-50%,-60%) scale(1.04);transition:opacity .7s,transform .7s}
.ad-wavecard .eyebrow{font-size:12px;letter-spacing:.4em;text-transform:uppercase;color:var(--dim)}
.ad-wavecard .big{font-weight:700;font-size:clamp(38px,8vw,72px);letter-spacing:.08em;line-height:1.05;
  background:linear-gradient(100deg,#c6fff5,#3ff5d0,#fff,#ffd66b,#c6fff5);background-size:300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;
  animation:adShimmer 2s linear infinite;filter:drop-shadow(0 0 14px rgba(63,245,208,.7)) drop-shadow(0 2px 0 rgba(0,40,40,.6))}
.ad-wavecard .rw{font-family:var(--mono);font-size:17px;color:var(--gold);margin-top:6px;text-shadow:0 0 10px rgba(255,200,80,.6)}
.ad-wavecard .rw small{font-family:'Fredoka',sans-serif;font-size:14px;color:#5dff9b;margin-left:10px}
.ad-wavecard .burst{position:absolute;left:50%;top:50%;width:180px;height:180px;margin:-90px;border-radius:50%;border:3px solid rgba(63,245,208,.8);opacity:0}
.ad-wavecard.on .burst{animation:adRing .9s ease-out}

/* toasts / floating */
.ad-toast{position:absolute;left:50%;bottom:192px;transform:translate(-50%,16px);opacity:0;padding:9px 18px 9px 14px;border-radius:999px!important;
  font-size:15px;color:var(--ink);white-space:nowrap;transition:opacity .45s,transform .55s cubic-bezier(.2,.8,.2,1);display:flex;align-items:center;gap:10px;max-width:calc(100vw - 32px)}
.ad-toast.on{opacity:1;transform:translate(-50%,0)}
.ad-toast i{width:20px;height:20px;flex:0 0 auto;border-radius:50%;display:grid;place-items:center;font-style:normal;font-weight:700;font-size:12px;color:#032430;background:var(--aqua);box-shadow:0 0 10px var(--aqua)}
.ad-toast span{white-space:normal}
.ad-float small{font-family:'Fredoka',sans-serif;font-weight:600;font-size:.62em;margin-left:.35em;letter-spacing:.04em}
.ad-float.low{text-shadow:0 1px 2px rgba(0,0,0,.7)}
.ad-float{position:absolute;left:0;top:0;font-family:var(--mono);font-weight:500;color:#eafff9;white-space:nowrap;opacity:0;will-change:transform,opacity;
  text-shadow:0 0 8px rgba(63,245,208,.9),0 2px 0 rgba(0,40,40,.6)}
.ad-callout{position:absolute;left:50%;top:62%;transform:translate(-50%,0);font-weight:700;font-size:20px;letter-spacing:.1em;color:#ffe0a8;opacity:0;
  text-shadow:0 0 14px rgba(255,170,60,.8);transition:opacity .25s,transform .6s cubic-bezier(.2,.8,.2,1)}
.ad-callout.on{opacity:1;transform:translate(-50%,-14px)}

@media (max-width:900px){.ad-boss{width:min(560px,calc(100vw - 32px));bottom:auto;top:150px;transform:translate(-50%,-20px)} .ad-boss.on{transform:translate(-50%,0)}
  .ad-bite{bottom:auto;top:100%;margin:14px 0 0}
  .ad-bossing .ad-banner{top:250px}}
@media (max-width:640px){.ad-boss{top:118px}.ad-bossing .ad-banner{top:220px}.ad-boss .nm{font-size:13px}}
@media (max-width:640px){
  .ad-wwarn{top:auto;bottom:118px;font-size:14px}.ad-dodge{top:auto;bottom:150px}
  .ad-tl{left:10px;top:10px;padding:9px 12px 10px}
  .ad-tier{font-size:17px}.ad-next{display:none}
  .ad-tr{right:10px;top:10px;gap:6px}
  #ui .ad-icon{width:36px;height:36px}
  .ad-mute{right:10px;top:10px}.ad-btnrow{margin-right:42px}
  .ad-scorebox{padding:8px 12px;min-width:0}
  .ad-score{font-size:22px}
  .ad-bl{left:10px;bottom:10px;padding:8px 10px;gap:9px}
  .ad-depth{font-size:18px}.ad-biome{font-size:12px}
    .ad-dash{width:36px;height:36px}
  .ad-br{right:10px;bottom:10px;gap:8px}
  #ui .ad-radar{width:86px;height:86px}
  .ad-controls{font-size:13px;padding:12px 14px;margin-top:22px}
  .ad-key{min-width:62px;font-size:10px}
  .ad-btn{font-size:19px;padding:14px 36px}
  .ad-card{padding:20px 16px 16px}
  .ad-stat .val{font-size:16px}.ad-stat.big .val{font-size:24px}
  .ad-dangertag{bottom:196px}
  .ad-toast{bottom:236px;font-size:13px}
  .ad-banner{top:17%}
}
@media (max-height:560px){.ad-controls{display:none}.ad-tag{margin:8px 0 16px}}
@media (prefers-reduced-motion:reduce){#ui *{animation-duration:0s!important;animation-iteration-count:1!important}}
`;

const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M9 5v14M15 5v14"/></svg>';
const ICON_SOUND = '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path class="wv" d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/><path class="x" d="M17 9l5 6M22 9l-5 6"/></svg>';
const ICON_DASH = '<svg viewBox="0 0 24 24"><path d="M13 2L4 14h6l-1 8 9-12h-6z"/></svg>';

export function createUI({ bus, camera, state }) {
  const root = document.getElementById('ui') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'ui' }));
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const el = (tag, cls, html, parent = root) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    parent.appendChild(e);
    return e;
  };
  const q = (p, s) => p.querySelector(s);

  // ---------- danger layer + arrows ----------
  const danger = el('div', 'ad-danger');
  const arrowLayer = el('div', '');
  arrowLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none';
  const ARROWS = 6;
  const arrows = [];
  for (let i = 0; i < ARROWS; i++) arrows.push({ el: el('div', 'ad-arrow', '<i></i>', arrowLayer), vis: false, hunt: false, boss: false });

  // ---------- floating text pool ----------
  const floatLayer = el('div', '');
  floatLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none';
  const FLOATS = 20;
  const floats = [];
  for (let i = 0; i < FLOATS; i++) floats.push({ el: el('div', 'ad-float', '', floatLayer), pos: new THREE.Vector3(), life: 0, dur: 1.1, active: false });
  let floatCursor = 0;
  const callout = el('div', 'ad-callout', 'CLOSE CALL!');

  // ---------- formation-wave UI ----------
  const waveLayer = el('div', '');
  waveLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none';
  const WCHEV = 8;
  const wchev = [];
  for (let i = 0; i < WCHEV; i++) {
    const e = el('div', 'ad-wchev', '<div class="in"><i></i><i></i></div><div class="cd"><b></b></div>', waveLayer);
    wchev.push({ el: e, cd: e.querySelector('.cd b'), on: false });
  }
  const wwarn = el('div', 'ad-wwarn', '<span></span><div class="bar"><b></b></div>');
  const wwarnTxt = wwarn.querySelector('span'), wwarnBar = wwarn.querySelector('.bar b');
  const dodge = el('div', 'ad-dodge', 'DODGE!');
  const waveCard = el('div', 'ad-wavecard', '<div class="burst"></div><div class="eyebrow">Formation dodged</div><div class="big">WAVE CLEARED</div><div class="rw"></div>');
  const waveRw = waveCard.querySelector('.rw');

  // ---------- HUD ----------
  const hud = el('div', 'ad-hud');
  const tl = el('div', 'ad-tl glass', `
    <div class="ad-tierrow"><div class="ad-tier">Fry</div><div class="ad-next"></div></div>
    <div class="ad-bar"><div class="ad-fill"></div></div>
    <div class="ad-pips">${TIERS.slice(1).map(() => '<div class="ad-pip"></div>').join('')}</div>`, hud);
  const tierEl = q(tl, '.ad-tier'), nextEl = q(tl, '.ad-next'), fillEl = q(tl, '.ad-fill');
  const pips = [...tl.querySelectorAll('.ad-pip')];

  const tr = el('div', 'ad-tr', null, hud);
  const btnRow = el('div', 'ad-btnrow', null, tr);
  const pauseBtn = el('button', 'ad-icon glass ad-i', ICON_PAUSE, btnRow);
  pauseBtn.title = 'Pause (Esc)';
  pauseBtn.addEventListener('click', (e) => { e.stopPropagation(); bus.emit('pause', true); });
  const scoreBox = el('div', 'ad-scorebox glass', '<div class="ad-score">0</div><div class="ad-eaten"><span>0</span> fish eaten</div>', tr);
  const scoreEl = q(scoreBox, '.ad-score'), eatenEl = q(scoreBox, '.ad-eaten span');

  const bl = el('div', 'ad-bl glass', `
    <div><div class="ad-mood">Swum</div><div class="ad-depth">0<small>m</small></div><div class="ad-biome">Open Ocean</div></div>
    <div class="ad-dash hide" title="Dash (Space / right-click)">${ICON_DASH}</div>`, hud);
  const distEl = q(bl, '.ad-depth'), regionEl = q(bl, '.ad-biome'), dashEl = q(bl, '.ad-dash');

  const br = el('div', 'ad-br', null, hud);
  const radar = el('div', 'ad-radar glass', '<canvas></canvas><div class="ad-sweep"></div>', br);
  const rCanvas = q(radar, 'canvas');
  const rctx = rCanvas.getContext('2d');

  const dangerTag = el('div', 'ad-dangertag', 'DANGER', hud);
  const toast = el('div', 'ad-toast glass', '<i>i</i><span></span>', hud);
  const toastText = q(toast, 'span');

  const muteBtn = el('button', 'ad-icon glass ad-i ad-mute', ICON_SOUND);
  muteBtn.title = 'Mute (M)';
  muteBtn.addEventListener('click', (e) => { e.stopPropagation(); bus.emit('toggleMute'); });
  bus.on('muteChanged', (p) => muteBtn.classList.toggle('muted', !!(p && p.muted)));

  // ---------- banners ----------
  const banner = el('div', 'ad-banner', '<div class="eyebrow">Entering</div><div class="name"></div><div class="line"></div><div class="meta"></div><div class="bonus"></div>');
  const bName = q(banner, '.name'), bMeta = q(banner, '.meta'), bBonus = q(banner, '.bonus'), bEyebrow = q(banner, '.eyebrow');
  const tierUp = el('div', 'ad-tierup glass', '<div class="ad-ring"></div><div class="eyebrow"><b>EVOLVED</b></div><div class="name"></div><div class="perk"></div>');
  const tuName = q(tierUp, '.name'), tuPerk = q(tierUp, '.perk');

  // ---------- boss UI ----------
  const lbT = el('div', 'ad-lbox t'), lbB = el('div', 'ad-lbox b');
  void lbT; void lbB;
  const bossCard = el('div', 'ad-bosscard', '<div class="eyebrow"></div><div class="name"></div><div class="slash"></div><div class="sub"></div>');
  const bcEye = q(bossCard, '.eyebrow'), bcName = q(bossCard, '.name'), bcSub = q(bossCard, '.sub');
  const bossBar = el('div', 'ad-boss', '<div class="ad-bite">BITE NOW!</div><div class="nm"></div><div class="ad-hp"><div class="lag"></div><div class="cur"></div><div class="seg"></div></div>');
  const bbName = q(bossBar, '.nm'), hpEl = q(bossBar, '.ad-hp'), hpCur = q(bossBar, '.cur'), hpLag = q(bossBar, '.lag'), biteEl = q(bossBar, '.ad-bite');
  const defeat = el('div', 'ad-defeat', '<div class="burst"></div><div class="big">DEFEATED</div><div class="who"></div><div class="rw"></div>');
  const dfWho = q(defeat, '.who'), dfRw = q(defeat, '.rw');

  // ---------- title ----------
  const title = el('div', 'ad-screen ad-title', `
    <div class="ad-rays"></div><div class="ad-bubbles"></div>
    <h1 class="ad-logo">${['ABYSS', 'DRIFT'].map((w, wi) => `<span class="w">${[...w].map((c, ci) => `<span class="l" style="--i:${wi * 6 + ci}">${c}</span>`).join('')}</span>`).join(' ')}</h1>
    <div class="ad-tag"><b>Eat.</b> <b>Grow.</b> <b>Evolve.</b> <b>Don't get eaten.</b></div>
    <div class="ad-tag2">An endless sea \u2014 everything grows with you.</div>
    <button class="ad-btn ad-i">PLAY<span class="k">ENTER</span></button>
    <div class="ad-controls glass">
      <div class="row ad-goal"><span class="ad-key">GOAL</span><span>Eat smaller fish and evolve into the Apex \u2014 then keep growing.</span></div>
      <div class="row"><span class="ad-key">CLICK / HOLD</span><span>Steer — your fish can't turn on a dime</span></div>
      <div class="row"><span class="ad-key">W A S D</span><span>Also steers</span></div>
      <div class="row"><span class="ad-key">SPACE / RMB</span><span>Dash</span></div>
      <div class="row"><span class="ad-key">ESC</span><span>Pause</span></div>
    </div>
    <div class="ad-best">Best<span>0</span></div>`);
  const bubbles = q(title, '.ad-bubbles');
  for (let i = 0; i < 18; i++) {
    const b = el('div', 'ad-bub', null, bubbles);
    const s = 6 + Math.random() * 22;
    b.style.cssText = `left:${Math.random() * 100}%;width:${s}px;height:${s}px;--dx:${(Math.random() * 60 - 30).toFixed(0)}px;` +
      `animation-duration:${(7 + Math.random() * 9).toFixed(1)}s;animation-delay:${(-Math.random() * 14).toFixed(1)}s`;
  }
  q(title, '.ad-btn').addEventListener('click', (e) => { e.stopPropagation(); bus.emit('start'); });
  const titleBest = q(title, '.ad-best'), titleBestVal = q(titleBest, 'span');

  // ---------- pause ----------
  const pause = el('div', 'ad-screen ad-pause', `
    <div class="ad-h1">PAUSED</div>
    <div class="ad-sub">The ocean holds its breath.</div>
    <button class="ad-btn ad-i">RESUME<span class="k">ESC</span></button>
    <div class="ad-hint"></div>`);
  q(pause, '.ad-btn').addEventListener('click', (e) => { e.stopPropagation(); bus.emit('pause', false); });
  const pauseHint = q(pause, '.ad-hint');
  const HINTS = [
    'Tip: start your turns early \u2014 big fish carve wide arcs.',
    'Tip: dash to close the gap on fleeing prey, or to escape a charge.',
    'Tip: red arrows at the screen edge point at big things nearby.',
    'Tip: big fish swim in straight lines \u2014 step out of their path.',
    'Tip: tiny prey barely feeds you. Hunt things close to your size.',
    'Tip: idling makes you hungry \u2014 keep eating to keep your size.',
    "Tip: bosses are too big to swallow. Bite them when they're stunned.",
  ];

  // ---------- stats (dead + victory) ----------
  const statsHTML = `
    <div class="ad-stats">
      <div class="ad-stat wide big"><div><div class="lbl">Score</div><div class="val" data-k="score">0</div></div><span class="ad-newbest">NEW BEST</span></div>
      <div class="ad-stat"><div class="lbl">Best</div><div class="val" data-k="best">0</div></div>
      <div class="ad-stat"><div class="lbl">Fish eaten</div><div class="val" data-k="eaten">0</div></div>
      <div class="ad-stat"><div class="lbl">Evolution</div><div class="val txt" data-k="tier">Microbe</div></div>
      <div class="ad-stat"><div class="lbl">Max size</div><div class="val" data-k="size">1.0</div></div>
      <div class="ad-stat"><div class="lbl">Distance</div><div class="val" data-k="dist">0</div></div>
      <div class="ad-stat"><div class="lbl">Regions seen</div><div class="val" data-k="regions">1</div></div>
      <div class="ad-stat"><div class="lbl">Bosses slain</div><div class="val" data-k="bosses">0</div></div>
      <div class="ad-stat"><div class="lbl">Waves cleared</div><div class="val" data-k="waves">0</div></div>
      <div class="ad-stat"><div class="lbl">Time</div><div class="val" data-k="time">0:00</div></div>
    </div>`;
  const nBosses = Object.keys(BOSSES).length;
  const fillStats = (scr) => {
    const set = (k, v) => { q(scr, `[data-k="${k}"]`).innerHTML = v; };
    set('score', fmtInt(state.score)); set('best', fmtInt(state.best)); set('eaten', fmtInt(state.eaten));
    set('tier', `${TIERS[state.tier] ? TIERS[state.tier].name : '\u2014'}<small> ${(state.tier | 0) + 1}/${TIERS.length}</small>`);
    set('size', `${(state.maxSize || 1).toFixed(1)}<small>\u00d7</small>`);
    set('dist', `${fmtInt(state.distance || 0)}<small> m</small>`);
    set('regions', `${(state.biomesSeen || []).length}<small> / ${BIOMES.length}</small>`);
    set('bosses', `${(state.bossesDefeated || []).length}<small> / ${nBosses}</small>`);
    set('waves', fmtInt(state.wavesCleared || 0));
    set('time', fmtTime(state.runTime));
    q(scr, '.ad-newbest').classList.toggle('on', state.score > 0 && state.score > runStartBest);
  };

  const dead = el('div', 'ad-screen dead ad-dead', `
    <div class="ad-card glass">
      <div class="eyebrow">Game over</div>
      <div class="ad-h1">EATEN</div>
      <div class="ad-sub">by <b data-k="killer">a shark</b></div>
      <div class="ad-where" data-k="where"></div>
      ${statsHTML}
      <div class="ad-btns"><button class="ad-btn ad-i">SWIM AGAIN<span class="k">ENTER</span></button></div>
    </div>`);
  q(dead, '.ad-btn').addEventListener('click', (e) => { e.stopPropagation(); bus.emit('restart'); });
  const killerEl = q(dead, '[data-k="killer"]'), whereEl = q(dead, '[data-k="where"]');

  const vic = el('div', 'ad-screen ad-vic', `
    <div class="ad-card glass">
      <div class="eyebrow">Top of the food chain</div>
      <div class="ad-sub" style="margin:0" data-v="pre">You became the</div>
      <div class="ad-h1" data-v="h">APEX</div>
      <div class="ad-sub" data-v="sub">From a single cell to the top. The sea is endless \u2014 keep swimming, keep growing.</div>
      ${statsHTML}
      <div class="ad-btns">
        <button class="ad-btn ad-i" data-a="cont">KEEP SWIMMING<span class="k">ENTER</span></button>
        <button class="ad-btn ghost ad-i" data-a="new">NEW RUN</button>
      </div>
    </div>`);
  q(vic, '[data-a="cont"]').addEventListener('click', (e) => { e.stopPropagation(); bus.emit('continue'); });
  q(vic, '[data-a="new"]').addEventListener('click', (e) => { e.stopPropagation(); bus.emit('restart'); });
  const vPre = q(vic, '[data-v="pre"]'), vH = q(vic, '[data-v="h"]'), vSub = q(vic, '[data-v="sub"]');

  // ---------- events ----------
  let bannerTimer = 0, calloutTimer = 0, cineTimer = 0, toastTimer = 0;
  let runStartBest = state.best;
  const lastBannerAt = new Map();
  let curPlayer = null;

  // --- centre-card queue: only one big centre card (evolve / boss intro / boss defeated) at a time
  const cardQ = [];
  let activeCard = null, cardGap = 0;
  function queueCard(card, urgent) {
    if (urgent) {
      if (activeCard && !activeCard.urgent) { activeCard.hide(); activeCard = null; cardGap = 0; }
      if (!activeCard) { startCard(card); return; }
      cardQ.unshift(card); return;
    }
    if (!activeCard && cardGap <= 0 && !cardQ.length) startCard(card); else cardQ.push(card);
  }
  function startCard(card) { activeCard = card; card.t = card.dur; card.show(); }
  function tickCards(dt) {
    if (activeCard) {
      if ((activeCard.t -= dt) <= 0) { activeCard.hide(); activeCard = null; cardGap = 0.35; }
    } else if (cardGap > 0) cardGap -= dt;
    else if (cardQ.length) startCard(cardQ.shift());
  }
  function clearCards() { if (activeCard) activeCard.hide(); activeCard = null; cardQ.length = 0; cardGap = 0; }
  const restartAnim = (e, cls) => { e.classList.remove(cls, 'out'); void e.offsetWidth; e.classList.add(cls); };

  function showRegionBanner(index, eyebrow, flavor) {
    const b = BIOMES[index];
    if (!b) return;
    bEyebrow.textContent = eyebrow;
    bName.textContent = b.name;
    bMeta.textContent = '';
    banner.style.setProperty('--bc', hex(b.accent));
    bBonus.textContent = flavor || '';
    bBonus.classList.toggle('on', !!flavor);
    restartAnim(banner, 'on');
    bannerTimer = flavor ? 4 : 2.6;
    lastBannerAt.set(index, state.time);
  }
  bus.on('biome', (p) => {
    if (state.mode !== 'playing' || !p) return;
    if (p.first) showRegionBanner(p.index, 'Discovered', REGION_FLAVOR[p.index]);
    else if (state.time - (lastBannerAt.get(p.index) ?? -99) > 15) showRegionBanner(p.index, 'Drifting into', '');
  });

  bus.on('evolve', (p) => {
    if (!p) return;
    const t = TIERS[p.tier] || {};
    const name = (p.name || t.name || '').toUpperCase();
    const form = p.form || t.form;
    queueCard({
      dur: 2.8,
      show() { tuName.textContent = '\u2192 ' + name; tuPerk.textContent = FORM_LINE[form] || ''; restartAnim(tierUp, 'on'); },
      hide() { tierUp.classList.remove('on'); },
    });
  });

  bus.on('playerAte', (p) => {
    if (!p || !p.pos) return;
    const f = floats[floatCursor];
    floatCursor = (floatCursor + 1) % FLOATS;
    f.pos.copy(p.pos);
    f.life = 0; f.active = true;
    const pts = p.points || 0;
    let sz = Math.min(38, 14 + Math.log10(1 + pts) * 6);
    f.dur = 0.9 + Math.min(1, Math.log10(1 + pts) * 0.22);
    const v = typeof p.value === 'number' ? p.value : 1;   // growth worth of this meal (bosses: full)
    let txt = '+' + fmtInt(pts), col;
    if (v < 0.25) {
      sz = Math.max(11, sz * 0.7);
      txt += '<small>tiny</small>'; col = '#9aa8b5';
    } else {
      col = pts >= 500 ? '#ffe28a' : v >= 0.75 ? '#c6fff5' : '#d9efe9';
      if (v >= 0.75) txt += '<small style="color:#5dff9b">\u25B2 growth</small>';
    }
    f.el.innerHTML = txt;
    f.el.classList.toggle('low', v < 0.25);
    f.el.style.fontSize = sz.toFixed(0) + 'px';
    f.el.style.color = col;
    if (scoreEl.animate) scoreEl.animate([{ transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'ease-out' });
  });

  bus.on('nearMiss', () => {
    if (state.mode !== 'playing') return;
    callout.textContent = 'CLOSE CALL!';
    callout.classList.add('on');
    calloutTimer = 1.1;
  });

  // boss events
  let curBoss = null, lastHp = -1, lastMaxHp = -1, lastVuln = null;
  bus.on('bossEngage', (p) => engageBoss(p && p.boss));
  function engageBoss(boss) {
    if (!boss) return;
    const key = boss.species, def = BOSSES[key] || { name: key, mini: false };
    curBoss = boss; lastHp = -1; lastMaxHp = -1; lastVuln = null;
    const col = bossColor(key);
    const isFinal = !def.mini;
    queueCard({
      dur: def.mini ? 2.6 : 3.6, urgent: true,
      show() {
        bossCard.style.setProperty('--bc', col);
        bossCard.classList.toggle('mini', !!def.mini);
        bcEye.textContent = def.mini ? 'Mini-boss' : 'Final boss';
        bcName.textContent = (def.mini ? def.name : 'THE ' + def.name).toUpperCase();
        bcSub.textContent = (BOSS_SUB[key] || '') + ' \u2014 bite it when it\u2019s stunned!';
        restartAnim(bossCard, 'on'); banner.classList.remove('on');
        if (!def.mini) { root.classList.add('ad-cine'); cineTimer = 3.4; }
      },
      hide() { bossCard.classList.add('out'); root.classList.remove('ad-cine'); },
    }, true);
    bossBar.style.setProperty('--bc', col);
    bossBar.classList.toggle('mini', !!def.mini); bossBar.classList.toggle('final', isFinal);
    bbName.innerHTML = `${def.name}<small>${def.mini ? 'MINI-BOSS' : isFinal ? 'FINAL BOSS' : 'BOSS'}</small>`;
    hpEl.style.setProperty('--n', Math.max(1, boss.maxHp || def.hp || 1));
    bossBar.classList.add('on');
    root.classList.add('ad-bossing');
  }
  const hideBossBar = () => { curBoss = null; bossBar.classList.remove('on'); root.classList.remove('ad-bossing'); biteEl.classList.remove('on'); lastVuln = null; };
  bus.on('bossDisengage', hideBossBar);
  bus.on('bossHit', () => {
    hpEl.classList.remove('hit'); void hpEl.offsetWidth; hpEl.classList.add('hit');
    callout.textContent = 'CHOMP!'; callout.classList.add('on'); calloutTimer = 0.7;
  });
  bus.on('bossDefeated', (p) => {
    const boss = p && p.boss; if (!boss) return;
    const def = BOSSES[boss.species] || { name: boss.species };
    hpCur.style.transform = 'scaleX(0)';
    setTimeout(hideBossBar, 700);
    if (activeCard && activeCard.urgent) { activeCard.hide(); activeCard = null; }
    queueCard({
      dur: 3, urgent: true,
      show() {
        dfWho.textContent = (def.mini ? def.name : 'The ' + def.name).toUpperCase();
        dfRw.textContent = def.reward ? `+${fmtInt(500 * def.reward)} pts  \u00b7  massive growth` : '';
        restartAnim(defeat, 'on'); banner.classList.remove('on');
      },
      hide() { defeat.classList.add('out'); },
    }, true);
  });

  // formation waves
  let waveId = null, waveDirs = [], waveT = 0, waveDur = 1.8, waveWarnOn = false, lastBonus = null, waveCardShown = false;
  function hideWaveWarn() {
    waveWarnOn = false; wwarn.classList.remove('on');
    for (const c of wchev) if (c.on) { c.on = false; c.el.classList.remove('on'); }
  }
  bus.on('waveWarn', (p) => {
    if (state.mode !== 'playing' || !p) return;
    waveId = p.id; waveDirs = Array.isArray(p.dirs) ? p.dirs.slice(0, WCHEV) : [];
    waveDur = Math.max(0.3, p.time || 1.8); waveT = 0; waveWarnOn = true;
    wwarnTxt.textContent = `\u26A0 ${p.name || 'Formation'} incoming!`;
    wwarnBar.style.transform = 'scaleX(1)';
    restartAnim(wwarn, 'on');
  });
  bus.on('waveStart', (p) => {
    if (state.mode !== 'playing') return;
    if (!p || p.id === waveId || waveId == null) hideWaveWarn();
    dodge.classList.remove('on'); void dodge.offsetWidth; dodge.classList.add('on');
  });
  bus.on('waveEnd', (p) => {
    if (p && p.id === waveId) hideWaveWarn();
    if (!p || !p.cleared || state.mode !== 'playing') return;
    queueCard({
      dur: 2.4,
      show() { waveCardShown = true; waveRw.innerHTML = bonusHTML(lastBonus); restartAnim(waveCard, 'on'); banner.classList.remove('on'); },
      hide() { waveCardShown = false; waveCard.classList.add('out'); lastBonus = null; },
    });
  });
  const bonusHTML = (b) => (b ? `+${fmtInt(b.points || 0)} pts<small>\u25B2 +growth</small>` : '<small>\u25B2 +growth</small>');
  bus.on('waveBonus', (b) => {
    lastBonus = b || null;
    if (waveCardShown) waveRw.innerHTML = bonusHTML(lastBonus);
  });

  bus.on('restart', () => {
    runStartBest = state.best; shownScore = 0;
    lastBannerAt.clear(); hideBossBar(); clearCards();
  });

  let killRatio = 0;
  bus.on('playerDeath', (p) => { const k = p && p.killer; killRatio = k && curPlayer && curPlayer.size ? k.size / curPlayer.size : 0; });

  let lastLowVal = null;

  // floating origin: shift anything stored in world coords
  bus.on('rebase', (p) => {
    if (!p) return;
    const dx = p.dx || 0, dy = p.dy || 0;
    for (const f of floats) if (f.active) { f.pos.x -= dx; f.pos.y -= dy; }
  });

  // ---------- onboarding toasts ----------
  let hintsSeen = new Set();
  try { hintsSeen = new Set(JSON.parse(localStorage.getItem('abyss-hints') || '[]')); } catch {}
  const toastQueue = [];
  function pushToast(h) {
    if (hintsSeen.has(h.id)) return;
    hintsSeen.add(h.id);
    try { localStorage.setItem('abyss-hints', JSON.stringify([...hintsSeen])); } catch {}
    toastQueue.push(h.text);
  }
  function tickToasts(dt, st, player) {
    if (st.runTime < 75) for (const h of HINTS_ONBOARD) {
      if (hintsSeen.has(h.id)) continue;
      if (st.runTime >= h.at) pushToast(h);
    }
    if (toastTimer > 0) {
      toastTimer -= dt;
      if (toastTimer <= 0) toast.classList.remove('on');
    } else if (toastTimer > -0.6) toastTimer -= dt; // gap between toasts
    else if (toastQueue.length) {
      toastText.textContent = toastQueue.shift();
      toast.classList.add('on');
      toastTimer = 4;
    }
  }

  // ---------- keyboard ----------
  let modeTime = 0;
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const enter = e.code === 'Enter' || e.code === 'NumpadEnter';
    const space = e.code === 'Space';
    // M (mute) is handled by audio.js
    if (state.mode === 'title' && (enter || space)) { e.preventDefault(); bus.emit('start'); }
    else if (state.mode === 'dead' && modeTime > 1.1 && (enter || space)) { e.preventDefault(); bus.emit('restart'); }
    else if (state.mode === 'victory' && modeTime > 0.8 && enter) { e.preventDefault(); bus.emit('continue'); }
    else if (state.mode === 'playing' && state.paused && enter) { e.preventDefault(); bus.emit('pause', false); }
  });

  // ---------- cached DOM state ----------
  let lastMode = null, lastPaused = null;
  let shownScore = 0, lastScoreTxt = '', lastEaten = -1, lastTier = -1, lastFill = -1, lastDist = -1, lastBiome = -1, lastSizeTxt = '';
  let lastDash = -2, lastDanger = false, lastBest = -1;
  const tmp = new THREE.Vector3();
  let W = window.innerWidth, H = window.innerHeight;
  window.addEventListener('resize', () => { W = window.innerWidth; H = window.innerHeight; sizeCanvases(); });

  let rSize = 0, rDpr = 1, radarAcc = 0;
  function sizeCanvases() {
    rDpr = Math.min(window.devicePixelRatio || 1, 2);
    rSize = radar.clientWidth || 120;
    rCanvas.width = rCanvas.height = Math.round(rSize * rDpr);
  }

  function setMode(mode) {
    title.classList.toggle('show', mode === 'title');
    hud.classList.toggle('show', mode === 'playing');
    dead.classList.toggle('show', mode === 'dead');
    vic.classList.toggle('show', mode === 'victory');
    if (mode === 'dead') {
      const name = killerName(state.killer);
      killerEl.textContent = BOSSES[state.killer] ? `the ${name}` : `${article(name)} ${name}`;
      const reg = BIOMES[state.biome] || BIOMES[0];
      whereEl.innerHTML = `in the <b>${reg.name}</b>` + (killRatio >= 1.4 ? ` \u00b7 <span class="small">it was ${killRatio.toFixed(1)}\u00d7 your size</span>` : '');
      fillStats(dead);
    } else if (mode === 'victory') {
      void vPre; void vH; void vSub;
      fillStats(vic);
    } else if (mode === 'title') { titleBestVal.textContent = fmtInt(state.best); titleBest.style.display = state.best > 0 ? '' : 'none'; }
    if (mode === 'playing' && lastMode !== 'victory') {
      shownScore = state.score; lastScoreTxt = ''; clearCards(); killRatio = 0;
      for (const f of floats) { f.active = false; f.el.style.opacity = '0'; }
      if (lastMode === 'title' || lastMode === 'dead') runStartBest = state.best;
      lastBannerAt.clear(); hideBossBar();
      setTimeout(() => { if (state.mode === 'playing') showRegionBanner(state.biome | 0, 'Your journey begins in', 'Eat what is smaller. Flee what is bigger.'); }, 600);
    }
    if (mode !== 'playing') {
      for (const a of arrows) if (a.vis) { a.vis = false; a.el.style.opacity = '0'; }
      hideWaveWarn(); dodge.classList.remove('on'); waveCard.classList.remove('on', 'out'); waveCardShown = false;
      if (lastDanger) { lastDanger = false; danger.classList.remove('on'); dangerTag.classList.remove('on'); }
      banner.classList.remove('on'); clearCards(); tierUp.classList.remove('on'); callout.classList.remove('on'); toast.classList.remove('on');
      bossCard.classList.remove('on'); root.classList.remove('ad-cine'); biteEl.classList.remove('on');
      if (mode !== 'victory') { defeat.classList.remove('on', 'out'); }
      bossBar.classList.remove('on'); root.classList.remove('ad-bossing');
    }
    if (mode === 'playing') requestAnimationFrame(sizeCanvases);
  }

  // ---------- threat arrows (XY plane, up = +y) ----------
  const cand = new Array(ARROWS).fill(null);
  const candD = new Float32Array(ARROWS);
  let nCand = 0;
  function consider(f, d) {
    if (nCand < ARROWS) { cand[nCand] = f; candD[nCand] = d; nCand++; }
    else if (d < candD[ARROWS - 1]) { cand[ARROWS - 1] = f; candD[ARROWS - 1] = d; }
    else return;
    for (let j = nCand - 1; j > 0 && candD[j] < candD[j - 1]; j--) {
      const tf = cand[j]; cand[j] = cand[j - 1]; cand[j - 1] = tf;
      const td = candD[j]; candD[j] = candD[j - 1]; candD[j - 1] = td;
    }
  }
  function updateArrows(player, eco, viewRadius, bossList) {
    nCand = 0;
    const px = player.pos.x, py = player.pos.y;
    const near = viewRadius * 1.5, far = viewRadius * 2.6;
    const dangerSize = player.size * CONFIG.eat.margin;
    const fish = eco && eco.fish;
    if (fish) for (let i = 0; i < fish.length; i++) {
      const f = fish[i];
      if (!f.alive) continue;
      const hunting = f.ai && f.ai.hunting;
      if (!hunting && f.size <= dangerSize) continue;
      const d = Math.hypot(f.pos.x - px, f.pos.y - py) - f.size;
      if (!(d <= (hunting ? far : near))) continue;
      consider(f, d);
    }
    if (bossList) for (let i = 0; i < bossList.length; i++) {
      const f = bossList[i];
      if (!f.alive) continue;
      const d = Math.hypot(f.pos.x - px, f.pos.y - py) - f.size;
      if (d <= viewRadius * 4) consider(f, d - viewRadius); // bosses take priority
    }
    const cx = W / 2, cy = H / 2, m = W < 640 ? 26 : 34;
    let used = 0;
    for (let i = 0; i < nCand && used < ARROWS; i++) {
      const f = cand[i];
      tmp.set(f.pos.x, f.pos.y, 0).project(camera);
      if (!Number.isFinite(tmp.x) || !Number.isFinite(tmp.y)) continue;
      let nx = tmp.x, ny = tmp.y;
      if (tmp.z > 1) { nx = -nx; ny = -ny; }
      else if (nx > -1.02 && nx < 1.02 && ny > -1.02 && ny < 1.02) continue; // on screen
      const dx = nx * cx, dy = -ny * cy;
      const len = Math.hypot(dx, dy) || 1;
      const s = Math.min((cx - m) / Math.abs(dx || 1e-6), (cy - m) / Math.abs(dy || 1e-6));
      const x = cx + dx * s, y = cy + dy * s;
      const isBoss = !!f.isBoss;
      const realD = isBoss ? candD[i] + viewRadius : candD[i];
      const close = clamp01(1 - (realD - viewRadius * 0.4) / (viewRadius * (isBoss ? 3 : 1.6)));
      const hunting = !!(f.ai && f.ai.hunting) || (isBoss && !!f.vulnerable);
      const scale = (isBoss ? 0.9 : 0.55) + close * 0.75 + Math.min(0.4, (f.size / player.size - 1) * 0.15);
      const a = arrows[used++];
      a.el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) rotate(${Math.atan2(dy / len, dx / len).toFixed(3)}rad) scale(${scale.toFixed(2)})`;
      a.el.style.opacity = (0.35 + close * 0.65 * (hunting || isBoss ? 1 : 0.7)).toFixed(2);
      a.vis = true;
      if (a.hunt !== hunting) { a.hunt = hunting; a.el.classList.toggle('hunt', hunting); }
      if (a.boss !== isBoss) { a.boss = isBoss; a.el.classList.toggle('boss', isBoss); }
    }
    for (let i = used; i < ARROWS; i++) { const a = arrows[i]; if (a.vis) { a.vis = false; a.el.style.opacity = '0'; } }
    for (let i = 0; i < nCand; i++) cand[i] = null;
  }

  // ---------- radar (local, XY; canvas up = +y) ----------
  function drawRadar(player, eco, viewRadius, bossList) {
    if (!rSize) sizeCanvases();
    const S = rCanvas.width, c = S / 2, R = c - 2 * rDpr;
    const range = viewRadius * 2, k = R / range;
    const ctx = rctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2); ctx.clip();
    const g = ctx.createRadialGradient(c, c, 0, c, c, R);
    g.addColorStop(0, 'rgba(20,90,110,0.35)'); g.addColorStop(1, 'rgba(2,20,32,0.55)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    const px = player.pos.x, py = player.pos.y;
    ctx.strokeStyle = 'rgba(150,240,255,0.12)'; ctx.lineWidth = rDpr;
    ctx.beginPath(); ctx.arc(c, c, R * 0.5, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(c - R, c); ctx.lineTo(c + R, c); ctx.moveTo(c, c - R); ctx.lineTo(c, c + R); ctx.stroke();
    const fish = eco && eco.fish;
    const ps = player.size, m = CONFIG.eat.margin;
    const blink = (performance.now() % 500) < 250;
    if (fish) for (let i = 0; i < fish.length; i++) {
      const f = fish[i];
      if (!f.alive) continue;
      const dx = f.pos.x - px, dy = f.pos.y - py;
      if (dx * dx + dy * dy > range * range) continue;
      const col = ps > f.size * m ? '#5dff9b' : f.size > ps * m ? '#ff4d6d' : '#e6f4ff';
      const hunting = f.ai && f.ai.hunting;
      const r = Math.max(1.2, Math.min(7, 1.2 + (f.size / ps) * 2.2)) * rDpr;
      ctx.globalAlpha = hunting ? (blink ? 1 : 0.55) : 0.85;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(c + dx * k, c - dy * k, r, 0, Math.PI * 2); ctx.fill();
      if (hunting) { ctx.strokeStyle = col; ctx.lineWidth = rDpr; ctx.beginPath(); ctx.arc(c + dx * k, c - dy * k, r + 2.5 * rDpr, 0, Math.PI * 2); ctx.stroke(); }
    }
    if (bossList) for (const f of bossList) {
      if (!f.alive) continue;
      const dx = f.pos.x - px, dy = f.pos.y - py;
      if (dx * dx + dy * dy > range * range * 1.2) continue;
      ctx.globalAlpha = 1; ctx.fillStyle = bossColor(f.species); ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 8 * rDpr;
      ctx.beginPath(); ctx.arc(c + dx * k, c - dy * k, Math.min(R * 0.25, Math.max(4, f.size * k)) , 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
    const h = player.heading, ch = Math.cos(h), sh = -Math.sin(h), s = 6 * rDpr;
    ctx.fillStyle = '#5ff6ff'; ctx.shadowColor = '#5ff6ff'; ctx.shadowBlur = 8 * rDpr;
    ctx.beginPath();
    ctx.moveTo(c + ch * s, c + sh * s);
    ctx.lineTo(c - ch * s * 0.7 - sh * s * 0.6, c - sh * s * 0.7 + ch * s * 0.6);
    ctx.lineTo(c - ch * s * 0.7 + sh * s * 0.6, c - sh * s * 0.7 - ch * s * 0.6);
    ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  // wave warning chevrons at the screen edge (dirs are world XY, y up → screen y down)
  function updateWaveChevrons(dt) {
    waveT += dt;
    const left = clamp01(1 - waveT / waveDur);
    wwarnBar.style.transform = `scaleX(${left.toFixed(3)})`;
    const cx = W / 2, cy = H / 2, m = W < 640 ? 30 : 42;
    const pulse = (0.6 - 0.4 * (1 - left)).toFixed(2) + 's';
    for (let i = 0; i < WCHEV; i++) {
      const c = wchev[i], d = waveDirs[i];
      if (!d || !Number.isFinite(d.x) || !Number.isFinite(d.y)) { if (c.on) { c.on = false; c.el.classList.remove('on'); } continue; }
      const dx = d.x, dy = -d.y, len = Math.hypot(dx, dy) || 1;
      const s = Math.min((cx - m) / Math.abs(dx || 1e-6), (cy - m) / Math.abs(dy || 1e-6));
      const x = cx + dx * s, y = cy + dy * s;
      // chevrons point inward (toward the player) along the incoming path
      c.el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) rotate(${Math.atan2(-dy / len, -dx / len).toFixed(3)}rad)`;
      c.el.style.setProperty('--wp', pulse);
      c.cd.style.transform = `scaleX(${left.toFixed(3)})`;
      if (!c.on) { c.on = true; c.el.classList.add('on'); }
    }
    if (waveT > waveDur + 1.5) hideWaveWarn(); // safety if waveStart never arrives
  }

  // ---------- per-frame ----------
  function update(dt, st, player, eco, viewRadius, bosses) {
    st = st || state;
    dt = dt || 0;
    curPlayer = player || null;
    const bossList = bosses && bosses.list;
    if (st.mode !== lastMode) { setMode(st.mode); lastMode = st.mode; modeTime = 0; }
    modeTime += dt;
    if (st.paused !== lastPaused) {
      lastPaused = st.paused;
      if (st.paused) pauseHint.textContent = HINTS[(Math.random() * HINTS.length) | 0];
      pause.classList.toggle('show', !!st.paused && st.mode === 'playing');
    }
    if (st.mode === 'title' && st.best !== lastBest) { lastBest = st.best; titleBestVal.textContent = fmtInt(st.best); titleBest.style.display = st.best > 0 ? '' : 'none'; }

    if (bannerTimer > 0 && (bannerTimer -= dt) <= 0) banner.classList.remove('on');
    if (calloutTimer > 0 && (calloutTimer -= dt) <= 0) callout.classList.remove('on');
    if (cineTimer > 0 && (cineTimer -= dt) <= 0) root.classList.remove('ad-cine');
    tickCards(dt);

    if (st.mode !== 'playing' || !player) return;
    if (camera.updateMatrixWorld) camera.updateMatrixWorld();
    viewRadius = viewRadius || 30;

    // score
    if (!Number.isFinite(shownScore)) shownScore = Number.isFinite(st.score) ? st.score : 0;
    if (shownScore !== st.score && Number.isFinite(st.score)) {
      const diff = st.score - shownScore;
      shownScore += diff * Math.min(1, dt * 7) + Math.sign(diff) * Math.min(Math.abs(diff), dt * 40);
      if (Math.abs(st.score - shownScore) < 0.5) shownScore = st.score;
    }
    const sTxt = fmtInt(shownScore);
    if (sTxt !== lastScoreTxt) { lastScoreTxt = sTxt; scoreEl.textContent = sTxt; }
    if (st.eaten !== lastEaten) { lastEaten = st.eaten; eatenEl.textContent = fmtInt(st.eaten); }

    // tier + growth (log scale between tier sizes)
    const t = Math.max(0, Math.min(TIERS.length - 1, st.tier | 0));
    if (t !== lastTier) {
      lastTier = t;
      tierEl.textContent = TIERS[t].name;
      if (t === TIERS.length - 1) tierEl.textContent = 'APEX \u2014 endless';
      pips.forEach((p, i) => p.classList.toggle('on', i < t));
    }
    const nTxt = t < TIERS.length - 1 ? `next: ${TIERS[t + 1].name}` : `size ${(player.size || 0).toFixed(1)}\u00d7`;
    if (nTxt !== lastSizeTxt) { lastSizeTxt = nTxt; nextEl.textContent = nTxt; }
    let frac = 1;
    if (t < TIERS.length - 1) {
      const a = Math.log(TIERS[t].size), b = Math.log(TIERS[t + 1].size);
      frac = clamp01((Math.log(Math.max(player.size, 1e-3)) - a) / (b - a));
    }
    const fq = Math.round(frac * 200) / 200;
    if (fq !== lastFill && Number.isFinite(fq)) { lastFill = fq; fillEl.style.transform = `scaleX(${fq})`; }
    const lowVal = (st.mealValue ?? 1) < 0.35;
    if (lowVal !== lastLowVal) { lastLowVal = lowVal; tl.classList.toggle('lowval', lowVal); }

    // distance swum + region mood
    const dist = Math.round(st.distance || 0);
    if (dist !== lastDist) { lastDist = dist; distEl.firstChild.nodeValue = fmtInt(dist); }
    if (st.biome !== lastBiome) {
      lastBiome = st.biome;
      const b = BIOMES[st.biome] || BIOMES[4];
      regionEl.textContent = b.name; regionEl.style.color = hex(b.accent);
    }

    // dash: dashCooldown01 = remaining cooldown fraction (1 just dashed → 0 ready)
    const dc = player.dashCooldown01;
    if (typeof dc === 'number') {
      const p = Math.round((1 - clamp01(dc)) * 50) / 50;
      if (p !== lastDash) {
        if (lastDash === -2) dashEl.classList.remove('hide');
        lastDash = p;
        dashEl.style.setProperty('--p', p);
        dashEl.classList.toggle('ready', p >= 1);
      }
    } else if (lastDash !== -2) { lastDash = -2; dashEl.classList.add('hide'); }

    const dz = (eco && eco.threat) > 0.6;
    if (dz !== lastDanger) { lastDanger = dz; danger.classList.toggle('on', dz); dangerTag.classList.toggle('on', dz); }

    // boss HP bar
    const boss = curBoss || st.boss;
    if (boss && !bossBar.classList.contains('on') && boss.alive !== false && st.boss) engageBoss(boss); // missed the event (e.g. UI reload)
    if (boss) {
      const maxHp = boss.maxHp || 1, hp = Math.max(0, boss.hp ?? maxHp);
      if (hp !== lastHp || maxHp !== lastMaxHp) {
        if (maxHp !== lastMaxHp) hpEl.style.setProperty('--n', maxHp);
        lastHp = hp; lastMaxHp = maxHp;
        const r = clamp01(hp / maxHp).toFixed(3);
        hpCur.style.transform = `scaleX(${r})`; hpLag.style.transform = `scaleX(${r})`;
      }
      const v = !!boss.vulnerable;
      if (v !== lastVuln) { lastVuln = v; biteEl.classList.toggle('on', v); }
    }

    if (!st.paused) {
      for (let i = 0; i < FLOATS; i++) {
        const f = floats[i];
        if (!f.active) continue;
        f.life += dt;
        const u = f.life / f.dur;
        if (u >= 1) { f.active = false; f.el.style.opacity = '0'; continue; }
        tmp.copy(f.pos).project(camera);
        if (!Number.isFinite(tmp.x) || !Number.isFinite(tmp.y)) { f.active = false; f.el.style.opacity = '0'; continue; }
        const x = (tmp.x * 0.5 + 0.5) * W, y = (-tmp.y * 0.5 + 0.5) * H - u * 70 - 10;
        const pop = u < 0.15 ? 0.6 + (u / 0.15) * 0.6 : 1.2 - Math.min(0.2, (u - 0.15) * 0.5);
        f.el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-50%) scale(${pop.toFixed(3)})`;
        f.el.style.opacity = (u < 0.6 ? 1 : 1 - (u - 0.6) / 0.4).toFixed(2);
      }
      updateArrows(player, eco, viewRadius, bossList);
      tickToasts(dt, st, player);
      if (waveWarnOn) updateWaveChevrons(dt);
    }

    radarAcc += dt;
    if (radarAcc >= 0.05) { radarAcc = 0; drawRadar(player, eco, viewRadius, bossList); }
  }

  setMode(state.mode); lastMode = state.mode;
  return { update };
}
