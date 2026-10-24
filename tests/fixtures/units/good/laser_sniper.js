// Laser Sniper
export default class Unit {
  constructor() {
    this.name = 'Laser Sniper';
    this.type = 'soldier';
    this.maxHealth = 500;
    this.damage = 100;
    this.range = 150;
    this.speed = 2;
    this.attackCooldown = 30;
    this.color = '#FF0000';
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
