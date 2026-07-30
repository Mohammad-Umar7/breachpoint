/**
 * Small numeric helpers shared across systems.
 * Kept dependency-free (no Three.js import) so it can be used anywhere.
 */

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Frame-rate independent exponential smoothing.
 * `lambda` is the decay rate: higher = snappier. Equivalent to
 * `lerp(a, b, 1 - exp(-lambda * dt))`.
 */
export function damp(a, b, lambda, dt) {
  return lerp(a, b, 1 - Math.exp(-lambda * dt));
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function randRange(min, max) {
  return min + Math.random() * (max - min);
}

export function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

export function randSign() {
  return Math.random() < 0.5 ? -1 : 1;
}

/** Box–Muller transform: normally distributed value, mean 0, stddev 1. */
export function randGaussian() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function pick(arr) {
  return arr[(Math.random() * arr.length) | 0];
}

/** Shortest signed angular difference between two angles (radians). */
export function angleDelta(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Rotate `from` toward `to` by at most `maxStep` radians. */
export function approachAngle(from, to, maxStep) {
  const d = angleDelta(from, to);
  if (Math.abs(d) <= maxStep) return to;
  return from + Math.sign(d) * maxStep;
}

/** Deterministic pseudo-random number generator (mulberry32). */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
