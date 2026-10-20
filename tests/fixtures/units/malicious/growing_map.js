// a Map that grows without bound inside update()
const memo = new Map();
export default class Unit {
  constructor() {
    this.name = 'Memory Hog';
    this.type = 'soldier';
    this.maxHealth = 120;
    this.damage = 10;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#FF00FF';

  }

  update(self, enemies, allies, world) {
    for (let i = 0; ; i++) memo.set(world.tick * 1e9 + i, { i, pad: [i, i, i, i] });
  }
}
