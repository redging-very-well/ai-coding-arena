// Field Medic: a demo-only healer (scripts/demo-showcase). Heals the most hurt ally in reach, otherwise follows the most hurt one.
export default class FieldMedic {
  constructor() {
    this.name = 'Field Medic';
    this.type = 'soldier';
    this.maxHealth = 900;
    this.damage = 0;
    this.range = 40;
    this.speed = 1.6;
    this.attackCooldown = 45;
    this.color = '#5CF08A';
    this.size = 10;
    this.shape = 'diamond';
    this.support = 'heal';
    this.supportPower = 120;
    this.supportRange = 120;
  }

  update(self, enemies, allies, world) {
    let hurt = null;
    let worst = 0.999;
    for (const a of allies) {
      if (a.type === 'wall' || a.type === 'factory') continue;
      const f = a.hp / a.maxHp;
      if (f < worst) { worst = f; hurt = a; }
    }
    if (hurt) {
      const gap = Math.hypot(hurt.x - self.x, hurt.y - self.y) - self.radius - hurt.radius;
      if (gap <= self.support.range) {
        return self.cooldownRemaining === 0 ? { action: 'heal', targetId: hurt.id } : { action: 'idle' };
      }
      return { action: 'move', destination: { x: hurt.x, y: hurt.y } };
    }
    // Nobody hurt: stay with the nearest ally, or walk to the middle.
    let near = null;
    let best = Infinity;
    for (const a of allies) {
      if (a.type === 'wall' || a.type === 'factory' || a.support) continue;
      const d = Math.hypot(a.x - self.x, a.y - self.y);
      if (d < best) { best = d; near = a; }
    }
    return { action: 'move', destination: near ? { x: near.x, y: near.y } : world.center };
  }
}
