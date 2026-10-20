// while(true) at the top level of the file
while (true) {}
export default class Unit {
  constructor() {
    this.name = 'Top Looper';
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
