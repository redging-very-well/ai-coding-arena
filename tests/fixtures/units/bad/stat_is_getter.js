export default class Sneaky {
  constructor() {
    this.name = 'Sneaky';
    this.type = 'soldier';
    this.maxHealth = 120;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#123456';
  }
  get damage() { return 10; }
  update() { return { action: 'idle' }; }
}
