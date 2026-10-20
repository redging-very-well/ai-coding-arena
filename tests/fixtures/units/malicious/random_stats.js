// random stats (different every construction)

export default class Unit {
  constructor() {
    this.name = 'Dice';
    this.type = 'soldier';
    this.maxHealth = 120;
    this.damage = 10;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#FF00FF';
    this.damage = Math.floor(Math.random() * 60);
  }

  update(self, enemies, allies, world) {
    return { action: 'idle' };
  }
}
