// A unit written with TypeScript syntax (type annotations, interfaces,
// access modifiers). The validator transpiles it with esbuild's TS loader.
interface Point { x: number; y: number }

type Action =
  | { action: 'idle' }
  | { action: 'move'; destination: Point }
  | { action: 'attack'; targetId: string };

export default class TypedTrooper {
  name: string;
  type: 'soldier' | 'tower';
  maxHealth: number;
  damage: number;
  range: number;
  speed: number;
  attackCooldown: number;
  color: string;
  private lastTarget: string | null = null;

  constructor() {
    this.name = 'Typed Trooper';
    this.type = 'soldier';
    this.maxHealth = 600;
    this.damage = 50;
    this.range = 40;
    this.speed = 1.5;
    this.attackCooldown = 60;
    this.color = '#22AA88';
  }

  update(self: any, enemies: any[], _allies: any[], world: any): Action {
    if (enemies.length === 0) return { action: 'move', destination: world.center as Point };
    const target = enemies[0]!;
    this.lastTarget = target.id as string;
    const gap = Math.hypot(target.x - self.x, target.y - self.y) - self.radius - target.radius;
    if (gap <= self.range) return { action: 'attack', targetId: target.id };
    return { action: 'move', destination: { x: target.x, y: target.y } };
  }
}
