// Resizable ArrayBuffers (and growable SharedArrayBuffers) grow outside the
// isolate's memory accounting. The harness's ArrayBuffer ignores the options
// argument (so resize() throws) and SharedArrayBuffer does not exist.
const hoard = [];
for (let i = 0; i < 6; i++) {
  const buf = new ArrayBuffer(0, { maxByteLength: 2 ** 30 });
  buf.resize(2 ** 28);
  new Uint8Array(buf).fill(1);
  hoard.push(buf);
}

export default class BufferHog {
  constructor() {
    this.name = 'Buffer Hog';
    this.type = 'soldier';
    this.maxHealth = 120;
    this.damage = 10;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#123456';
  }

  update() {
    return { action: 'idle', n: hoard.length };
  }
}
