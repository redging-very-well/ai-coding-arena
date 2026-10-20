// while(true) in update()

export default class Unit {
  constructor() {
    this.name = 'Update Looper';
    this.type = 'soldier';
    this.maxHealth = 120;
    this.damage = 10;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#FF00FF';

  }

  update(self, enemies, allies, world) {
    while (true) {}
  }
}
