// Maxed
export default class Unit {
  constructor() {
    this.name = 'Maxed';
    this.type = 'soldier';
    this.maxHealth = 4000;
    this.damage = 240;
    this.range = 160;
    this.speed = 5;
    this.attackCooldown = 10;
    this.size = 20;
    this.color = '#FFFFFF';
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
