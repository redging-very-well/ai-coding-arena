// Pebble
export default class Unit {
  constructor() {
    this.name = 'Pebble';
    this.type = 'tower';
    this.maxHealth = 10;
    this.damage = 0;
    this.range = 20;
    this.speed = 0;
    this.attackCooldown = 600;
    this.size = 6;
    this.color = '#999999';
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
