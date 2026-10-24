// Scout CD10
export default class Unit {
  constructor() {
    this.name = 'Scout CD10';
    this.type = 'soldier';
    this.maxHealth = 480;
    this.damage = 24;
    this.range = 30;
    this.speed = 4;
    this.attackCooldown = 10;
    this.size = 6;
    this.color = '#FFCC00';
  }

  update(self, enemies) {
    if (enemies.length === 0) return { action: 'idle' };
    const target = enemies[0];
    const gap = Math.hypot(target.x - self.x, target.y - self.y) - self.radius - target.radius;
    if (gap <= self.range) return { action: 'attack', targetId: target.id };
    if (self.type === 'soldier') return { action: 'move', destination: { x: target.x, y: target.y } };
    return { action: 'idle' };
  }
}
