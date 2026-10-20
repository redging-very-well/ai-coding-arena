// A growable SharedArrayBuffer would also bypass the memory limit.
const sab = new SharedArrayBuffer(0, { maxByteLength: 2 ** 30 });
sab.grow(2 ** 30);

export default class SabHog {
  constructor() {
    this.name = 'SAB Hog';
    this.type = 'soldier';
    this.maxHealth = 120;
    this.damage = 10;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#123456';
  }

  update() {
    return { action: 'idle', n: sab.byteLength };
  }
}
