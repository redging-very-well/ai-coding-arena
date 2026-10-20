// about 15 ms of busy work per update() (sim time is frozen, so it counts iterations)

export default class Unit {
  constructor() {
    this.name = 'Slowpoke';
    this.type = 'soldier';
    this.maxHealth = 120;
    this.damage = 10;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#FF00FF';

  }

  update(self, enemies, allies, world) {
    let s = 0;
    for (let i = 0; i < 4e7; i++) s += i % 7;
    return { action: 'idle', s };
  }
}
