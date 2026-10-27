// Basic Tower: the starter tower template (Pixel Clash).
// (Notes on cost and options are at the bottom of this file.)

export default class FrostTower {
  constructor() {
    this.name = 'Frost Tower';
    this.type = 'tower';        // towers never move
    this.maxHealth = 1200;      // 80-4000
    this.damage = 72;           // 0-240 per hit
    this.range = 180;           // 20-300 px, EDGE to edge; above 50 it fires homing shots
    this.speed = 0;             // towers: always 0
    this.attackCooldown = 45;   // faster than 60 multiplies the whole cost (here x1.33)
    this.color = '#7FE3FF';     // "#RRGGBB"
    this.size = 14;             // 6-20 px body radius (hitbox and drawn size); $8 per px above 6 (more near the max)
    // this.element = 'ice';    // 'normal', 'fire' or 'lightning' (x1.3 on the price) or 'ice' (x1.75)
    // this.splashRadius = 40;  // 0-80 px: other enemies near the target take half (x1.6 at 40)
    this.shape = 'square';      // circle, square, triangle or diamond (just for looks)
    this.element = 'ice';
  }

  // Called once per tick for each copy of this tower. `enemies` holds only
  // units of other teams (same teamId = friend), so every target is fair game.
  update(self, enemies, allies, world) {
    // Can't fire yet: nothing to do this tick.
    if (self.cooldownRemaining > 0) {
      return { action: 'idle' };
    }

    // Shoot the nearest enemy in range (gap between the bodies <= range).
    // Walls can't hurt anyone, so shoot one only when nothing else is in range.
    // (Shots fly over walls.)
    let target = null;
    let bestGap = Infinity;
    let wallTarget = null;
    let bestWallGap = Infinity;
    for (const enemy of enemies) {
      const gap = Math.hypot(enemy.x - self.x, enemy.y - self.y) - self.radius - enemy.radius;
      if (gap > self.range) continue;
      if (enemy.type === 'wall') {
        if (gap < bestWallGap) {
          bestWallGap = gap;
          wallTarget = enemy;
        }
      } else if (gap < bestGap) {
        bestGap = gap;
        target = enemy;
      }
    }

    if (target || wallTarget) {
      return { action: 'attack', targetId: (target || wallTarget).id };
    }
    return { action: 'idle' };
  }

  // How the unit looks: pixel art, called ONCE when the unit is checked (never
  // in battle). Each frame is 16 strings of 16 characters; each character is
  // one pixel: a palette key, or '.' for transparent. Draw it FACING RIGHT (the
  // game mirrors it when it goes left) with a dark outline so it pops on the
  // floor. The drawn size follows this.size, not the grid.
  // This one is a stone turret with a glowing crystal on top.
  sprite() {
    return {
      grid: 16, // 16x16 pixels per frame
      palette: {
        o: '#1A1428', // outline (dark)
        g: '#A7ADBA', // stone
        s: '#7D8393', // stone shadow
        d: '#4B4F5E', // dark stone
        c: '#FF9933', // crystal (my colour)
        l: '#FFD199', // crystal shine
        k: '#B5520F', // crystal shadow
        y: '#FFF6A8', // glow
      },
      frames: {
        idle: [ // 2 frames: the crystal twinkles
          [
            '.......oo.......',
            '......olko......',
            '.....olccko.....',
            '.....olckko.....',
            '......okko......',
            '..ooo.oooo.ooo..',
            '..ogo.ogso.odo..',
            '..ogooogsoooso..',
            '..ogggggssssdo..',
            '..oddddddddddo..',
            '..oggsggsoosdo..',
            '..ogsgggsooddo..',
            '..oddddddddddo..',
            '..oggsgggsgsdo..',
            '.ogggsggggssddo.',
            '.oooooooooooooo.',
          ],
          [
            '.......oo...y...',
            '......oyko......',
            '.....oylcko.....',
            '.....olckko.....',
            '......okko......',
            '..ooo.oooo.ooo..',
            '..ogo.ogso.odo..',
            '..ogooogsoooso..',
            '..ogggggssssdo..',
            '..oddddddddddo..',
            '..oggsggsoosdo..',
            '..ogsgggsooddo..',
            '..oddddddddddo..',
            '..oggsgggsgsdo..',
            '.ogggsggggssddo.',
            '.oooooooooooooo.',
          ],
        ],
        walk: [ // towers never move, so this is never shown
          [
            '.......oo.......',
            '......olko......',
            '.....olccko.....',
            '.....olckko.....',
            '......okko......',
            '..ooo.oooo.ooo..',
            '..ogo.ogso.odo..',
            '..ogooogsoooso..',
            '..ogggggssssdo..',
            '..oddddddddddo..',
            '..oggsggsoosdo..',
            '..ogsgggsooddo..',
            '..oddddddddddo..',
            '..oggsgggsgsdo..',
            '.ogggsggggssddo.',
            '.oooooooooooooo.',
          ],
          [
            '.......oo...y...',
            '......oyko......',
            '.....oylcko.....',
            '.....olckko.....',
            '......okko......',
            '..ooo.oooo.ooo..',
            '..ogo.ogso.odo..',
            '..ogooogsoooso..',
            '..ogggggssssdo..',
            '..oddddddddddo..',
            '..oggsggsoosdo..',
            '..ogsgggsooddo..',
            '..oddddddddddo..',
            '..oggsgggsgsdo..',
            '.ogggsggggssddo.',
            '.oooooooooooooo.',
          ],
        ],
        attack: [ // 1 frame: the crystal flashes
          [
            '...y...oo...y...',
            '......oyyo......',
            '..y..oyyylo..y..',
            '.....olyyko.....',
            '...y..ocko...y..',
            '..ooo.oooo.ooo..',
            '..ogo.ogso.odo..',
            '..ogooogsoooso..',
            '..ogggggssssdo..',
            '..oddddddddddo..',
            '..oggsggsoosdo..',
            '..ogsgggsooddo..',
            '..oddddddddddo..',
            '..oggsgggsgsdo..',
            '.ogggsggggssddo.',
            '.oooooooooooooo.',
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
// Towers never move (speed must be 0), so they shoot whoever comes close.
// The constructor sets the stats; the game reads them once and prices the unit.
//
// Cost = (50 + each stat's price) * max(1, 60 / attackCooldown) * power * splash * element,
// where a stat's price is its normal price (maxHealth*0.1875, damage*1.875, range*1.38,
// speed*90, (size - 6)*8) times 1 + (stat/max)^2: a maxed stat costs 2x.
// power = 1 + 2 * (maxHealth/4000) * (damage/240) = 1.18 here.
//      = (50 + 245.25 + 147.15 + 235.27 + 0 + 84.9) * (60 / 45) * 1.18 = 762.57 * 1.333... * 1.18 = 1199.78  ->  $1,200
// Towers out-range soldiers: a tower can reach 300 px, a soldier only 160.
//
// Options (all optional): this.element ('fire' or 'lightning': x1.3, 'ice': x1.75), this.splashRadius
// (0-80 px: x1.6 at 40), or a support: this.support = 'heal' with this.supportPower = 128 (HP per
// heal) and this.supportRange = 160 (reach) makes a Healing Shrine (return { action: 'heal', targetId }).
// Shots at a MOVING enemy can miss (up to 20% at full speed; never at a standing enemy).
//
// No imports, no timers, no network, no async.
