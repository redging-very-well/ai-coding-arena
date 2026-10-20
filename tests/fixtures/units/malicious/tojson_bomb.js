// A kid-planted Object.prototype.toJSON that throws a 12 MB message. It runs
// when the harness serializes the returned action; the error must stay a
// short, bounded unit error (never a 12 MB string through the host).
Object.prototype.toJSON = function () {
  throw new Error('A'.repeat(12e6));
};

export default class ToJsonBomb {
  constructor() {
    this.name = 'ToJSON Bomb';
    this.type = 'soldier';
    this.maxHealth = 120;
    this.damage = 10;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#123456';
  }

  update() {
    return { action: 'idle' };
  }
}
