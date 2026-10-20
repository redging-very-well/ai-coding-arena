// an infinite microtask chain started from update()

export default class Unit {
  constructor() {
    this.name = 'Microtasker';
    this.type = 'soldier';
    this.maxHealth = 120;
    this.damage = 10;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#FF00FF';

  }

  update(self, enemies, allies, world) {
    Promise.resolve().then(function again() { Promise.resolve().then(again); });
    return { action: 'idle' };
  }
}
