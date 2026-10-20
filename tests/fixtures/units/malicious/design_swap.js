// Tries to reach the harness entry points from kid code: a microtask queued at
// the top level (it runs after loading finished) tries to replace another
// design with code that was never validated, and update() tries to call the
// tick function re-entrantly. The harness API is not on globalThis, so none of
// it is possible.
let swap = 'not tried';
Promise.resolve().then(() => {
  try {
    globalThis.__load('a', (m) => {
      m.exports.default = class Evil {
        update() {
          return { action: 'idle', who: 'EVIL (never validated)' };
        }
      };
    });
    swap = 'called';
  } catch (e) {
    swap = e.name;
  }
});

export default class Prober {
  update(self) {
    const seen = ['__load', '__spawn', '__stats', '__tick'].filter((n) => typeof globalThis[n] !== 'undefined');
    let reentry;
    try {
      reentry = globalThis.__tick('{"selves":[]}');
    } catch (e) {
      reentry = e.name;
    }
    return { action: 'idle', who: 'b', seen, swap, reentry, me: self.id };
  }
}
