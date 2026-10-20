// Basic Soldier: the starter soldier template (Pixel Clash).
//
// Every unit is ONE class that is the default export. The constructor sets
// the stats as plain properties on `this`; the game reads them once, when the
// unit is checked, and works out the cost from them. Changing stats later
// (inside update) has no effect.
//
// Cost = (10 + each stat's price) * max(1, 60 / attackCooldown), where a stat's
// price is its normal price (maxHealth*0.25, damage*1.5, range*0.2, speed*12,
// (size - 6)*0.5) times 1 + 2*(stat/max)^2: a maxed stat costs 3x.
//      = (10 + 33.46 + 15.83 + 8.28 + 21.24 + 2.33) * 1 = 91.14  ->  $92
//
// No imports, no timers, no network, no async: the unit only gets what the
// game passes to update().

export default class BasicSoldier {
  constructor() {
    this.name = 'Basic Soldier';
    this.type = 'soldier';      // soldiers can move; towers can't
    this.maxHealth = 120;       // 10-500
    this.damage = 10;           // 0-60 per hit
    this.range = 40;            // 20-300 px, measured EDGE to edge between the two bodies
    this.speed = 1.5;           // 0.5-5 px per tick (60 ticks = 1 second)
    this.attackCooldown = 60;   // whole ticks between attacks: 60 = once per second
    this.color = '#3399FF';     // "#RRGGBB"
    this.size = 10;             // 6-20 px body radius (hitbox and drawn size); $0.5 per px above 6 (more near the max)
    this.shape = 'circle';      // circle, square, triangle or diamond (just for looks)
  }

  // Called once per tick (60 times a second) for each copy of this unit.
  //   self    - this copy: position, hp, range, radius, cooldownRemaining...
  //   enemies - every living enemy unit
  //   allies  - my other living units
  //   world   - arena size, tick, my corner, the shrinking safe zone
  // Return one action: { action: 'attack', targetId }, { action: 'move', destination: {x, y} }
  // or { action: 'idle' }.
  update(self, enemies, allies, world) {
    // No enemies left: walk to the middle (and stay inside the safe zone).
    if (enemies.length === 0) {
      return { action: 'move', destination: world.center };
    }

    // Find the nearest enemy, measuring the gap between the two bodies.
    let target = enemies[0];
    let bestGap = Infinity;
    for (const enemy of enemies) {
      const gap = Math.hypot(enemy.x - self.x, enemy.y - self.y) - self.radius - enemy.radius;
      if (gap < bestGap) {
        bestGap = gap;
        target = enemy;
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

    // Too far away: walk straight towards it.
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
