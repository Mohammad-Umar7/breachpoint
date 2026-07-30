/**
 * EnemyTypes — the archetypes that make up a squad.
 *
 * Difficulty multipliers from `Difficulty.js` are applied on top of these at
 * spawn time. Health values are deliberately restrained: the brief is explicit
 * that enemies should be harder because they play better, not because they
 * soak more bullets. The toughest unit (Heavy) still dies to two sniper body
 * shots or a well-placed shotgun blast.
 *
 * `armor` is a separate pool in front of health. A weapon's `armorPen`
 * decides how much damage bypasses it; the rest chews through the plate until
 * it breaks (with a visible and audible tell).
 */

export const ENEMY_TYPES = Object.freeze({
  standard: {
    id: 'standard',
    label: 'Rifleman',
    health: 100, armor: 25, armorBreakable: true,
    moveSpeed: 3.4, chaseSpeed: 4.8, strafeMul: 0.85,
    accuracy: 0.55, reactionTime: 0.6,
    fireInterval: 0.14, burst: [3, 5], burstPause: [0.8, 1.6],
    damage: 9.5, weaponRange: 55, preferredRange: 13,
    magSize: 28, reloadTime: 2.4,
    pellets: 1, spreadDeg: 0,
    staggerResist: 0.2, scale: 1.0,
    aggression: 0.6, coverAffinity: 0.8, flankAffinity: 0.35,
    crouches: true, retreatsAt: 0.28,
    scoreValue: 100,
    tint: 0x454e3a, vestTint: 0x23262a,
  },

  rusher: {
    id: 'rusher',
    label: 'Skirmisher',
    health: 70, armor: 0, armorBreakable: false,
    moveSpeed: 4.6, chaseSpeed: 6.6, strafeMul: 1.15,
    accuracy: 0.42, reactionTime: 0.42,
    fireInterval: 0.075, burst: [5, 9], burstPause: [0.55, 1.0],
    damage: 6.0, weaponRange: 32, preferredRange: 6,
    magSize: 35, reloadTime: 1.9,
    pellets: 1, spreadDeg: 1.2,
    staggerResist: 0.0, scale: 0.94,
    aggression: 0.95, coverAffinity: 0.25, flankAffinity: 0.7,
    crouches: false, retreatsAt: 0.12,
    scoreValue: 120,
    tint: 0x3d4a44, vestTint: 0x1c2224,
  },

  armored: {
    id: 'armored',
    label: 'Breacher',
    health: 130, armor: 90, armorBreakable: true,
    moveSpeed: 2.9, chaseSpeed: 3.9, strafeMul: 0.6,
    accuracy: 0.6, reactionTime: 0.7,
    fireInterval: 0.16, burst: [4, 6], burstPause: [0.9, 1.5],
    damage: 11, weaponRange: 50, preferredRange: 11,
    magSize: 30, reloadTime: 2.8,
    pellets: 1, spreadDeg: 0,
    staggerResist: 0.75, scale: 1.08,
    aggression: 0.7, coverAffinity: 0.55, flankAffinity: 0.2,
    crouches: false, retreatsAt: 0.18,
    scoreValue: 200,
    tint: 0x3a4046, vestTint: 0x14181b,
  },

  shotgunner: {
    id: 'shotgunner',
    label: 'Enforcer',
    health: 95, armor: 20, armorBreakable: true,
    moveSpeed: 3.8, chaseSpeed: 5.4, strafeMul: 0.95,
    accuracy: 0.5, reactionTime: 0.55,
    fireInterval: 0.85, burst: [1, 2], burstPause: [1.1, 1.8],
    damage: 5.5, weaponRange: 20, preferredRange: 6,
    magSize: 6, reloadTime: 3.0,
    pellets: 7, spreadDeg: 5.5,
    staggerResist: 0.25, scale: 1.02,
    aggression: 0.85, coverAffinity: 0.45, flankAffinity: 0.45,
    crouches: false, retreatsAt: 0.2,
    scoreValue: 150,
    tint: 0x4a423a, vestTint: 0x241f1c,
  },

  sniper: {
    id: 'sniper',
    label: 'Marksman',
    health: 80, armor: 0, armorBreakable: false,
    moveSpeed: 2.8, chaseSpeed: 3.6, strafeMul: 0.4,
    accuracy: 0.85, reactionTime: 1.25,
    fireInterval: 1.6, burst: [1, 1], burstPause: [2.0, 3.2],
    damage: 34, weaponRange: 95, preferredRange: 42,
    magSize: 5, reloadTime: 3.4,
    pellets: 1, spreadDeg: 0,
    staggerResist: 0.0, scale: 0.98,
    aggression: 0.2, coverAffinity: 0.95, flankAffinity: 0.05,
    crouches: true, retreatsAt: 0.45,
    holdsPosition: true, telegraphs: true,
    scoreValue: 220,
    tint: 0x3f4736, vestTint: 0x1b2019,
  },

  heavy: {
    id: 'heavy',
    label: 'Gunner',
    health: 200, armor: 120, armorBreakable: true,
    moveSpeed: 2.3, chaseSpeed: 3.0, strafeMul: 0.35,
    accuracy: 0.48, reactionTime: 0.8,
    fireInterval: 0.085, burst: [10, 18], burstPause: [1.4, 2.2],
    damage: 7.5, weaponRange: 60, preferredRange: 16,
    magSize: 90, reloadTime: 5.0,
    pellets: 1, spreadDeg: 1.8,
    staggerResist: 0.95, scale: 1.16,
    aggression: 0.5, coverAffinity: 0.4, flankAffinity: 0.05,
    crouches: false, retreatsAt: 0.1,
    suppresses: true,
    scoreValue: 280,
    tint: 0x30363a, vestTint: 0x101315,
  },

  elite: {
    id: 'elite',
    label: 'Operator',
    health: 140, armor: 60, armorBreakable: true,
    moveSpeed: 4.2, chaseSpeed: 6.0, strafeMul: 1.2,
    accuracy: 0.8, reactionTime: 0.34,
    fireInterval: 0.09, burst: [3, 3], burstPause: [0.45, 0.8],
    damage: 13, weaponRange: 70, preferredRange: 15,
    magSize: 30, reloadTime: 2.0,
    pellets: 1, spreadDeg: 0,
    staggerResist: 0.5, scale: 1.02,
    aggression: 0.85, coverAffinity: 0.9, flankAffinity: 0.85,
    crouches: true, retreatsAt: 0.3,
    scoreValue: 320,
    tint: 0x25292b, vestTint: 0x0d0f10,
  },
});

