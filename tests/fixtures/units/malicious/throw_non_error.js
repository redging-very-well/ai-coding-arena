// throws a plain string from the constructor

export default class Unit {
  constructor() {
    this.name = 'Stringy Thrower';
    this.type = 'soldier';
    this.maxHealth = 120;
    this.damage = 10;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#FF00FF';
    throw 'boom';
  }

  update(self, enemies, allies, world) {
    return { action: 'idle' };
  }
}
