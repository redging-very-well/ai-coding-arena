// 3D observer prototype: replays a finished battle as a voxel (Minecraft-style)
// world in three.js. It reads the same ReplayDTO as the projector, so it adds no
// server code: the sim stays authoritative and this is only another view.
//
//   /observe?round=N   a stored battle (default: the latest)
//   /observe?demo      the canned dev replay (needs `npm run dev`)
//
// Reused from the 2D renderer: FrameBuffer / PlaybackClock (interpolation,
// walls carried between frames), resolveSprite (a unit's own pixel art or the
// fallback) and the seat colours. Each sprite pixel becomes a cube (voxels.ts).

import {
  AmbientLight, BoxGeometry, BufferGeometry, Color, DirectionalLight, DoubleSide, Fog, Group, HemisphereLight,
  InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, PCFSoftShadowMap,
  PerspectiveCamera, PlaneGeometry, Raycaster, Scene, Vector2, Vector3, WebGLRenderer, CylinderGeometry,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FRAME_FLAGS, zoneRect, type FrameEvent, type ReplayDTO, type StatsSnapshot } from '@pixel-clash/shared';
import '../common/theme.css';
import { api } from '../common/api.js';
import { FrameBuffer, PlaybackClock, TICKS_PER_SECOND } from '../common/render/playback.js';
import { resolveSprite, type AnimState } from '../common/render/sprites.js';
import { minionFactoryId } from '../common/render/buildings.js';
import { seatStyle } from '../common/seats.js';
import { formatClock } from '../common/ui.js';
import { boxVoxels, spriteVoxels, voxelGeometry, type Voxel } from './voxels.js';

/** Edge of one ground block in arena px (the sim is 800-1200 px wide). */
const BLOCK = 10;
const WALL_BLOCKS_HIGH = 3;
const ANIM_FPS = 8;

type Kind = 'soldier' | 'tower' | 'wall' | 'factory' | 'minion';

interface Def {
  seat: number;
  name: string;
  stats: Pick<StatsSnapshot, 'maxHealth' | 'size' | 'color' | 'type' | 'shape'>;
  kind: Kind;
  sprite: ReturnType<typeof resolveSprite>;
}

interface Body {
  id: string;
  def: Def;
  group: Group;
  mesh: Mesh;
  material: MeshLambertMaterial;
  bar: Group;
  barFill: Mesh;
  height: number;
  heading: number;
  px: number;
  py: number;
  geoKey: string;
}

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document): T => root.querySelector(sel) as T;

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function loadReplay(): Promise<ReplayDTO> {
  const params = new URLSearchParams(location.search);
  if (params.has('demo')) {
    // Only the Vite dev server (default :5173) serves this file; the game server's built client does not.
    const res = await fetch('/src/common/render/__demo/replay.json');
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.includes('json')) {
      throw new Error(`the demo replay is only served by the Vite dev server (npm run dev, usually http://localhost:5173/observe?demo; got ${res.status} here). On the game server use /observe?round=N.`);
    }
    return (await res.json()) as ReplayDTO;
  }
  const round = params.get('round');
  return api.replay(round ? Number(round) : 'latest');
}

function buildDefs(replay: ReplayDTO): Map<string, Def> {
  const defs = new Map<string, Def>();
  for (const p of replay.reveal.players) {
    const units = new Map(p.units.map((u) => [u.unitId, u]));
    for (const inst of p.instances) {
      const u = units.get(inst.unitId);
      if (!u) continue;
      defs.set(inst.instanceId, { seat: p.seat, name: u.name, stats: u.stats, kind: u.stats.type, sprite: resolveSprite(u) });
    }
  }
  return defs;
}

