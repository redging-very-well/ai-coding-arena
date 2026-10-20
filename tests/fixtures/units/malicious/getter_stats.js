// stats as getters that change every read

export default class Unit {
  constructor() {
    this.name = 'Shapeshifter';
    this.type = 'soldier';
    this.maxHealth = 120;
    this.damage = 10;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#FF00FF';
    Object.defineProperty(this, 'damage', { get() { return Math.random() * 1000; }, enumerable: true });
    Object.defineProperty(this, 'maxHealth', { get: () => 120, set: () => {}, enumerable: true });
  }

  update(self, enemies, allies, world) {
    return { action: 'idle' };
  }
}
