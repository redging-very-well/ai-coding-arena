// Writes and reads a global, and reports Math.random/Date.now, to prove each
// player's isolate is separate and deterministic.
globalThis.marker = globalThis.marker ?? [];

export default class Spy {
  constructor() {
    this.name = 'Spy';
    this.type = 'soldier';
    this.maxHealth = 120;
    this.damage = 10;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#101010';
  }

  update(self) {
    globalThis.marker.push(self.id);
    return { action: 'idle', seen: globalThis.marker.slice(), random: Math.random(), now: Date.now(), date: new Date().getTime() };
  }
}
