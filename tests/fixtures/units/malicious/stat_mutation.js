// changes its own stats inside update() (no effect: stats are snapshotted)

export default class Unit {
  constructor() {
    this.name = 'Cheater';
    this.type = 'soldier';
    this.maxHealth = 120;
    this.damage = 10;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#FF00FF';

  }

  update(self, enemies, allies, world) {
    this.damage = 9999;
    this.maxHealth = 99999;
    this.range = 9999;
    return { action: 'idle', damage: this.damage };
  }
}
