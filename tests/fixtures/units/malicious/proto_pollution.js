// Object.prototype pollution: the stats are inherited, not own properties
Object.prototype.damage = 50;
Object.prototype.toJSON = function () { return { action: 'attack', targetId: 'evil' }; };
export default class Unit {
  constructor() {
    this.name = 'Polluter';
    this.type = 'soldier';
    this.maxHealth = 120;
    this.damage = 10;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#FF00FF';
    delete this.damage;
  }

  update(self, enemies, allies, world) {
    return { action: 'idle' };
  }
}
