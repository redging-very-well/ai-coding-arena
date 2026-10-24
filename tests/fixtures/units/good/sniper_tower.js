// Sniper Tower
export default class Unit {
  constructor() {
    this.name = 'Sniper Tower';
    this.type = 'tower';
    this.maxHealth = 400;
    this.damage = 200;
    this.range = 280;
    this.speed = 0;
    this.attackCooldown = 60;
    this.color = '#AA22CC';
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
