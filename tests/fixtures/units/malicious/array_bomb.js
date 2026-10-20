// allocates arrays until memory runs out inside update()
const keep = [];
export default class Unit {
  constructor() {
    this.name = 'Array Bomb';
    this.type = 'soldier';
    this.maxHealth = 120;
    this.damage = 10;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#FF00FF';

  }

  update(self, enemies, allies, world) {
    for (;;) keep.push(new Array(1e5).fill(1.5));
  }
}
