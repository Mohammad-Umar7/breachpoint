/**
 * Difficulty — one table describing how hard the AI plays.
 *
 * Difficulty is expressed as *behavioural* multipliers first (reaction time,
 * accuracy, cover use, flanking, coordination) and health second. The design
 * goal from the brief is explicit: enemies should be harder because they play
 * better, not because they soak more bullets. Health scaling is therefore
 * deliberately mild (0.85x – 1.25x).
 */

export const DIFFICULTIES = Object.freeze({
  easy: {
    id: 'easy',
    label: 'RECRUIT',
    blurb: 'Slow to react, poor accuracy, rarely coordinates.',
    healthMul: 0.85,
    accuracyMul: 0.62,
    reactionMul: 1.7,        // higher = slower to open fire
    fireRateMul: 0.85,
    damageMul: 0.75,
    aggression: 0.45,        // chance to push rather than hold
    coverSkill: 0.35,        // how reliably they use cover
    flankChance: 0.1,
    predictionLead: 0.0,     // seconds of player-movement lead
    maxConcurrentAttackers: 2,
    suppressionAccuracy: 0.5,
    playerDamageTakenMul: 0.8,
  },
  normal: {
    id: 'normal',
    label: 'SOLDIER',
    blurb: 'Balanced health, accuracy and tactics.',
    healthMul: 1.0,
    accuracyMul: 1.0,
    reactionMul: 1.0,
    fireRateMul: 1.0,
    damageMul: 1.0,
    aggression: 0.6,
    coverSkill: 0.65,
    flankChance: 0.25,
    predictionLead: 0.06,
    maxConcurrentAttackers: 3,
    suppressionAccuracy: 0.7,
    playerDamageTakenMul: 1.0,
  },
  hard: {
    id: 'hard',
    label: 'VETERAN',
    blurb: 'Fast reactions, disciplined cover use, flanks often.',
    healthMul: 1.12,
    accuracyMul: 1.25,
    reactionMul: 0.68,
    fireRateMul: 1.12,
    damageMul: 1.2,
    aggression: 0.72,
    coverSkill: 0.85,
    flankChance: 0.45,
    predictionLead: 0.12,
    maxConcurrentAttackers: 4,
    suppressionAccuracy: 0.85,
    playerDamageTakenMul: 1.15,
  },
  extreme: {
    id: 'extreme',
    label: 'BLACK OPS',
    blurb: 'Coordinated squads, constant repositioning, scarce resources.',
    healthMul: 1.25,
    accuracyMul: 1.5,
    reactionMul: 0.48,
    fireRateMul: 1.25,
    damageMul: 1.4,
    aggression: 0.85,
    coverSkill: 0.95,
    flankChance: 0.65,
    predictionLead: 0.2,
    maxConcurrentAttackers: 5,
    suppressionAccuracy: 0.95,
    playerDamageTakenMul: 1.3,
    /** Pickups are rarer and enemy drops less generous. */
    resourceMul: 0.6,
  },
});

export function getDifficulty(id) {
  return DIFFICULTIES[id] ?? DIFFICULTIES.normal;
}

export const DIFFICULTY_ORDER = ['easy', 'normal', 'hard', 'extreme'];
