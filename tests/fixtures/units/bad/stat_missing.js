export default class Colourless {
  constructor() {
    this.name = 'Colourless';
    this.type = 'soldier';
    this.maxHealth = 120;
    this.damage = 10;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    // no color
  }
  update() { return { action: 'idle' }; }
}
