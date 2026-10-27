// The optional 3D (voxel) view of a battle arena, shared by /screen and /play.
//
// An ArenaRenderer keeps all the battle logic and the 2D drawing. This wires
// a second canvas to it: when 3D is on, the arena runs headless and the voxel
// view (observe/voxelView.ts, three.js) draws its state instead. three.js is
// loaded on first use, so a player who keeps the 2D view never downloads it.
// 3D is the default; the choice is remembered per device, `?view=2d` / `?view=3d`
// overrides it for one visit, and a browser without WebGL stays on 2D.

import type { ArenaRenderer } from './render/arena.js';

export type ViewPref = '2d' | '3d';

const KEY = 'pixel-clash:view';

/** The wanted view: the URL, else this device's remembered choice, else 3D. */
export function viewPref(): ViewPref {
  try {
    const q = new URLSearchParams(location.search).get('view');
    if (q === '2d' || q === '3d') return q;
  } catch {
    // no location: fall through
  }
  try {
    const v = localStorage.getItem(KEY);
    if (v === '2d' || v === '3d') return v;
  } catch {
    // storage blocked: default
  }
  return '3d';
}

function rememberPref(p: ViewPref): void {
  try {
    localStorage.setItem(KEY, p);
  } catch {
    // ignore: the choice just isn't remembered
  }
}

/** What the 3D camera is following (or null: the free orbit camera). */
export interface Following {
  name: string;
  /** Owner seat. */
  seat: number;
  kind: string;
  mode: 'follow' | 'chase';
}

export interface ViewOptions {
  /** Click a unit to follow it, with V / N / Tab / Esc (see VoxelViewOptions). */
  interactive?: boolean;
  keys?: 'window' | 'canvas';
  /** Shadow map edge in px (the projector can afford more than a player's laptop). */
  shadowMapSize?: number;
  /** Cap on the device pixel ratio. */
  maxPixelRatio?: number;
}

export interface Arena3D {
  /** The view being shown right now. */
  readonly mode: ViewPref;
  /** 3D could not start (no WebGL, or the chunk failed to load): the 2D view stays. */
  readonly unavailable: boolean;
  /** The unit the camera follows, if any. */
  readonly following: Following | null;
  /** Cycle orbit / follow / chase and pick the next unit (the keys' actions, for buttons). */
  cycleCamera(): void;
  selectNext(): void;
  release(): void;
  /** Switch (and remember the choice on this device). */
  set(pref: ViewPref): void;
  toggle(): void;
  subscribe(fn: () => void): () => void;
  /** Volume factor for a sound at arena (x, y): louder near the 3D camera (1 in 2D). */
  near(x: number, y: number): number;
  dispose(): void;
}

/**
 * Give `arena` a 3D view drawn into `canvas3d` (a sibling of the arena's own
 * canvas, same box). Starts in the remembered view (default 3D).
 */
export function attach3D(arena: ArenaRenderer, canvas3d: HTMLCanvasElement, opts: ViewOptions = {}): Arena3D {
  type Voxel = import('../observe/voxelView.js').VoxelView;
  let view: Voxel | null = null;
  let loading: Promise<Voxel | null> | null = null;
  let mode: ViewPref = '2d';
  let unavailable = false;
  let disposed = false;
  let pick: { name: string; owner: number; kind: string } | null = null;
  let camMode: 'orbit' | 'follow' | 'chase' = 'orbit';
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const fn of listeners) fn();
  };
  canvas3d.style.display = 'none';

  const load = (): Promise<Voxel | null> => {
    loading ??= import('../observe/voxelView.js')
      .then(({ createVoxelView }) => {
        if (disposed) return null;
        const v = createVoxelView(canvas3d, arena, {
          shadowMapSize: opts.shadowMapSize ?? 2048,
          maxPixelRatio: opts.maxPixelRatio ?? 2,
          interactive: opts.interactive ?? false,
          keys: opts.keys ?? 'window',
          onPick: (p) => {
            pick = p;
            emit();
          },
          onViewMode: (m) => {
            camMode = m;
            emit();
          },
        });
        view = v;
        return v;
      })
      .catch(() => {
        unavailable = true;
        emit();
        return null;
      });
    return loading;
  };

  const show = (pref: ViewPref): void => {
    if (pref === '3d') {
      void load().then((v) => {
        if (!v || disposed) return;
        v.setEnabled(true);
        mode = '3d';
        emit();
      });
    } else {
      view?.setEnabled(false);
      mode = '2d';
      emit();
    }
  };
  show(viewPref());

  return {
    get mode() {
      return mode;
    },
    get unavailable() {
      return unavailable;
    },
    get following() {
      return pick && camMode !== 'orbit' ? { name: pick.name, seat: pick.owner, kind: pick.kind, mode: camMode } : null;
    },
    cycleCamera() {
      view?.cycleViewMode();
    },
    selectNext() {
      view?.selectNext();
    },
    release() {
      view?.select(null);
    },
    set(pref) {
      rememberPref(pref);
      show(pref);
    },
    toggle() {
      this.set(mode === '3d' ? '2d' : '3d');
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    near(x, y) {
      return mode === '3d' && view ? view.near(x, y) : 1;
    },
    dispose() {
      disposed = true;
      view?.dispose();
      view = null;
    },
  };
}
