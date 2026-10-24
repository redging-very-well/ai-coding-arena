// Big Tank
export default class Unit {
  constructor() {
    this.name = 'Big Tank';
    this.type = 'soldier';
    this.maxHealth = 2500;
    this.damage = 100;
    this.range = 40;
    this.speed = 0.8;
    this.attackCooldown = 60;
    this.size = 20;
    this.color = '#556B2F';
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
