// Walking Tower
export default class Unit {
  constructor() {
    this.name = 'Walking Tower';
    this.type = 'tower';
    this.maxHealth = 150;
    this.damage = 15;
    this.range = 180;
    this.speed = 2;
    this.attackCooldown = 45;
    this.color = '#3399FF';
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
