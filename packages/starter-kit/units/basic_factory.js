// Basic Factory: the starter factory template (Pixel Clash).
//
// A factory never moves or attacks. Every productionInterval ticks it builds a Minion
// (40 HP, 5 damage, fast little melee fighter), at most 4 alive per factory.
// update() only decides WHERE the minions go: return { action: 'rally', destination }.
// ({ action: 'hold' } pauses building for a tick.)
//
// Cost = body + production
//   body       = 10 + maxHealth*0.12 * (1 + 2*(maxHealth/1000)^2) = 10 + 42.48 = 52.48  ->  $53
//   production = 5 minions (one every 15 s in a 90 s battle) x $28 (half price: they arrive late) = $140
//   total      = $193
//
// No imports, no timers, no network, no async.

export default class BasicFactory {
  constructor() {
    this.name = 'Basic Factory';
    this.type = 'factory';           // a building: never moves, never attacks
    this.maxHealth = 300;            // 100-1000
    this.productionInterval = 900;   // 600-1800 ticks between minions (900 = 15 s); faster costs more
    this.color = '#C0A060';          // "#RRGGBB": also the colour of its minions
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