export const ENEMY_TYPE_IDS = Object.keys(ENEMY_TYPES);

/**
 * Wave composition table — which archetypes appear, and how often.
 * Weights are relative; the manager samples from them per spawn.
 */
export const WAVE_COMPOSITION = [
  { standard: 8, rusher: 3 },
  { standard: 7, rusher: 4, shotgunner: 2 },
  { standard: 6, rusher: 4, shotgunner: 3, sniper: 2, armored: 2 },
  { standard: 5, rusher: 4, shotgunner: 3, sniper: 2, armored: 3, heavy: 2, elite: 1 },
  { standard: 3, rusher: 4, shotgunner: 3, sniper: 3, armored: 4, heavy: 3, elite: 4 },
];

/** Pick a weighted-random archetype for a wave index. */
export function pickEnemyType(waveIndex, rng = Math.random) {
  const table = WAVE_COMPOSITION[Math.min(waveIndex, WAVE_COMPOSITION.length - 1)];
  let total = 0;
  for (const v of Object.values(table)) total += v;
  let roll = rng() * total;
  for (const [id, weight] of Object.entries(table)) {
    roll -= weight;
    if (roll <= 0) return ENEMY_TYPES[id];
  }
  return ENEMY_TYPES.standard;
}

/** Apply difficulty scaling to a base archetype. */
export function scaleForDifficulty(type, diff) {
  return {
    ...type,
    health: Math.round(type.health * diff.healthMul),
    armor: Math.round(type.armor * diff.healthMul),
    accuracy: Math.min(0.97, type.accuracy * diff.accuracyMul),
    reactionTime: Math.max(0.1, type.reactionTime * diff.reactionMul),
    fireInterval: Math.max(0.05, type.fireInterval / diff.fireRateMul),
    damage: type.damage * diff.damageMul,
    aggression: Math.min(1, type.aggression * (0.6 + diff.aggression * 0.7)),
    coverAffinity: Math.min(1, type.coverAffinity * (0.5 + diff.coverSkill * 0.8)),
    flankAffinity: Math.min(1, type.flankAffinity * (0.4 + diff.flankChance * 1.4)),
    predictionLead: diff.predictionLead,
  };
}
