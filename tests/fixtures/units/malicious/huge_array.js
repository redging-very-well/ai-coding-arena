// a 500 MB array at the top level
const big = new Array(5e8).fill(0);
export default class Unit {
  constructor() {
    this.name = 'Hoarder';
    this.type = 'soldier';
    this.maxHealth = 120;
    this.damage = 10;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#FF00FF';

  }

  update(self, enemies, allies, world) {
    return { action: 'idle' };
  }
}
