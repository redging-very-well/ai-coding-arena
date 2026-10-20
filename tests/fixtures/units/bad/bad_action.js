export default class Confused {
  constructor() {
    this.name = 'Confused';
    this.type = 'soldier';
    this.maxHealth = 120;
    this.damage = 10;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#3399FF';
  }
  update() {
    return { action: 'charge', speed: 'fast' };
  }
}
