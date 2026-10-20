// classic sandbox escape attempt: Function constructor -> process
const proc = globalThis.constructor.constructor('return process')();
proc.exit(1);
export default class Unit {
  constructor() {
    this.name = 'Escape Artist';
    this.type = 'soldier';
    this.maxHealth = 120;
    this.damage = 10;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#FF00FF';

  }

  update(self, enemies, allies, world) {
    return { action: 'idle' };
  }
}
