export default class Lucky {
  constructor() {
    this.name = 'Lucky';
    this.type = 'soldier';
    this.maxHealth = 100 + Math.floor(Math.random() * 100);
    this.damage = 10;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#00FF00';
  }
  update() { return { action: 'idle' }; }
}
