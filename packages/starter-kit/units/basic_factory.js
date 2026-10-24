// Basic Factory: the starter factory template (Pixel Clash).
//
// A factory never moves or attacks. Every productionInterval ticks it builds a minion
// (up to 12 a battle), at most 4 alive per factory. update() decides what the minions do.
//
// Options (all optional; this template uses the defaults):
//   this.produces = 'grunt'   which minion it builds (the price follows):
//       'grunt'  360 HP, 20 damage, melee, speed 1.5   $177 each (the default)
//       'archer' 240 HP, 20 damage, shoots from 110 px  $216 each
//       'runner' 480 HP, 24 damage, melee, speed 2.6   $263 each
//       'brute' 1100 HP, 32 damage (x3 on walls), slow $263 each
//       'medic'  300 HP, never attacks: heals 60 HP     $248 each (cleanses burning/frozen
//                within 60 px of it                     friends first; not a fighter on its own)
//   this.minionElement = 'normal'  'fire' or 'lightning' (x1.3) or 'ice' (x1.75) for every
//                             minion's price (medics ignore it)
//   this.burst = 1            1-4: save up minions INSIDE and send them out together
//                             (free, but stored minions are lost if the factory dies)
//
// What update() can return:
//   { action: 'rally', destination: { x, y } }              attack, gathering at that spot
//   { action: 'command', order: 'attack' }                   hunt the nearest enemies (default)
//   { action: 'command', order: 'defend' }                   stay near the factory
//   { action: 'command', order: 'swarm', targetId: e.id }    all minions go for ONE enemy
//   { action: 'command', order: 'guard', targetId: a.id }    stay next to an ally (e.g. a tower)
//   { action: 'release' }                                    send stored minions out now
//   { action: 'hold' }                                       pause building for a tick
//
// Cost = body + production
//   body       = 50 + maxHealth*0.075 * (1 + (maxHealth/8000)^2) = 50 + 196.2 = 246.2  ->  $247
//   production = 11 minions (one every 10 s in a 120 s battle) x $177 (half price: they arrive late) = $1,947
//   total      = $2,194
//
// No imports, no timers, no network, no async.

export default class BasicFactory {
  constructor() {
    this.name = 'Basic Factory';
    this.type = 'factory';           // a building: never moves, never attacks
    this.maxHealth = 2400;           // 800-8000
    this.productionInterval = 600;   // 300-1200 ticks between minions (600 = 10 s); faster costs more
    this.color = '#C0A060';          // "#RRGGBB": also the colour of its minions
    // this.produces = 'archer';     // 'grunt' (default), 'archer', 'runner', 'brute' or 'medic': the price follows
    // this.minionElement = 'fire';  // 'normal' (default), 'fire' or 'lightning' (x1.3) or 'ice' (x1.75) on each minion
    // this.burst = 3;               // 1-4: save up minions inside and send them out together
  }

  // Called once per tick. Send the minions at the nearest enemy that isn't a wall.
  update(self, enemies, allies, world) {
    let target = null;
    let best = Infinity;
    for (const enemy of enemies) {
      if (enemy.type === 'wall') continue;   // walls can't hurt anyone: go for real fighters
      const d = Math.hypot(enemy.x - self.x, enemy.y - self.y);
      if (d < best) { best = d; target = enemy; }
    }
    const spot = target ? { x: target.x, y: target.y } : world.center;
    return { action: 'rally', destination: spot };
    // Other ideas:
    // if (target) return { action: 'command', order: 'swarm', targetId: target.id };  // everyone at one enemy
    // return { action: 'command', order: 'defend' };                                  // stay home
    // const tower = allies.find((a) => a.type === 'tower');
    // if (tower) return { action: 'command', order: 'guard', targetId: tower.id };    // protect a tower
  }

  // A little workshop: a chimney puffing smoke, two lit windows, a big door
  // that lights up when a minion pops out.
  sprite() {
    const body = [
      '..........oooo..',
      '..........occo..',
      '..oooooooooccoo.',
      '.orrrrrrrrrrrrro',
      '.owwwwwwwwwwwwwo',
      '.owyywwwwwwyywwo',
      '.owyywwwwwwyywwo',
      '.owwwwoddowwwwwo',
      '.owwwwoddowwwwwo',
      '.owwwwoddowwwwwo',
      '.ooooooooooooooo',
      '................',
    ];
    const smokeLow = ['................', '...........ss...', '..........ssss..', '...........ss...'];
    const smokeHigh = ['............ss..', '...........ssss.', '............ss..', '................'];
    const doorOpen = body.map((row) => row.replace('dd', 'yy'));  // the door lights up when a minion pops out
    return {
      grid: 16,
      palette: { o: '#2B2118', w: '#C0A060', r: '#8E3B2E', d: '#4A3426', y: '#FFE27A', s: '#D8D8D8', c: '#6B6B6B' },
      frames: {
        idle: [smokeLow.concat(body), smokeHigh.concat(body)],
        attack: [smokeLow.concat(doorOpen)],   // played when a minion is made
      },
    };
  }
}
