/**
 * WeaponDefinitions — pure data for the whole arsenal.
 *
 * Every number that shapes how a gun feels lives here so the arsenal can be
 * re-tuned without touching logic. **Angles are authored in DEGREES** and
 * converted once when the weapon is constructed.
 *
 * Recoil patterns
 * ---------------
 * `recoil.pattern` is a list of `[pitch, yaw]` offsets in degrees, indexed by
 * shot number within a burst. They are deliberately *learnable*: a rifle
 * climbs hard for the first six rounds, then drifts right, then left. Only a
 * small random jitter (`randomPitch` / `randomYaw`) is added on top, so a
 * player who pulls down and counter-steers can hold a tight group. Past the
 * end of the pattern the last entry repeats.
 *
 * Optics
 * ------
 * `optic.type` drives both the sight picture and the zoom:
 *   iron    ~1.1x   no glass, fastest ADS
 *   reddot  ~1.3x   floating dot, clear view
 *   holo    ~1.4x   ring + dot
 *   acog    ~3.5x   chevron, medium zoom
 *   scope   4x–10x  full scope overlay, renders through a dedicated camera
 *
 * Balance reference: a standard soldier has 100 HP + 25 armour on Normal.
 */

/** Base vertical FOV the ADS FOVs are expressed against. */
export const BASE_FOV = 85;

