// Locating repo files at runtime, from both src/ (tsx) and dist/ (built).

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let root: string | undefined;

/** The repo root: the nearest ancestor containing packages/starter-kit. */
export function repoRoot(): string {
  if (root) return root;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'packages', 'starter-kit'))) return (root = dir);
    const up = dirname(dir);
    if (up === dir) throw new Error('could not find the repo root (packages/starter-kit)');
    dir = up;
  }
}

export function repoPath(...parts: string[]): string {
  return join(repoRoot(), ...parts);
}

/** The built client (vite build output): packages/server/dist/public. */
export function defaultPublicDir(): string {
  return repoPath('packages', 'server', 'dist', 'public');
}
