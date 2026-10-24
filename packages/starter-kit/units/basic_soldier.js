// Basic Soldier: the starter soldier template (Pixel Clash).
// (Notes on cost and options are at the bottom of this file.)

export default class BasicSoldier {
  constructor() {
    this.name = 'Basic Soldier';
    this.type = 'soldier';      // soldiers can move; towers can't
    this.maxHealth = 1400;      // 80-4000
    this.damage = 56;           // 0-240 per hit
    this.range = 40;            // 20-160 px for soldiers (towers reach 300), EDGE to edge between the two bodies
    this.speed = 1.5;           // 0.5-5 px per tick (60 ticks = 1 second)
    this.attackCooldown = 60;   // whole ticks between attacks: 60 = once per second
    this.color = '#3399FF';     // "#RRGGBB"
    this.size = 10;             // 6-20 px body radius (hitbox and drawn size); $8 per px above 6 (more near the max)
    // this.element = 'fire';   // 'normal', 'fire' or 'lightning' (x1.3 on the price) or 'ice' (x1.75)
    // this.splashRadius = 40;  // 0-80 px: other enemies near the target take half (x1.6 at 40)
    this.shape = 'circle';      // circle, square, triangle or diamond (just for looks)
  }

  // Called once per tick (60 times a second) for each copy of this unit.
  //   self    - this copy: position, hp, range, radius, cooldownRemaining...
  //   enemies - every living enemy unit (also enemy walls, factories and minions:
  //             check enemy.type)
  //   allies  - my other living units (and in team mode my teammates' units)
  //   world   - arena size (world.width: 800, 1040 or 1200), world.center,
  //             tick, my start zone, the shrinking safe zone. Never assume 800!
  // Return one action: { action: 'attack', targetId }, { action: 'move', destination: {x, y} }
  // or { action: 'idle' }.
  update(self, enemies, allies, world) {
    // No enemies left: walk to the middle (and stay inside the safe zone).
    if (enemies.length === 0) {
      return { action: 'move', destination: world.center };
    }

    // Stuck behind an ENEMY wall for 2 seconds (120 ticks)? Smash through it.
    // (Only while that wall is still standing: it is in `enemies` until it breaks.
    // Our own and our teammates' walls are never in `enemies`.)
    if (self.blockedTicks >= 120) {
      const wall = enemies.find((enemy) => enemy.id === self.blockedBy);
      if (wall) {
        const gap = Math.hypot(wall.x - self.x, wall.y - self.y) - self.radius - wall.radius;
        if (gap <= self.range) {
          return self.cooldownRemaining === 0 ? { action: 'attack', targetId: wall.id } : { action: 'idle' };
        }
        return { action: 'move', destination: { x: wall.x, y: wall.y } };
      }
    }

    // Find the nearest enemy that isn't a wall (walls can't fight back, and
    // they're worth nothing at the end), measuring the gap between the bodies.
    // If only walls are left, take the nearest wall.
    let target = null;
    let bestGap = Infinity;
    for (const enemy of enemies) {
      if (enemy.type === 'wall') continue;
      const gap = Math.hypot(enemy.x - self.x, enemy.y - self.y) - self.radius - enemy.radius;
      if (gap < bestGap) {
        bestGap = gap;
        target = enemy;
      }
    }
    if (!target) {
      for (const enemy of enemies) {
        const gap = Math.hypot(enemy.x - self.x, enemy.y - self.y) - self.radius - enemy.radius;
        if (gap < bestGap) {
          bestGap = gap;
          target = enemy;
        }
      }
    }

    // Close enough to hit it?
    if (bestGap <= self.range) {
      // Attack when ready; otherwise hold position until the cooldown ends.
      if (self.cooldownRemaining === 0) {
        return { action: 'attack', targetId: target.id };
      }
      return { action: 'idle' };
    }

    // Too far away: walk towards it. If a wall is in the way, the game slides
    // the soldier along it (self.blockedBy / self.blockedTicks say so).
    return { action: 'move', destination: { x: target.x, y: target.y } };
  }