export const WEAPON_DEFS = [
  /* ===================================================================== */
  /* PISTOLS                                                               */
  /* ===================================================================== */
  {
    id: 'pistol',
    name: 'M9 SIDEARM',
    short: 'M9',
    category: 'pistol',
    slot: 'secondary',
    modelClass: 'pistol',
    modelId: 'pistol',
    description: 'Reliable semi-auto sidearm. Fast to draw, forgiving recoil.',

    damage: 28, headMul: 2.2, limbMul: 0.78, pellets: 1, armorPen: 0.35,
    range: 95, falloffStart: 26, falloffEnd: 66, falloffMinScale: 0.55,

    rpm: 380, automatic: false, magSize: 15,
    startReserve: 90, maxReserve: 150,
    reloadTime: 1.35, reloadEmptyTime: 1.75, reloadType: 'magazine',
    switchTime: 0.3,

    spreadBase: 0.32, spreadMoving: 1.4, spreadJumping: 3.2, spreadCrouch: -0.14,
    spreadPerShot: 0.5, spreadMax: 4.2, spreadRecovery: 6.0,

    recoil: {
      pattern: [[1.25, 0.10], [1.35, -0.16], [1.30, 0.22], [1.40, -0.10], [1.30, 0.14],
                [1.45, 0.20], [1.35, -0.24], [1.30, 0.12]],
      randomPitch: 0.16, randomYaw: 0.20,
      recovery: 9.0, recoveryDelay: 0.09,
      adsMul: 0.62, crouchMul: 0.78, moveMul: 1.22, airMul: 1.55,
      kickback: 0.030, kickRot: 1.5, shake: 0.05,
    },

    optic: { type: 'iron', magnification: 1.15, reticle: 'none' },
    adsTime: 0.11, adsSensitivity: 0.95, adsMoveSpeedMul: 0.86,
    adsSpreadMul: 0.12,
    moveSpeedMul: 1.0,

    viewOffset: [0.185, -0.155, -0.30],
    adsOffset: [0.0, -0.0405, -0.20],
    adsRotation: [0, 0, 0],

    tracerColor: 0xffe0a0, tracerWidth: 0.026, tracerSpeed: 460,
    muzzleFlashScale: 0.7, shellVelocity: [1.9, 2.4, 0.4],
    fireSound: 'shootPistol',
    reloadSounds: [[0.05, 'magOut'], [0.7, 'magIn'], [1.15, 'boltRelease']],
  },

  {
    id: 'deagle',
    name: '.50 MAGNUM',
    short: 'MAG',
    category: 'pistol',
    slot: 'secondary',
    modelClass: 'heavyPistol',
    modelId: 'deagle',
    description: 'Hand cannon. Two body shots, one headshot. Brutal kick.',

    damage: 62, headMul: 2.4, limbMul: 0.72, pellets: 1, armorPen: 0.7,
    range: 110, falloffStart: 30, falloffEnd: 75, falloffMinScale: 0.62,

    rpm: 200, automatic: false, magSize: 7,
    startReserve: 42, maxReserve: 70,
    reloadTime: 1.85, reloadEmptyTime: 2.3, reloadType: 'magazine',
    switchTime: 0.4,

    spreadBase: 0.45, spreadMoving: 2.3, spreadJumping: 4.8, spreadCrouch: -0.2,
    spreadPerShot: 1.5, spreadMax: 6.5, spreadRecovery: 5.0,

    recoil: {
      pattern: [[4.2, 0.35], [4.6, -0.55], [4.4, 0.65], [4.8, -0.40], [4.5, 0.50]],
      randomPitch: 0.45, randomYaw: 0.55,
      recovery: 6.5, recoveryDelay: 0.14,
      adsMul: 0.7, crouchMul: 0.8, moveMul: 1.3, airMul: 1.7,
      kickback: 0.085, kickRot: 3.4, shake: 0.16,
    },

    optic: { type: 'iron', magnification: 1.2, reticle: 'none' },
    adsTime: 0.15, adsSensitivity: 0.95, adsMoveSpeedMul: 0.80,
    adsSpreadMul: 0.1,
    moveSpeedMul: 0.97,

    viewOffset: [0.19, -0.16, -0.33],
    adsOffset: [0.0, -0.0455, -0.22],
    adsRotation: [0, 0, 0],

    tracerColor: 0xffd07a, tracerWidth: 0.04, tracerSpeed: 500,
    muzzleFlashScale: 1.35, shellVelocity: [2.3, 3.0, 0.5],
    fireSound: 'shootMagnum',
    reloadSounds: [[0.08, 'magOut'], [1.0, 'magIn'], [1.55, 'boltRelease']],
  },

  /* ===================================================================== */
  /* ASSAULT                                                               */
  /* ===================================================================== */
  {
    id: 'rifle',
    name: 'AR-15 CARBINE',
    short: 'AR-15',
    category: 'rifle',
    slot: 'primary',
    modelClass: 'rifle',
    // Authored in Blender and exported to public/models/ar15.glb. If the file
    // is missing the weapon silently falls back to `modelClass: 'rifle'`.
    modelId: 'ar15',
    description: 'All-rounder. Full-auto, red dot, learnable climb-then-drift.',

    damage: 24, headMul: 2.0, limbMul: 0.8, pellets: 1, armorPen: 0.5,
    range: 150, falloffStart: 40, falloffEnd: 105, falloffMinScale: 0.55,

    rpm: 720, automatic: true, magSize: 30,
    startReserve: 180, maxReserve: 300,
    reloadTime: 1.95, reloadEmptyTime: 2.5, reloadType: 'magazine',
    switchTime: 0.42,

    spreadBase: 0.36, spreadMoving: 1.8, spreadJumping: 4.0, spreadCrouch: -0.16,
    spreadPerShot: 0.30, spreadMax: 5.0, spreadRecovery: 7.0,

    recoil: {
      // Climb for six, drift right, snap left — a classic controllable spray.
      pattern: [
        [0.95, 0.05], [1.05, -0.12], [1.10, 0.10], [1.05, 0.20], [0.95, 0.32], [0.85, 0.40],
        [0.70, 0.44], [0.60, 0.38], [0.50, 0.20], [0.45, -0.10], [0.42, -0.34], [0.40, -0.48],
        [0.38, -0.50], [0.36, -0.40], [0.35, -0.20], [0.34, 0.06], [0.34, 0.28], [0.33, 0.42],
        [0.32, 0.44], [0.32, 0.30], [0.31, 0.08], [0.30, -0.16], [0.30, -0.34], [0.30, -0.40],
      ],
      randomPitch: 0.10, randomYaw: 0.13,
      recovery: 8.5, recoveryDelay: 0.11,
      adsMul: 0.66, crouchMul: 0.78, moveMul: 1.28, airMul: 1.6,
      kickback: 0.020, kickRot: 1.1, shake: 0.04,
    },

    optic: { type: 'reddot', magnification: 1.3, reticle: 'dot' },
    adsTime: 0.14, adsSensitivity: 0.95, adsMoveSpeedMul: 0.80,
    adsSpreadMul: 0.10,
    moveSpeedMul: 0.94,

    viewOffset: [0.19, -0.148, -0.40],
    // Only [2] is used: how far in front of the eye the sight anchor sits.
    // 0.15 m puts the optic's 57 mm aperture across ~52% of the screen and the
    // hood across ~72%, which is the classic tube-sight picture.
    adsOffset: [0.0, 0.0, -0.15],
    adsRotation: [0, 0, 0],

    tracerColor: 0xffd28a, tracerWidth: 0.032, tracerSpeed: 520,
    muzzleFlashScale: 1.0, shellVelocity: [2.4, 2.7, 0.5],
    fireSound: 'shootRifle',
    reloadSounds: [[0.1, 'magOut'], [1.0, 'magIn'], [1.6, 'boltRelease']],
  },

  {
    id: 'burst',
    name: 'BR-3 BURST',
    short: 'BR-3',
    category: 'rifle',
    slot: 'primary',
    modelClass: 'burstRifle',
    modelId: 'burst',
    description: 'Three-round burst. Deadly at range if you land all three.',

    damage: 30, headMul: 2.1, limbMul: 0.8, pellets: 1, armorPen: 0.55,
    range: 165, falloffStart: 48, falloffEnd: 120, falloffMinScale: 0.6,

    rpm: 900, automatic: false, burstCount: 3, burstCooldown: 0.30,
    magSize: 30, startReserve: 150, maxReserve: 270,
    reloadTime: 2.1, reloadEmptyTime: 2.65, reloadType: 'magazine',
    switchTime: 0.45,

    spreadBase: 0.28, spreadMoving: 1.7, spreadJumping: 4.0, spreadCrouch: -0.14,
    spreadPerShot: 0.22, spreadMax: 4.0, spreadRecovery: 9.0,

    recoil: {
      pattern: [[1.10, 0.06], [1.25, 0.22], [1.35, 0.36]],
      randomPitch: 0.09, randomYaw: 0.12,
      recovery: 10.0, recoveryDelay: 0.16,
      adsMul: 0.6, crouchMul: 0.76, moveMul: 1.25, airMul: 1.6,
      kickback: 0.024, kickRot: 1.3, shake: 0.05,
    },

    optic: { type: 'holo', magnification: 1.45, reticle: 'holo' },
    adsTime: 0.15, adsSensitivity: 0.95, adsMoveSpeedMul: 0.79,
    adsSpreadMul: 0.09,
    moveSpeedMul: 0.94,

    viewOffset: [0.20, -0.175, -0.43],
    adsOffset: [0.0, -0.0525, -0.27],
    adsRotation: [0, 0, 0],

    tracerColor: 0xbfe4ff, tracerWidth: 0.030, tracerSpeed: 560,
    muzzleFlashScale: 0.95, shellVelocity: [2.4, 2.7, 0.5],
    fireSound: 'shootBurst',
    reloadSounds: [[0.1, 'magOut'], [1.05, 'magIn'], [1.7, 'boltRelease']],
  },

  {
    id: 'smg',
    name: 'MP-9 SMG',
    short: 'MP-9',
    category: 'smg',
    slot: 'primary',
    modelClass: 'smg',
    modelId: 'smg',
    description: 'Blistering fire rate, wide spray. Owns close quarters.',

    damage: 17, headMul: 1.8, limbMul: 0.85, pellets: 1, armorPen: 0.3,
    range: 85, falloffStart: 18, falloffEnd: 55, falloffMinScale: 0.42,

    rpm: 1000, automatic: true, magSize: 35,
    startReserve: 245, maxReserve: 385,
    reloadTime: 1.7, reloadEmptyTime: 2.15, reloadType: 'magazine',
    switchTime: 0.32,

    spreadBase: 0.55, spreadMoving: 1.2, spreadJumping: 3.4, spreadCrouch: -0.2,
    spreadPerShot: 0.28, spreadMax: 6.5, spreadRecovery: 8.0,

    recoil: {
      pattern: [
        [0.70, -0.06], [0.75, 0.10], [0.78, -0.14], [0.80, 0.18], [0.76, -0.22], [0.72, 0.26],
        [0.66, -0.30], [0.60, 0.32], [0.55, -0.28], [0.50, 0.24], [0.46, -0.20], [0.44, 0.18],
        [0.42, -0.22], [0.40, 0.26], [0.40, -0.30], [0.38, 0.28],
      ],
      randomPitch: 0.12, randomYaw: 0.22,
      recovery: 10.5, recoveryDelay: 0.08,
      adsMul: 0.7, crouchMul: 0.82, moveMul: 1.15, airMul: 1.45,
      kickback: 0.014, kickRot: 0.85, shake: 0.028,
    },

    optic: { type: 'iron', magnification: 1.2, reticle: 'none' },
    adsTime: 0.10, adsSensitivity: 0.98, adsMoveSpeedMul: 0.90,
    adsSpreadMul: 0.22,
    moveSpeedMul: 1.02,

    viewOffset: [0.19, -0.165, -0.36],
    adsOffset: [0.0, -0.0445, -0.23],
    adsRotation: [0, 0, 0],

    tracerColor: 0xffdca0, tracerWidth: 0.024, tracerSpeed: 460,
    muzzleFlashScale: 0.8, shellVelocity: [2.6, 2.5, 0.5],
    fireSound: 'shootSmg',
    reloadSounds: [[0.08, 'magOut'], [0.85, 'magIn'], [1.4, 'boltRelease']],
  },

  /* ===================================================================== */
  /* SHOTGUNS                                                              */
  /* ===================================================================== */
  {
    id: 'shotgun',
    name: 'M870 BREACHER',
    short: 'M870',
    category: 'shotgun',
    slot: 'primary',
    modelClass: 'shotgun',
    modelId: 'shotgun',
    description: 'Pump-action. Devastating inside ten metres.',

    damage: 15, headMul: 1.5, limbMul: 0.9, pellets: 9, armorPen: 0.25,
    range: 48, falloffStart: 9, falloffEnd: 30, falloffMinScale: 0.2,

    rpm: 78, automatic: false, magSize: 7,
    startReserve: 42, maxReserve: 84,
    reloadTime: 0.46, reloadEmptyTime: 0.46, reloadType: 'shells',
    reloadStartTime: 0.35, reloadEndTime: 0.4,
    pumpTime: 0.55,
    switchTime: 0.48,

    spreadBase: 3.0, spreadMoving: 1.0, spreadJumping: 2.2, spreadCrouch: -0.5,
    spreadPerShot: 0.35, spreadMax: 6.5, spreadRecovery: 4.5,

    recoil: {
      pattern: [[4.0, 0.30], [4.3, -0.45], [4.1, 0.50], [4.4, -0.35]],
      randomPitch: 0.42, randomYaw: 0.5,
      recovery: 6.0, recoveryDelay: 0.16,
      adsMul: 0.8, crouchMul: 0.82, moveMul: 1.2, airMul: 1.6,
      kickback: 0.075, kickRot: 3.0, shake: 0.17,
    },

    optic: { type: 'iron', magnification: 1.12, reticle: 'none' },
    adsTime: 0.16, adsSensitivity: 0.98, adsMoveSpeedMul: 0.84,
    adsSpreadMul: 0.62,   // ADS tightens the pattern but never to a point
    moveSpeedMul: 0.92,

    viewOffset: [0.21, -0.185, -0.46],
    adsOffset: [0.0, -0.0535, -0.30],
    adsRotation: [0, 0, 0],

    tracerColor: 0xffc98a, tracerWidth: 0.020, tracerSpeed: 400,
    muzzleFlashScale: 1.55, shellVelocity: [2.1, 2.9, 0.4],
    fireSound: 'shootShotgun',
    reloadSounds: [],
  },

  {
    id: 'autoshotgun',
    name: 'SPAS-12 AUTO',
    short: 'SPAS',
    category: 'shotgun',
    slot: 'primary',
    modelClass: 'autoShotgun',
    modelId: 'autoshotgun',
    description: 'Semi-auto shotgun. Less punch per shell, far more of them.',

    damage: 11, headMul: 1.45, limbMul: 0.9, pellets: 8, armorPen: 0.2,
    range: 42, falloffStart: 8, falloffEnd: 26, falloffMinScale: 0.18,

    rpm: 190, automatic: false, magSize: 8,
    startReserve: 48, maxReserve: 96,
    reloadTime: 2.5, reloadEmptyTime: 3.0, reloadType: 'magazine',
    switchTime: 0.5,

    spreadBase: 3.4, spreadMoving: 1.1, spreadJumping: 2.4, spreadCrouch: -0.5,
    spreadPerShot: 0.55, spreadMax: 7.5, spreadRecovery: 5.0,

    recoil: {
      pattern: [[2.6, 0.24], [2.9, -0.34], [3.1, 0.40], [3.0, -0.30], [2.8, 0.34]],
      randomPitch: 0.3, randomYaw: 0.36,
      recovery: 7.0, recoveryDelay: 0.12,
      adsMul: 0.78, crouchMul: 0.82, moveMul: 1.2, airMul: 1.55,
      kickback: 0.055, kickRot: 2.3, shake: 0.12,
    },

    optic: { type: 'iron', magnification: 1.12, reticle: 'none' },
    adsTime: 0.16, adsSensitivity: 0.98, adsMoveSpeedMul: 0.84,
    adsSpreadMul: 0.6,
    moveSpeedMul: 0.93,

    viewOffset: [0.21, -0.185, -0.45],
    adsOffset: [0.0, -0.0525, -0.29],
    adsRotation: [0, 0, 0],

    tracerColor: 0xffc98a, tracerWidth: 0.020, tracerSpeed: 400,
    muzzleFlashScale: 1.4, shellVelocity: [2.3, 2.8, 0.45],
    fireSound: 'shootShotgun',
    reloadSounds: [[0.15, 'magOut'], [1.4, 'magIn'], [2.1, 'boltRelease']],
  },

  /* ===================================================================== */
  /* PRECISION                                                             */
  /* ===================================================================== */
  {
    id: 'sniper',
    name: 'AWM BOLT-ACTION',
    short: 'AWM',
    category: 'sniper',
    slot: 'primary',
    modelClass: 'sniper',
    modelId: 'sniper',
    description: 'One shot, one kill — if you can hold the crosshair still.',

    damage: 115, headMul: 2.5, limbMul: 0.62, pellets: 1, armorPen: 0.9,
    range: 400, falloffStart: 200, falloffEnd: 380, falloffMinScale: 0.75,

    rpm: 45, automatic: false, magSize: 5,
    startReserve: 25, maxReserve: 40,
    reloadTime: 3.1, reloadEmptyTime: 3.6, reloadType: 'magazine',
    boltTime: 1.05,
    switchTime: 0.62,

    spreadBase: 0.9, spreadMoving: 5.5, spreadJumping: 9.0, spreadCrouch: -0.4,
    spreadPerShot: 0.6, spreadMax: 8.0, spreadRecovery: 4.0,

    recoil: {
      pattern: [[6.5, 0.30], [6.8, -0.45], [6.6, 0.50]],
      randomPitch: 0.5, randomYaw: 0.45,
      recovery: 4.5, recoveryDelay: 0.22,
      adsMul: 0.85, crouchMul: 0.8, moveMul: 1.4, airMul: 1.9,
      kickback: 0.11, kickRot: 4.2, shake: 0.24,
    },

    optic: {
      type: 'scope', reticle: 'mildot',
      magnifications: [5, 9],       // adjustable zoom, cycled while scoped
      scoped: true,
      swayAmplitude: 0.0035,        // radians of idle sway at full zoom
      breathHold: true,
      holdDuration: 3.4,
      holdRecovery: 5.0,
    },
    adsTime: 0.24, adsSensitivity: 0.92, adsMoveSpeedMul: 0.58,
    adsSpreadMul: 0.0,              // pinpoint accurate when fully scoped
    moveSpeedMul: 0.86,

    /** Bullets are simulated with travel time and drop. */
    projectile: { speed: 900, gravity: 5.0 },

    viewOffset: [0.215, -0.185, -0.50],
    adsOffset: [0.0, -0.0555, -0.34],
    adsRotation: [0, 0, 0],

    tracerColor: 0xfff0c0, tracerWidth: 0.045, tracerSpeed: 900,
    muzzleFlashScale: 1.8, shellVelocity: [2.4, 3.0, 0.5],
    fireSound: 'shootSniper',
    reloadSounds: [[0.2, 'magOut'], [1.6, 'magIn'], [2.7, 'boltRelease']],
  },

  {
    id: 'marksman',
    name: 'SR-25 MARKSMAN',
    short: 'SR-25',
    category: 'sniper',
    slot: 'primary',
    modelClass: 'marksman',
    modelId: 'marksman',
    description: 'Semi-auto DMR. Medium scope, fast follow-up shots.',

    damage: 62, headMul: 2.3, limbMul: 0.7, pellets: 1, armorPen: 0.75,
    range: 260, falloffStart: 110, falloffEnd: 230, falloffMinScale: 0.7,

    rpm: 200, automatic: false, magSize: 12,
    startReserve: 72, maxReserve: 120,
    reloadTime: 2.4, reloadEmptyTime: 2.9, reloadType: 'magazine',
    switchTime: 0.52,

    spreadBase: 0.5, spreadMoving: 3.4, spreadJumping: 6.5, spreadCrouch: -0.25,
    spreadPerShot: 0.9, spreadMax: 6.0, spreadRecovery: 5.0,

    recoil: {
      pattern: [[3.0, 0.20], [3.3, -0.30], [3.1, 0.34], [3.4, -0.22], [3.2, 0.28]],
      randomPitch: 0.24, randomYaw: 0.28,
      recovery: 6.5, recoveryDelay: 0.14,
      adsMul: 0.7, crouchMul: 0.76, moveMul: 1.35, airMul: 1.8,
      kickback: 0.062, kickRot: 2.6, shake: 0.11,
    },

    optic: {
      type: 'scope', reticle: 'chevron',
      magnifications: [3.5],
      scoped: true,
      swayAmplitude: 0.0022,
      breathHold: true,
      holdDuration: 4.0,
      holdRecovery: 5.5,
    },
    adsTime: 0.19, adsSensitivity: 0.94, adsMoveSpeedMul: 0.70,
    adsSpreadMul: 0.05,
    moveSpeedMul: 0.9,

    viewOffset: [0.21, -0.18, -0.47],
    adsOffset: [0.0, -0.0545, -0.31],
    adsRotation: [0, 0, 0],

    tracerColor: 0xffe6b0, tracerWidth: 0.036, tracerSpeed: 700,
    muzzleFlashScale: 1.3, shellVelocity: [2.5, 2.8, 0.5],
    fireSound: 'shootMarksman',
    reloadSounds: [[0.15, 'magOut'], [1.25, 'magIn'], [2.0, 'boltRelease']],
  },

  /* ===================================================================== */
  /* SUPPORT                                                               */
  /* ===================================================================== */
  {
    id: 'lmg',
    name: 'M249 SAW',
    short: 'M249',
    category: 'lmg',
    slot: 'primary',
    modelClass: 'lmg',
    modelId: 'lmg',
    description: '100-round belt. Terrible mobility, endless suppression.',

    damage: 22, headMul: 1.8, limbMul: 0.85, pellets: 1, armorPen: 0.6,
    range: 160, falloffStart: 45, falloffEnd: 115, falloffMinScale: 0.55,

    rpm: 800, automatic: true, magSize: 100,
    startReserve: 200, maxReserve: 400,
    reloadTime: 4.6, reloadEmptyTime: 5.4, reloadType: 'magazine',
    switchTime: 0.7,

    spreadBase: 0.9, spreadMoving: 3.2, spreadJumping: 6.0, spreadCrouch: -0.45,
    spreadPerShot: 0.20, spreadMax: 7.0, spreadRecovery: 5.5,

    recoil: {
      pattern: [
        [1.05, 0.05], [1.15, 0.16], [1.20, 0.28], [1.15, 0.36], [1.05, 0.30], [0.95, 0.12],
        [0.85, -0.14], [0.75, -0.34], [0.68, -0.46], [0.62, -0.44], [0.58, -0.28], [0.55, -0.04],
        [0.52, 0.22], [0.50, 0.40], [0.48, 0.46], [0.46, 0.36], [0.45, 0.14], [0.44, -0.12],
        [0.43, -0.32], [0.42, -0.42],
      ],
      randomPitch: 0.14, randomYaw: 0.2,
      recovery: 7.0, recoveryDelay: 0.13,
      adsMul: 0.6, crouchMul: 0.62, moveMul: 1.45, airMul: 1.8,
      kickback: 0.026, kickRot: 1.4, shake: 0.055,
    },

    optic: { type: 'iron', magnification: 1.25, reticle: 'none' },
    adsTime: 0.22, adsSensitivity: 0.95, adsMoveSpeedMul: 0.64,
    adsSpreadMul: 0.14,
    moveSpeedMul: 0.8,

    viewOffset: [0.225, -0.19, -0.48],
    adsOffset: [0.0, -0.0545, -0.30],
    adsRotation: [0, 0, 0],

    tracerColor: 0xffcf6a, tracerWidth: 0.038, tracerSpeed: 520,
    muzzleFlashScale: 1.35, shellVelocity: [2.9, 2.6, 0.6],
    fireSound: 'shootLmg',
    reloadSounds: [[0.3, 'magOut'], [2.6, 'magIn'], [4.2, 'boltRelease']],
  },

  /* ===================================================================== */
  /* MELEE & THROWABLES                                                    */
  /* ===================================================================== */
  {
    id: 'knife',
    name: 'COMBAT KNIFE',
    short: 'KNIFE',
    category: 'melee',
    slot: 'melee',
    modelClass: 'knife',
    modelId: 'knife',
    description: 'Silent, instant, and lethal from behind.',

    damage: 65, headMul: 1.6, limbMul: 1.0, backstabMul: 3.0,
    armorPen: 0.5,
    range: 2.4,
    falloffStart: 2.4, falloffEnd: 2.4, falloffMinScale: 1,

    rpm: 90, automatic: false, magSize: Infinity,
    startReserve: 0, maxReserve: 0,
    reloadTime: 0, reloadEmptyTime: 0, reloadType: 'none',
    switchTime: 0.24,
    melee: true,
    swingTime: 0.42, hitTime: 0.16, hitRadius: 0.6,

    spreadBase: 0, spreadMoving: 0, spreadJumping: 0, spreadCrouch: 0,
    spreadPerShot: 0, spreadMax: 0, spreadRecovery: 1,

    recoil: {
      pattern: [[0.4, 0.3]],
      randomPitch: 0.1, randomYaw: 0.1,
      recovery: 12, recoveryDelay: 0.05,
      adsMul: 1, crouchMul: 1, moveMul: 1, airMul: 1,
      kickback: 0.05, kickRot: 2.0, shake: 0.03,
    },

    optic: { type: 'none', magnification: 1, reticle: 'none' },
    adsTime: 0.14, adsSensitivity: 1.0, adsMoveSpeedMul: 1.0,
    adsSpreadMul: 1, noAds: true,
    moveSpeedMul: 1.09,

    viewOffset: [0.22, -0.20, -0.32],
    adsOffset: [0.22, -0.20, -0.32],
    adsRotation: [0, 0, 0],

    tracerColor: 0xffffff, tracerWidth: 0, tracerSpeed: 1,
    muzzleFlashScale: 0, shellVelocity: [0, 0, 0],
    fireSound: 'knifeSwing',
    reloadSounds: [],
  },

  {
    id: 'grenade',
    name: 'M67 FRAG',
    short: 'FRAG',
    category: 'throwable',
    slot: 'throwable',
    modelClass: 'grenade',
    modelId: 'grenade',
    description: 'Cook it, bank it off a wall, clear the room.',

    damage: 130, headMul: 1, limbMul: 1, armorPen: 0.8,
    range: 60,
    falloffStart: 0, falloffEnd: 7.5, falloffMinScale: 0,
    blastRadius: 7.5, fuseTime: 2.6, throwSpeed: 17,

    rpm: 45, automatic: false, magSize: 1,
    startReserve: 2, maxReserve: 4,
    reloadTime: 0.9, reloadEmptyTime: 0.9, reloadType: 'magazine',
    switchTime: 0.3,
    throwable: true,
    // Separate from `throwable`, which describes how it is used. This one
    // states that a hit claimed against yourself is believable — true of your
    // own frag and of a barrel, and false of every bullet in the game.
    selfHarm: true,

    spreadBase: 0, spreadMoving: 0, spreadJumping: 0, spreadCrouch: 0,
    spreadPerShot: 0, spreadMax: 0, spreadRecovery: 1,

    recoil: {
      pattern: [[0.5, 0.1]],
      randomPitch: 0.1, randomYaw: 0.1,
      recovery: 12, recoveryDelay: 0.05,
      adsMul: 1, crouchMul: 1, moveMul: 1, airMul: 1,
      kickback: 0.02, kickRot: 1.0, shake: 0.02,
    },

    optic: { type: 'none', magnification: 1, reticle: 'none' },
    adsTime: 0.16, adsSensitivity: 1.0, adsMoveSpeedMul: 0.95,
    adsSpreadMul: 1, noAds: true,
    moveSpeedMul: 1.04,

    viewOffset: [0.2, -0.19, -0.3],
    adsOffset: [0.12, -0.14, -0.28],
    adsRotation: [0, 0, 0],

    tracerColor: 0xffffff, tracerWidth: 0, tracerSpeed: 1,
    muzzleFlashScale: 0, shellVelocity: [0, 0, 0],
    fireSound: 'grenadeThrow',
    reloadSounds: [],
  },

  /* ===================================================================== */
  /* GADGETS                                                               */
  /* ===================================================================== */
  /*
   * The scout drone's handset. A weapon in the table, and nothing else.
   *
   * It is in WEAPON_DEFS on purpose, and that membership is the entire
   * multiplayer half of the feature: the server derives `HELD_WEAPON_IDS` from
   * this array, `w` is already in every snapshot row, so an enemy who walks in
   * on a pilot sees a screen in their hands instead of a rifle with NO protocol
   * change at all. A gadget kept in a table of its own would have needed one.
   *
   * `slot: 'gadget'` is what keeps it out of everything that would be wrong.
   * `weaponsForSlot` and the loadout browser both filter for primary/secondary,
   * so it can never be picked; `SLOTS` in WeaponSystem lists the four carried
   * slots, so it is on no number key; and it is reached only through
   * `equipGadget`, against the pool rather than a slot index.
   *
   * `damage: 0` is what keeps it out of `test/damage-falloff.mjs`, which skips
   * anything that cannot hurt somebody.
   */
  {
    id: 'dronectl',
    name: 'FIELD TERMINAL',
    short: 'TERM',
    category: 'gadget',
    slot: 'gadget',
    /*
     * Procedural, and deliberately WITHOUT a `modelId`.
     *
     * Every other weapon names one, and every one of those ids has a .glb in
     * `public/models/` produced by a script in `assets/blender/builds/`. There
     * is no authored terminal and no build script for one, so naming a model id
     * here would either fail `test/contracts.mjs` ("every weapon resolves to a
     * model that is actually loaded") or, if the manifest were extended to
     * match, 404 on every single page load forever for a file nothing produces.
     *
     * Omitting it is also strictly safer than a unique-but-absent id:
     * `buildViewModel` adds an authored scene WITHOUT cloning it, so two defs
     * sharing an id reparent geometry out of each other's group. With no id
     * there is nothing to share. When a `dronectl.glb` is eventually authored,
     * adding the manifest entry and one line here is the whole change.
     */
    modelClass: 'terminal',
    gadget: true,
    description: 'Handheld control terminal for the scout drone. Not a weapon.',

    // Priced like everything else so nothing downstream has to special-case it,
    // and zeroed so the price is always nothing. See `_handleFiring`: a gadget
    // is neither `melee` nor `throwable`, and with an empty magazine and no
    // reserve the trigger falls through to the dry-fire branch and stops there.
    damage: 0, headMul: 1, limbMul: 1, pellets: 1, armorPen: 0,
    range: 0, falloffStart: 0, falloffEnd: 0, falloffMinScale: 1,

    rpm: 60, automatic: false, magSize: 0,
    startReserve: 0, maxReserve: 0,
    // 'none' rather than 'magazine': `canReload` is false for it, which is what
    // stops the auto-reload in `_handleReload` firing every frame on a weapon
    // that is permanently empty by design.
    reloadTime: 0, reloadEmptyTime: 0, reloadType: 'none',
    switchTime: 0.45,

    spreadBase: 0, spreadMoving: 0, spreadJumping: 0, spreadCrouch: 0,
    spreadPerShot: 0, spreadMax: 0, spreadRecovery: 1,

    // Never read — `fire()` is unreachable for a gadget — but present because
    // `RecoilSystem.fire` indexes `def.recoil.pattern` without guarding, and a
    // definition that is complete cannot become the next NaN.
    recoil: {
      pattern: [[0, 0]],
      randomPitch: 0, randomYaw: 0,
      recovery: 12, recoveryDelay: 0.05,
      adsMul: 1, crouchMul: 1, moveMul: 1, airMul: 1,
      kickback: 0, kickRot: 0, shake: 0,
    },

    optic: { type: 'none', magnification: 1, reticle: 'none' },
    adsTime: 0.14, adsSensitivity: 1.0, adsMoveSpeedMul: 1.0,
    adsSpreadMul: 1, noAds: true,
    // Held two-handed at chest height and read rather than aimed. Slower than
    // the LMG, because a pilot is a stationary target by design.
    moveSpeedMul: 0.62,

    /*
     * Held higher and closer than a gun, because the screen has to be READ.
     *
     * A rifle's offset points a barrel down-range and puts the receiver at the
     * bottom of the frame, which is exactly where you want a gun and exactly
     * wrong for a panel: at -0.15 the terminal sat almost entirely below the
     * viewport, with only its aerial and the top centimetre of the bezel
     * showing. Raised and pulled in until the panel occupies the lower third
     * of the screen and can actually be looked at.
     */
    viewOffset: [0.002, -0.074, -0.347],
    adsOffset: [0.002, -0.074, -0.347],
    adsRotation: [0, 0, 0],

    tracerColor: 0xffffff, tracerWidth: 0, tracerSpeed: 1,
    muzzleFlashScale: 0, shellVelocity: [0, 0, 0],
    // A button press, not a shot. `fireSound` is required of every carried
    // definition (see test/contracts.mjs) and every name must have a synth.
    fireSound: 'uiClick',
    reloadSounds: [],
  },
];

