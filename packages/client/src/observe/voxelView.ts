// The 3D voxel (Minecraft-style) battle view, drawn with three.js.
//
// It is a second renderer for the shared ArenaRenderer, not a second game
// client: the arena keeps doing everything it does for the 2D view (live frame
// buffer, playback clock, reveal, events, projectiles) and runs headless
// (no 2D drawing); this view reads its state every frame and draws that in 3D.
// So /screen, /play and /observe all get live battles, replays, pause/seek and
// the reveal for free, and the server and protocol are untouched.
//
// Each sprite pixel becomes a cube (voxels.ts). Elemental shots, auras, heals,
// splash, lightning and sudden death are drawn from the same frame data and
// events the 2D renderer uses.

import {
  AmbientLight, BoxGeometry, BufferGeometry, CircleGeometry, Color, CylinderGeometry, DirectionalLight, DoubleSide, Fog,
  Group, HemisphereLight, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, OctahedronGeometry,
  PCFSoftShadowMap, PerspectiveCamera, PlaneGeometry, Raycaster, RingGeometry, Scene, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FRAME_FLAGS, type AuraKind, type Element, type FrameEvent } from '@pixel-clash/shared';
import { arenaZoneRect, bodyOf, zoneTint, type ArenaInstance, type ArenaRenderer } from '../common/render/arena.js';
import { AURA_COLOR, CLEANSE_COLOR, ELEMENT_COLOR, HEAL_COLOR } from '../common/render/effects.js';
import { TICKS_PER_SECOND } from '../common/render/playback.js';
import type { AnimState } from '../common/render/sprites.js';
import { seatStyle } from '../common/seats.js';
import { boxVoxels, spriteVoxels, voxelGeometry, type Voxel } from './voxels.js';

/** Edge of one ground block in arena px (the sim is 800-1200 px wide). */
const BLOCK = 10;
const WALL_BLOCKS_HIGH = 3;
const ANIM_FPS = 8;
/** Width of the grass rim round the arena. */
const RIM = 180;

export type ViewMode = 'orbit' | 'follow' | 'chase';

export interface VoxelViewOptions {
  /** Click a unit to follow it, V / Tab / Esc for the follow and chase cameras (the /observe page). Default false: orbit only. */
  interactive?: boolean;
  /** Shadow map edge in px (default 2048; 4096 is crisper but heavier). */
  shadowMapSize?: number;
  /** Cap on the device pixel ratio (default 2). */
  maxPixelRatio?: number;
  /** The followed unit changed (null = none). */
  onPick?: (pick: { name: string; owner: number; kind: string } | null) => void;
  /** The camera mode changed. */
  onViewMode?: (mode: ViewMode) => void;
}

export interface VoxelView {
  readonly canvas: HTMLCanvasElement;
  readonly enabled: boolean;
  /** Show this view (arena runs headless) or hide it (arena draws 2D again). */
  setEnabled(on: boolean): void;
  resize(): void;
  /** Volume factor 0.12-1 for something happening at arena (x, y): louder near the camera. */
  near(x: number, y: number): number;
  readonly viewMode: ViewMode;
  setViewMode(mode: ViewMode): void;
  cycleViewMode(): void;
  select(id: string | null): void;
  selectNext(): void;
  dispose(): void;
}

type Kind = 'soldier' | 'tower' | 'wall' | 'factory' | 'minion';

/** What a body is and does, taken from the arena's instance (the reveal, or a minion adopted from its factory). */
interface Def {
  seat: number;
  name: string;
  stats: ArenaInstance['stats'];
  kind: Kind;
  sprite: ArenaInstance['spec'];
  element: Element;
  splash: number;
  aura: { kind: AuraKind; range: number } | null;
}

interface Body {
  id: string;
  def: Def;
  group: Group;
  mesh: Mesh;
  material: MeshLambertMaterial;
  bar: Group;
  barFill: Mesh;
  /** Ground ring of an aura unit (haste / might / shield), pulsing. */
  aura: Mesh | null;
  /** White ring under the highlighted seat's units (own units on /play). */
  ring: Mesh | null;
  height: number;
  heading: number;
  px: number;
  py: number;
  geoKey: string;
}

interface Unit {
  id: string;
  x: number;
  y: number;
  hp: number;
  flags: number;
}

