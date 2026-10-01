# Abyss Drift — Infinite

Browser game in Three.js. Everything (models, scenery, effects, audio) is generated in code; no assets, no build step.

An endless side-view sea. Eat smaller creatures, dodge bigger ones, evolve through 7 forms (Microbe → Apex) and keep
growing. Everything around you scales with your size, wherever you swim. Dangerous fish move in straight lines or
hover in place, so you can read their paths. Steering is WC3 "ice escape" style: your fish always swims forward and
can only turn at a limited rate.

Run locally:

```bash
python3 -m http.server 8124
```

Controls: click / hold to steer, WASD also steers, Space or right-click to dash, Esc to pause, M to mute.

The earlier bottom-to-surface version lives at https://github.com/Milbaxter/abyss-drift-ascent