/** Optic magnification lookup used for ADS FOV and sensitivity scaling. */
export function opticMagnification(def, zoomIndex = 0) {
  const o = def.optic;
  if (!o) return 1;
  if (Array.isArray(o.magnifications) && o.magnifications.length) {
    return o.magnifications[Math.min(zoomIndex, o.magnifications.length - 1)];
  }
  return o.magnification ?? 1;
}

/**
 * Vertical FOV (degrees) that corresponds to a given magnification, relative
 * to the player's chosen base FOV. Derived properly from the tangent so a
 * "4x" optic really does halve the on-screen size twice over.
 */
export function fovForMagnification(baseFovDeg, magnification) {
  const halfBase = Math.tan((baseFovDeg * Math.PI) / 360);
  const halfZoom = halfBase / Math.max(1, magnification);
  return (Math.atan(halfZoom) * 360) / Math.PI;
}

/**
 * Hazards that deal damage without being weapons.
 *
 * The server prices every hit from a definition, so a barrel blast had to
 * claim to be something the server recognised — and it claimed to be a
 * grenade. Barrels therefore hit for the grenade's 130 instead of their own
 * 95 in a match, and the kill feed credited a frag nobody had thrown.
 *
 * Kept out of WEAPON_DEFS so a barrel can never turn up in the loadout
 * browser, which is generated from that list.
 */