/** Minions are never in the reveal: they take their factory's seat and colour. */
function minionDef(factory: Def, replay: ReplayDTO): Def {
  const m = replay.reveal.minion?.stats;
  const stats = { maxHealth: m?.maxHealth ?? 40, size: m?.size ?? 8, color: factory.stats.color, type: 'soldier' as const, shape: 'circle' as const };
  return { seat: factory.seat, name: 'Minion', stats, kind: 'minion', sprite: resolveSprite({ sprite: null, stats }) };
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

function mulberry(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildWorld(scene: Scene, replay: ReplayDTO, S: number): void {
  const rand = mulberry(7);
  const grassA = new Color('#5fae3d');
  const grassB = new Color('#58a537');
  const zones = replay.reveal.players.map((p) => ({ rect: p.mapZone ?? (p.zone ? zoneRect(p.zone) : null), color: new Color(seatStyle(p.seat).color) }));

  // Ground: one block per BLOCK×BLOCK of arena, checkered grass, tinted inside each player's zone.
  const n = Math.ceil(S / BLOCK);
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
        if (r && cx >= r.x && cx < r.x + r.width && cy >= r.y && cy < r.y + r.height) c.lerp(z.color, 0.38);
      }
      ground.setColorAt(idx, c);
    }
  }
  ground.receiveShadow = true;
  scene.add(ground);

  // The island: a lower grass rim with dirt sides, and water all round.
  const dirt = new MeshLambertMaterial({ color: '#7a5436' });
  const rim = new MeshLambertMaterial({ color: '#4d9632' });
  const island = new Mesh(new BoxGeometry(S + 360, 40, S + 360), [dirt, dirt, rim, dirt, dirt, dirt]);
  island.position.set(S / 2, -4 - 20, S / 2);
  island.receiveShadow = true;
  scene.add(island);
  const water = new Mesh(new PlaneGeometry(S * 12, S * 12), new MeshLambertMaterial({ color: '#3a6fd8' }));
  water.rotation.x = -Math.PI / 2;
  water.position.set(S / 2, -30, S / 2);
  scene.add(water);

  // Trees on the rim (decoration only).
  const bark = new Color('#6b4a2b');
  const leaf = new Color('#2f7a2a');
  const treeVoxels: Voxel[] = [
    ...boxVoxels(2, 7, 2, () => bark),
    ...boxVoxels(6, 4, 6, (x, y, z) => leaf.clone().multiplyScalar(0.85 + ((x * 7 + y * 3 + z * 5) % 4) * 0.07)).map((v) => ({ ...v, y: v.y + 6 })),
    ...boxVoxels(4, 2, 4, () => leaf.clone().multiplyScalar(1.05)).map((v) => ({ ...v, y: v.y + 10 })),
  ];
  const treeGeo = voxelGeometry(treeVoxels, 5);
  const treeMat = new MeshLambertMaterial({ vertexColors: true });
  for (let i = 0; i < 26; i++) {
    const a = rand() * Math.PI * 2;
    const d = S * 0.5 * Math.SQRT2 + 40 + rand() * 90;
    const x = S / 2 + Math.cos(a) * d;
    const z = S / 2 + Math.sin(a) * d;
    if (Math.abs(x - S / 2) < S / 2 + 20 && Math.abs(z - S / 2) < S / 2 + 20) continue;
    const t = new Mesh(treeGeo, treeMat);
    t.position.set(x, -4, z);
    t.rotation.y = rand() * Math.PI;
    t.castShadow = true;
    scene.add(t);
  }

  // Clouds drift slowly (animated in the render loop through scene.userData).
  const cloudGeo = voxelGeometry(boxVoxels(9, 2, 5, () => new Color('#ffffff')), 22, 0.02);
  const cloudMat = new MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.92 });
  const clouds: Mesh[] = [];
  for (let i = 0; i < 9; i++) {
    const c = new Mesh(cloudGeo, cloudMat);
    c.position.set(rand() * S * 2 - S / 2, S * 0.95 + rand() * 80, rand() * S * 2 - S / 2);
    scene.add(c);
    clouds.push(c);
  }
  scene.userData.clouds = clouds;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const app = $('#app');
  app.innerHTML = `
    <style>
      body { margin: 0; overflow: hidden; background: #8ec5ff; }
      canvas.stage { position: fixed; inset: 0; width: 100vw; height: 100vh; display: block; }
      .hud { position: fixed; left: 0; right: 0; top: 0; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 8px 12px; background: rgba(13,15,26,.78); color: var(--text, #fff); font: 13px system-ui, sans-serif; }
      .hud button { font: inherit; padding: 5px 10px; cursor: pointer; }
      .hud input[type=range] { flex: 1; min-width: 160px; }
      .hud .title { font-size: 12px; color: var(--accent, #ffd447); }
      .legend, .pick { position: fixed; background: rgba(13,15,26,.78); color: #fff; font: 13px system-ui, sans-serif; padding: 8px 10px; }
      .legend { left: 12px; top: 60px; }
      .legend div { display: flex; gap: 8px; align-items: center; margin: 3px 0; }
      .legend i { width: 12px; height: 12px; display: inline-block; border: 2px solid #000; }
      .pick { right: 12px; top: 60px; min-width: 190px; }
      .help { position: fixed; left: 12px; bottom: 10px; color: #fff; text-shadow: 0 1px 3px #000; font: 12px system-ui, sans-serif; }
      #msg { position: fixed; inset: 0; display: grid; place-items: center; color: #fff; font: 16px system-ui, sans-serif; text-shadow: 0 1px 4px #000; }
    </style>
    <canvas class="stage"></canvas>
    <div class="hud">
      <span class="title pixel">3D OBSERVER <small>(prototype)</small></span>
      <button id="play">Pause</button><button id="speed">1x</button>
      <input id="scrub" type="range" min="0" max="1" value="0" step="1" />
      <span id="time">0:00</span>
      <button id="view">View: orbit</button>
    </div>
    <div class="legend" id="legend"></div>
    <div class="pick" id="pick" hidden></div>
    <div class="help">Drag: orbit · wheel: zoom · right-drag: pan · click a unit to follow it · V: follow / chase view · Tab: next unit · Esc: release · Space: pause · ←/→: ±5 s</div>
    <div id="msg">Loading battle…</div>`;
  const msg = $('#msg');

  let replay: ReplayDTO;
  try {
    replay = await loadReplay();
  } catch (e) {
    msg.textContent = `Could not load a battle: ${e instanceof Error ? e.message : String(e)}`;
    return;
  }
  msg.remove();

  const S = replay.reveal.map?.width ?? 800;
  const defs = buildDefs(replay);

  // Playback: the 2D renderer's buffer and clock, so interpolation and wall carry-over match the projector.
  const buffer = new FrameBuffer();
  buffer.setSticky(
    [...defs.entries()].filter(([, d]) => d.kind === 'wall').map(([id, d]) => {
      const inst = replay.reveal.players.flatMap((p) => p.instances).find((i) => i.instanceId === id)!;
      return [id, inst.x, inst.y, d.stats.maxHealth, 0] as [string, number, number, number, number];
    }),
  );
  buffer.push(replay.frames);
  const clock = new PlaybackClock();
  clock.mode = 'replay';
  const endTick = replay.end.endTick;

  // Scene.
  const canvas = $<HTMLCanvasElement>('canvas.stage');
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  const scene = new Scene();
  scene.background = new Color('#8ec5ff');
  scene.fog = new Fog('#8ec5ff', S * 1.6, S * 5);
  scene.add(new HemisphereLight('#dff0ff', '#6b5a3a', 1.05), new AmbientLight('#ffffff', 0.25));
  const sun = new DirectionalLight('#fff4d6', 2.1);
  sun.position.set(S * 0.9, 700, S * 0.1);
  sun.target.position.set(S / 2, 0, S / 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -S * 0.75;
  sc.right = sc.top = S * 0.75;
  sc.near = 100;
  sc.far = 2200;
  sun.shadow.bias = -0.0006;
  scene.add(sun, sun.target);
  buildWorld(scene, replay, S);

  const camera = new PerspectiveCamera(50, 1, 5, S * 8);
  camera.position.set(S * 0.5, S * 0.62, S * 1.28);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(S / 2, 0, S / 2);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.maxDistance = S * 3;
  controls.update();

  // Bodies.
  const world = new Group();
  scene.add(world);
  const bodies = new Map<string, Body>();
  const geoCache = new WeakMap<object, Map<string, BufferGeometry>>();
  const barGeo = new PlaneGeometry(1, 1);
  const barBack = new MeshBasicMaterial({ color: '#000000', side: DoubleSide, depthTest: false, transparent: true, opacity: 0.7 });
  const plateGeo = new BoxGeometry(1, 1, 1);

  const defOf = (id: string): Def | null => {
    const known = defs.get(id);
    if (known) return known;
    const fid = minionFactoryId(id);
    const factory = fid ? defs.get(fid) : null;
    if (!factory) return null;
    const d = minionDef(factory, replay);
    defs.set(id, d);
    return d;
  };

  /** One voxel model per (sprite, state, frame, size): built once, shared by every copy. */
  const geometryFor = (def: Def, state: AnimState, tick: number): { geo: BufferGeometry; key: string; height: number } => {
    const spec = def.sprite;
    const frames = spec.frames[state] ?? spec.frames.idle;
    const i = Math.floor((tick / TICKS_PER_SECOND) * ANIM_FPS) % frames.length;
    const big = def.kind === 'tower' || def.kind === 'factory';
    const cell = (def.stats.size * (big ? 3.1 : 2.6)) / spec.grid;
    const key = `${state}:${i}:${cell.toFixed(2)}`;
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
      // Seat plate under the unit: the colour (and badge digit in the legend) tells the teams apart.
      const plate = new Mesh(plateGeo, new MeshLambertMaterial({ color: seatStyle(def.seat).color }));
      const w = def.stats.size * 2.3;
      plate.scale.set(w, 1.2, w);
      plate.position.y = 0.6;
      plate.receiveShadow = true;
      group.add(plate);
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
    world.add(group);
    return { id, def, group, mesh, material, bar, barFill, height, heading: def.seat % 2 ? Math.PI : 0, px: NaN, py: NaN, geoKey: '' };
  };

  // Particles: voxel debris, sparks and flames from one pooled InstancedMesh.
  const MAX_P = 900;
  const parts = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshLambertMaterial(), MAX_P);
  parts.frustumCulled = false;
  parts.castShadow = false;
  scene.add(parts);
  const pPos = new Float32Array(MAX_P * 3);
  const pVel = new Float32Array(MAX_P * 3);
  const pLife = new Float32Array(MAX_P);
  const pSize = new Float32Array(MAX_P);
  let pNext = 0;
  const zero = new Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < MAX_P; i++) parts.setMatrixAt(i, zero);
  const rnd = mulberry(99);
  const burst = (x: number, y: number, z: number, color: string, count: number, power: number, size: number, up = 1): void => {
    const c = new Color(color);
    for (let k = 0; k < count; k++) {
      const i = pNext++ % MAX_P;
      pPos.set([x, y, z], i * 3);
      pVel.set([(rnd() - 0.5) * power, (0.4 + rnd()) * power * up, (rnd() - 0.5) * power], i * 3);
      pLife[i] = 0.5 + rnd() * 0.7;
      pSize[i] = size * (0.6 + rnd() * 0.8);
      parts.setColorAt(i, c.clone().multiplyScalar(0.8 + rnd() * 0.4));
    }
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
      pVel[i * 3 + 1]! -= 260 * dt;
      for (let a = 0; a < 3; a++) pPos[i * 3 + a]! += pVel[i * 3 + a]! * dt;
      if (pPos[i * 3 + 1]! < 0) {
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

  // Projectiles and the sudden-death wall.
  const shots = new Map<number, Mesh>();
  const shotGeo = new BoxGeometry(3.5, 3.5, 3.5);
  const shotMat = new MeshBasicMaterial({ color: '#fff1a8' });
  const zoneRing = new Mesh(new CylinderGeometry(1, 1, 80, 72, 1, true), new MeshBasicMaterial({ color: '#ff4d4d', transparent: true, opacity: 0.2, side: DoubleSide, depthWrite: false }));
  zoneRing.position.set(S / 2, 40, S / 2);
  zoneRing.visible = false;
  scene.add(zoneRing);

  // Legend and HUD.
  const legend = $('#legend');
  const seats = replay.reveal.players.map((p) => ({ seat: p.seat, name: p.name }));
  legend.innerHTML = seats.map((s) => `<div><i style="background:${seatStyle(s.seat).color}"></i>${seatStyle(s.seat).symbol} ${s.name} <span data-alive="${s.seat}"></span></div>`).join('');
  const scrub = $<HTMLInputElement>('#scrub');
  scrub.max = String(endTick);
  const pick = $('#pick');

  // Controls.
  type View = 'orbit' | 'follow' | 'chase';
  let view: View = 'orbit';
  let selected: string | null = null;
  const setView = (v: View): void => {
    view = selected ? v : 'orbit';
    controls.enabled = view !== 'chase';
    $('#view').textContent = `View: ${view}`;
  };
  const select = (id: string | null): void => {
    selected = id;
    pick.hidden = !id;
    setView(id ? (view === 'orbit' ? 'follow' : view) : 'orbit');
  };
  $('#play').onclick = () => {
    if (clock.tick >= endTick - 1) clock.seek(0);
    clock.paused = !clock.paused;
    $('#play').textContent = clock.paused ? 'Play' : 'Pause';
  };
  $('#speed').onclick = () => {
    clock.speed = clock.speed === 1 ? 2 : 1;
    $('#speed').textContent = `${clock.speed}x`;
  };
  $('#view').onclick = () => setView(view === 'orbit' ? 'follow' : view === 'follow' ? 'chase' : 'orbit');
  let scrubbing = false;
  scrub.oninput = () => {
    scrubbing = true;
    clock.seek(Number(scrub.value));
  };
  scrub.onchange = () => (scrubbing = false);

  const living = (): string[] => [...bodies.values()].filter((b) => b.group.visible && b.def.kind !== 'wall').map((b) => b.id).sort();
  addEventListener('keydown', (e) => {
    if (e.key === ' ') {
      e.preventDefault();
      $('#play').click();
    } else if (e.key === 'v' || e.key === 'V') $('#view').click();
    else if (e.key === 'Escape') select(null);
    else if (e.key === 'Tab') {
      e.preventDefault();
      const ids = living();
      if (ids.length) select(ids[(Math.max(0, ids.indexOf(selected ?? '')) + (selected ? 1 : 0)) % ids.length]!);
    } else if (e.key === 'ArrowRight') clock.seek(clock.tick + 5 * TICKS_PER_SECOND);
    else if (e.key === 'ArrowLeft') clock.seek(clock.tick - 5 * TICKS_PER_SECOND);
  });
  const ray = new Raycaster();
  const ndc = new Vector2();
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects([...bodies.values()].filter((b) => b.group.visible && b.def.kind !== 'wall').map((b) => b.mesh), false)[0];
    select((hit?.object.userData.bodyId as string | undefined) ?? null);
  });
  const resize = (): void => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize);
  resize();

  // Render loop.
  let prevTick = 0;
  let last = performance.now();
  const target = new Map<string, string>();
  const fwd = new Vector3();
  const want = new Vector3();
  const look = new Vector3();
  const lastTarget = new Vector3(S / 2, 0, S / 2);
  const lerpAngle = (a: number, b: number, f: number): number => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * f;

  const frame = (now: number): void => {
    const dtMs = now - last;
    last = now;
    const tick = clock.advance(dtMs, buffer.firstT, endTick);
    const sample = buffer.sample(tick);
    const simDt = clock.paused ? 0 : Math.min(dtMs, 100) / 1000 * clock.speed;
    if (sample) {
      const seen = new Set<string>();
      const pos = new Map(sample.units.map((u) => [u.id, u]));
      const alive = new Map<number, number>();
      for (const u of sample.units) {
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
          if (foe && Math.hypot(foe.x - u.x, foe.y - u.y) > 0.5) b.heading = lerpAngle(b.heading, Math.atan2(foe.y - u.y, foe.x - u.x), 0.35);
          else if (moved > 0.05) b.heading = lerpAngle(b.heading, Math.atan2(u.y - b.py, u.x - b.px), 0.25);
          alive.set(b.def.seat, (alive.get(b.def.seat) ?? 0) + 1);
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
        const burning = (u.flags & FRAME_FLAGS.BURNING) !== 0;
        const frozen = (u.flags & FRAME_FLAGS.FROZEN) !== 0;
        b.material.emissive.set(burning ? '#ff6a00' : frozen ? '#4fc3ff' : '#000000').multiplyScalar(burning || frozen ? 0.35 : 0);
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
      for (const el of legend.querySelectorAll<HTMLElement>('[data-alive]')) el.textContent = `(${alive.get(Number(el.dataset.alive)) ?? 0})`;

      // Projectiles.
      const live = new Set<number>();
      for (const p of sample.projectiles) {
        live.add(p.id);
        let m = shots.get(p.id);
        if (!m) {
          m = new Mesh(shotGeo, shotMat);
          shots.set(p.id, m);
          scene.add(m);
        }
        m.position.set(p.x, 13, p.y);
      }
      for (const [id, m] of shots) {
        if (live.has(id)) continue;
        scene.remove(m);
        shots.delete(id);
      }

      const r = sample.safeZoneRadius;
      zoneRing.visible = r > 0 && r < S * 0.69;
      zoneRing.scale.set(r, 1, r);

      // Events since the last frame (not across a seek).
      if (tick >= prevTick && tick - prevTick < 120) {
        for (const { event } of buffer.eventsBetween(prevTick, tick)) onEvent(event, pos);
      }
      prevTick = tick;
    }
    function onEvent(ev: FrameEvent, pos: Map<string, { x: number; y: number }>): void {
      if (ev.type === 'fire') target.set(ev.instanceId, ev.targetId);
      else if (ev.type === 'hit') {
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
      }
    }

    stepParticles(simDt);
    const clouds = scene.userData.clouds as Mesh[];
    for (const c of clouds) c.position.x = ((c.position.x + simDt * 6 + S / 2) % (S * 2)) - S / 2;

    // Camera.
    const sel = selected ? bodies.get(selected) : undefined;
    if (selected && (!sel || !sel.group.visible)) select(null);
    else if (sel) {
      pick.innerHTML = `<b>${sel.def.name}</b><br>${seats.find((s) => s.seat === sel.def.seat)?.name ?? ''} · ${sel.def.kind}`;
      if (view === 'follow') {
        want.set(sel.px, sel.height * 0.5, sel.py);
        const delta = want.clone().sub(controls.target).multiplyScalar(Math.min(1, dtMs / 150));
        controls.target.add(delta);
        camera.position.add(delta);
      } else if (view === 'chase') {
        fwd.set(Math.cos(sel.heading), 0, Math.sin(sel.heading));
        want.set(sel.px, 0, sel.py).addScaledVector(fwd, -(sel.def.stats.size * 5 + 45)).setY(sel.height + 38);
        look.set(sel.px, sel.height * 0.7, sel.py).addScaledVector(fwd, 60);
        camera.position.lerp(want, Math.min(1, dtMs / 220));
        lastTarget.lerp(look, Math.min(1, dtMs / 160));
        camera.lookAt(lastTarget);
        controls.target.copy(lastTarget);
      }
    }
    if (view !== 'chase') controls.update();

    if (!scrubbing) scrub.value = String(Math.round(tick));
    $('#time').textContent = formatClock((endTick - tick) / TICKS_PER_SECOND);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void main();
