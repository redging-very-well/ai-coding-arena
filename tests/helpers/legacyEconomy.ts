// The $1,000-game economy rescaled ×5 ("Old ×5 (k 2)"): the
// M8.7 formula (k = 2, no power factor) with every money coefficient ×5
// (base 50, hp 0.25, damage 1.5, range 1.0, speed 60, size 2.5; walls 20 /
// 0.06; factories 50 / 0.12), the $5,000 budget and $2,500 cap, and the
// M8.7 minions at exactly ×5 (the grunt at 200 HP, not M8.8's 180; the brute at
// 500 HP, not M8.8's 550). The
// curve maxima are today's ×5 bounds, so a ×5 unit costs what its ×1
// original cost, ×5 (up to the rounding of each price).
//
// tests/rescale.test.ts plays the M8.7 battles on it at ×1 and ×5 to show
// the rescale changes nothing: the sim is scale-invariant (sudden death is a
// percentage), and battles without elements or support play exactly like
// M8.7. (tests/balance.test.ts moved to the M8.8 prices with the balance refit.)

import { ConfigSchema, DEFAULT_CONFIG, type GameConfig } from '@pixel-clash/shared';

export const LEGACY_ECONOMY_CONFIG: GameConfig = ConfigSchema.parse({
  ...DEFAULT_CONFIG,
  cost: {
    ...DEFAULT_CONFIG.cost,
    base: 50,
    hp: 0.25,
    damage: 1.5,
    range: 1.0,
    speed: 60,
    size: 2.5,
    curveK: 2,
    powerFactor: 0,
    wall: { base: 20, hp: 0.06 },
    factory: { base: 50, hp: 0.12, minionDiscount: 0.5 },
  },
  factory: {
    ...DEFAULT_CONFIG.factory,
    minions: {
      ...DEFAULT_CONFIG.factory.minions,
      grunt: { ...DEFAULT_CONFIG.factory.minions.grunt, maxHealth: 200 },
      brute: { ...DEFAULT_CONFIG.factory.minions.brute, maxHealth: 500 },
    },
  },
});