export const HAZARD_DEFS = [
  {
    id: 'barrel',
    name: 'EXPLOSION',
    short: 'BLAST',
    category: 'hazard',

    // Matches Level.js, which is where the barrels themselves are configured.
    damage: 95, headMul: 1, limbMul: 1, armorPen: 0.8,
    range: 60,
    /*
     * A barrel is dangerous at the range you actually shoot one from.
     *
     * This used to be the frag's curve — full damage at the centre falling
     * linearly to ZERO at 7.5 m. That works for a grenade, which you drop at
     * your own feet, and not at all for a barrel, which nobody stands next to
     * while shooting it. At a normal 6-7 m it paid 6-19 damage, of which
     * armour ate 60%, so an exploding barrel cost you two to eight health and
     * felt like nothing at all.
     *
     * Full damage inside 2.5 m, still 33 at the very edge.
     */
    falloffStart: 2.5, falloffEnd: 7.5, falloffMinScale: 0.35,
    blastRadius: 7.5,

    // Standing next to one that goes off is very much your own problem.
    selfHarm: true,
    // Chains set off several within a second, and each is a separate claim.
    // Too low a figure here and the rate limiter eats the back half of a chain.
    rpm: 300, automatic: false, magSize: 1,
  },
];

export function getWeaponDef(id) {
  return WEAPON_DEFS.find((w) => w.id === id)
    ?? HAZARD_DEFS.find((h) => h.id === id)
    ?? null;
}

/** Weapons the player can put in a loadout slot. */
export function weaponsForSlot(slot) {
  return WEAPON_DEFS.filter((w) => w.slot === slot);
}

export const CATEGORY_LABELS = Object.freeze({
  pistol: 'Pistol',
  rifle: 'Assault',
  smg: 'SMG',
  shotgun: 'Shotgun',
  sniper: 'Precision',
  lmg: 'Support',
  melee: 'Melee',
  throwable: 'Throwable',
});
