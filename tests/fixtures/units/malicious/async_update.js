// async update() returns a Promise

export default class Unit {
  constructor() {
    this.name = 'Async Andy';
    this.type = 'soldier';
    this.maxHealth = 120;
    this.damage = 10;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#FF00FF';

  }

  async update(self, enemies, allies, world) {
    await null;
    return { action: 'idle' };
  }
}
