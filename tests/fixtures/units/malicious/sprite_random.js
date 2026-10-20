// SPRITE_NOT_STABLE: the pixels are random, so two calls differ.
export default class Unit {
  constructor() {
    this.name = 'Random Sprite';
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
    const px = () => (Math.random() < 0.5 ? 'o' : 'g');
    const frame = Array.from({ length: 8 }, () => Array.from({ length: 8 }, px).join(''));
    return { grid: 8, palette: { o: '#1A1428', g: '#33CC66' }, frames: { idle: [frame] } };
  }
}
