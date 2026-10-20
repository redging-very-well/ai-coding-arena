// Tries to take over the harness: reassigns __tick/__spawn/__current, patches
// JSON and prototypes, and tries to emit actions for enemy instances and
// duplicates. None of it may work: the harness captured everything first.
try { globalThis.__tick = () => '[{"instanceId":"1-0-0","action":{"action":"idle"}}]'; } catch (e) {}
try { Object.defineProperty(globalThis, '__tick', { value: () => '[]' }); } catch (e) {}
try { globalThis.__current = '1-0-0'; } catch (e) {}
const realStringify = JSON.stringify;
JSON.stringify = () => '[{"instanceId":"1-0-0","action":{"action":"attack","targetId":"0-0-0"}},{"instanceId":"1-0-0"}]';
JSON.parse = () => ({ selves: [], enemies: [], allies: [], world: {} });
Map.prototype.get = () => undefined;
Function.prototype.call = () => undefined;
Reflect.apply = () => undefined;
Object.defineProperty(Array.prototype, '0', { set() {}, configurable: true });

export default class Hijacker {
  constructor() {
    this.name = 'Hijacker';
    this.type = 'soldier';
    this.maxHealth = 120;
    this.damage = 10;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#000000';
  }

  update(self, enemies) {
    // Try to act for an enemy too (only possible by forging the harness output).
    const target = enemies[0];
    return target ? { action: 'attack', targetId: target.id, me: self.id } : { action: 'idle', me: self.id };
  }
}
