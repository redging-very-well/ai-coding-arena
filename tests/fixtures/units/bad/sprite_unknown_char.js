// SPRITE_BAD_FRAME: idle frame 0, row 2, col 3 uses 'x', which is not in the palette.
export default class Unit {
  constructor() {
    this.name = 'Unknown Char';
    this.type = 'soldier';
    this.maxHealth = 100;
    this.damage = 10;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#33CC66';
  }

  update(self, enemies) {
    if (enemies.length === 0) return { action: 'idle' };
    const target = enemies[0];
    const gap = Math.hypot(target.x - self.x, target.y - self.y) - self.radius - target.radius;
    if (gap <= self.range) return { action: 'attack', targetId: target.id };
    return { action: 'move', destination: { x: target.x, y: target.y } };
  }

  sprite() {
    return {
      grid: 8,
      palette: { o: '#1A1428', g: '#33CC66', w: '#FFFFFF' },
      frames: {
        idle: [
          [
            '..o..o..',
            '.oggggo.',
            'oggxgwgo',
            'oggggggo',
            '.oggggo.',
            '..oggo..',
            '.o.oo.o.',
            '........',
          ],
        ],
      },
    };
  }
}
