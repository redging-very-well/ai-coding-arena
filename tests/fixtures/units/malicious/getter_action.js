// returns an action object full of getters and a throwing toJSON

export default class Unit {
  constructor() {
    this.name = 'Tricky Returner';
    this.type = 'soldier';
    this.maxHealth = 120;
    this.damage = 10;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#FF00FF';

  }

  update(self, enemies, allies, world) {
    const out = {};
    Object.defineProperty(out, 'action', { get() { throw new Error('gotcha'); }, enumerable: true });
    return out;
  }
}