  // How the unit looks: pixel art, called ONCE when the unit is checked (never
  // in battle). Each frame is 16 strings of 16 characters; each character is
  // one pixel: a palette key, or '.' for transparent. Draw it FACING RIGHT (the
  // game mirrors it when it goes left) with a dark outline so it pops on the
  // floor. The drawn size follows this.size, not the grid.
  // This one is a little knight with a sword and shield.
  sprite() {
    return {
      grid: 16, // 16x16 pixels per frame
      palette: {
        o: '#1A1428', // outline (dark)
        s: '#D8E0EA', // steel
        m: '#8C98AC', // steel shadow
        b: '#3399FF', // tunic (my colour)
        d: '#1E5AA8', // tunic shadow
        r: '#E8413C', // plume
        y: '#FFC933', // gold
        w: '#F4F8FF', // blade
        n: '#6B4226', // boots
      },
      frames: {
        idle: [ // standing: 2 frames, breathing
          [
            '......ooo.......',
            '.....orrro......',
            '....ommmmmo.....',
            '...omssssmmo..o.',
            '...omsssoooo.owo',
            '...omsssssmo.owo',
            '....ommmmmo..owo',
            '..ooodbbbbo..owo',
            '.odyddbbbbbooyyo',
            '.oyyydbbbbbbomo.',
            '.odyddbbbbdo.o..',
            '..ooomssssmo....',
            '....omoooomo....',
            '....omo..omo....',
            '...onno..onno...',
            '...oooo..oooo...',
          ],
          [
            '................',
            '......ooo.......',
            '.....orrro......',
            '....ommmmmo.....',
            '...omssssmmo..o.',
            '...omsssoooo.owo',
            '....ommmmmo..owo',
            '..ooodbbbbo..owo',
            '.odyddbbbbbooyyo',
            '.oyyydbbbbbbomo.',
            '.odyddbbbbdo.o..',
            '..ooomssssmo....',
            '....omoooomo....',
            '....omo..omo....',
            '...onno..onno...',
            '...oooo..oooo...',
          ],
        ],
        walk: [ // 2 frames, legs apart / together
          [
            '......ooo.......',
            '.....orrro......',
            '....ommmmmo.....',
            '...omssssmmo..o.',
            '...omsssoooo.owo',
            '...omsssssmo.owo',
            '....ommmmmo..owo',
            '..ooodbbbbo..owo',
            '.odyddbbbbbooyyo',
            '.oyyydbbbbbbomo.',
            '.odyddbbbbdo.o..',
            '..ooomssssmo....',
            '...omoooooomo...',
            '..omo......omo..',
            '.onno......onno.',
            '.oooo......oooo.',
          ],
          [
            '................',
            '......ooo.......',
            '.....orrro......',
            '....ommmmmo.....',
            '...omssssmmo..o.',
            '...omsssoooo.owo',
            '....ommmmmo..owo',
            '..ooodbbbbo..owo',
            '.odyddbbbbbooyyo',
            '.oyyydbbbbbbomo.',
            '.odyddbbbbdo.o..',
            '..ooomssssmo....',
            '.....omoomo.....',
            '.....omoomo.....',
            '....onnonno.....',
            '....oooooooo....',
          ],
        ],
        attack: [ // 1 frame: sword thrust forward
          [
            '......ooo.......',
            '.....orrro......',
            '....ommmmmo.....',
            '...omssssmmo....',
            '...omsssoooo....',
            '...omsssssmo....',
            '....ommmmmo.....',
            '..ooodbbbbooo...',
            '.odyddbbbbbmyooo',
            '.oyyydbbbbbmywww',
            '.odyddbbbbdoyooo',
            '..ooomssssmoo...',
            '....omoooomo....',
            '....omo..omo....',
            '...onno..onno...',
            '...oooo..oooo...',
          ],
        ],
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------
//
// Every unit is ONE class that is the default export. The constructor sets
// the stats as plain properties on `this`; the game reads them once, when the
// unit is checked, and works out the cost from them. Changing stats later
// (inside update) has no effect.
//
// Cost = (50 + each stat's price) * max(1, 60 / attackCooldown) * power * splash * element,
// where a stat's price is its normal price (maxHealth*0.1875, damage*1.875, range*1.38,
// speed*90, (size - 6)*8) times 1 + (stat/max)^2: a maxed stat costs 2x.
// power = 1 + 2 * (maxHealth/4000) * (damage/240): tough AND strong costs more (up to x3).
//      = (50 + 294.66 + 110.72 + 56.18 + 147.15 + 34.61) * 1 * 1.163 = 693.32 * 1.163 = 806.56  ->  $807
// Up to 12 fighters per army: copy 4 of the SAME design costs 15% more, copy 5 30% more,
// and so on (walls never cost more).
//
// Options (all optional; this template uses none of them):
//   this.element = 'fire';      'normal' (default), 'fire' (burns +50% over 3 s; x1.3), 'ice' (slows
//                               35% for 2 s; x1.75) or 'lightning' (35% chance to zap a 2nd enemy; x1.3).
//                               Burning enemies take +25% from your other hits, frozen ones +25% too.
//   this.splashRadius = 40;     0-80 px: other enemies this close to the target take half: x1.6 at 40
//   this.support = 'heal';      'heal' (return { action: 'heal', targetId }), or an aura that
//   this.supportPower = 60;     works by itself: 'haste', 'might' or 'shield' (power in %)
//   this.supportRange = 120;    heal reach / aura radius in px, edge to edge
//
// No imports, no timers, no network, no async: the unit only gets what the
// game passes to update().
