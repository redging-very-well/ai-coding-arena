// WebAssembly.Memory is allocated outside the isolate's ArrayBuffer allocator,
// so the 32 MB limit would not count it (6 x 256 MB here). The harness removes
// WebAssembly, so this must fail at load time.
const hoard = [];
for (let i = 0; i < 6; i++) {
  const mem = new WebAssembly.Memory({ initial: 4096 });
  new Uint8Array(mem.buffer).fill(1);
  hoard.push(mem);
}

export default class WasmHog {
  constructor() {
    this.name = 'Wasm Hog';
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
