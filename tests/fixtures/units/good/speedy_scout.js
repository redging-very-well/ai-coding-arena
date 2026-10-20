// Speedy Scout
export default class Unit {
  constructor() {
    this.name = 'Speedy Scout';
    this.type = 'soldier';
    this.maxHealth = 60;
    this.damage = 6;
    this.range = 30;
    this.speed = 4;
    this.attackCooldown = 20;
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
