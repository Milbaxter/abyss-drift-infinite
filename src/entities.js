import * as THREE from 'three';
import { SPECIES, BOSSES, CONFIG } from './config.js';

let nextId = 1;

// The ONE fish shape used by player, ecosystem, renderer, UI, audio, effects.
// SIDE VIEW. Heading convention: forward = (cos(heading), sin(heading), 0). Model nose points +X locally,
// so a mesh uses rotation.z = heading, and rolls 180° about its nose when facing left (belly stays down).
export function makeFish(species, size, x = 0, y = 0, heading = 0) {
  const sp = SPECIES[species] || BOSSES[species];
  const c = sp.colors[(Math.random() * sp.colors.length) | 0];
  return {
    id: nextId++,
    species,
    isPlayer: false,
    alive: true,
    pos: new THREE.Vector3(x, y, 0),   // gameplay on the XY plane; z is cosmetic only (keep ~0)
    vel: new THREE.Vector3(),
    heading,
    size,                                // collision radius in world units
    mass: size * size,
    color: new THREE.Color(c),
    swimPhase: Math.random() * Math.PI * 2,
    swimRate: 1,                         // tail-beat speed multiplier (raise when fleeing/dashing)
    bank: 0,                             // roll in radians when turning (-0.6..0.6)
    wallHit: 0,                          // 0..1 set by terrain.collide on contact (decays)
    invuln: 0,                           // seconds of spawn protection (renderer blinks it)
    puff: 0,                             // 0..1 puffer inflate
    gulp: 0,                             // 0..1 decays after eating; renderer can pulse mouth/scale
    age: 0,                              // seconds alive
    ai: {},                              // ecosystem scratch space
  };
}

export function sizeFromMass(mass) { return Math.sqrt(mass); }

// Apply a meal to `eater`. Returns mass gained.
export function feed(eater, eaten) {
  const gain = eaten.mass * CONFIG.eat.growth;
  eater.mass += gain;
  eater.size = sizeFromMass(eater.mass);
  eater.gulp = 1;
  return gain;
}
