export default class Careless {
  constructor() {
    this.name = 'Careless';
    this.type = 'soldier';
    this.maxHealth = 120;
    this.damage = 10;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#3399FF';
  }
  update(self, enemies) {
    const target = enemies[0];
    return { action: 'attack', targetId: target.id }; // throws when enemies is empty
  }
}