function mulberry(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerpAngle = (a: number, b: number, f: number): number => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * f;

/** Throws when WebGL is unavailable: the caller falls back to the 2D view. */
export function createVoxelView(canvas: HTMLCanvasElement, arena: ArenaRenderer, opts: VoxelViewOptions = {}): VoxelView {
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, opts.maxPixelRatio ?? 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;

  const scene = new Scene();
  scene.background = new Color('#8ec5ff');
  scene.fog = new Fog('#8ec5ff', 1280, 4000);
  scene.add(new HemisphereLight('#dff0ff', '#6b5a3a', 1.05), new AmbientLight('#ffffff', 0.25));
  const sun = new DirectionalLight('#fff4d6', 2.1);
  sun.castShadow = true;
  const shadowSize = opts.shadowMapSize ?? 2048;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  sun.shadow.bias = -0.0006;
  scene.add(sun, sun.target);

  const camera = new PerspectiveCamera(50, 1, 5, 6400);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;

  // ---------------------------------------------------------------------------
  // The world: ground, island, water and trees. Rebuilt when the map or the zone tints change.
  // ---------------------------------------------------------------------------

  let worldKey = '';
  let worldGroup: Group | null = null;
  let S = 800;

  const buildWorld = (size: number, zones: Array<{ rect: { x: number; y: number; width: number; height: number }; color: Color }>): Group => {
    const g = new Group();
    const rand = mulberry(7);
    const grassA = new Color('#5fae3d');
    const grassB = new Color('#58a537');
    // Ground: one block per BLOCK×BLOCK of arena, checkered grass, tinted inside each zone.
    const n = Math.ceil(size / BLOCK);
    const ground = new InstancedMesh(new BoxGeometry(BLOCK, BLOCK, BLOCK), new MeshLambertMaterial(), n * n);
    const m = new Matrix4();
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const idx = i * n + j;
        m.setPosition(i * BLOCK + BLOCK / 2, -BLOCK / 2, j * BLOCK + BLOCK / 2);
        ground.setMatrixAt(idx, m);
        const c = ((i + j) & 1 ? grassA : grassB).clone().multiplyScalar(0.94 + rand() * 0.12);
        const cx = i * BLOCK + BLOCK / 2;
        const cy = j * BLOCK + BLOCK / 2;
        for (const z of zones) {
          const r = z.rect;
          if (cx >= r.x && cx < r.x + r.width && cy >= r.y && cy < r.y + r.height) c.lerp(z.color, 0.38);
        }
        ground.setColorAt(idx, c);
      }
    }
    ground.receiveShadow = true;
    g.add(ground);

    // The island: a lower grass rim with dirt sides, and water all round.
    const dirt = new MeshLambertMaterial({ color: '#7a5436' });
    const rim = new MeshLambertMaterial({ color: '#4d9632' });
    const island = new Mesh(new BoxGeometry(size + 2 * RIM, 40, size + 2 * RIM), [dirt, dirt, rim, dirt, dirt, dirt]);
    island.position.set(size / 2, -4 - 20, size / 2);
    island.receiveShadow = true;
    g.add(island);
    const water = new Mesh(new PlaneGeometry(size * 12, size * 12), new MeshLambertMaterial({ color: '#3a6fd8' }));
    water.rotation.x = -Math.PI / 2;
    water.position.set(size / 2, -30, size / 2);
    g.add(water);

    // Trees on the rim (decoration only, never over the water).
    const bark = new Color('#6b4a2b');
    const leaf = new Color('#2f7a2a');
    const treeVoxels: Voxel[] = [
      ...boxVoxels(2, 7, 2, () => bark),
      ...boxVoxels(6, 4, 6, (x, y, z) => leaf.clone().multiplyScalar(0.85 + ((x * 7 + y * 3 + z * 5) % 4) * 0.07)).map((v) => ({ ...v, y: v.y + 6 })),
      ...boxVoxels(4, 2, 4, () => leaf.clone().multiplyScalar(1.05)).map((v) => ({ ...v, y: v.y + 10 })),
    ];
    const treeGeo = voxelGeometry(treeVoxels, 5);
    const treeMat = new MeshLambertMaterial({ vertexColors: true });
    for (let placed = 0; placed < 26; ) {
      const x = -RIM + 20 + rand() * (size + 2 * RIM - 40);
      const z = -RIM + 20 + rand() * (size + 2 * RIM - 40);
      if (x > -24 && x < size + 24 && z > -24 && z < size + 24) continue;
      const t = new Mesh(treeGeo, treeMat);
      t.position.set(x, -4, z);
      t.rotation.y = rand() * Math.PI;
      t.castShadow = true;
      g.add(t);
      placed++;
    }
    return g;
  };

  const disposeGroup = (g: Group): void => {
    g.traverse((o) => {
      const mesh = o as Mesh;
      mesh.geometry?.dispose?.();
      const mat = mesh.material;
      if (Array.isArray(mat)) for (const mm of mat) mm.dispose();
      else mat?.dispose?.();
    });
  };

  const placeCamera = (): void => {
    camera.far = S * 8;
    camera.position.set(S * 0.5, S * 0.62, S * 1.28);
    controls.target.set(S / 2, 0, S / 2);
    controls.maxDistance = S * 3;
    controls.update();
  };

  const syncWorld = (): void => {
    const size = arena.arenaSize;
    const zones = arena.currentZones.map((z) => ({ rect: arenaZoneRect(z), color: new Color(zoneTint(z)) }));
    const key = `${size}|${zones.map((z) => `${z.rect.x},${z.rect.y},${z.rect.width},${z.rect.height}:${z.color.getHexString()}`).join(';')}`;
    if (key === worldKey) return;
    worldKey = key;
    if (worldGroup) {
      scene.remove(worldGroup);
      disposeGroup(worldGroup);
    }
    const sizeChanged = size !== S || !worldGroup;
    S = size;
    worldGroup = buildWorld(S, zones);
    scene.add(worldGroup);
    if (sizeChanged) {
      scene.fog = new Fog('#8ec5ff', S * 1.6, S * 5);
      sun.position.set(S * 0.9, 700, S * 0.1);
      sun.target.position.set(S / 2, 0, S / 2);
      const sc = sun.shadow.camera;
      sc.left = sc.bottom = -S * 0.75;
      sc.right = sc.top = S * 0.75;
      sc.near = 100;
      sc.far = 2200;
      sc.updateProjectionMatrix();
      zoneRing.position.set(S / 2, 40, S / 2);
      placeCamera();
    }
  };

  // ---------------------------------------------------------------------------
  // Bodies
  // ---------------------------------------------------------------------------

  const unitsGroup = new Group();
  scene.add(unitsGroup);
  const bodies = new Map<string, Body>();
  const defs = new Map<string, Def | null>();
  const geoCache = new WeakMap<object, Map<string, BufferGeometry>>();
  const barGeo = new PlaneGeometry(1, 1);
  const barBack = new MeshBasicMaterial({ color: '#000000', side: DoubleSide, depthTest: false, transparent: true, opacity: 0.7 });
  const plateGeo = new BoxGeometry(1, 1, 1);

  const defOf = (id: string): Def | null => {
    const cached = defs.get(id);
    if (cached !== undefined) return cached;
    const info = arena.instance(id);
    if (!info) return null; // not known yet: try again next frame
    const kind = bodyOf(info) as Kind;
    const d: Def = { seat: info.seat, name: info.name, stats: info.stats, kind, sprite: info.spec, element: info.element ?? 'normal', splash: info.splash ?? 0, aura: info.aura ?? null };
    defs.set(id, d);
    return d;
  };

  /** One voxel model per (sprite, state, frame, size): built once, shared by every copy. */
  const geometryFor = (def: Def, state: AnimState, tick: number): { geo: BufferGeometry; key: string; height: number } => {
    const spec = def.sprite;
    const big = def.kind === 'tower' || def.kind === 'factory';
    // A tower never moves, and its sprite's idle/attack frames are mostly flame flicker and muzzle sparks that
    // read as flashing cubes once extruded: hold its first idle frame (the projectile shows the shot).
    const still = def.kind === 'tower';
    const frames = still ? spec.frames.idle : (spec.frames[state] ?? spec.frames.idle);
    const i = still ? 0 : Math.floor((tick / TICKS_PER_SECOND) * ANIM_FPS) % frames.length;
    const cell = (def.stats.size * (big ? 3.1 : 2.6)) / spec.grid;
    const key = `${still ? 'idle' : state}:${i}:${cell.toFixed(2)}`;
    let per = geoCache.get(spec);
    if (!per) geoCache.set(spec, (per = new Map()));
    let geo = per.get(key);
    if (!geo) {
      const depth = Math.max(3, Math.round(spec.grid * (big ? 0.5 : 0.3)));
      geo = voxelGeometry(spriteVoxels(spec, frames[i] ?? frames[0]!, depth), cell);
      per.set(key, geo);
    }
    return { geo, key, height: spec.grid * cell };
  };

  const makeBody = (id: string, def: Def): Body => {
    const group = new Group();
    const material = new MeshLambertMaterial({ vertexColors: true });
    let mesh: Mesh;
    let height: number;
    let ring: Mesh | null = null;
    if (def.kind === 'wall') {
      const seat = new Color(seatStyle(def.seat).color);
      const stone = new Color('#8a8d92');
      const vox = boxVoxels(4, WALL_BLOCKS_HIGH, 4, (x, y, z) => (y === WALL_BLOCKS_HIGH - 1 && (x === 0 || z === 0 || x === 3 || z === 3) ? seat.clone().lerp(stone, 0.3) : stone.clone().multiplyScalar(0.9 + ((x + y * 2 + z * 3) % 3) * 0.06)));
      mesh = new Mesh(voxelGeometry(vox, BLOCK), material);
      height = BLOCK * WALL_BLOCKS_HIGH;
    } else {
      const g = geometryFor(def, 'idle', 0);
      mesh = new Mesh(g.geo, material);
      height = g.height;
      // Seat plate under the unit: the colour tells the players apart.
      const plate = new Mesh(plateGeo, new MeshLambertMaterial({ color: seatStyle(def.seat).color }));
      const w = def.stats.size * 2.3;
      plate.scale.set(w, 1.2, w);
      plate.position.y = 0.6;
      plate.receiveShadow = true;
      group.add(plate);
      // The highlighted seat's own units get a white ring round the plate.
      const r = def.stats.size * 1.5;
      ring = new Mesh(new RingGeometry(r, r + 2.4, 40), new MeshBasicMaterial({ color: '#ffffff', side: DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 1.4;
      ring.visible = false;
      group.add(ring);
    }
    mesh.castShadow = true;
    mesh.userData.bodyId = id;
    group.add(mesh);

    const bar = new Group();
    const back = new Mesh(barGeo, barBack);
    const fillMat = new MeshBasicMaterial({ color: '#4ade80', side: DoubleSide, depthTest: false, transparent: true });
    const barFill = new Mesh(barGeo, fillMat);
    const bw = Math.max(18, def.stats.size * 2.6);
    back.scale.set(bw + 1.6, 4.2, 1);
    barFill.scale.set(bw, 2.6, 1);
    back.renderOrder = 10;
    barFill.renderOrder = 11;
    bar.add(back, barFill);
    bar.position.y = height + 8;
    bar.visible = false;
    group.add(bar);

    let aura: Mesh | null = null;
    if (def.aura) {
      // Edge to edge: the unit's radius plus the aura's reach. A flat translucent ring on the ground.
      const r = def.stats.size + def.aura.range;
      aura = new Mesh(new RingGeometry(r - 2.5, r, 64), new MeshBasicMaterial({ color: AURA_COLOR[def.aura.kind], transparent: true, opacity: 0.7, side: DoubleSide, depthWrite: false }));
      const fill = new Mesh(new CircleGeometry(r, 64), new MeshBasicMaterial({ color: AURA_COLOR[def.aura.kind], transparent: true, opacity: 0.12, side: DoubleSide, depthWrite: false }));
      aura.add(fill);
      aura.rotation.x = -Math.PI / 2;
      aura.position.y = 0.8;
      group.add(aura);
    }
    unitsGroup.add(group);
    return { id, def, group, mesh, material, bar, barFill, aura, ring, height, heading: NaN, px: NaN, py: NaN, geoKey: '' };
  };

  // ---------------------------------------------------------------------------
  // Particles: voxel debris, sparks, flames, bolts and beams from one pooled InstancedMesh
  // ---------------------------------------------------------------------------

  const MAX_P = 900;
  const parts = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshLambertMaterial(), MAX_P);
  parts.frustumCulled = false;
  scene.add(parts);
  const pPos = new Float32Array(MAX_P * 3);
  const pVel = new Float32Array(MAX_P * 3);
  const pLife = new Float32Array(MAX_P);
  const pSize = new Float32Array(MAX_P);
  const pGrav = new Float32Array(MAX_P);
  let pNext = 0;
  const zero = new Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < MAX_P; i++) parts.setMatrixAt(i, zero);
  const rnd = mulberry(99);
  const burst = (x: number, y: number, z: number, color: string, count: number, power: number, size: number): void => {
    const c = new Color(color);
    for (let k = 0; k < count; k++) {
      const i = pNext++ % MAX_P;
      pPos.set([x, y, z], i * 3);
      pVel.set([(rnd() - 0.5) * power, (0.4 + rnd()) * power, (rnd() - 0.5) * power], i * 3);
      pLife[i] = 0.5 + rnd() * 0.7;
      pGrav[i] = 1;
      pSize[i] = size * (0.6 + rnd() * 0.8);
      parts.setColorAt(i, c.clone().multiplyScalar(0.8 + rnd() * 0.4));
    }
    if (parts.instanceColor) parts.instanceColor.needsUpdate = true;
  };
  /** One particle with its own velocity, life and gravity (bolts, beams and rings use gravity 0). */
  const dot = (x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, color: string, grav = 0): void => {
    const i = pNext++ % MAX_P;
    pPos.set([x, y, z], i * 3);
    pVel.set([vx, vy, vz], i * 3);
    pLife[i] = life;
    pGrav[i] = grav;
    pSize[i] = size;
    parts.setColorAt(i, new Color(color));
    if (parts.instanceColor) parts.instanceColor.needsUpdate = true;
  };
  const tmp = new Matrix4();
  const stepParticles = (dt: number): void => {
    for (let i = 0; i < MAX_P; i++) {
      if (pLife[i]! <= 0) continue;
      pLife[i]! -= dt;
      if (pLife[i]! <= 0) {
        parts.setMatrixAt(i, zero);
        continue;
      }
      pVel[i * 3 + 1]! -= 260 * pGrav[i]! * dt;
      for (let a = 0; a < 3; a++) pPos[i * 3 + a]! += pVel[i * 3 + a]! * dt;
      if (pGrav[i]! > 0 && pPos[i * 3 + 1]! < 0) {
        pPos[i * 3 + 1] = 0;
        pVel[i * 3 + 1] = Math.abs(pVel[i * 3 + 1]!) * 0.3;
        pVel[i * 3] = pVel[i * 3]! * 0.6;
        pVel[i * 3 + 2] = pVel[i * 3 + 2]! * 0.6;
      }
      const s = pSize[i]! * Math.min(1, pLife[i]! * 3);
      tmp.makeScale(s, s, s).setPosition(pPos[i * 3]!, pPos[i * 3 + 1]!, pPos[i * 3 + 2]!);
      parts.setMatrixAt(i, tmp);
    }
    parts.instanceMatrix.needsUpdate = true;
  };
  const clearParticles = (): void => {
    pLife.fill(0);
    for (let i = 0; i < MAX_P; i++) parts.setMatrixAt(i, zero);
    parts.instanceMatrix.needsUpdate = true;
  };

  // ---------------------------------------------------------------------------
  // Projectiles and the sudden-death wall
  // ---------------------------------------------------------------------------

  const shots = new Map<number, { mesh: Mesh; element: Element; dist: number }>();
  const shotGeos = {
    normal: new BoxGeometry(3.5, 3.5, 3.5),
    fire: new BoxGeometry(5.5, 5.5, 5.5),
    ice: new OctahedronGeometry(4.6),
    lightning: new BoxGeometry(1.6, 1.6, 8),
  };
  const shotMats = new Map<string, MeshBasicMaterial>();
  const shotMat = (color: string): MeshBasicMaterial => {
    let m = shotMats.get(color);
    if (!m) shotMats.set(color, (m = new MeshBasicMaterial({ color })));
    return m;
  };
  /** A fireball (orange with a yellow core), an ice shard, a yellow spark, or a cube in the shooter's colour. */
  const shotMesh = (element: Element, color: string): Mesh => {
    const mesh = new Mesh(shotGeos[element], shotMat(element === 'normal' ? color : element === 'fire' ? '#ff5a1f' : ELEMENT_COLOR[element]));
    if (element === 'fire') mesh.add(new Mesh(new BoxGeometry(3, 3, 3), shotMat('#ffe14a')));
    if (element === 'ice') mesh.add(new Mesh(new OctahedronGeometry(2.6), shotMat('#ffffff')));
    return mesh;
  };
  const zoneRing = new Mesh(new CylinderGeometry(1, 1, 80, 72, 1, true), new MeshBasicMaterial({ color: '#ff4d4d', transparent: true, opacity: 0.2, side: DoubleSide, depthWrite: false }));
  zoneRing.visible = false;
  scene.add(zoneRing);

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  const target = new Map<string, string>();
  const lastFire = new Map<string, string>();

  /** Voxel dots along a line (bolts and heal beams): `jit` = sideways wobble. */
  const trail = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, color: string, steps: number, jit: number, life: number, size: number): void => {
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const w = i === 0 || i === steps ? 0 : jit;
      dot(ax + (bx - ax) * t + (rnd() - 0.5) * w, ay + (by - ay) * t + (rnd() - 0.5) * w, az + (bz - az) * t + (rnd() - 0.5) * w, 0, 0, 0, life, size, color);
    }
  };
  const chest = (id: string, pos: Map<string, Unit>): Vector3 | null => {
    const p = pos.get(id);
    const b = bodies.get(id);
    return p && b ? new Vector3(p.x, b.height * 0.55, p.y) : null;
  };

  const onEvent = (ev: FrameEvent, pos: Map<string, Unit>): void => {
    if (ev.type === 'fire') {
      target.set(ev.instanceId, ev.targetId);
      lastFire.set(ev.targetId, ev.instanceId);
    } else if (ev.type === 'hit') {
      const t = bodies.get(ev.targetId);
      const p = pos.get(ev.targetId);
      if (!t || !p) return;
      const col = ev.element === 'fire' ? '#ff7a1a' : ev.element === 'ice' ? '#8fe3ff' : ev.element === 'lightning' ? '#fff27a' : '#ffffff';
      burst(p.x, t.height * 0.6, p.y, col, 4, 70, 2.6);
    } else if (ev.type === 'death') {
      const b = bodies.get(ev.instanceId);
      if (b) burst(b.px, b.height * 0.4, b.py, b.def.stats.color, Math.min(40, 10 + b.def.stats.size * 2), 120, Math.max(2.4, b.def.stats.size / 3.2));
    } else if (ev.type === 'crumble') {
      for (const id of ev.ids) {
        const b = bodies.get(id);
        if (b) burst(b.px, 12, b.py, '#8a8d92', 14, 90, 4);
      }
    } else if (ev.type === 'arc') {
      // Lightning hopping from the struck body to each of its neighbours: a jagged chain of yellow voxels.
      let from = chest(ev.from, pos);
      for (const id of ev.to) {
        const to = chest(id, pos);
        if (from && to) trail(from.x, from.y, from.z, to.x, to.y, to.z, ELEMENT_COLOR.lightning, 12, 9, 0.28, 2.2);
        from = to ?? from;
      }
    } else if (ev.type === 'splash') {
      for (let k = 0; k < 28; k++) {
        const a = (k / 28) * Math.PI * 2;
        dot(ev.x, 3, ev.y, (Math.cos(a) * ev.r) / 0.25, 0, (Math.sin(a) * ev.r) / 0.25, 0.25, 2.8, ELEMENT_COLOR[ev.element]);
      }
    } else if (ev.type === 'heal' || ev.type === 'cleanse') {
      const color = ev.type === 'heal' ? HEAL_COLOR : CLEANSE_COLOR;
      const from = chest(ev.from, pos);
      const to = chest(ev.to, pos);
      if (from && to) trail(from.x, from.y, from.z, to.x, to.y, to.z, color, 10, 0, 0.35, 1.8);
      if (to) for (let k = 0; k < 5; k++) dot(to.x + (rnd() - 0.5) * 10, to.y + (rnd() - 0.5) * 8, to.z + (rnd() - 0.5) * 10, 0, 34, 0, 0.8, 2.6, color);
    }
  };

  let queue: FrameEvent[] = [];
  const offEvents = arena.subscribeEvents((ev) => {
    if (enabled && queue.length < 400) queue.push(ev);
  });

  // ---------------------------------------------------------------------------
  // Camera modes and selection (interactive pages only)
  // ---------------------------------------------------------------------------

  let mode: ViewMode = 'orbit';
  let selected: string | null = null;
  const setViewMode = (v: ViewMode): void => {
    mode = selected ? v : 'orbit';
    controls.enabled = mode !== 'chase';
    opts.onViewMode?.(mode);
  };
  const select = (id: string | null): void => {
    selected = id;
    const b = id ? bodies.get(id) : undefined;
    opts.onPick?.(b ? { name: b.def.name, owner: b.def.seat, kind: b.def.kind } : null);
    setViewMode(id ? (mode === 'orbit' ? 'follow' : mode) : 'orbit');
  };
  const living = (): string[] => [...bodies.values()].filter((b) => b.group.visible && b.def.kind !== 'wall').map((b) => b.id).sort();
  const selectNext = (): void => {
    const ids = living();
    if (ids.length) select(ids[(Math.max(0, ids.indexOf(selected ?? '')) + (selected ? 1 : 0)) % ids.length]!);
  };

  const ray = new Raycaster();
  const ndc = new Vector2();
  let down: { x: number; y: number } | null = null;
  const onDown = (e: PointerEvent): void => void (down = { x: e.clientX, y: e.clientY });
  const onUp = (e: PointerEvent): void => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects([...bodies.values()].filter((b) => b.group.visible && b.def.kind !== 'wall').map((b) => b.mesh), false)[0];
    select((hit?.object.userData.bodyId as string | undefined) ?? null);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (!enabled) return;
    if (e.key === 'v' || e.key === 'V') cycleViewMode();
    else if (e.key === 'Escape') select(null);
    else if (e.key === 'Tab') {
      e.preventDefault();
      selectNext();
    }
  };
  const cycleViewMode = (): void => setViewMode(mode === 'orbit' ? 'follow' : mode === 'follow' ? 'chase' : 'orbit');
  if (opts.interactive) {
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    addEventListener('keydown', onKey);
  }

  // ---------------------------------------------------------------------------
  // Size and enabling
  // ---------------------------------------------------------------------------

  const resize = (): void => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w < 2 || h < 2) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  ro?.observe(canvas);
  resize();

  let enabled = false;
  const setEnabled = (on: boolean): void => {
    enabled = on;
    canvas.style.display = on ? '' : 'none';
    arena.setOptions({ headless: on, onStep: on ? (_arena, now) => frame(now) : undefined });
    if (on) resize();
    else queue = [];
  };

  // ---------------------------------------------------------------------------
  // Per frame
  // ---------------------------------------------------------------------------

  let generation = -1;
  let last = performance.now();
  const fwd = new Vector3();
  const want = new Vector3();
  const look = new Vector3();
  const lastTarget = new Vector3(400, 0, 400);

  /** The bodies to draw: the interpolated battle sample, or (before the first frame) every placed copy at its spawn. */
  const unitsNow = (): Unit[] => {
    const sample = arena.currentSample;
    if (sample) return sample.units;
    const out: Unit[] = [];
    for (const id of arena.instanceIds) {
      const info = arena.instance(id);
      if (!info || info.ghost) continue;
      out.push({ id, x: info.x0, y: info.y0, hp: info.stats.maxHealth, flags: 0 });
    }
    return out;
  };

  function frame(now: number): void {
    if (!enabled) return;
    const dtMs = Math.min(now - last, 100);
    last = now;
    if (generation !== arena.battleGeneration) {
      // A new battle (or none): forget the bodies, shots and what was learned about them.
      generation = arena.battleGeneration;
      for (const b of bodies.values()) unitsGroup.remove(b.group);
      bodies.clear();
      defs.clear();
      for (const sh of shots.values()) scene.remove(sh.mesh);
      shots.clear();
      target.clear();
      lastFire.clear();
      queue = [];
      clearParticles();
      select(null);
    }
    syncWorld();

    const sample = arena.currentSample;
    const tick = arena.tick;
    const simDt = arena.clock.paused ? 0 : (dtMs / 1000) * arena.clock.speed;
    const units = unitsNow();
    const pos = new Map(units.map((u) => [u.id, u]));
    const highlight = arena.highlightSeat;
    const seen = new Set<string>();

    for (const u of units) {
      const def = defOf(u.id);
      if (!def) continue;
      let b = bodies.get(u.id);
      if (!b) bodies.set(u.id, (b = makeBody(u.id, def)));
      seen.add(u.id);
      b.group.visible = true;
      const moved = Number.isNaN(b.px) ? 0 : Math.hypot(u.x - b.px, u.y - b.py);
      const attacking = (u.flags & FRAME_FLAGS.ATTACKING) !== 0;
      const foe = attacking ? pos.get(target.get(u.id) ?? '') : undefined;
      if (b.def.kind !== 'wall') {
        // Only soldiers and minions turn; towers and factories keep facing the middle of the arena.
        const mobile = b.def.kind === 'soldier' || b.def.kind === 'minion';
        if (Number.isNaN(b.heading)) b.heading = mobile ? (b.def.seat % 2 ? Math.PI : 0) : Math.atan2(S / 2 - u.y, S / 2 - u.x);
        if (!mobile) {
          // no turning
        } else if (foe && Math.hypot(foe.x - u.x, foe.y - u.y) > 0.5) b.heading = lerpAngle(b.heading, Math.atan2(foe.y - u.y, foe.x - u.x), 0.35);
        else if (moved > 0.05) b.heading = lerpAngle(b.heading, Math.atan2(u.y - b.py, u.x - b.px), 0.25);
        const state: AnimState = attacking ? 'attack' : (u.flags & FRAME_FLAGS.MOVING) !== 0 ? 'walk' : 'idle';
        const g = geometryFor(b.def, state, tick);
        if (g.key + state !== b.geoKey) {
          b.mesh.geometry = g.geo;
          b.geoKey = g.key + state;
        }
        const hop = (u.flags & FRAME_FLAGS.MOVING) !== 0 ? Math.abs(Math.sin(tick * 0.45 + u.x)) * 1.6 : 0;
        b.mesh.position.y = hop;
        b.mesh.rotation.y = -b.heading;
      } else b.material.color.setScalar(0.45 + 0.55 * (u.hp / b.def.stats.maxHealth));
      b.px = u.x;
      b.py = u.y;
      b.group.position.set(u.x, 0, u.y);
      if (b.ring) b.ring.visible = highlight !== null && b.def.seat === highlight;
      const burning = (u.flags & FRAME_FLAGS.BURNING) !== 0;
      const frozen = (u.flags & FRAME_FLAGS.FROZEN) !== 0;
      b.material.emissive.set(burning ? '#ff6a00' : frozen ? '#4fc3ff' : '#000000').multiplyScalar(burning || frozen ? 0.35 : 0);
      if (b.aura) (b.aura.material as MeshBasicMaterial).opacity = 0.5 + 0.3 * Math.sin(now / 280 + b.px * 0.05);
      // Under a haste / might / shield aura: a few motes of its colour rise off the body.
      const buff: AuraKind | null = u.flags & FRAME_FLAGS.HASTED ? 'haste' : u.flags & FRAME_FLAGS.MIGHTY ? 'might' : u.flags & FRAME_FLAGS.SHIELDED ? 'shield' : null;
      if (buff && simDt > 0 && rnd() < 0.08) {
        const sz = b.def.stats.size;
        dot(u.x + (rnd() - 0.5) * sz * 1.6, 2, u.y + (rnd() - 0.5) * sz * 1.6, 0, 26, 0, 0.8, 2.2, AURA_COLOR[buff]);
      }
      if (burning && simDt > 0 && rnd() < 0.5) burst(u.x, b.height * 0.6, u.y, rnd() < 0.5 ? '#ff7a1a' : '#ffd23f', 1, 22, 2.4);
      // HP bar: only while damaged (walls and minions) or always (everything else), facing the camera.
      const ratio = Math.max(0, Math.min(1, u.hp / b.def.stats.maxHealth));
      const show = ratio < 0.999 || (b.def.kind !== 'wall' && b.def.kind !== 'minion');
      b.bar.visible = show;
      if (show) {
        const bw = Math.max(18, b.def.stats.size * 2.6);
        b.barFill.scale.x = Math.max(0.01, bw * ratio);
        b.barFill.position.x = -(bw * (1 - ratio)) / 2;
        (b.barFill.material as MeshBasicMaterial).color.set(ratio > 0.5 ? '#4ade80' : ratio > 0.25 ? '#facc15' : '#f87171');
        b.bar.quaternion.copy(camera.quaternion);
      }
    }
    for (const [id, b] of bodies) if (!seen.has(id)) b.group.visible = false;

    // Events first (a shot's shooter is learned from its `fire` event).
    for (const ev of queue) onEvent(ev, pos);
    queue = [];

    // Projectiles: look by the shooter's element (normal cube, fireball, ice shard, lightning spark); splash shots are bigger.
    const live = new Set<number>();
    for (const p of sample?.projectiles ?? []) {
      live.add(p.id);
      let sh = shots.get(p.id);
      const foe = pos.get(p.targetId);
      if (!sh) {
        const shooter = bodies.get(lastFire.get(p.targetId) ?? '')?.def;
        const element = shooter?.element ?? 'normal';
        sh = { mesh: shotMesh(element, shooter?.stats.color ?? '#ffffff'), element, dist: Math.max(1, foe ? Math.hypot(foe.x - p.x, foe.y - p.y) : 1) };
        if ((shooter?.splash ?? 0) > 0) sh.mesh.scale.setScalar(1.8);
        shots.set(p.id, sh);
        scene.add(sh.mesh);
      }
      const remaining = foe ? Math.hypot(foe.x - p.x, foe.y - p.y) : 0;
      const prog = Math.max(0, Math.min(1, 1 - remaining / sh.dist));
      const y = 10 + 4 * prog * (1 - prog) * Math.min(36, sh.dist * 0.25);
      sh.mesh.position.set(p.x, y, p.y);
      if (sh.element === 'ice') sh.mesh.rotation.set(tick * 0.12, tick * 0.17, 0);
      if (sh.element === 'lightning') sh.mesh.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
      if (simDt > 0) {
        if (sh.element === 'fire' && rnd() < 0.6) dot(p.x, y, p.y, (rnd() - 0.5) * 30, 14, (rnd() - 0.5) * 30, 0.35, 2.4, rnd() < 0.5 ? '#ffb347' : '#ff5a1f');
        else if (sh.element === 'ice' && rnd() < 0.4) dot(p.x, y, p.y, (rnd() - 0.5) * 12, -6, (rnd() - 0.5) * 12, 0.4, 1.8, '#e8fbff');
        else if (sh.element === 'lightning' && rnd() < 0.7) dot(p.x + (rnd() - 0.5) * 6, y + (rnd() - 0.5) * 6, p.y + (rnd() - 0.5) * 6, 0, 0, 0, 0.18, 1.8, ELEMENT_COLOR.lightning);
      }
    }
    for (const [id, sh] of shots) {
      if (live.has(id)) continue;
      scene.remove(sh.mesh);
      shots.delete(id);
    }

    const r = sample?.safeZoneRadius ?? 0;
    zoneRing.visible = r > 0 && r < S * 0.69;
    zoneRing.scale.set(r, 1, r);

    stepParticles(simDt);

    // Camera.
    const sel = selected ? bodies.get(selected) : undefined;
    if (selected && (!sel || !sel.group.visible)) select(null);
    else if (sel) {
      if (mode === 'follow') {
        want.set(sel.px, sel.height * 0.5, sel.py);
        const delta = want.clone().sub(controls.target).multiplyScalar(Math.min(1, dtMs / 150));
        controls.target.add(delta);
        camera.position.add(delta);
      } else if (mode === 'chase') {
        fwd.set(Math.cos(sel.heading), 0, Math.sin(sel.heading));
        want.set(sel.px, 0, sel.py).addScaledVector(fwd, -(sel.def.stats.size * 5 + 45)).setY(sel.height + 38);
        look.set(sel.px, sel.height * 0.7, sel.py).addScaledVector(fwd, 60);
        camera.position.lerp(want, Math.min(1, dtMs / 220));
        lastTarget.lerp(look, Math.min(1, dtMs / 160));
        camera.lookAt(lastTarget);
        controls.target.copy(lastTarget);
      }
    }
    if (mode !== 'chase') controls.update();

    renderer.render(scene, camera);
  }

  return {
    canvas,
    get enabled() {
      return enabled;
    },
    setEnabled,
    resize,
    near(x: number, y: number): number {
      const d = Math.hypot(camera.position.x - x, camera.position.z - y);
      return Math.max(0.12, Math.min(1, 1 / (1 + (d / (S * 0.45)) ** 2)));
    },
    get viewMode() {
      return mode;
    },
    setViewMode,
    cycleViewMode,
    select,
    selectNext,
    dispose(): void {
      setEnabled(false);
      offEvents();
      ro?.disconnect();
      if (opts.interactive) {
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointerup', onUp);
        removeEventListener('keydown', onKey);
      }
      controls.dispose();
      if (worldGroup) disposeGroup(worldGroup);
      disposeGroup(unitsGroup);
      renderer.dispose();
    },
  };
}
